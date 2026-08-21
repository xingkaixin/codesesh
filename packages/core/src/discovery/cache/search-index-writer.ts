import type { SessionCacheMeta } from "../../agents/base.js";
import type { SessionDetail, SessionFileActivity, SessionHead } from "../../types/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { SEARCH_INDEX_BULK_SYNC_THRESHOLD, type PersistedSessionHeadChange } from "./db.js";
import { advanceAnalyticsRevision } from "./analytics-revision.js";
import {
  buildSessionContentFromMessages,
  messageCursorContentFromStructuredRecord,
  MESSAGE_PARTS_FORMAT_VERSION,
  normalizeMessages,
  prepareInsertFileActivity,
  prepareInsertMessageTool,
  prepareUpsertIndexedSession,
  assertSessionProjectIdentities,
  requireSessionProjectIdentity,
  upsertSessionRow,
  writeFileActivityRows,
  type StructuredMessageRecord,
} from "./messages.js";
import { advanceMessageCursorDigest, initialMessageCursorDigest } from "./message-cursor.js";
import { withCacheDbReadOnly, withSearchIndexDb } from "./connection.js";
import { runSearchIndexWrite } from "./schema.js";
import { sessionDetailVersion } from "./detail-version.js";
import type { SessionSnapshotCompleteness } from "./sessions.js";
import {
  deletePublicationPayloads,
  discardPublicationStaging,
  readPublicationPayloads,
  stagePublicationPayloads,
} from "./publication-staging.js";

export interface SearchIndexSyncOptions {
  isBulk?: boolean;
  bulkThreshold?: number;
  includePendingReindex?: boolean;
  detailVersions?: Readonly<Record<string, string>>;
  completeness?: SessionSnapshotCompleteness;
  removedSessionIds?: readonly string[];
  publicationId?: string;
}

export interface SearchIndexSyncFailure {
  sessionId: string;
  reason: "parse-failed" | "superseded";
  message?: string;
}

export interface SearchIndexSyncResult {
  agentName: string;
  mode: "bulk" | "incremental";
  sessions: number;
  changed: number;
  deleted: number;
  indexed: number;
  skipped: number;
  failures?: SearchIndexSyncFailure[];
  durationMs: number;
  rebuildDurationMs?: number;
}

export interface PendingSearchIndexMaintenance {
  sessionIds: string[];
  total: number;
}

interface SearchIndexState {
  contentHashBySessionId: Map<string, string>;
  publishedContentHashBySessionId: Map<string, string>;
  indexedMessageCountBySessionId: Map<string, number>;
  messageCountBySessionId: Map<string, number>;
  detailVersionBySessionId: Map<string, string>;
  targetDetailVersionBySessionId: Map<string, string>;
  pendingReindexSessionIds: Set<string>;
}

interface IndexedSearchRow {
  session_id?: string;
  content_hash?: string;
  indexed_message_count?: number;
  detail_version?: string;
  meta_json?: string | null;
}

interface PublishedSessionRow {
  session_title?: string | null;
  session_directory?: string | null;
  session_time_created?: number | null;
  session_time_updated?: number | null;
  session_message_count?: number | null;
  session_total_input_tokens?: number | null;
  session_total_output_tokens?: number | null;
  session_total_cache_read_tokens?: number | null;
  session_total_cache_create_tokens?: number | null;
  session_total_cost?: number | null;
  session_cost_source?: string | null;
  session_total_tokens?: number | null;
  session_project_identity_kind?: string | null;
  session_project_identity_key?: string | null;
  session_project_display_name?: string | null;
  session_project_identity_resolver_revision?: string | null;
  session_project_identity_input_signature?: string | null;
}

interface MessageCountRow {
  session_id?: string;
  value?: number;
}

function readPendingReindexIds(db: SQLiteDatabase, agentName: string): Set<string> {
  const rows = db
    .prepare("SELECT session_id FROM pending_reindex WHERE agent_name = ?")
    .all(agentName) as Array<{ session_id?: string }>;
  return new Set(rows.map((row) => String(row.session_id)));
}

type SearchIndexStateRow = IndexedSearchRow & MessageCountRow & PublishedSessionRow;

const SEARCH_INDEX_STATE_BATCH_SIZE = 900;
const SEARCH_INDEX_COMMIT_CHUNK_SIZE = 64;

interface LoadedSearchIndexEntry {
  session: SessionHead;
  messages: StructuredMessageRecord[];
  contentText: string;
  contentHash: string;
  fileActivity: SessionFileActivity[];
  sortIndex: number;
  detailVersion: string;
}

interface SearchIndexRowWriteOptions {
  verifySupersession?: boolean;
}

type SearchIndexPlanRequest =
  | { kind: "snapshot"; sessions: SessionHead[] }
  | {
      kind: "changes";
      changes: PersistedSessionHeadChange[];
      removedSessionIds: readonly string[];
    };

interface SearchIndexPlan {
  agentName: string;
  mode: "bulk" | "incremental";
  sessionCount: number;
  changes: PersistedSessionHeadChange[];
  removedSessionIds: string[];
  detailVersionBySessionId: Map<string, string>;
  needsRebuild: boolean;
  startedAt: number;
}

interface SearchIndexPlanInput {
  agentName: string;
  sessionCount: number;
  candidates: PersistedSessionHeadChange[];
  removedSessionIds: string[];
  state: SearchIndexState;
  options: SearchIndexSyncOptions;
  startedAt: number;
}

/** Full snapshots bound memory with durable chunks; targeted changes retain one atomic write. */
type LargeBacklogWriteStrategy = "atomic" | "chunked";

interface PreparedSearchIndexPublication {
  agentName: string;
  mode: "bulk" | "incremental";
  sessions: number;
  changed: number;
  removedSessionIds: string[];
  entries: LoadedSearchIndexEntry[];
  publicationId?: string;
  /** Full entries stored outside the live tables until the atomic commit. */
  preStaged: number;
  failures: SearchIndexSyncFailure[];
  needsRebuild: boolean;
  startedAt: number;
}

function shouldBulkSyncSearchIndex(options: SearchIndexSyncOptions, changedCount: number): boolean {
  if (options.isBulk != null) {
    return options.isBulk;
  }

  const threshold = options.bulkThreshold ?? SEARCH_INDEX_BULK_SYNC_THRESHOLD;
  return threshold > 0 && changedCount >= threshold;
}

interface SearchIndexSessionFacts {
  title: string;
  directory: string;
  timeCreated: number;
  timeUpdated: number;
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreateTokens: number;
  totalCost: number;
  costSource: string;
  totalTokens: number;
  projectIdentityKind: string;
  projectIdentityKey: string;
  projectDisplayName: string;
  projectIdentityResolverRevision: string;
  projectIdentityInputSignature: string;
}

function searchIndexSessionFacts(session: SessionHead): SearchIndexSessionFacts {
  return {
    title: session.title,
    directory: session.directory,
    timeCreated: session.time_created,
    timeUpdated: session.time_updated ?? session.time_created,
    messageCount: session.stats.message_count,
    totalInputTokens: session.stats.total_input_tokens,
    totalOutputTokens: session.stats.total_output_tokens,
    totalCacheReadTokens: session.stats.total_cache_read_tokens ?? 0,
    totalCacheCreateTokens: session.stats.total_cache_create_tokens ?? 0,
    totalCost: session.stats.total_cost,
    costSource: session.stats.cost_source ?? "",
    totalTokens: session.stats.total_tokens ?? 0,
    projectIdentityKind: session.project_identity?.kind ?? "",
    projectIdentityKey: session.project_identity?.key ?? "",
    projectDisplayName: session.project_identity?.displayName ?? "",
    projectIdentityResolverRevision: session.project_identity_resolver_revision ?? "",
    projectIdentityInputSignature: session.project_identity_input_signature ?? "",
  };
}

function hashSearchIndexSessionFacts(facts: SearchIndexSessionFacts): string {
  return JSON.stringify(facts);
}

function sessionContentHash(session: SessionHead): string {
  return hashSearchIndexSessionFacts(searchIndexSessionFacts(session));
}

function publishedSessionContentHash(row: PublishedSessionRow): string | null {
  if (row.session_title == null) return null;
  return hashSearchIndexSessionFacts({
    title: row.session_title,
    directory: row.session_directory ?? "",
    timeCreated: Number(row.session_time_created ?? 0),
    timeUpdated: Number(row.session_time_updated ?? row.session_time_created ?? 0),
    messageCount: Number(row.session_message_count ?? 0),
    totalInputTokens: Number(row.session_total_input_tokens ?? 0),
    totalOutputTokens: Number(row.session_total_output_tokens ?? 0),
    totalCacheReadTokens: Number(row.session_total_cache_read_tokens ?? 0),
    totalCacheCreateTokens: Number(row.session_total_cache_create_tokens ?? 0),
    totalCost: Number(row.session_total_cost ?? 0),
    costSource: row.session_cost_source ?? "",
    totalTokens: Number(row.session_total_tokens ?? 0),
    projectIdentityKind: row.session_project_identity_kind ?? "",
    projectIdentityKey: row.session_project_identity_key ?? "",
    projectDisplayName: row.session_project_display_name ?? "",
    projectIdentityResolverRevision: row.session_project_identity_resolver_revision ?? "",
    projectIdentityInputSignature: row.session_project_identity_input_signature ?? "",
  });
}

function detailVersionFromMetaJson(value: string | null | undefined): string {
  if (!value) return sessionDetailVersion(null);
  try {
    return sessionDetailVersion(JSON.parse(value) as SessionCacheMeta);
  } catch {
    return sessionDetailVersion(null);
  }
}

function searchIndexStateFromRows(
  indexedRows: SearchIndexStateRow[],
  messageCountRows: MessageCountRow[],
  pendingReindexSessionIds: Set<string> = new Set(),
): SearchIndexState {
  return {
    contentHashBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), String(row.content_hash ?? "")]),
    ),
    publishedContentHashBySessionId: new Map(
      indexedRows.flatMap((row) => {
        const contentHash = publishedSessionContentHash(row);
        return contentHash == null ? [] : [[String(row.session_id), contentHash]];
      }),
    ),
    indexedMessageCountBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), Number(row.indexed_message_count ?? 0)]),
    ),
    messageCountBySessionId: new Map(
      messageCountRows.map((row) => [String(row.session_id), Number(row.value ?? 0)]),
    ),
    detailVersionBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), String(row.detail_version ?? "")]),
    ),
    targetDetailVersionBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), detailVersionFromMetaJson(row.meta_json)]),
    ),
    pendingReindexSessionIds,
  };
}

/**
 * Freshness probe for a batch of sessions: is each one's indexed document still
 * in step with its cached head?
 *
 * INDEXED BY is not a micro-optimisation. Without stats SQLite prefers the
 * UNIQUE(agent_name, session_id) auto-index, and reaching content_hash then
 * means reading each row past content_text through its overflow chain — proving
 * an unchanged agent is up to date would cost the size of the indexed corpus.
 * Pinning the covering index keeps the probe proportional to the session count.
 */
export function searchIndexStateQuery(sessionIdCount: number): string {
  const requestedRows = Array.from({ length: sessionIdCount }, () => "(?)").join(", ");
  return `
    WITH requested_session_ids(session_id) AS (VALUES ${requestedRows})
    SELECT
      requested.session_id,
      documents.content_hash,
      documents.indexed_message_count,
      documents.detail_version,
      sessions.meta_json,
      sessions.title AS session_title,
      sessions.directory AS session_directory,
      sessions.time_created AS session_time_created,
      sessions.time_updated AS session_time_updated,
      sessions.message_count AS session_message_count,
      sessions.total_input_tokens AS session_total_input_tokens,
      sessions.total_output_tokens AS session_total_output_tokens,
      sessions.total_cache_read_tokens AS session_total_cache_read_tokens,
      sessions.total_cache_create_tokens AS session_total_cache_create_tokens,
      sessions.total_cost AS session_total_cost,
      sessions.cost_source AS session_cost_source,
      sessions.total_tokens AS session_total_tokens,
      sessions.project_identity_kind AS session_project_identity_kind,
      sessions.project_identity_key AS session_project_identity_key,
      sessions.project_display_name AS session_project_display_name,
      sessions.project_identity_resolver_revision AS session_project_identity_resolver_revision,
      sessions.project_identity_input_signature AS session_project_identity_input_signature,
      COUNT(messages.message_index) AS value
    FROM requested_session_ids AS requested
    LEFT JOIN session_documents AS documents
      INDEXED BY idx_session_documents_state
      ON documents.agent_name = ? AND documents.session_id = requested.session_id
    LEFT JOIN messages
      ON messages.agent_name = ? AND messages.session_id = requested.session_id
    LEFT JOIN sessions
      ON sessions.agent_name = ? AND sessions.session_id = requested.session_id
    GROUP BY
      requested.session_id,
      documents.content_hash,
      documents.indexed_message_count,
      documents.detail_version,
      sessions.meta_json,
      sessions.title,
      sessions.directory,
      sessions.time_created,
      sessions.time_updated,
      sessions.message_count,
      sessions.total_input_tokens,
      sessions.total_output_tokens,
      sessions.total_cache_read_tokens,
      sessions.total_cache_create_tokens,
      sessions.total_cost,
      sessions.cost_source,
      sessions.total_tokens,
      sessions.project_identity_kind,
      sessions.project_identity_key,
      sessions.project_display_name,
      sessions.project_identity_resolver_revision,
      sessions.project_identity_input_signature
  `;
}

function readSearchIndexState(
  db: SQLiteDatabase,
  agentName: string,
  sessionIds: string[],
): SearchIndexState {
  const rows: SearchIndexStateRow[] = [];
  const uniqueSessionIds = [...new Set(sessionIds)];

  for (let offset = 0; offset < uniqueSessionIds.length; offset += SEARCH_INDEX_STATE_BATCH_SIZE) {
    const batch = uniqueSessionIds.slice(offset, offset + SEARCH_INDEX_STATE_BATCH_SIZE);
    const batchRows = db
      .prepare(searchIndexStateQuery(batch.length))
      .all(...batch, agentName, agentName, agentName) as SearchIndexStateRow[];
    rows.push(...batchRows);
  }

  return searchIndexStateFromRows(rows, rows, readPendingReindexIds(db, agentName));
}

function targetDetailVersion(
  state: SearchIndexState,
  sessionId: string,
  options: SearchIndexSyncOptions,
): string {
  return (
    options.detailVersions?.[sessionId] ??
    state.targetDetailVersionBySessionId.get(sessionId) ??
    sessionDetailVersion(null)
  );
}

function searchIndexEntryNeedsUpdate(
  state: SearchIndexState,
  session: SessionHead,
  options: SearchIndexSyncOptions,
): boolean {
  const sessionId = session.reference.sessionId;
  const pendingMaintenance = state.pendingReindexSessionIds.has(sessionId);
  const targetVersion = targetDetailVersion(state, sessionId, options);
  if (pendingMaintenance && options.includePendingReindex === false) {
    return (
      state.publishedContentHashBySessionId.get(sessionId) !== sessionContentHash(session) ||
      state.targetDetailVersionBySessionId.get(sessionId) !== targetVersion
    );
  }
  return (
    pendingMaintenance ||
    state.detailVersionBySessionId.get(sessionId) !== targetVersion ||
    state.contentHashBySessionId.get(sessionId) !== sessionContentHash(session) ||
    state.indexedMessageCountBySessionId.get(sessionId) !==
      (state.messageCountBySessionId.get(sessionId) ?? 0)
  );
}

export function readPendingSearchIndexMaintenance(
  agentName: string,
  limit: number,
): PendingSearchIndexMaintenance | null {
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const outcome = withCacheDbReadOnly((db) => {
    const totalRow = db
      .prepare(
        `
          SELECT COUNT(*) AS value
          FROM pending_reindex AS pending
          INNER JOIN sessions
            ON sessions.agent_name = pending.agent_name
            AND sessions.session_id = pending.session_id
          WHERE pending.agent_name = ?
            AND sessions.publication_id IS NULL
        `,
      )
      .get(agentName) as { value?: number } | undefined;
    const rows = db
      .prepare(
        `
          SELECT pending.session_id
          FROM pending_reindex AS pending
          INNER JOIN sessions
            ON sessions.agent_name = pending.agent_name
            AND sessions.session_id = pending.session_id
          WHERE pending.agent_name = ?
            AND sessions.publication_id IS NULL
          ORDER BY sessions.sort_index, pending.session_id
          LIMIT ?
        `,
      )
      .all(agentName, boundedLimit) as Array<{ session_id?: string }>;
    return {
      sessionIds: rows.map((row) => String(row.session_id)),
      total: Number(totalRow?.value ?? 0),
    };
  });
  return outcome.status === "success" ? outcome.value : null;
}

function loadSearchIndexEntry(
  agentName: string,
  change: PersistedSessionHeadChange,
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersion: string,
  failures: SearchIndexSyncFailure[],
): LoadedSearchIndexEntry | null {
  const sessionId = change.session.reference.sessionId;
  try {
    const data = loadSessionData(sessionId);
    const messages = normalizeMessages(data);
    const identity = requireSessionProjectIdentity(agentName, change.session);
    return {
      session: change.session,
      messages,
      contentText: buildSessionContentFromMessages(data.title ?? change.session.title, messages),
      contentHash: sessionContentHash(change.session),
      fileActivity: extractSessionFileActivity(agentName, sessionId, identity.key, data.messages),
      sortIndex: change.sortIndex,
      detailVersion,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ sessionId, reason: "parse-failed", message });
    getCoreDiagnostics()?.warn("search_index.session_parse_failed", {
      agent: agentName,
      session_id: sessionId,
      message,
    });
    return null;
  }
}

function* loadSearchIndexEntries(
  agentName: string,
  changes: Iterable<PersistedSessionHeadChange>,
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersionFor: (sessionId: string) => string,
  failures: SearchIndexSyncFailure[],
): Generator<LoadedSearchIndexEntry> {
  for (const change of changes) {
    const sessionId = change.session.reference.sessionId;
    const entry = loadSearchIndexEntry(
      agentName,
      change,
      loadSessionData,
      detailVersionFor(sessionId),
      failures,
    );
    if (entry) yield entry;
  }
}

function writeSearchIndexRows(
  db: SQLiteDatabase,
  agentName: string,
  removedSessionIds: string[],
  entries: Iterable<LoadedSearchIndexEntry>,
  failures: SearchIndexSyncFailure[],
  options: SearchIndexRowWriteOptions = {},
): number {
  const { verifySupersession = true } = options;
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
  const deleteModelCost = db.prepare(
    "DELETE FROM session_model_cost WHERE agent_name = ? AND session_id = ?",
  );
  const deleteCostSummary = db.prepare(
    "DELETE FROM session_cost_summary WHERE agent_name = ? AND session_id = ?",
  );
  // Derived from the message rows just written, in the same transaction, so
  // the rollup can never drift from its source (CS-270).
  const rebuildModelCost = db.prepare(`
    INSERT INTO session_model_cost(agent_name, session_id, model, cost, cost_recorded)
    SELECT
      agent_name,
      session_id,
      model,
      SUM(COALESCE(cost, 0)),
      SUM(CASE WHEN cost_source = 'recorded' THEN COALESCE(cost, 0) ELSE 0 END)
    FROM messages
    WHERE agent_name = ? AND session_id = ? AND model IS NOT NULL AND model <> ''
    GROUP BY agent_name, session_id, model
  `);
  const rebuildCostSummary = db.prepare(`
    WITH normalized AS (
      SELECT
        agent_name,
        session_id,
        COALESCE(time_completed, 0) <= 0 AND COALESCE(time_created, 0) <= 0 AS untimed,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.input'), 0) AS INTEGER), 0) AS input_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.output'), 0) AS INTEGER), 0) AS output_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.reasoning'), 0) AS INTEGER), 0) AS reasoning_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_read'), 0) AS INTEGER), 0) AS cache_read_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_create'), 0) AS INTEGER), 0) AS cache_create_tokens,
        CASE WHEN cost > 0 THEN cost ELSE 0 END AS normalized_cost
      FROM messages
      WHERE agent_name = ? AND session_id = ?
    )
    INSERT INTO session_cost_summary(
      agent_name,
      session_id,
      message_count,
      untimed_message_count,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cache_read_tokens,
      cache_create_tokens,
      untimed_input_tokens,
      untimed_output_tokens,
      untimed_reasoning_tokens,
      untimed_cache_read_tokens,
      untimed_cache_create_tokens,
      message_cost,
      untimed_message_cost
    )
    SELECT
      agent_name,
      session_id,
      COUNT(*),
      SUM(CASE WHEN untimed THEN 1 ELSE 0 END),
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(reasoning_tokens),
      SUM(cache_read_tokens),
      SUM(cache_create_tokens),
      SUM(CASE WHEN untimed THEN input_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN output_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN reasoning_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_read_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_create_tokens ELSE 0 END),
      SUM(normalized_cost),
      SUM(CASE WHEN untimed THEN normalized_cost ELSE 0 END)
    FROM normalized
    GROUP BY agent_name, session_id
  `);
  const writeIndexedSession = prepareUpsertIndexedSession(db);
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
      parts_format_version,
      content_chain_digest,
      subagent_id,
      nickname,
      content_text,
      tool_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      parts_format_version = excluded.parts_format_version,
      content_chain_digest = excluded.content_chain_digest,
      subagent_id = excluded.subagent_id,
      nickname = excluded.nickname,
      content_text = excluded.content_text,
      tool_metadata_json = excluded.tool_metadata_json
  `);
  const upsertRow = db.prepare(`
    INSERT INTO session_documents(
      agent_name,
      session_id,
      title,
      content_text,
      content_hash,
      indexed_message_count,
      detail_version,
      indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      title = excluded.title,
      content_text = excluded.content_text,
      content_hash = excluded.content_hash,
      indexed_message_count = excluded.indexed_message_count,
      detail_version = excluded.detail_version,
      indexed_at = excluded.indexed_at
  `);

  const readCurrentMeta = db.prepare(
    "SELECT meta_json FROM sessions WHERE agent_name = ? AND session_id = ?",
  );

  const clearPendingReindex = db.prepare(
    "DELETE FROM pending_reindex WHERE agent_name = ? AND session_id = ?",
  );

  for (const sessionId of new Set(removedSessionIds)) {
    deleteRow.run(agentName, sessionId);
    deleteFileActivity.run(agentName, sessionId);
    deleteMessageTools.run(agentName, sessionId, 0);
    deleteMessages.run(agentName, sessionId, 0);
    deleteModelCost.run(agentName, sessionId);
    deleteCostSummary.run(agentName, sessionId);
    clearPendingReindex.run(agentName, sessionId);
  }

  let indexed = 0;
  for (const entry of entries) {
    const sessionId = entry.session.reference.sessionId;
    if (verifySupersession) {
      const current = readCurrentMeta.get(agentName, sessionId) as
        | { meta_json?: string | null }
        | undefined;
      if (entry.detailVersion !== detailVersionFromMetaJson(current?.meta_json)) {
        failures.push({ sessionId, reason: "superseded" });
        continue;
      }
    }
    upsertSessionRow(writeIndexedSession, agentName, entry.session, null, entry.sortIndex, null);
    deleteFileActivity.run(agentName, sessionId);
    deleteMessageTools.run(agentName, sessionId, 0);
    clearPendingReindex.run(agentName, sessionId);
    writeFileActivityRows(insertFileActivity, entry.fileActivity);
    let contentChainDigest = initialMessageCursorDigest({
      agentName,
      sessionId,
    });
    for (const message of entry.messages) {
      contentChainDigest = advanceMessageCursorDigest(
        contentChainDigest,
        messageCursorContentFromStructuredRecord(message),
      );
      upsertMessage.run(
        agentName,
        sessionId,
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
        MESSAGE_PARTS_FORMAT_VERSION,
        contentChainDigest,
        message.subagentId ?? null,
        message.nickname ?? null,
        message.contentText,
        message.toolMetadataJson ?? null,
      );
      for (const toolName of message.toolNames) {
        insertMessageTool.run(agentName, sessionId, message.index, toolName);
      }
    }
    deleteMessages.run(agentName, sessionId, entry.messages.length);
    deleteModelCost.run(agentName, sessionId);
    deleteCostSummary.run(agentName, sessionId);
    rebuildModelCost.run(agentName, sessionId);
    rebuildCostSummary.run(agentName, sessionId);
    upsertRow.run(
      agentName,
      sessionId,
      entry.session.title,
      entry.contentText,
      entry.contentHash,
      entry.messages.length,
      entry.detailVersion,
      Date.now(),
    );
    indexed += 1;
  }
  return indexed;
}

/**
 * Loaded entries carry full message bodies, so a backlog larger than one commit
 * chunk cannot be held in memory at once — a first-time index of a large agent
 * (multi-GB codex rollouts) used to OOM the search-index worker. Larger
 * backlogs are serialized into a shadow table in chunks. The final transaction
 * streams those payloads into the live tables, keeping memory bounded without
 * publishing any detail facts ahead of their session heads.
 */
function loadOrPreStageEntries(
  db: SQLiteDatabase,
  agentName: string,
  changes: PersistedSessionHeadChange[],
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersionFor: (sessionId: string) => string,
  failures: SearchIndexSyncFailure[],
  publicationId?: string,
): { entries: LoadedSearchIndexEntry[]; preStaged: number } {
  if (changes.length <= SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
    return {
      entries: [
        ...loadSearchIndexEntries(agentName, changes, loadSessionData, detailVersionFor, failures),
      ],
      preStaged: 0,
    };
  }

  if (!publicationId) {
    throw new Error("Large durable publications require a publication id");
  }

  let preStaged = 0;
  for (let offset = 0; offset < changes.length; offset += SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
    const chunk = changes.slice(offset, offset + SEARCH_INDEX_COMMIT_CHUNK_SIZE);
    runSearchIndexWrite(db, false, () => {
      const entries = loadSearchIndexEntries(
        agentName,
        chunk,
        loadSessionData,
        detailVersionFor,
        failures,
      );
      preStaged += stagePublicationPayloads(
        db,
        publicationId,
        agentName,
        (function* () {
          for (const entry of entries) {
            yield {
              sessionId: entry.session.reference.sessionId,
              json: JSON.stringify(entry),
            };
          }
        })(),
      );
    });
  }
  getCoreDiagnostics()?.info?.("search_index.pre_staged", {
    agent: agentName,
    changed: changes.length,
    staged: preStaged,
  });
  return { entries: [], preStaged };
}

function readSearchIndexPlanInput(
  db: SQLiteDatabase,
  agentName: string,
  request: SearchIndexPlanRequest,
  options: SearchIndexSyncOptions,
): SearchIndexPlanInput {
  const startedAt = performance.now();
  let candidates: PersistedSessionHeadChange[];
  let removedSessionIds: string[];
  let sessionCount: number;

  if (request.kind === "snapshot") {
    const existingRows = db
      .prepare("SELECT session_id FROM session_documents WHERE agent_name = ? ORDER BY id")
      .all(agentName) as IndexedSearchRow[];
    const includedSessionIds = new Set(
      request.sessions.map((session) => session.reference.sessionId),
    );
    const sortIndexBySessionId = new Map(
      request.sessions.map((session, sortIndex) => [session.reference.sessionId, sortIndex]),
    );
    const explicitRemovedSessionIds = new Set(options.removedSessionIds ?? []);
    const completeness = options.completeness ?? "complete";
    removedSessionIds = existingRows
      .map((row) => String(row.session_id))
      .filter(
        (sessionId) =>
          explicitRemovedSessionIds.has(sessionId) ||
          (completeness === "complete" && !includedSessionIds.has(sessionId)),
      );
    candidates = request.sessions.map((session) => ({
      session,
      sortIndex: sortIndexBySessionId.get(session.reference.sessionId) ?? 0,
    }));
    sessionCount = request.sessions.length;
  } else {
    candidates = request.changes;
    removedSessionIds = [...new Set(request.removedSessionIds)];
    sessionCount = request.changes.length;
  }

  const state = readSearchIndexState(
    db,
    agentName,
    candidates.map(({ session }) => session.reference.sessionId),
  );

  return {
    agentName,
    sessionCount,
    candidates,
    removedSessionIds,
    state,
    options,
    startedAt,
  };
}

function createSearchIndexPlan(input: SearchIndexPlanInput): SearchIndexPlan {
  const changes = input.candidates.filter(({ session }) =>
    searchIndexEntryNeedsUpdate(input.state, session, input.options),
  );
  const detailVersionBySessionId = new Map(
    changes.map(({ session }) => {
      const sessionId = session.reference.sessionId;
      return [sessionId, targetDetailVersion(input.state, sessionId, input.options)];
    }),
  );
  const changedCount = input.removedSessionIds.length + changes.length;
  const isBulk = shouldBulkSyncSearchIndex(input.options, changedCount);

  return {
    agentName: input.agentName,
    mode: isBulk ? "bulk" : "incremental",
    sessionCount: input.sessionCount,
    changes,
    removedSessionIds: input.removedSessionIds,
    detailVersionBySessionId,
    needsRebuild: isBulk && changedCount > 0,
    startedAt: input.startedAt,
  };
}

function planSearchIndexWrite(
  db: SQLiteDatabase,
  agentName: string,
  request: SearchIndexPlanRequest,
  options: SearchIndexSyncOptions,
): SearchIndexPlan {
  return createSearchIndexPlan(readSearchIndexPlanInput(db, agentName, request, options));
}

function detailVersionForPlan(plan: SearchIndexPlan, sessionId: string): string {
  return plan.detailVersionBySessionId.get(sessionId) ?? sessionDetailVersion(null);
}

function prepareSearchIndexPublication(
  db: SQLiteDatabase,
  plan: SearchIndexPlan,
  loadSessionData: (sessionId: string) => SessionDetail,
  publicationId?: string,
): PreparedSearchIndexPublication {
  getCoreDiagnostics()?.info?.("search_index.publication_plan", {
    agent: plan.agentName,
    sessions: plan.sessionCount,
    changed: plan.changes.length,
    removed: plan.removedSessionIds.length,
    mode: plan.mode,
    planning_ms: Math.round(performance.now() - plan.startedAt),
  });
  const failures: SearchIndexSyncFailure[] = [];
  const { entries, preStaged } = loadOrPreStageEntries(
    db,
    plan.agentName,
    plan.changes,
    loadSessionData,
    (sessionId) => detailVersionForPlan(plan, sessionId),
    failures,
    publicationId,
  );

  return {
    agentName: plan.agentName,
    mode: plan.mode,
    sessions: plan.sessionCount,
    changed: plan.changes.length,
    removedSessionIds: plan.removedSessionIds,
    entries,
    publicationId,
    preStaged,
    failures,
    needsRebuild: plan.needsRebuild,
    startedAt: plan.startedAt,
  };
}

export function prepareSessionSnapshotSearchIndex(
  db: SQLiteDatabase,
  agentName: string,
  sessions: SessionHead[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): PreparedSearchIndexPublication {
  return prepareSearchIndexPublication(
    db,
    planSearchIndexWrite(db, agentName, { kind: "snapshot", sessions }, options),
    loadSessionData,
    options.publicationId,
  );
}

export function prepareSessionChangesSearchIndex(
  db: SQLiteDatabase,
  agentName: string,
  changes: PersistedSessionHeadChange[],
  removedSessionIds: string[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): PreparedSearchIndexPublication {
  return prepareSearchIndexPublication(
    db,
    planSearchIndexWrite(db, agentName, { kind: "changes", changes, removedSessionIds }, options),
    loadSessionData,
    options.publicationId,
  );
}

export function writePreparedSessionSearchIndex(
  db: SQLiteDatabase,
  publication: PreparedSearchIndexPublication,
): SearchIndexSyncResult {
  let indexed = 0;
  const { rebuildDurationMs } = runSearchIndexWrite(
    db,
    publication.needsRebuild,
    () => {
      const entries = (function* (): Generator<LoadedSearchIndexEntry> {
        yield* publication.entries;
        if (!publication.publicationId || publication.preStaged === 0) return;
        for (const payload of readPublicationPayloads(
          db,
          publication.publicationId,
          publication.agentName,
        )) {
          yield JSON.parse(payload) as LoadedSearchIndexEntry;
        }
      })();
      indexed += writeSearchIndexRows(
        db,
        publication.agentName,
        publication.removedSessionIds,
        entries,
        publication.failures,
      );
      if (publication.publicationId) {
        deletePublicationPayloads(db, publication.publicationId, publication.agentName);
      }
    },
    "caller",
  );

  return {
    agentName: publication.agentName,
    mode: publication.mode,
    sessions: publication.sessions,
    changed: publication.changed,
    deleted: publication.removedSessionIds.length,
    indexed,
    skipped: publication.changed - indexed,
    failures: publication.failures.length > 0 ? publication.failures : undefined,
    durationMs: performance.now() - publication.startedAt,
    rebuildDurationMs,
  };
}

export function discardPreparedSessionSearchIndex(publicationId: string, agentName: string): void {
  withSearchIndexDb((db) =>
    db.transaction(() => discardPublicationStaging(db, publicationId, agentName)).immediate(),
  );
}

function searchIndexSyncResult(
  plan: SearchIndexPlan,
  indexed: number,
  failures: SearchIndexSyncFailure[],
  rebuildDurationMs?: number,
  mode = plan.mode,
): SearchIndexSyncResult {
  return {
    agentName: plan.agentName,
    mode,
    sessions: plan.sessionCount,
    changed: plan.changes.length,
    deleted: plan.removedSessionIds.length,
    indexed,
    skipped: plan.changes.length - indexed,
    failures: failures.length > 0 ? failures : undefined,
    durationMs: performance.now() - plan.startedAt,
    rebuildDurationMs,
  };
}

function executeSearchIndexPlan(
  db: SQLiteDatabase,
  plan: SearchIndexPlan,
  loadSessionData: (sessionId: string) => SessionDetail,
  largeBacklogStrategy: LargeBacklogWriteStrategy,
): SearchIndexSyncResult {
  let indexed = 0;
  const failures: SearchIndexSyncFailure[] = [];
  const loadEntries = (changes: PersistedSessionHeadChange[]) =>
    loadSearchIndexEntries(
      plan.agentName,
      changes,
      loadSessionData,
      (sessionId) => detailVersionForPlan(plan, sessionId),
      failures,
    );

  if (largeBacklogStrategy === "chunked" && plan.changes.length > SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
    runSearchIndexWrite(db, false, () => {
      indexed += writeSearchIndexRows(db, plan.agentName, plan.removedSessionIds, [], failures);
      if (plan.removedSessionIds.length > 0) advanceAnalyticsRevision(db);
    });
    for (let offset = 0; offset < plan.changes.length; offset += SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
      const chunk = plan.changes.slice(offset, offset + SEARCH_INDEX_COMMIT_CHUNK_SIZE);
      runSearchIndexWrite(db, false, () => {
        const chunkIndexed = writeSearchIndexRows(
          db,
          plan.agentName,
          [],
          loadEntries(chunk),
          failures,
        );
        indexed += chunkIndexed;
        if (chunkIndexed > 0) advanceAnalyticsRevision(db);
      });
    }
    return searchIndexSyncResult(plan, indexed, failures, undefined, "incremental");
  }

  const { rebuildDurationMs } = runSearchIndexWrite(db, plan.needsRebuild, () => {
    indexed = writeSearchIndexRows(
      db,
      plan.agentName,
      plan.removedSessionIds,
      loadEntries(plan.changes),
      failures,
    );
    if (indexed > 0 || plan.removedSessionIds.length > 0) advanceAnalyticsRevision(db);
  });
  return searchIndexSyncResult(plan, indexed, failures, rebuildDurationMs);
}

export function syncSessionSearchIndex(
  agentName: string,
  sessions: SessionHead[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): SearchIndexSyncResult | null {
  assertSessionProjectIdentities(agentName, sessions);
  return withSearchIndexDb((db) =>
    executeSearchIndexPlan(
      db,
      planSearchIndexWrite(db, agentName, { kind: "snapshot", sessions }, options),
      loadSessionData,
      "chunked",
    ),
  );
}

export function syncSessionSearchIndexChanges(
  agentName: string,
  changes: PersistedSessionHeadChange[],
  removedSessionIds: string[],
  loadSessionData: (sessionId: string) => SessionDetail,
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

  assertSessionProjectIdentities(
    agentName,
    changes.map(({ session }) => session),
  );

  return withSearchIndexDb((db) =>
    executeSearchIndexPlan(
      db,
      planSearchIndexWrite(db, agentName, { kind: "changes", changes, removedSessionIds }, options),
      loadSessionData,
      "atomic",
    ),
  );
}
