import type { SessionCacheMeta } from "../../agents/base.js";
import type { SessionDetail, SessionFileActivity, SessionHead } from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { SEARCH_INDEX_BULK_SYNC_THRESHOLD, type SessionHeadChange } from "./db.js";
import {
  buildSessionContentFromMessages,
  MESSAGE_PARTS_FORMAT_VERSION,
  normalizeMessages,
  prepareInsertFileActivity,
  prepareInsertMessageTool,
  prepareUpsertIndexedSession,
  upsertSessionRow,
  writeFileActivityRows,
  type StructuredMessageRecord,
} from "./messages.js";
import { runSearchIndexWrite, withSearchIndexDb } from "./schema.js";
import { sessionDetailVersion } from "./detail-version.js";
import type { SessionSnapshotCompleteness } from "./sessions.js";

export interface SearchIndexSyncOptions {
  isBulk?: boolean;
  bulkThreshold?: number;
  detailVersions?: Readonly<Record<string, string>>;
  completeness?: SessionSnapshotCompleteness;
  removedSessionIds?: readonly string[];
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

interface SearchIndexState {
  contentHashBySessionId: Map<string, string>;
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

type SearchIndexStateRow = IndexedSearchRow & MessageCountRow;

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

function detailVersionFromMetaJson(value: string | null | undefined): string {
  if (!value) return sessionDetailVersion(null);
  try {
    return sessionDetailVersion(JSON.parse(value) as SessionCacheMeta);
  } catch {
    return sessionDetailVersion(null);
  }
}

function searchIndexStateFromRows(
  indexedRows: IndexedSearchRow[],
  messageCountRows: MessageCountRow[],
  pendingReindexSessionIds: Set<string> = new Set(),
): SearchIndexState {
  return {
    contentHashBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), String(row.content_hash ?? "")]),
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

function readSearchIndexState(
  db: SQLiteDatabase,
  agentName: string,
  sessionIds: string[],
): SearchIndexState {
  const rows: SearchIndexStateRow[] = [];
  const uniqueSessionIds = [...new Set(sessionIds)];

  for (let offset = 0; offset < uniqueSessionIds.length; offset += SEARCH_INDEX_STATE_BATCH_SIZE) {
    const batch = uniqueSessionIds.slice(offset, offset + SEARCH_INDEX_STATE_BATCH_SIZE);
    const requestedRows = batch.map(() => "(?)").join(", ");
    const batchRows = db
      .prepare(
        `
          WITH requested_session_ids(session_id) AS (VALUES ${requestedRows})
          SELECT
            requested.session_id,
            documents.content_hash,
            documents.indexed_message_count,
            documents.detail_version,
            sessions.meta_json,
            COUNT(messages.message_index) AS value
          FROM requested_session_ids AS requested
          LEFT JOIN session_documents AS documents
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
            sessions.meta_json
        `,
      )
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
  const sessionId = session.id;
  return (
    state.pendingReindexSessionIds.has(sessionId) ||
    state.detailVersionBySessionId.get(sessionId) !==
      targetDetailVersion(state, sessionId, options) ||
    state.contentHashBySessionId.get(sessionId) !== sessionContentHash(session) ||
    state.indexedMessageCountBySessionId.get(sessionId) !==
      (state.messageCountBySessionId.get(sessionId) ?? 0)
  );
}

function loadSearchIndexEntry(
  agentName: string,
  change: SessionHeadChange,
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersion: string,
  failures: SearchIndexSyncFailure[],
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
      detailVersion,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ sessionId: change.session.id, reason: "parse-failed", message });
    getCoreDiagnostics()?.warn("search_index.session_parse_failed", {
      agent: agentName,
      session_id: change.session.id,
      message,
    });
    return null;
  }
}

function* loadSearchIndexEntries(
  agentName: string,
  changes: Iterable<SessionHeadChange>,
  loadSessionData: (sessionId: string) => SessionDetail,
  detailVersionFor: (sessionId: string) => string,
  failures: SearchIndexSyncFailure[],
): Generator<LoadedSearchIndexEntry> {
  for (const change of changes) {
    const entry = loadSearchIndexEntry(
      agentName,
      change,
      loadSessionData,
      detailVersionFor(change.session.id),
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
): number {
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
      parts_format_version,
      subagent_id,
      nickname,
      content_text,
      tool_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    clearPendingReindex.run(agentName, sessionId);
  }

  let indexed = 0;
  for (const entry of entries) {
    const current = readCurrentMeta.get(agentName, entry.session.id) as
      | { meta_json?: string | null }
      | undefined;
    if (entry.detailVersion !== detailVersionFromMetaJson(current?.meta_json)) {
      failures.push({ sessionId: entry.session.id, reason: "superseded" });
      continue;
    }
    upsertSessionRow(upsertIndexedSession, agentName, entry.session, null, entry.sortIndex, null);
    deleteFileActivity.run(agentName, entry.session.id);
    deleteMessageTools.run(agentName, entry.session.id, 0);
    clearPendingReindex.run(agentName, entry.session.id);
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
        MESSAGE_PARTS_FORMAT_VERSION,
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

export function syncSessionSearchIndex(
  agentName: string,
  sessions: SessionHead[],
  loadSessionData: (sessionId: string) => SessionDetail,
  options: SearchIndexSyncOptions = {},
): SearchIndexSyncResult | null {
  return withSearchIndexDb((db) => {
    const startedAt = performance.now();
    const existingRows = db
      .prepare("SELECT session_id FROM session_documents WHERE agent_name = ? ORDER BY id")
      .all(agentName) as IndexedSearchRow[];
    const sessionSortIndexMap = new Map(sessions.map((session, index) => [session.id, index]));
    const searchIndexState = readSearchIndexState(
      db,
      agentName,
      sessions.map((session) => session.id),
    );
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    const explicitRemovedSessionIds = new Set(options.removedSessionIds ?? []);
    const completeness = options.completeness ?? "complete";
    const toDelete = existingRows
      .map((row) => String(row.session_id))
      .filter(
        (sessionId) =>
          explicitRemovedSessionIds.has(sessionId) ||
          (completeness === "complete" && !sessionMap.has(sessionId)),
      );
    const toUpsert = sessions.filter((session) =>
      searchIndexEntryNeedsUpdate(searchIndexState, session, options),
    );
    const changedCount = toDelete.length + toUpsert.length;
    const isBulk = shouldBulkSyncSearchIndex(options, changedCount);
    const changes = toUpsert.map((session) => ({
      session,
      sortIndex: sessionSortIndexMap.get(session.id) ?? 0,
    }));
    let indexed = 0;
    const failures: SearchIndexSyncFailure[] = [];
    const detailVersionFor = (sessionId: string) =>
      targetDetailVersion(searchIndexState, sessionId, options);

    // A large backlog (e.g. the first full-history backfill) takes minutes to
    // parse; one transaction would roll all of it back on interrupt. Chunked
    // commits keep the FTS triggers active so every chunk is durable, and a
    // restarted sync skips already-indexed sessions via their content hashes.
    if (changes.length > SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
      runSearchIndexWrite(db, false, () => {
        indexed += writeSearchIndexRows(db, agentName, toDelete, [], failures);
      });
      for (let offset = 0; offset < changes.length; offset += SEARCH_INDEX_COMMIT_CHUNK_SIZE) {
        const chunk = changes.slice(offset, offset + SEARCH_INDEX_COMMIT_CHUNK_SIZE);
        runSearchIndexWrite(db, false, () => {
          indexed += writeSearchIndexRows(
            db,
            agentName,
            [],
            loadSearchIndexEntries(agentName, chunk, loadSessionData, detailVersionFor, failures),
            failures,
          );
        });
      }
      return {
        agentName,
        mode: "incremental",
        sessions: sessions.length,
        changed: toUpsert.length,
        deleted: toDelete.length,
        indexed,
        skipped: toUpsert.length - indexed,
        failures: failures.length > 0 ? failures : undefined,
        durationMs: performance.now() - startedAt,
      };
    }

    const writeRows = () => {
      indexed = writeSearchIndexRows(
        db,
        agentName,
        toDelete,
        loadSearchIndexEntries(agentName, changes, loadSessionData, detailVersionFor, failures),
        failures,
      );
    };

    const needsRebuild = isBulk && changedCount > 0;
    const { rebuildDurationMs } = runSearchIndexWrite(db, needsRebuild, writeRows);

    return {
      agentName,
      mode: isBulk ? "bulk" : "incremental",
      sessions: sessions.length,
      changed: toUpsert.length,
      deleted: toDelete.length,
      indexed,
      skipped: toUpsert.length - indexed,
      failures: failures.length > 0 ? failures : undefined,
      durationMs: performance.now() - startedAt,
      rebuildDurationMs,
    };
  });
}

export function syncSessionSearchIndexChanges(
  agentName: string,
  changes: SessionHeadChange[],
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

  return withSearchIndexDb((db) => {
    const startedAt = performance.now();
    const searchIndexState = readSearchIndexState(
      db,
      agentName,
      changes.map(({ session }) => session.id),
    );
    const toUpsert = changes.filter(({ session }) =>
      searchIndexEntryNeedsUpdate(searchIndexState, session, options),
    );
    const uniqueRemovedSessionIds = Array.from(new Set(removedSessionIds));
    const changedCount = uniqueRemovedSessionIds.length + toUpsert.length;
    const isBulk = shouldBulkSyncSearchIndex(options, changedCount);
    let indexed = 0;
    const failures: SearchIndexSyncFailure[] = [];
    const detailVersionFor = (sessionId: string) =>
      targetDetailVersion(searchIndexState, sessionId, options);
    const writeRows = () => {
      indexed = writeSearchIndexRows(
        db,
        agentName,
        uniqueRemovedSessionIds,
        loadSearchIndexEntries(agentName, toUpsert, loadSessionData, detailVersionFor, failures),
        failures,
      );
    };

    const needsRebuild = isBulk && changedCount > 0;
    const { rebuildDurationMs } = runSearchIndexWrite(db, needsRebuild, writeRows);

    return {
      agentName,
      mode: isBulk ? "bulk" : "incremental",
      sessions: changes.length,
      changed: toUpsert.length,
      deleted: uniqueRemovedSessionIds.length,
      indexed,
      skipped: toUpsert.length - indexed,
      failures: failures.length > 0 ? failures : undefined,
      durationMs: performance.now() - startedAt,
      rebuildDurationMs,
    };
  });
}
