/**
 * Structured message storage: row ↔ domain mapping, prepared-statement
 * binders, and message-text builders shared by sessions/search/file-activity.
 */
import type { SessionCacheMeta } from "../../agents/base.js";
import type {
  Message,
  MessagePart,
  ProjectIdentity,
  ProjectIdentityKind,
  SessionData,
  SessionFileActivity,
  SessionHead,
} from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import type { SQLiteStatement } from "./db.js";

export interface SessionRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  sort_index?: number;
  slug?: string;
  title?: string;
  source_path?: string | null;
  directory?: string;
  project_identity_kind?: ProjectIdentityKind;
  project_identity_key?: string;
  project_display_name?: string;
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

export function stringifyOptionalJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

export function parseOptionalJson<T>(value: unknown): T | undefined {
  return value == null ? undefined : (JSON.parse(String(value)) as T);
}

export function sourcePathFromMeta(meta: SessionCacheMeta | undefined): string | null {
  return typeof meta?.sourcePath === "string" ? meta.sourcePath : null;
}

export function sourcePathFromMetaJson(metaJson: string | null | undefined): string | null {
  if (!metaJson) return null;
  const meta = JSON.parse(metaJson) as SessionCacheMeta;
  return sourcePathFromMeta(meta);
}

export function prepareUpsertCachedSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO cached_sessions(agent_name, session_id, session_json, meta_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      session_json = excluded.session_json,
      meta_json = excluded.meta_json
  `);
}

export function prepareUpsertProjectSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO project_sessions(
      agent_name,
      session_id,
      identity_kind,
      identity_key,
      display_name,
      directory,
      activity_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      identity_kind = excluded.identity_kind,
      identity_key = excluded.identity_key,
      display_name = excluded.display_name,
      directory = excluded.directory,
      activity_time = excluded.activity_time
  `);
}

export function prepareUpsertSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO sessions(
      agent_name,
      session_id,
      sort_index,
      slug,
      title,
      source_path,
      directory,
      project_identity_kind,
      project_identity_key,
      project_display_name,
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
      meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      sort_index = excluded.sort_index,
      slug = excluded.slug,
      title = excluded.title,
      source_path = excluded.source_path,
      directory = excluded.directory,
      project_identity_kind = excluded.project_identity_kind,
      project_identity_key = excluded.project_identity_key,
      project_display_name = excluded.project_display_name,
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
      meta_json = excluded.meta_json
  `);
}

export function prepareUpsertIndexedSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO sessions(
      agent_name,
      session_id,
      sort_index,
      slug,
      title,
      source_path,
      directory,
      project_identity_kind,
      project_identity_key,
      project_display_name,
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
      meta_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      slug = excluded.slug,
      title = excluded.title,
      directory = excluded.directory,
      project_identity_kind = excluded.project_identity_kind,
      project_identity_key = excluded.project_identity_key,
      project_display_name = excluded.project_display_name,
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
      smart_tags_source_updated_at = excluded.smart_tags_source_updated_at
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
  const identity = session.project_identity ?? computeIdentity(session.directory, realFs);
  const activityTime = session.time_updated ?? session.time_created;
  statement.run(
    agentName,
    session.id,
    sortIndex,
    session.slug,
    session.title,
    sourcePath,
    session.directory,
    identity.kind,
    identity.key,
    identity.displayName,
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
    metaJson,
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
      activity.agent_name,
      activity.session_id,
      activity.project_identity_key,
      activity.path,
      activity.kind,
      activity.count,
      activity.latest_time,
    );
  }
}

export function writeProjectSessionRow(
  statement: SQLiteStatement,
  agentName: string,
  session: SessionHead,
  identity: ProjectIdentity,
): void {
  statement.run(
    agentName,
    session.id,
    identity.kind,
    identity.key,
    identity.displayName,
    session.directory,
    session.time_updated ?? session.time_created,
  );
}

export function sessionFromRow(row: SessionRow): SessionHead {
  const session: SessionHead = {
    id: String(row.session_id),
    slug: String(row.slug),
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

  return session;
}

export function messageFromBackfillRow(row: MessageBackfillRow): Message {
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
    parts: JSON.parse(String(row.parts_json ?? "[]")) as MessagePart[],
    subagent_id: row.subagent_id ?? undefined,
    nickname: row.nickname ?? undefined,
  };
}

export function messageFromCachedRow(row: CachedMessageRow): Message {
  const message = messageFromBackfillRow(row);
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

export function summarizeToolPart(part: MessagePart): Record<string, unknown> {
  const state =
    part.state == null
      ? undefined
      : compactRecord({
          status: part.state.status,
          error: part.state.error,
          metadata: part.state.metadata,
        });

  return compactRecord({
    type: part.type,
    tool: part.tool,
    title: part.title,
    nickname: part.nickname,
    callID: part.callID,
    approval_status: part.approval_status,
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
    appendPlainText(part.title, chunks);
    appendPlainText(part.nickname, chunks);
    appendPlainText(part.tool, chunks);
    appendPlainText(part.text, chunks);
    appendPlainText(part.input, chunks);
    appendPlainText(part.output, chunks);
    appendPlainText(part.state, chunks);
  }

  return chunks.join("\n");
}

export function normalizeMessages(session: SessionData): StructuredMessageRecord[] {
  return session.messages.map((message, index) => {
    const toolMetadata = message.parts
      .filter((part) => part.type === "tool")
      .map((part) => summarizeToolPart(part));

    return {
      index,
      id: message.id || `${session.id}:${index}`,
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
