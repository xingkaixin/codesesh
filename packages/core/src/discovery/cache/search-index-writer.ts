import type {
  ProjectIdentity,
  SessionData,
  SessionFileActivity,
  SessionHead,
} from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { SEARCH_INDEX_BULK_SYNC_THRESHOLD, type SessionHeadChange } from "./db.js";
import {
  buildSessionContentFromMessages,
  normalizeMessages,
  prepareInsertFileActivity,
  prepareInsertMessageTool,
  prepareUpsertIndexedSession,
  upsertSessionRow,
  writeFileActivityRows,
  type StructuredMessageRecord,
} from "./messages.js";
import {
  createMessageSearchTriggers,
  createSearchTriggers,
  dropMessageSearchTriggers,
  dropSearchTriggers,
  ensureFtsConsistency,
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

interface SearchIndexState {
  contentHashBySessionId: Map<string, string>;
  messageCountBySessionId: Map<string, number>;
}

type SearchIndexStateRow = IndexedSearchRow & MessageCountRow;

const SEARCH_INDEX_STATE_BATCH_SIZE = 900;

interface LoadedSearchIndexEntry {
  session: SessionHead;
  identity: ProjectIdentity;
  messages: StructuredMessageRecord[];
  contentText: string;
  contentHash: string;
  fileActivity: SessionFileActivity[];
  sortIndex: number;
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

function searchIndexStateFromRows(
  indexedRows: IndexedSearchRow[],
  messageCountRows: MessageCountRow[],
): SearchIndexState {
  return {
    contentHashBySessionId: new Map(
      indexedRows.map((row) => [String(row.session_id), String(row.content_hash ?? "")]),
    ),
    messageCountBySessionId: new Map(
      messageCountRows.map((row) => [String(row.session_id), Number(row.value ?? 0)]),
    ),
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
            COUNT(messages.message_index) AS value
          FROM requested_session_ids AS requested
          LEFT JOIN session_documents AS documents
            ON documents.agent_name = ? AND documents.session_id = requested.session_id
          LEFT JOIN messages
            ON messages.agent_name = ? AND messages.session_id = requested.session_id
          GROUP BY requested.session_id, documents.content_hash
        `,
      )
      .all(...batch, agentName, agentName) as SearchIndexStateRow[];
    rows.push(...batchRows);
  }

  return searchIndexStateFromRows(rows, rows);
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
    const sessionSortIndexMap = new Map(sessions.map((session, index) => [session.id, index]));
    const messageCountRows = db
      .prepare(
        "SELECT session_id, COUNT(*) AS value FROM messages WHERE agent_name = ? GROUP BY session_id",
      )
      .all(agentName) as MessageCountRow[];
    const searchIndexState = searchIndexStateFromRows(existingRows, messageCountRows);
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    const toDelete = existingRows
      .map((row) => String(row.session_id))
      .filter((sessionId) => !sessionMap.has(sessionId));
    const toUpsert = sessions.filter(
      (session) =>
        searchIndexState.contentHashBySessionId.get(session.id) !== sessionContentHash(session) ||
        searchIndexState.messageCountBySessionId.get(session.id) !== session.stats.message_count,
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
    const searchIndexState = readSearchIndexState(
      db,
      agentName,
      changes.map(({ session }) => session.id),
    );
    const toUpsert = changes.filter(
      ({ session }) =>
        (searchIndexState.contentHashBySessionId.get(session.id) ?? "") !==
          sessionContentHash(session) ||
        (searchIndexState.messageCountBySessionId.get(session.id) ?? 0) !==
          session.stats.message_count,
    );
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
