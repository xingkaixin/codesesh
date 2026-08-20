import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import { assertSessionIdentity, type SessionReference } from "../contract/index.js";
import type {
  IdentifiedSessionDetail,
  IdentifiedSessionHead,
  ProjectIdentity,
  SessionDetail,
} from "../types/index.js";
import {
  classifySessionTags,
  extractSessionFileActivity,
  getSmartTagSourceTimestamp,
  SMART_TAG_CLASSIFIER_REVISION,
} from "../utils/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { listSessionFileActivity } from "./cache/file-activity.js";
import { sessionDetailVersion } from "./cache/detail-version.js";
import {
  loadCachedSessionRawEntry,
  readCachedSessionCursor,
  type CachedSessionCursorEntry,
  type CachedSessionCursorReader,
  type CachedSessionRawEntry,
} from "./cache/sessions.js";
import {
  messageCursorContentFromCachedRow,
  messageFromCachedRow,
  messageJsonFromCachedRow,
  type CachedMessageRow,
} from "./cache/messages.js";
import {
  computeMessageCursorDigest,
  initialMessageCursorDigest,
  MESSAGE_CURSOR_VERSION,
} from "./cache/message-cursor.js";
import type { LiveSnapshot } from "./scanner.js";

export type SessionDetailResult =
  | { status: "found"; data: IdentifiedSessionDetail }
  | { status: "unknown-agent" }
  | { status: "not-ready" };

export type SessionDetailResponseResult =
  | SessionDetailResult
  | {
      status: "found-json";
      data: Omit<IdentifiedSessionDetail, "messages">;
      messages: Iterable<string>;
      messageCount: number;
      sentMessageCount: number;
    };

export interface SessionDetailResponseOptions {
  messageCursor?: string;
}

interface SessionDetailLookup {
  agentsByName: Map<string, BaseAgent>;
  headsByReference: Map<string, IdentifiedSessionHead>;
}

interface SessionDetailContext {
  agent: BaseAgent;
  head: IdentifiedSessionHead | undefined;
}

const sessionDetailLookups = new WeakMap<IdentifiedSessionHead[], SessionDetailLookup>();
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

interface CachedMessageStream {
  cursor: string;
  update: "append" | "reset";
  messageRows: CachedMessageRow[];
  messageCount: number;
}

function loadCachedMessageStream(
  reference: SessionReference,
  entry: CachedSessionCursorEntry,
  cursor: CachedSessionCursorReader,
  requestedCursor: string | undefined,
): CachedMessageStream {
  const requested = parseMessageCursor(requestedCursor);
  const initialDigest = initialMessageCursorDigest(reference);
  const hasStoredChain = entry.messageCount === 0 || entry.messageDigest !== null;
  const canCheckAppend =
    hasStoredChain && requested !== null && requested.count <= entry.messageCount;
  const requestedDigest =
    canCheckAppend && requested
      ? requested.count === 0
        ? initialDigest
        : cursor.messageDigest(requested.count)
      : null;
  const canAppend = canCheckAppend && requested !== null && requestedDigest === requested.digest;
  let startIndex = canAppend ? requested.count : 0;
  let update: CachedMessageStream["update"] = canAppend ? "append" : "reset";
  let messageRows = entry.messageCount === 0 ? [] : cursor.messageRows(startIndex);

  let messageCount = entry.messageCount;
  let digest = entry.messageCount === 0 ? initialDigest : entry.messageDigest;
  if (messageRows.length !== entry.messageCount - startIndex) {
    startIndex = 0;
    update = "reset";
    messageRows = cursor.messageRows(startIndex);
    messageCount = messageRows.length;
    digest = null;
  }

  if (!digest) {
    digest = computeMessageCursorDigest(
      reference,
      messageRows.map((row) => messageCursorContentFromCachedRow(row)),
    );
  }
  return {
    cursor: encodeMessageCursor(messageCount, digest),
    update,
    messageRows,
    messageCount,
  };
}

function sessionReferenceKey(agentName: string, sessionId: string): string {
  return `${agentName}\0${sessionId}`;
}

function assertSessionMatchesReference(
  session: IdentifiedSessionHead | SessionDetail,
  reference: SessionReference,
): void {
  assertSessionIdentity(session, reference.agentName);
  if (session.reference.sessionId !== reference.sessionId) {
    throw new Error("Session identity fields disagree");
  }
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
  const headsByReference = new Map<string, IdentifiedSessionHead>();
  for (const sessions of Object.values(scanResult.byAgent)) {
    for (const session of sessions) {
      const key = sessionReferenceKey(session.reference.agentName, session.reference.sessionId);
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
type CachedSessionDetailEntry = Pick<
  CachedSessionRawEntry,
  "data" | "detailVersion" | "pendingReindex"
>;

function cachedDetailState(
  cachedEntry: CachedSessionDetailEntry | null,
  currentMeta: SessionCacheMeta | undefined,
  messageCount: number,
): CachedDetailState {
  if (!cachedEntry || (messageCount === 0 && cachedEntry.data.stats.message_count > 0)) {
    return "missing";
  }
  return !cachedEntry.pendingReindex &&
    cachedEntry.detailVersion === sessionDetailVersion(currentMeta)
    ? "fresh"
    : "stale";
}

function getProjectIdentity(
  data: Pick<SessionDetail, "reference" | "project_identity">,
  head: IdentifiedSessionHead | undefined,
): ProjectIdentity {
  const identity = head?.project_identity ?? data.project_identity;
  if (identity) return identity;
  throw new Error(
    `Session ${data.reference.agentName}/${data.reference.sessionId} reached detail materialization without project_identity`,
  );
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
  const currentMeta = head ? agent.getSessionCacheMeta(reference.sessionId) : undefined;
  const cacheState = cachedDetailState(
    cachedEntry,
    currentMeta,
    cachedEntry?.messageRows.length ?? 0,
  );
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
  assertSessionMatchesReference(data, reference);

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

function* serializeCachedMessages(messageRows: CachedMessageRow[]): IterableIterator<string> {
  for (const messageRow of messageRows) {
    yield messageJsonFromCachedRow(messageRow);
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

  const currentMeta = context.head
    ? context.agent.getSessionCacheMeta(reference.sessionId)
    : undefined;
  const startedAt = performance.now();
  const cursorRead = readCachedSessionCursor(
    reference.agentName,
    reference.sessionId,
    (entry, cursor) => {
      const cacheState = cachedDetailState(entry, currentMeta, entry.messageCount);
      const stream =
        cacheState === "fresh" &&
        entry.data.smart_tags != null &&
        entry.data.smart_tags_classifier_revision === SMART_TAG_CLASSIFIER_REVISION
          ? loadCachedMessageStream(reference, entry, cursor, options.messageCursor)
          : null;
      return { entry, cacheState, stream };
    },
  );
  const cachedEntry = cursorRead?.entry ?? null;
  const cacheState = cursorRead?.cacheState ?? "missing";
  if (
    !cachedEntry ||
    cacheState !== "fresh" ||
    cachedEntry.data.smart_tags == null ||
    cachedEntry.data.smart_tags_classifier_revision !== SMART_TAG_CLASSIFIER_REVISION
  ) {
    const result = materializeStructuredSessionDetail(context, reference, undefined);
    return result.status === "found"
      ? { ...result, data: { ...result.data, message_update: "reset" } }
      : result;
  }

  const data = cachedEntry.data;
  assertSessionMatchesReference(data, reference);
  const projectIdentity = getProjectIdentity(data, context.head);
  const stream = cursorRead?.stream;
  if (!stream) {
    const result = materializeStructuredSessionDetail(context, reference, undefined);
    return result.status === "found"
      ? { ...result, data: { ...result.data, message_update: "reset" } }
      : result;
  }
  const partsJsonBytes = stream.messageRows.reduce(
    (total, row) => total + Buffer.byteLength(String(row.parts_json)),
    0,
  );
  getCoreDiagnostics()?.info?.("session_detail.cursor_stream", {
    update: stream.update,
    message_count: stream.messageCount,
    sent_message_count: stream.messageRows.length,
    parts_json_bytes: partsJsonBytes,
    duration_ms: Math.round(performance.now() - startedAt),
  });
  return {
    status: "found-json",
    data: {
      ...data,
      detail_freshness: "fresh",
      message_cursor: stream.cursor,
      message_update: stream.update,
      project_identity: projectIdentity,
      smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
      file_activity:
        data.file_activity ?? listSessionFileActivity(reference.agentName, reference.sessionId),
    },
    messages: serializeCachedMessages(stream.messageRows),
    messageCount: stream.messageCount,
    sentMessageCount: stream.messageRows.length,
  };
}
