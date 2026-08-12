import { createHash, type Hash } from "node:crypto";
import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import type { SessionReference } from "../contract/index.js";
import type { SessionDetail, SessionHead } from "../types/index.js";
import { computeIdentity, realFs } from "../projects/index.js";
import {
  classifySessionTags,
  extractSessionFileActivity,
  getSmartTagSourceTimestamp,
  SMART_TAG_CLASSIFIER_REVISION,
} from "../utils/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { listSessionFileActivity } from "./cache/file-activity.js";
import { sessionDetailVersion } from "./cache/detail-version.js";
import { loadCachedSessionRawEntry, type CachedSessionRawEntry } from "./cache/sessions.js";
import { messageFromCachedRow, messageJsonFromCachedRow } from "./cache/messages.js";
import type { LiveSnapshot } from "./scanner.js";

export type SessionDetailResult =
  | { status: "found"; data: SessionDetail }
  | { status: "unknown-agent" }
  | { status: "not-ready" };

export type SessionDetailResponseResult =
  | SessionDetailResult
  | {
      status: "found-json";
      data: Omit<SessionDetail, "messages">;
      messages: Iterable<string>;
      messageCount: number;
      sentMessageCount: number;
    };

export interface SessionDetailResponseOptions {
  messageCursor?: string;
}

interface SessionDetailLookup {
  agentsByName: Map<string, BaseAgent>;
  headsByReference: Map<string, SessionHead>;
}

interface SessionDetailContext {
  agent: BaseAgent;
  head: SessionHead | undefined;
}

const sessionDetailLookups = new WeakMap<SessionHead[], SessionDetailLookup>();
const MESSAGE_CURSOR_VERSION = 1;
const MAX_MESSAGE_CURSOR_LENGTH = 512;

interface MessageCursorPayload {
  version: typeof MESSAGE_CURSOR_VERSION;
  count: number;
  digest: string;
}

function parseMessageCursor(value: string | undefined): MessageCursorPayload | null {
  if (!value || value.length > MAX_MESSAGE_CURSOR_LENGTH) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<MessageCursorPayload>;
    if (
      payload.version !== MESSAGE_CURSOR_VERSION ||
      !Number.isSafeInteger(payload.count) ||
      payload.count == null ||
      payload.count < 0 ||
      typeof payload.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.digest)
    ) {
      return null;
    }
    return payload as MessageCursorPayload;
  } catch {
    return null;
  }
}

function encodeMessageCursor(count: number, digest: string): string {
  return Buffer.from(JSON.stringify({ version: MESSAGE_CURSOR_VERSION, count, digest })).toString(
    "base64url",
  );
}

function createMessageCursorHash(reference: SessionReference): Hash {
  return createHash("sha256")
    .update("codesesh-session-messages-v1\0")
    .update(JSON.stringify([reference.agentName, reference.sessionId]))
    .update("\n");
}

function updateMessageCursorField(hash: Hash, value: string | number | null | undefined) {
  if (value == null) {
    hash.update("n;");
    return;
  }
  const text = String(value);
  hash.update(`v${text.length}:`).update(text).update(";");
}

function updateMessageCursorHash(hash: Hash, row: CachedSessionRawEntry["messageRows"][number]) {
  updateMessageCursorField(hash, row.message_id);
  updateMessageCursorField(hash, row.role);
  updateMessageCursorField(hash, row.time_created);
  updateMessageCursorField(hash, row.time_completed);
  updateMessageCursorField(hash, row.agent);
  updateMessageCursorField(hash, row.mode);
  updateMessageCursorField(hash, row.model);
  updateMessageCursorField(hash, row.provider);
  updateMessageCursorField(hash, row.tokens_json);
  updateMessageCursorField(hash, row.cost);
  updateMessageCursorField(hash, row.cost_source);
  updateMessageCursorField(hash, row.parts_json);
  updateMessageCursorField(hash, row.parts_format_version);
  updateMessageCursorField(hash, row.subagent_id);
  updateMessageCursorField(hash, row.nickname);
  hash.update("\n");
}

function projectMessageStream(
  reference: SessionReference,
  rows: CachedSessionRawEntry["messageRows"],
  requestedCursor: string | undefined,
) {
  const requested = parseMessageCursor(requestedCursor);
  const hash = createMessageCursorHash(reference);
  let requestedDigest = requested?.count === 0 ? hash.copy().digest("hex") : null;

  for (let index = 0; index < rows.length; index += 1) {
    updateMessageCursorHash(hash, rows[index]!);
    if (requested?.count === index + 1) requestedDigest = hash.copy().digest("hex");
  }

  const digest = hash.digest("hex");
  const canAppend =
    requested !== null && requested.count <= rows.length && requestedDigest === requested.digest;
  return {
    cursor: encodeMessageCursor(rows.length, digest),
    startIndex: canAppend ? requested.count : 0,
    update: canAppend ? ("append" as const) : ("reset" as const),
  };
}

function sessionReferenceKey(agentName: string, sessionId: string): string {
  return `${agentName}\0${sessionId}`;
}

/**
 * The canonical sessions array is replaced atomically with each scan snapshot,
 * so its identity also versions this lazily built lookup.
 */
function getSessionDetailLookup(scanResult: LiveSnapshot): SessionDetailLookup {
  const cached = sessionDetailLookups.get(scanResult.sessions);
  if (cached) return cached;

  const agentsByName = new Map<string, BaseAgent>();
  for (const agent of scanResult.agents) {
    if (!agentsByName.has(agent.name)) agentsByName.set(agent.name, agent);
  }
  const headsByReference = new Map<string, SessionHead>();
  for (const [agentName, sessions] of Object.entries(scanResult.byAgent)) {
    for (const session of sessions) {
      const key = sessionReferenceKey(agentName, session.id);
      if (!headsByReference.has(key)) headsByReference.set(key, session);
    }
  }

  const lookup = { agentsByName, headsByReference };
  sessionDetailLookups.set(scanResult.sessions, lookup);
  return lookup;
}

function getSessionDetailContext(
  scanResult: LiveSnapshot,
  reference: SessionReference,
): SessionDetailContext | null {
  const lookup = getSessionDetailLookup(scanResult);
  const agent = lookup.agentsByName.get(reference.agentName);
  if (!agent) return null;
  return {
    agent,
    head: lookup.headsByReference.get(
      sessionReferenceKey(reference.agentName, reference.sessionId),
    ),
  };
}

type CachedDetailState = "fresh" | "stale" | "missing";

function cachedDetailState(
  cachedEntry: CachedSessionRawEntry | null,
  currentMeta: SessionCacheMeta | undefined,
): CachedDetailState {
  if (
    !cachedEntry ||
    (cachedEntry.messageRows.length === 0 && cachedEntry.data.stats.message_count > 0)
  ) {
    return "missing";
  }
  return !cachedEntry.pendingReindex &&
    cachedEntry.detailVersion === sessionDetailVersion(currentMeta)
    ? "fresh"
    : "stale";
}

function getProjectIdentity(
  data: Pick<SessionDetail, "directory" | "project_identity">,
  head: SessionHead | undefined,
) {
  return head?.project_identity ?? data.project_identity ?? computeIdentity(data.directory, realFs);
}

function getSmartTags(data: SessionDetail) {
  if (
    Array.isArray(data.smart_tags) &&
    data.smart_tags_classifier_revision === SMART_TAG_CLASSIFIER_REVISION
  ) {
    return data.smart_tags;
  }
  return classifySessionTags(data);
}

function materializeStructuredSessionDetail(
  context: SessionDetailContext,
  reference: SessionReference,
  cachedEntry = loadCachedSessionRawEntry(reference.agentName, reference.sessionId),
): SessionDetailResult {
  const { agent, head } = context;
  const currentMeta = head ? agent.getSessionMetaMap().get(reference.sessionId) : undefined;
  const cacheState = cachedDetailState(cachedEntry, currentMeta);
  let useCache = cacheState === "fresh";
  let freshness: SessionDetail["detail_freshness"] = useCache ? "fresh" : undefined;
  let data: SessionDetail | null = useCache
    ? {
        ...cachedEntry!.data,
        messages: cachedEntry!.messageRows.map((messageRow) => messageFromCachedRow(messageRow)),
      }
    : null;
  let sourceError: unknown;
  if (!data && head) {
    try {
      data = agent.getSessionData(reference.sessionId);
      if (data) freshness = "fresh";
    } catch (error) {
      sourceError = error;
    }
  }
  if (!data && cacheState === "stale" && cachedEntry) {
    useCache = true;
    freshness = "stale";
    data = {
      ...cachedEntry.data,
      messages: cachedEntry.messageRows.map((messageRow) => messageFromCachedRow(messageRow)),
    };
    getCoreDiagnostics()?.warn("session_detail.stale_fallback", {
      agent: reference.agentName,
      session_id: reference.sessionId,
      stored_version: cachedEntry.detailVersion,
      target_version: sessionDetailVersion(currentMeta),
      error: sourceError instanceof Error ? sourceError.message : undefined,
    });
  }
  if (sourceError && !data) throw sourceError;

  if (!data) {
    return { status: "not-ready" };
  }

  const projectIdentity = getProjectIdentity(data, head);
  const fileActivity =
    data.file_activity ??
    (useCache
      ? listSessionFileActivity(reference.agentName, reference.sessionId)
      : extractSessionFileActivity(
          reference.agentName,
          reference.sessionId,
          projectIdentity.key,
          data.messages,
        ));

  return {
    status: "found",
    data: {
      ...data,
      reference,
      detail_freshness: freshness,
      project_identity: projectIdentity,
      project_identity_resolver_revision:
        head?.project_identity_resolver_revision ?? data.project_identity_resolver_revision,
      project_identity_input_signature:
        head?.project_identity_input_signature ?? data.project_identity_input_signature,
      smart_tags: getSmartTags(data),
      smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
      file_activity: fileActivity,
    },
  };
}

function* serializeCachedMessages(
  entry: CachedSessionRawEntry,
  startIndex = 0,
): IterableIterator<string> {
  for (let index = startIndex; index < entry.messageRows.length; index += 1) {
    yield messageJsonFromCachedRow(entry.messageRows[index]!);
  }
}

export function materializeSessionDetail(
  scanResult: LiveSnapshot,
  reference: SessionReference,
): SessionDetailResult {
  const context = getSessionDetailContext(scanResult, reference);
  if (!context) return { status: "unknown-agent" };
  return materializeStructuredSessionDetail(context, reference);
}

export function materializeSessionDetailResponse(
  scanResult: LiveSnapshot,
  reference: SessionReference,
  options: SessionDetailResponseOptions = {},
): SessionDetailResponseResult {
  const context = getSessionDetailContext(scanResult, reference);
  if (!context) return { status: "unknown-agent" };

  const cachedEntry = loadCachedSessionRawEntry(reference.agentName, reference.sessionId);
  const currentMeta = context.head
    ? context.agent.getSessionMetaMap().get(reference.sessionId)
    : undefined;
  const cacheState = cachedDetailState(cachedEntry, currentMeta);
  if (
    !cachedEntry ||
    cacheState !== "fresh" ||
    cachedEntry.data.smart_tags == null ||
    cachedEntry.data.smart_tags_classifier_revision !== SMART_TAG_CLASSIFIER_REVISION
  ) {
    const result = materializeStructuredSessionDetail(context, reference, cachedEntry);
    return result.status === "found"
      ? { ...result, data: { ...result.data, message_update: "reset" } }
      : result;
  }

  const data = cachedEntry.data;
  const stream = projectMessageStream(reference, cachedEntry.messageRows, options.messageCursor);
  return {
    status: "found-json",
    data: {
      ...data,
      reference,
      detail_freshness: "fresh",
      message_cursor: stream.cursor,
      message_update: stream.update,
      project_identity: getProjectIdentity(data, context.head),
      smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
      file_activity:
        data.file_activity ?? listSessionFileActivity(reference.agentName, reference.sessionId),
    },
    messages: serializeCachedMessages(cachedEntry, stream.startIndex),
    messageCount: cachedEntry.messageRows.length,
    sentMessageCount: cachedEntry.messageRows.length - stream.startIndex,
  };
}
