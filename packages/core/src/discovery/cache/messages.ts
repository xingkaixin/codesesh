/**
 * Structured message storage: row ↔ domain mapping, prepared-statement
 * binders, and message-text builders shared by sessions/search/file-activity.
 */
import type { SessionCacheMeta } from "../../agents/session-source-types.js";
import { assertIdentifiedSessionHead } from "../../contract/session.js";
import type {
  IdentifiedSessionHead,
  Message,
  MessagePart,
  ProjectIdentity,
  ProjectIdentityKind,
  SessionDetail,
  SessionFileActivity,
  SessionHead,
  ToolPart,
} from "../../types/index.js";
import { normalizeMessageParts } from "../../contract/message-part.js";
import { assertSessionIdentity, createSessionIdentity } from "../../contract/session-reference.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import type { SQLiteStatement } from "./db.js";
import { CacheDataIntegrityError } from "./errors.js";
import type { MessageCursorContent } from "./message-cursor.js";

export const MESSAGE_PARTS_FORMAT_VERSION = 1;

export interface SessionRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  sort_index?: number;
  title?: string;
  source_path?: string | null;
  directory?: string;
  parent_agent_name?: string | null;
  parent_session_id?: string | null;
  project_identity_kind?: ProjectIdentityKind;
  project_identity_key?: string;
  project_display_name?: string;
  project_identity_resolver_revision?: string | null;
  project_identity_input_signature?: string | null;
  time_created?: number;
  time_updated?: number | null;
  activity_time?: number;
  message_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number | null;
  total_cache_create_tokens?: number | null;
  total_cost?: number;
  cost_source?: SessionHead["stats"]["cost_source"] | null;
  total_tokens?: number | null;
  model_usage_json?: string | null;
  smart_tags_json?: string | null;
  smart_tags_source_updated_at?: number | null;
  smart_tags_classifier_revision?: string | null;
  meta_json?: string | null;
}

export interface MessageBackfillRow extends DatabaseRow {
  message_id?: string;
  role?: Message["role"];
  time_created?: number;
  time_completed?: number | null;
  agent?: string | null;
  mode?: string | null;
  model?: string | null;
  provider?: string | null;
  parts_json?: string;
  subagent_id?: string | null;
  nickname?: string | null;
}

export interface CachedMessageRow extends MessageBackfillRow {
  parts_format_version?: number | string;
  content_chain_digest?: string | null;
  tokens_json?: string | null;
  cost?: number | null;
  cost_source?: SessionHead["stats"]["cost_source"] | null;
}

export interface StructuredMessageRecord {
  index: number;
  id: string;
  role: Message["role"];
  timeCreated: number;
  timeCompleted?: number | null;
  agent?: string | null;
  mode?: string | null;
  model?: string | null;
  provider?: string | null;
  tokensJson?: string | null;
  cost?: number | null;
  costSource?: string | null;
  partsJson: string;
  subagentId?: string | null;
  nickname?: string | null;
  contentText: string;
  toolMetadataJson?: string | null;
  toolNames: string[];
}

export function messageCursorContentFromCachedRow(row: CachedMessageRow): MessageCursorContent {
  return {
    messageId: String(row.message_id),
    role: String(row.role),
    timeCreated: Number(row.time_created),
    timeCompleted: row.time_completed,
    agent: row.agent,
    mode: row.mode,
    model: row.model,
    provider: row.provider,
    tokensJson: row.tokens_json,
    cost: row.cost,
    costSource: row.cost_source,
    partsJson: String(row.parts_json),
    partsFormatVersion: row.parts_format_version,
    subagentId: row.subagent_id,
    nickname: row.nickname,
  };
}

export function messageCursorContentFromStructuredRecord(
  record: StructuredMessageRecord,
): MessageCursorContent {
  return {
    messageId: record.id,
    role: record.role,
    timeCreated: record.timeCreated,
    timeCompleted: record.timeCompleted,
    agent: record.agent,
    mode: record.mode,
    model: record.model,
    provider: record.provider,
    tokensJson: record.tokensJson,
    cost: record.cost,
    costSource: record.costSource,
    partsJson: record.partsJson,
    partsFormatVersion: MESSAGE_PARTS_FORMAT_VERSION,
    subagentId: record.subagentId,
    nickname: record.nickname,
  };
}

export function stringifyOptionalJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

export function parseOptionalJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  try {
    return JSON.parse(String(value)) as T;
  } catch (error) {
    throw new CacheDataIntegrityError("Cached JSON field is malformed", { cause: error });
  }
}

export function sourcePathFromMeta(meta: SessionCacheMeta | undefined): string | null {
  return typeof meta?.sourcePath === "string" ? meta.sourcePath : null;
}

export function sourcePathFromMetaJson(metaJson: string | null | undefined): string | null {
  if (!metaJson) return null;
  try {
    const meta = JSON.parse(metaJson) as SessionCacheMeta;
    return sourcePathFromMeta(meta);
  } catch (error) {
    throw new CacheDataIntegrityError("Cached session metadata is malformed", { cause: error });
  }
}

export function requireSessionProjectIdentity(
  agentName: string,
  session: SessionHead,
): ProjectIdentity {
  assertSessionIdentity(session, agentName);
  assertIdentifiedSessionHead(session);
  return session.project_identity;
}

export function assertSessionProjectIdentities(
  agentName: string,
  sessions: Iterable<SessionHead>,
): void {
  for (const session of sessions) requireSessionProjectIdentity(agentName, session);
}

export function prepareUpsertSession(
  db: SQLiteDatabase,
  mode: "cache" | "materialization" = "cache",
): SQLiteStatement {
  const cacheAssignments =
    mode === "cache"
      ? `sort_index = excluded.sort_index,
      source_path = CASE
        WHEN excluded.meta_json IS NULL THEN sessions.source_path
        ELSE excluded.source_path
      END,
      meta_json = COALESCE(excluded.meta_json, sessions.meta_json),`
      : "";
  return db.prepare(`
    INSERT INTO sessions(
      agent_name,
      session_id,
      sort_index,
      title,
      source_path,
      directory,
      parent_agent_name,
      parent_session_id,
      project_identity_kind,
      project_identity_key,
      project_display_name,
      project_identity_resolver_revision,
      project_identity_input_signature,
      time_created,
      time_updated,
      activity_time,
      message_count,
      total_input_tokens,
      total_output_tokens,
      total_cache_read_tokens,
      total_cache_create_tokens,
      total_cost,
      cost_source,
      total_tokens,
      model_usage_json,
      smart_tags_json,
      smart_tags_source_updated_at,
      smart_tags_classifier_revision,
      meta_json,
      publication_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      ${cacheAssignments}
      title = excluded.title,
      directory = excluded.directory,
      parent_agent_name = excluded.parent_agent_name,
      parent_session_id = excluded.parent_session_id,
      project_identity_kind = excluded.project_identity_kind,
      project_identity_key = excluded.project_identity_key,
      project_display_name = excluded.project_display_name,
      project_identity_resolver_revision = excluded.project_identity_resolver_revision,
      project_identity_input_signature = excluded.project_identity_input_signature,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated,
      activity_time = excluded.activity_time,
      message_count = excluded.message_count,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cache_create_tokens = excluded.total_cache_create_tokens,
      total_cost = excluded.total_cost,
      cost_source = excluded.cost_source,
      total_tokens = excluded.total_tokens,
      model_usage_json = excluded.model_usage_json,
      smart_tags_json = excluded.smart_tags_json,
      smart_tags_source_updated_at = excluded.smart_tags_source_updated_at,
      smart_tags_classifier_revision = excluded.smart_tags_classifier_revision,
      publication_id = excluded.publication_id
  `);
}

export function upsertSessionRow(
  statement: SQLiteStatement,
  agentName: string,
  session: SessionHead,
  metaJson: string | null,
  sortIndex: number,
  sourcePath: string | null,
): void {
  const identity = requireSessionProjectIdentity(agentName, session);
  const activityTime = session.time_updated ?? session.time_created;
  statement.run(
    session.reference.agentName,
    session.reference.sessionId,
    sortIndex,
    session.title,
    sourcePath,
    session.directory,
    session.parent_reference?.agentName ?? null,
    session.parent_reference?.sessionId ?? null,
    identity.kind,
    identity.key,
    identity.displayName,
    session.project_identity_resolver_revision ?? null,
    session.project_identity_input_signature ?? null,
    session.time_created,
    session.time_updated ?? null,
    activityTime,
    session.stats.message_count,
    session.stats.total_input_tokens,
    session.stats.total_output_tokens,
    session.stats.total_cache_read_tokens ?? null,
    session.stats.total_cache_create_tokens ?? null,
    session.stats.total_cost,
    session.stats.cost_source ?? null,
    session.stats.total_tokens ?? null,
    stringifyOptionalJson(session.model_usage),
    stringifyOptionalJson(session.smart_tags),
    session.smart_tags_source_updated_at ?? null,
    session.smart_tags_classifier_revision ?? null,
    metaJson,
    null,
  );
}

export function prepareInsertFileActivity(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO session_file_activity(
      agent_name,
      session_id,
      project_identity_key,
      path,
      kind,
      count,
      latest_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
}

export function prepareInsertMessageTool(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT OR IGNORE INTO message_tools(
      agent_name,
      session_id,
      message_index,
      tool_name
    ) VALUES (?, ?, ?, ?)
  `);
}

export function writeFileActivityRows(
  statement: SQLiteStatement,
  activities: SessionFileActivity[],
): void {
  for (const activity of activities) {
    statement.run(
      activity.reference.agentName,
      activity.reference.sessionId,
      activity.projectIdentityKey,
      activity.path,
      activity.kind,
      activity.count,
      activity.latestTime,
    );
  }
}

export function sessionFromRow(row: SessionRow): IdentifiedSessionHead {
  const session: SessionHead = {
    ...createSessionIdentity({
      agentName: String(row.agent_name),
      sessionId: String(row.session_id),
    }),
    title: String(row.title),
    directory: String(row.directory),
    time_created: Number(row.time_created),
    stats: {
      message_count: Number(row.message_count ?? 0),
      total_input_tokens: Number(row.total_input_tokens ?? 0),
      total_output_tokens: Number(row.total_output_tokens ?? 0),
      total_cost: Number(row.total_cost ?? 0),
    },
  };

  if (row.project_identity_key) {
    session.project_identity = {
      kind: row.project_identity_kind ?? "path",
      key: String(row.project_identity_key),
      displayName: String(row.project_display_name ?? ""),
    };
  }
  if (row.project_identity_resolver_revision) {
    session.project_identity_resolver_revision = String(row.project_identity_resolver_revision);
  }
  if (row.project_identity_input_signature) {
    session.project_identity_input_signature = String(row.project_identity_input_signature);
  }
  if (row.parent_agent_name && row.parent_session_id) {
    session.parent_reference = {
      agentName: String(row.parent_agent_name),
      sessionId: String(row.parent_session_id),
    };
  }
  if (row.time_updated != null) {
    session.time_updated = Number(row.time_updated);
  }
  if (row.total_cache_read_tokens != null) {
    session.stats.total_cache_read_tokens = Number(row.total_cache_read_tokens);
  }
  if (row.total_cache_create_tokens != null) {
    session.stats.total_cache_create_tokens = Number(row.total_cache_create_tokens);
  }
  if (row.cost_source) {
    session.stats.cost_source = row.cost_source;
  }
  if (row.total_tokens != null) {
    session.stats.total_tokens = Number(row.total_tokens);
  }

  const modelUsage = parseOptionalJson<Record<string, number>>(row.model_usage_json);
  if (modelUsage) {
    session.model_usage = modelUsage;
  }

  const smartTags = parseOptionalJson<SessionHead["smart_tags"]>(row.smart_tags_json);
  if (smartTags) {
    session.smart_tags = smartTags;
  }
  if (row.smart_tags_source_updated_at != null) {
    session.smart_tags_source_updated_at = Number(row.smart_tags_source_updated_at);
  }
  if (row.smart_tags_classifier_revision) {
    session.smart_tags_classifier_revision = String(row.smart_tags_classifier_revision);
  }

  try {
    assertIdentifiedSessionHead(session);
  } catch (error) {
    throw new CacheDataIntegrityError("Cached session identity is incomplete", { cause: error });
  }
  return session;
}

function messageMetadataFromBackfillRow(row: MessageBackfillRow): Omit<Message, "parts"> {
  const role = row.role === "assistant" || row.role === "tool" ? row.role : "user";
  return {
    id: String(row.message_id ?? ""),
    role,
    agent: row.agent ?? null,
    time_created: Number(row.time_created ?? 0),
    time_completed: row.time_completed == null ? null : Number(row.time_completed),
    mode: row.mode ?? null,
    model: row.model ?? null,
    provider: row.provider ?? null,
    subagent_id: row.subagent_id ?? undefined,
    nickname: row.nickname ?? undefined,
  };
}

function messageMetadataFromCachedRow(row: CachedMessageRow): Omit<Message, "parts"> {
  const message = messageMetadataFromBackfillRow(row);
  const tokens = parseOptionalJson<Message["tokens"]>(row.tokens_json);
  if (tokens) {
    message.tokens = tokens;
  }
  if (row.cost != null) {
    message.cost = Number(row.cost);
  }
  if (row.cost_source) {
    message.cost_source = row.cost_source;
  }
  return message;
}

export function messageFromBackfillRow(row: MessageBackfillRow): Message {
  return {
    ...messageMetadataFromBackfillRow(row),
    parts: messagePartsFromJson(row.parts_json),
  };
}

export function messageFromCachedRow(row: CachedMessageRow): Message {
  return {
    ...messageMetadataFromCachedRow(row),
    parts: messagePartsFromJson(row.parts_json),
  };
}

function messagePartsFromJson(value: unknown): MessagePart[] {
  try {
    return normalizeMessageParts(JSON.parse(String(value ?? "[]")));
  } catch {
    return [];
  }
}

export function normalizeMessagePartsJson(value: unknown): string {
  return JSON.stringify(messagePartsFromJson(value));
}

export function messageJsonFromCachedRow(row: CachedMessageRow): string {
  const metadataJson = JSON.stringify(messageMetadataFromBackfillRow(row));
  const fields: string[] = [];
  if (row.tokens_json != null) {
    fields.push(`"tokens":${String(row.tokens_json)}`);
  }
  if (row.cost != null) {
    fields.push(`"cost":${JSON.stringify(Number(row.cost))}`);
  }
  if (row.cost_source) {
    fields.push(`"cost_source":${JSON.stringify(row.cost_source)}`);
  }
  const partsJson =
    Number(row.parts_format_version) >= MESSAGE_PARTS_FORMAT_VERSION
      ? String(row.parts_json ?? "[]")
      : normalizeMessagePartsJson(row.parts_json);
  fields.push(`"parts":${partsJson}`);
  return `${metadataJson.slice(0, -1)},${fields.join(",")}}`;
}

export function appendPlainText(value: unknown, chunks: string[]): void {
  if (value == null) return;

  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized) {
      chunks.push(normalized);
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    chunks.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendPlainText(item, chunks);
    }
    return;
  }

  if (typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      appendPlainText(nested, chunks);
    }
  }
}

export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value != null));
}

export function normalizeToolName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return name || null;
}

export function toolNamesFromMetadataJson(value: unknown): string[] {
  if (!value) return [];

  try {
    const metadata = JSON.parse(String(value));
    if (!Array.isArray(metadata)) return [];
    const tools = new Set<string>();
    for (const item of metadata) {
      if (item == null || typeof item !== "object") continue;
      const toolName = normalizeToolName((item as Record<string, unknown>).tool);
      if (toolName) tools.add(toolName);
    }
    return [...tools];
  } catch {
    return [];
  }
}

export function toolNamesFromMessage(message: Message): string[] {
  const tools = new Set<string>();
  for (const part of message.parts) {
    if (part.type !== "tool") continue;
    const toolName = normalizeToolName(part.tool);
    if (toolName) tools.add(toolName);
  }
  return [...tools];
}

export function summarizeToolPart(part: ToolPart): Record<string, unknown> {
  const state = compactRecord({
    status: part.state.status,
    error: part.state.error,
    metadata: part.state.metadata,
  });
  return compactRecord({
    type: part.type,
    tool: part.tool,
    title: part.title,
    callID: part.callID,
    state,
  });
}

export function buildMessageText(message: Message): string {
  const chunks: string[] = [];

  chunks.push(message.role);
  appendPlainText(message.agent, chunks);
  appendPlainText(message.model, chunks);

  for (const part of message.parts) {
    appendPlainText(part.type, chunks);
    if (part.type === "text" || part.type === "reasoning" || part.type === "plan") {
      appendPlainText(part.text, chunks);
    } else if (part.type === "tool") {
      appendPlainText(part.title, chunks);
      appendPlainText(part.tool, chunks);
      appendPlainText(part.state, chunks);
    }
  }

  return chunks.join("\n");
}

export function normalizeMessages(session: SessionDetail): StructuredMessageRecord[] {
  return session.messages.map((message, index) => {
    const toolMetadata = message.parts
      .filter((part): part is ToolPart => part.type === "tool")
      .map((part) => summarizeToolPart(part));

    return {
      index,
      id: message.id || `${session.reference.sessionId}:${index}`,
      role: message.role,
      timeCreated: message.time_created,
      timeCompleted: message.time_completed ?? null,
      agent: message.agent ?? null,
      mode: message.mode ?? null,
      model: message.model ?? null,
      provider: message.provider ?? null,
      tokensJson: stringifyOptionalJson(message.tokens),
      cost: message.cost ?? null,
      costSource: message.cost_source ?? null,
      partsJson: JSON.stringify(message.parts),
      subagentId: message.subagent_id ?? null,
      nickname: message.nickname ?? null,
      contentText: buildMessageText(message),
      toolMetadataJson: toolMetadata.length > 0 ? JSON.stringify(toolMetadata) : null,
      toolNames: toolNamesFromMessage(message),
    };
  });
}

export function buildSessionContentFromMessages(
  title: string | null | undefined,
  messages: StructuredMessageRecord[],
): string {
  const chunks: string[] = [];
  appendPlainText(title, chunks);
  for (const message of messages) {
    appendPlainText(message.contentText, chunks);
  }
  return chunks.join("\n");
}
