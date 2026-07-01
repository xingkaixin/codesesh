/**
 * Full-text search: query parsing, FTS index sync, session/message search,
 * and match highlighting / snippet building.
 */
import type {
  FileActivityKind,
  Message,
  ProjectIdentity,
  ProjectIdentityKind,
  SessionData,
  SessionFileActivity,
  SessionHead,
  SmartTag,
} from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import {
  escapeRegExp,
  filePathFtsQuery,
  hasCacheStorage,
  likePattern,
  SEARCH_INDEX_BULK_SYNC_THRESHOLD,
  type SessionHeadChange,
} from "./db.js";
import {
  buildSessionContentFromMessages,
  normalizeMessages,
  normalizeToolName,
  prepareInsertFileActivity,
  prepareInsertMessageTool,
  prepareUpsertIndexedSession,
  sessionFromRow,
  upsertSessionRow,
  writeFileActivityRows,
  type SessionRow,
  type StructuredMessageRecord,
} from "./messages.js";
import {
  createMessageSearchTriggers,
  createSearchTriggers,
  dropMessageSearchTriggers,
  dropSearchTriggers,
  ensureFtsConsistency,
  ensureFtsReady,
  rebuildMessageSearchIndex,
  rebuildSearchIndex,
  withCacheDb,
  type IndexedSearchRow,
  type MessageCountRow,
} from "./schema.js";

export interface SearchIndexSyncOptions {
  isBulk?: boolean;
  bulkThreshold?: number;
}

export interface SearchIndexSyncResult {
  agentName: string;
  mode: "bulk" | "incremental";
  sessions: number;
  changed: number;
  deleted: number;
  indexed: number;
  skipped: number;
  durationMs: number;
  rebuildDurationMs?: number;
}

interface MessageSearchRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  message_index?: number;
  role?: Message["role"];
  mode?: string | null;
  content_text?: string;
  tool_metadata_json?: string | null;
}

export interface SearchResultRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  slug?: string;
  title?: string;
  directory?: string;
  project_identity_kind?: ProjectIdentityKind;
  project_identity_key?: string;
  project_display_name?: string;
  time_created?: number;
  time_updated?: number | null;
  message_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number | null;
  total_cache_create_tokens?: number | null;
  total_cost?: number;
  cost_source?: string | null;
  total_tokens?: number | null;
  model_usage_json?: string | null;
  smart_tags_json?: string | null;
  smart_tags_source_updated_at?: number | null;
  snippet?: string | null;
}

interface LoadedSearchIndexEntry {
  session: SessionHead;
  identity: ProjectIdentity;
  messages: StructuredMessageRecord[];
  contentText: string;
  contentHash: string;
  fileActivity: SessionFileActivity[];
  sortIndex: number;
}

export interface SearchResult {
  agentName: string;
  session: SessionHead;
  snippet: string;
  matchType: SearchMatchType;
}

export type SearchMatchType =
  | "recent"
  | "title"
  | "user_message"
  | "assistant_reply"
  | "tool_output"
  | "file_path";

export interface SearchQueryFilters {
  agent?: string;
  project?: string;
  projectKey?: string;
  cwd?: string;
  tags?: SmartTag[];
  tools?: string[];
  file?: string;
  fileKind?: FileActivityKind;
  costMin?: number;
  costMax?: number;
  costMinExclusive?: boolean;
  costMaxExclusive?: boolean;
}

export interface ParsedSearchQuery {
  text: string;
  filters: SearchQueryFilters;
  hasQualifiers: boolean;
}

export interface SearchOptions {
  agent?: string;
  project?: string;
  projectKey?: string;
  cwd?: string;
  tags?: SmartTag[];
  tools?: string[];
  file?: string;
  fileKind?: FileActivityKind;
  costMin?: number;
  costMax?: number;
  costMinExclusive?: boolean;
  costMaxExclusive?: boolean;
  from?: number;
  to?: number;
  limit?: number;
}

function shouldBulkSyncSearchIndex(options: SearchIndexSyncOptions, changedCount: number): boolean {
  if (options.isBulk != null) {
    return options.isBulk;
  }

  const threshold = options.bulkThreshold ?? SEARCH_INDEX_BULK_SYNC_THRESHOLD;
  return threshold > 0 && changedCount >= threshold;
}

function sessionContentHash(session: SessionHead): string {
  return JSON.stringify([
    session.slug,
    session.title,
    session.directory,
    session.time_created,
    session.time_updated ?? session.time_created,
    session.stats.message_count,
    session.stats.total_input_tokens,
    session.stats.total_output_tokens,
    session.stats.total_cache_read_tokens ?? 0,
    session.stats.total_cache_create_tokens ?? 0,
    session.stats.total_cost,
    session.stats.cost_source ?? "",
    session.stats.total_tokens ?? 0,
  ]);
}

function escapeFtsTerm(value: string): string {
  return value.replaceAll('"', '""');
}

function splitSearchTokens(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let inQuote = false;

  for (const char of input) {
    if (char === '"') {
      inQuote = !inQuote;
      token += char;
      continue;
    }
    if (/\s/.test(char) && !inQuote) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (token) {
    tokens.push(token);
  }

  return tokens;
}

function unwrapSearchValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseCostQualifier(value: string, filters: SearchQueryFilters): void {
  const raw = unwrapSearchValue(value);
  const range = raw.match(/^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)$/);
  if (range) {
    filters.costMin = Number(range[1]);
    filters.costMax = Number(range[2]);
    return;
  }

  const comparison = raw.match(/^(>=|>|<=|<)(\d+(?:\.\d+)?)$/);
  if (comparison) {
    const amount = Number(comparison[2]);
    if (comparison[1]?.includes(">")) {
      filters.costMin = amount;
      filters.costMinExclusive = comparison[1] === ">";
    } else {
      filters.costMax = amount;
      filters.costMaxExclusive = comparison[1] === "<";
    }
    return;
  }

  const amount = Number(raw);
  if (!Number.isNaN(amount)) {
    filters.costMin = amount;
    filters.costMax = amount;
  }
}

function appendUnique<T>(values: T[] | undefined, value: T): T[] {
  if (values?.includes(value)) return values;
  return [...(values ?? []), value];
}

function isSmartTag(value: string): value is SmartTag {
  return (
    value === "bugfix" ||
    value === "refactoring" ||
    value === "feature-dev" ||
    value === "testing" ||
    value === "docs" ||
    value === "git-ops" ||
    value === "build-deploy" ||
    value === "exploration" ||
    value === "planning"
  );
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const filters: SearchQueryFilters = {};
  const textTokens: string[] = [];
  let hasQualifiers = false;

  for (const token of splitSearchTokens(input)) {
    const match = token.match(/^([a-zA-Z][a-zA-Z_-]*):(.+)$/);
    if (!match) {
      textTokens.push(token);
      continue;
    }

    const key = match[1]!.toLowerCase();
    const value = unwrapSearchValue(match[2]!);
    if (!value) continue;

    let consumed = true;
    if (key === "agent") filters.agent = value.toLowerCase();
    else if (key === "project") filters.project = value;
    else if (key === "projectkey" || key === "project-key") filters.projectKey = value;
    else if (key === "cwd") filters.cwd = value;
    else if (key === "tool") filters.tools = appendUnique(filters.tools, value.toLowerCase());
    else if (key === "file" || key === "path") filters.file = value;
    else if (key === "kind" || key === "filekind" || key === "file-kind") {
      if (value === "read" || value === "edit" || value === "write" || value === "delete") {
        filters.fileKind = value;
      } else {
        consumed = false;
      }
    } else if (key === "tag" || key === "signal") {
      const tag = value.toLowerCase();
      if (isSmartTag(tag)) {
        filters.tags = appendUnique(filters.tags, tag);
      } else {
        consumed = false;
      }
    } else if (key === "cost") {
      parseCostQualifier(value, filters);
    } else {
      consumed = false;
    }

    if (consumed) {
      hasQualifiers = true;
    } else {
      textTokens.push(token);
    }
  }

  return {
    text: textTokens.join(" ").trim(),
    filters,
    hasQualifiers,
  };
}

function toFtsQuery(input: string): string {
  const tokens = splitSearchTokens(input);
  const mapped = tokens
    .map((token) => {
      if (/^OR$/i.test(token)) {
        return "OR";
      }
      if (token.startsWith('"') && token.endsWith('"')) {
        return `"${escapeFtsTerm(token.slice(1, -1))}"`;
      }
      return `"${escapeFtsTerm(token)}"`;
    })
    .filter(
      (token, index, values) =>
        token !== "OR" ||
        (index > 0 &&
          index < values.length - 1 &&
          values[index - 1] !== "OR" &&
          values[index + 1] !== "OR"),
    );

  return mapped.join(" ");
}

function loadSearchIndexEntry(
  agentName: string,
  change: SessionHeadChange,
  loadSessionData: (sessionId: string) => SessionData,
): LoadedSearchIndexEntry | null {
  try {
    const data = loadSessionData(change.session.id);
    const messages = normalizeMessages(data);
    const identity =
      change.session.project_identity ??
      data.project_identity ??
      computeIdentity(change.session.directory, realFs);
    return {
      session: change.session,
      identity,
      messages,
      contentText: buildSessionContentFromMessages(data.title ?? change.session.title, messages),
      contentHash: sessionContentHash(change.session),
      fileActivity: extractSessionFileActivity(
        agentName,
        change.session.id,
        identity.key,
        data.messages,
      ),
      sortIndex: change.sortIndex,
    };
  } catch {
    return null;
  }
}

function writeSearchIndexRows(
  db: SQLiteDatabase,
  agentName: string,
  removedSessionIds: string[],
  entries: LoadedSearchIndexEntry[],
): void {
  const deleteRow = db.prepare(
    "DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?",
  );
  const deleteMessages = db.prepare(
    "DELETE FROM messages WHERE agent_name = ? AND session_id = ? AND message_index >= ?",
  );
  const deleteMessageTools = db.prepare(
    "DELETE FROM message_tools WHERE agent_name = ? AND session_id = ? AND message_index >= ?",
  );
  const deleteFileActivity = db.prepare(
    "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
  );
  const upsertIndexedSession = prepareUpsertIndexedSession(db);
  const insertFileActivity = prepareInsertFileActivity(db);
  const insertMessageTool = prepareInsertMessageTool(db);
  const upsertMessage = db.prepare(`
    INSERT INTO messages(
      agent_name,
      session_id,
      message_index,
      message_id,
      role,
      time_created,
      time_completed,
      agent,
      mode,
      model,
      provider,
      tokens_json,
      cost,
      cost_source,
      parts_json,
      subagent_id,
      nickname,
      content_text,
      tool_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id, message_index) DO UPDATE SET
      message_id = excluded.message_id,
      role = excluded.role,
      time_created = excluded.time_created,
      time_completed = excluded.time_completed,
      agent = excluded.agent,
      mode = excluded.mode,
      model = excluded.model,
      provider = excluded.provider,
      tokens_json = excluded.tokens_json,
      cost = excluded.cost,
      cost_source = excluded.cost_source,
      parts_json = excluded.parts_json,
      subagent_id = excluded.subagent_id,
      nickname = excluded.nickname,
      content_text = excluded.content_text,
      tool_metadata_json = excluded.tool_metadata_json
  `);
  const upsertRow = db.prepare(`
    INSERT INTO session_documents(
      agent_name,
      session_id,
      slug,
      title,
      directory,
      project_identity_kind,
      project_identity_key,
      project_display_name,
      time_created,
      time_updated,
      activity_time,
      content_text,
      content_hash,
      indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      content_text = excluded.content_text,
      content_hash = excluded.content_hash,
      indexed_at = excluded.indexed_at
  `);

  for (const sessionId of new Set(removedSessionIds)) {
    deleteRow.run(agentName, sessionId);
    deleteFileActivity.run(agentName, sessionId);
    deleteMessageTools.run(agentName, sessionId, 0);
    deleteMessages.run(agentName, sessionId, 0);
  }

  for (const entry of entries) {
    const activityTime = entry.session.time_updated ?? entry.session.time_created;
    upsertSessionRow(upsertIndexedSession, agentName, entry.session, null, entry.sortIndex, null);
    deleteFileActivity.run(agentName, entry.session.id);
    deleteMessageTools.run(agentName, entry.session.id, 0);
    writeFileActivityRows(insertFileActivity, entry.fileActivity);
    for (const message of entry.messages) {
      upsertMessage.run(
        agentName,
        entry.session.id,
        message.index,
        message.id,
        message.role,
        message.timeCreated,
        message.timeCompleted ?? null,
        message.agent ?? null,
        message.mode ?? null,
        message.model ?? null,
        message.provider ?? null,
        message.tokensJson ?? null,
        message.cost ?? null,
        message.costSource ?? null,
        message.partsJson,
        message.subagentId ?? null,
        message.nickname ?? null,
        message.contentText,
        message.toolMetadataJson ?? null,
      );
      for (const toolName of message.toolNames) {
        insertMessageTool.run(agentName, entry.session.id, message.index, toolName);
      }
    }
    deleteMessages.run(agentName, entry.session.id, entry.messages.length);
    upsertRow.run(
      agentName,
      entry.session.id,
      entry.session.slug,
      entry.session.title,
      entry.session.directory,
      entry.identity.kind,
      entry.identity.key,
      entry.identity.displayName,
      entry.session.time_created,
      entry.session.time_updated ?? null,
      activityTime,
      entry.contentText,
      entry.contentHash,
      Date.now(),
    );
  }
}

export function syncSessionSearchIndex(
  agentName: string,
  sessions: SessionHead[],
  loadSessionData: (sessionId: string) => SessionData,
  options: SearchIndexSyncOptions = {},
): SearchIndexSyncResult | null {
  return withCacheDb((db) => {
    ensureFtsConsistency(db);
    const startedAt = performance.now();
    const existingRows = db
      .prepare(
        "SELECT session_id, content_hash FROM session_documents WHERE agent_name = ? ORDER BY id",
      )
      .all(agentName) as IndexedSearchRow[];
    const existingMap = new Map(
      existingRows.map((row) => [String(row.session_id), String(row.content_hash ?? "")]),
    );
    const sessionSortIndexMap = new Map(sessions.map((session, index) => [session.id, index]));
    const messageCountRows = db
      .prepare(
        "SELECT session_id, COUNT(*) AS value FROM messages WHERE agent_name = ? GROUP BY session_id",
      )
      .all(agentName) as MessageCountRow[];
    const messageCountMap = new Map(
      messageCountRows.map((row) => [String(row.session_id), Number(row.value ?? 0)]),
    );
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    const toDelete = existingRows
      .map((row) => String(row.session_id))
      .filter((sessionId) => !sessionMap.has(sessionId));
    const toUpsert = sessions.filter(
      (session) =>
        existingMap.get(session.id) !== sessionContentHash(session) ||
        messageCountMap.get(session.id) !== session.stats.message_count,
    );
    const changedCount = toDelete.length + toUpsert.length;
    const isBulk = shouldBulkSyncSearchIndex(options, changedCount);

    const loaded = toUpsert
      .map((session) =>
        loadSearchIndexEntry(
          agentName,
          { session, sortIndex: sessionSortIndexMap.get(session.id) ?? 0 },
          loadSessionData,
        ),
      )
      .filter((entry): entry is LoadedSearchIndexEntry => entry !== null);

    const writeRows = () => writeSearchIndexRows(db, agentName, toDelete, loaded);

    let rebuildDurationMs: number | undefined;
    const needsRebuild = isBulk && (toDelete.length > 0 || loaded.length > 0);

    if (needsRebuild) {
      db.transaction(() => {
        dropSearchTriggers(db);
        dropMessageSearchTriggers(db);
        writeRows();
        const rebuildStartedAt = performance.now();
        rebuildSearchIndex(db);
        rebuildMessageSearchIndex(db);
        rebuildDurationMs = performance.now() - rebuildStartedAt;
        createSearchTriggers(db);
        createMessageSearchTriggers(db);
      })();
    } else {
      db.transaction(writeRows)();
    }

    return {
      agentName,
      mode: isBulk ? "bulk" : "incremental",
      sessions: sessions.length,
      changed: toUpsert.length,
      deleted: toDelete.length,
      indexed: loaded.length,
      skipped: toUpsert.length - loaded.length,
      durationMs: performance.now() - startedAt,
      rebuildDurationMs,
    };
  });
}

export function syncSessionSearchIndexChanges(
  agentName: string,
  changes: SessionHeadChange[],
  removedSessionIds: string[],
  loadSessionData: (sessionId: string) => SessionData,
  options: SearchIndexSyncOptions = {},
): SearchIndexSyncResult | null {
  if (changes.length === 0 && removedSessionIds.length === 0) {
    return {
      agentName,
      mode: "incremental",
      sessions: 0,
      changed: 0,
      deleted: 0,
      indexed: 0,
      skipped: 0,
      durationMs: 0,
    };
  }

  return withCacheDb((db) => {
    ensureFtsConsistency(db);
    const startedAt = performance.now();
    const getIndexedRow = db.prepare(
      "SELECT content_hash FROM session_documents WHERE agent_name = ? AND session_id = ?",
    );
    const getMessageCount = db.prepare(
      "SELECT COUNT(*) AS value FROM messages WHERE agent_name = ? AND session_id = ?",
    );
    const toUpsert = changes.filter(({ session }) => {
      const indexed = getIndexedRow.get(agentName, session.id) as IndexedSearchRow | undefined;
      const messageCount = getMessageCount.get(agentName, session.id) as
        | MessageCountRow
        | undefined;
      return (
        String(indexed?.content_hash ?? "") !== sessionContentHash(session) ||
        Number(messageCount?.value ?? 0) !== session.stats.message_count
      );
    });
    const uniqueRemovedSessionIds = Array.from(new Set(removedSessionIds));
    const changedCount = uniqueRemovedSessionIds.length + toUpsert.length;
    const isBulk = shouldBulkSyncSearchIndex(options, changedCount);
    const loaded = toUpsert
      .map((change) => loadSearchIndexEntry(agentName, change, loadSessionData))
      .filter((entry): entry is LoadedSearchIndexEntry => entry !== null);
    const writeRows = () => writeSearchIndexRows(db, agentName, uniqueRemovedSessionIds, loaded);

    let rebuildDurationMs: number | undefined;
    const needsRebuild = isBulk && (uniqueRemovedSessionIds.length > 0 || loaded.length > 0);

    if (needsRebuild) {
      db.transaction(() => {
        dropSearchTriggers(db);
        dropMessageSearchTriggers(db);
        writeRows();
        const rebuildStartedAt = performance.now();
        rebuildSearchIndex(db);
        rebuildMessageSearchIndex(db);
        rebuildDurationMs = performance.now() - rebuildStartedAt;
        createSearchTriggers(db);
        createMessageSearchTriggers(db);
      })();
    } else {
      db.transaction(writeRows)();
    }

    return {
      agentName,
      mode: isBulk ? "bulk" : "incremental",
      sessions: changes.length,
      changed: toUpsert.length,
      deleted: uniqueRemovedSessionIds.length,
      indexed: loaded.length,
      skipped: toUpsert.length - loaded.length,
      durationMs: performance.now() - startedAt,
      rebuildDurationMs,
    };
  });
}

export function sessionHeadFromSearchRow(row: SearchResultRow): SessionHead {
  return sessionFromRow(row as SessionRow);
}

export function mergeSearchLists<T>(
  left: T[] | undefined,
  right: T[] | undefined,
): T[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function mergeSearchQueryOptions(query: string, options: SearchOptions) {
  const parsed = parseSearchQuery(query);
  return {
    text: parsed.text || (parsed.hasQualifiers ? "" : query.trim()),
    options: {
      ...options,
      agent: options.agent ?? parsed.filters.agent,
      project: options.project ?? parsed.filters.project,
      projectKey: options.projectKey ?? parsed.filters.projectKey,
      cwd: options.cwd ?? parsed.filters.cwd,
      tags: mergeSearchLists(options.tags, parsed.filters.tags),
      tools: mergeSearchLists(options.tools, parsed.filters.tools),
      file: options.file ?? parsed.filters.file,
      fileKind: options.fileKind ?? parsed.filters.fileKind,
      costMin: options.costMin ?? parsed.filters.costMin,
      costMax: options.costMax ?? parsed.filters.costMax,
      costMinExclusive: options.costMinExclusive ?? parsed.filters.costMinExclusive,
      costMaxExclusive: options.costMaxExclusive ?? parsed.filters.costMaxExclusive,
    },
    parsed,
  };
}

export function sessionMatchesSearchCost(session: SessionHead, options: SearchOptions): boolean {
  const cost = session.stats.total_cost;
  if (options.costMin != null) {
    if (options.costMinExclusive ? cost <= options.costMin : cost < options.costMin) {
      return false;
    }
  }
  if (options.costMax != null) {
    if (options.costMaxExclusive ? cost >= options.costMax : cost > options.costMax) {
      return false;
    }
  }
  return true;
}

function buildSessionSearchFilters(options: SearchOptions): {
  where: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.agent) {
    clauses.push("s.agent_name = ?");
    params.push(options.agent);
  }
  if (options.projectKey) {
    clauses.push("s.project_identity_key = ?");
    params.push(options.projectKey);
  }
  if (options.cwd) {
    clauses.push("(s.project_identity_key = ? OR LOWER(s.directory) LIKE ? ESCAPE '\\')");
    params.push(computeIdentity(options.cwd, realFs).key, likePattern(options.cwd));
  }
  if (options.project) {
    clauses.push(
      "(LOWER(s.project_identity_key) LIKE ? ESCAPE '\\' OR LOWER(s.project_display_name) LIKE ? ESCAPE '\\' OR LOWER(s.directory) LIKE ? ESCAPE '\\')",
    );
    const pattern = likePattern(options.project);
    params.push(pattern, pattern, pattern);
  }
  for (const tag of options.tags ?? []) {
    clauses.push("s.smart_tags_json LIKE ?");
    params.push(`%"${tag}"%`);
  }
  for (const tool of options.tools ?? []) {
    const toolName = normalizeToolName(tool);
    if (!toolName) continue;
    clauses.push(
      "EXISTS (SELECT 1 FROM message_tools mt WHERE mt.tool_name = ? AND mt.agent_name = s.agent_name AND mt.session_id = s.session_id)",
    );
    params.push(toolName);
  }
  if (options.file || options.fileKind) {
    const fileClauses = ["fa.agent_name = s.agent_name", "fa.session_id = s.session_id"];
    if (options.file) {
      const pathQuery = filePathFtsQuery(options.file);
      if (pathQuery) {
        fileClauses.push(
          "fa.rowid IN (SELECT rowid FROM session_file_activity_path_fts WHERE path MATCH ?)",
        );
        params.push(pathQuery);
      } else {
        fileClauses.push("LOWER(fa.path) LIKE ? ESCAPE '\\'");
        params.push(likePattern(options.file));
      }
    }
    if (options.fileKind) {
      fileClauses.push("fa.kind = ?");
      params.push(options.fileKind);
    }
    clauses.push(
      `EXISTS (SELECT 1 FROM session_file_activity fa WHERE ${fileClauses.join(" AND ")})`,
    );
  }
  if (options.from != null) {
    clauses.push("s.activity_time >= ?");
    params.push(options.from);
  }
  if (options.to != null) {
    clauses.push("s.activity_time <= ?");
    params.push(options.to);
  }
  if (options.costMin != null) {
    clauses.push(options.costMinExclusive ? "s.total_cost > ?" : "s.total_cost >= ?");
    params.push(options.costMin);
  }
  if (options.costMax != null) {
    clauses.push(options.costMaxExclusive ? "s.total_cost < ?" : "s.total_cost <= ?");
    params.push(options.costMax);
  }

  return {
    where: clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "",
    params,
  };
}

function searchSessionColumns(): string {
  return `
    s.agent_name,
    s.session_id,
    s.slug,
    s.title,
    s.directory,
    s.project_identity_kind,
    s.project_identity_key,
    s.project_display_name,
    s.time_created,
    s.time_updated,
    s.message_count,
    s.total_input_tokens,
    s.total_output_tokens,
    s.total_cache_read_tokens,
    s.total_cache_create_tokens,
    s.total_cost,
    s.cost_source,
    s.total_tokens,
    s.model_usage_json,
    s.smart_tags_json,
    s.smart_tags_source_updated_at
  `;
}

function parseTextTerms(input: string): { terms: string[]; mode: "all" | "any" } {
  const tokens = splitSearchTokens(input);
  return {
    terms: tokens
      .filter((token) => !/^OR$/i.test(token))
      .map((token) => unwrapSearchValue(token).toLowerCase())
      .filter(Boolean),
    mode: tokens.some((token) => /^OR$/i.test(token)) ? "any" : "all",
  };
}

function textMatchesTerms(text: string, terms: { terms: string[]; mode: "all" | "any" }) {
  const lower = text.toLowerCase();
  if (terms.terms.length === 0) return true;
  if (terms.mode === "any") return terms.terms.some((term) => lower.includes(term));
  return terms.terms.every((term) => lower.includes(term));
}

function highlightTerm(text: string, term: string): string {
  return text.replace(new RegExp(escapeRegExp(term), "gi"), (match) => `<mark>${match}</mark>`);
}

function buildTermSnippet(text: string, terms: { terms: string[]; mode: "all" | "any" }): string {
  const lower = text.toLowerCase();
  const term = terms.terms.find((item) => lower.includes(item)) ?? terms.terms[0] ?? "";
  if (!term) return text.slice(0, 180);

  const index = lower.indexOf(term);
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + term.length + 80);
  return `${start > 0 ? "… " : ""}${highlightTerm(text.slice(start, end), term)}${
    end < text.length ? " …" : ""
  }`;
}

function messageMatchType(row: MessageSearchRow): SearchMatchType {
  if (row.role === "user") return "user_message";
  if (row.role === "tool" || row.mode === "tool" || row.tool_metadata_json) return "tool_output";
  return "assistant_reply";
}

function searchResultRowKey(row: Pick<SearchResultRow, "agent_name" | "session_id">): string {
  return `${String(row.agent_name)}\u0000${String(row.session_id)}`;
}

function fetchMessageSearchMatches(
  db: SQLiteDatabase,
  rows: SearchResultRow[],
  ftsQuery: string,
  terms: { terms: string[]; mode: "all" | "any" },
): Map<string, { snippet: string; matchType: SearchMatchType }> {
  const candidates = rows.filter((row) => !textMatchesTerms(String(row.title ?? ""), terms));
  if (candidates.length === 0) {
    return new Map();
  }

  const clauses: string[] = [];
  const params: unknown[] = [ftsQuery];
  for (const row of candidates) {
    clauses.push("(m.agent_name = ? AND m.session_id = ?)");
    params.push(String(row.agent_name), String(row.session_id));
  }

  const messageRows = db
    .prepare(
      `
        SELECT
          m.agent_name,
          m.session_id,
          m.message_index,
          m.role,
          m.mode,
          m.content_text,
          m.tool_metadata_json
        FROM messages_fts
        JOIN messages m ON m.rowid = messages_fts.rowid
        WHERE messages_fts MATCH ?
          AND (${clauses.join(" OR ")})
        ORDER BY m.message_index
      `,
    )
    .all(...params) as MessageSearchRow[];
  const matches = new Map<string, { snippet: string; matchType: SearchMatchType }>();

  for (const message of messageRows) {
    const key = searchResultRowKey(message);
    if (matches.has(key)) continue;

    const text = String(message.content_text ?? "");
    if (!textMatchesTerms(text, terms)) continue;

    matches.set(key, {
      snippet: buildTermSnippet(text, terms),
      matchType: messageMatchType(message),
    });
  }

  return matches;
}

function resolveSearchMatch(
  row: SearchResultRow,
  terms: { terms: string[]; mode: "all" | "any" },
  messageMatches: Map<string, { snippet: string; matchType: SearchMatchType }>,
): { snippet: string; matchType: SearchMatchType } {
  const title = String(row.title ?? "");

  if (terms.terms.length === 0) {
    return {
      snippet: `Recent session · ${String(row.directory ?? "")}`,
      matchType: "recent",
    };
  }

  if (textMatchesTerms(title, terms)) {
    return { snippet: buildTermSnippet(title, terms), matchType: "title" };
  }

  const messageMatch = messageMatches.get(searchResultRowKey(row));
  if (messageMatch) {
    return messageMatch;
  }

  return {
    snippet: String(row.snippet ?? ""),
    matchType: "assistant_reply",
  };
}

function rowsToSearchResults(
  db: SQLiteDatabase,
  rows: SearchResultRow[],
  textQuery: string,
  ftsQuery = toFtsQuery(textQuery),
): SearchResult[] {
  const terms = parseTextTerms(textQuery);
  const messageMatches =
    terms.terms.length > 0 && ftsQuery
      ? fetchMessageSearchMatches(db, rows, ftsQuery, terms)
      : new Map<string, { snippet: string; matchType: SearchMatchType }>();

  return rows.map((row) => {
    const match = resolveSearchMatch(row, terms, messageMatches);
    return {
      agentName: String(row.agent_name),
      session: sessionHeadFromSearchRow(row),
      snippet: match.snippet,
      matchType: match.matchType,
    };
  });
}

export function searchSessions(query: string, options: SearchOptions = {}): SearchResult[] {
  const search = mergeSearchQueryOptions(query, options);
  const normalizedQuery = search.text.trim();
  if (!hasCacheStorage()) {
    return [];
  }

  const results = withCacheDb((db) => {
    ensureFtsReady(db);
    const filters = buildSessionSearchFilters(search.options);

    if (!normalizedQuery) {
      const rows = db
        .prepare(
          `
            SELECT
              ${searchSessionColumns()},
              '' AS snippet
            FROM sessions s
            WHERE 1 = 1
              ${filters.where}
            ORDER BY s.activity_time DESC
            LIMIT ?
          `,
        )
        .all(...filters.params, search.options.limit ?? 50) as SearchResultRow[];

      return rowsToSearchResults(db, rows, "");
    }

    const ftsQuery = toFtsQuery(normalizedQuery);
    if (!ftsQuery) return [];
    const rows = db
      .prepare(
        `
          SELECT
            ${searchSessionColumns()},
            COALESCE(
              NULLIF(snippet(session_documents_fts, 1, '<mark>', '</mark>', ' … ', 18), ''),
              highlight(session_documents_fts, 0, '<mark>', '</mark>')
            ) AS snippet
          FROM session_documents_fts
          JOIN session_documents d ON d.id = session_documents_fts.rowid
          JOIN sessions s ON s.agent_name = d.agent_name AND s.session_id = d.session_id
          WHERE session_documents_fts MATCH ?
            ${filters.where}
          ORDER BY bm25(session_documents_fts, 8.0, 1.0), s.activity_time DESC
          LIMIT ?
        `,
      )
      .all(ftsQuery, ...filters.params, search.options.limit ?? 50) as SearchResultRow[];

    return rowsToSearchResults(db, rows, normalizedQuery, ftsQuery);
  });

  return results ?? [];
}
