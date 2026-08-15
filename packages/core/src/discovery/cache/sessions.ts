/**
 * Cache persistence: load / save / clear / info / initialization tracking.
 */
import { existsSync, rmSync, unlinkSync } from "node:fs";
import type { SessionCacheMeta } from "../../agents/base.js";
import type { ReferencedSessionHead, SessionReference } from "../../contract/index.js";
import { formatSessionReference, normalizeSessionReference } from "../../contract/index.js";
import type { SessionDetail, SessionHead } from "../../types/index.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import { tableExists, type SQLiteDatabase } from "../../utils/sqlite.js";
import {
  closeCacheStorage,
  getCachePath,
  getLegacyCachePath,
  hasCacheStorage,
  type ScalarRow,
  type PersistedSessionHeadChange,
} from "./db.js";
import { advanceAnalyticsRevision } from "./analytics-revision.js";
import {
  withCacheDb,
  withCacheDbOutcome,
  withCacheDbReadOnly,
  type CacheReadOutcome,
} from "./schema.js";
import {
  assertSessionProjectIdentities,
  messageFromCachedRow,
  prepareUpsertSession,
  sessionFromRow,
  sourcePathFromMeta,
  upsertSessionRow,
  type CachedMessageRow,
  type SessionRow,
} from "./messages.js";
import { fileActivityFromRow, type FileActivityRow } from "./file-activity.js";

export const CACHE_INITIALIZATION_VERSION = "session-cache-v2";
const FULL_SYNC_CURSOR_PREFIX = "full_sync_cursor:";
const SESSION_REFERENCE_QUERY_CHUNK_SIZE = 400;
const SESSION_HEAD_SELECT_COLUMNS = `
  s.agent_name,
  s.session_id,
  s.sort_index,
  s.slug,
  s.title,
  s.source_path,
  s.directory,
  s.parent_agent_name,
  s.parent_session_id,
  s.project_identity_kind,
  s.project_identity_key,
  s.project_display_name,
  s.project_identity_resolver_revision,
  s.project_identity_input_signature,
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
  s.smart_tags_source_updated_at,
  s.smart_tags_classifier_revision,
  s.meta_json
`;
export interface CachedResult {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  timestamp: number;
}

export interface CachedSessionDataEntry {
  data: SessionDetail;
  meta: SessionCacheMeta | null;
}

interface CachedSessionEntryBase {
  data: Omit<SessionDetail, "messages">;
  meta: SessionCacheMeta | null;
  detailVersion: string | null;
  pendingReindex: boolean;
}

export interface CachedSessionRawEntry extends CachedSessionEntryBase {
  messageRows: CachedMessageRow[];
}

export interface CachedSessionCursorEntry extends CachedSessionEntryBase {
  messageCount: number;
  messageDigest: string | null;
}

export interface CachedSessionCursorReader {
  messageDigest(messageCount: number): string | null;
  messageRows(startIndex: number): CachedMessageRow[];
}

export type SessionSnapshotCompleteness = "complete" | "partial";

export interface SaveCachedSessionsOptions {
  completeness?: SessionSnapshotCompleteness;
  removedSessionIds?: readonly string[];
}

function parseCachedSessionMeta(value: string | null | undefined): SessionCacheMeta | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as SessionCacheMeta;
  } catch {
    return null;
  }
}

export function deleteLegacyCacheFile(): void {
  const legacyPath = getLegacyCachePath();
  if (!existsSync(legacyPath)) {
    return;
  }

  try {
    unlinkSync(legacyPath);
  } catch {
    // Ignore legacy cleanup errors
  }
}

/**
 * Distinguishes "no cache yet" (success with null) from "the database read
 * failed" so callers can log the degradation instead of silently rescanning.
 */
export function readCachedSessions(agentName: string): CacheReadOutcome<CachedResult | null> {
  if (!hasCacheStorage()) {
    return { status: "success", value: null };
  }

  return withCacheDbOutcome((db) => {
    const timestampRow = db
      .prepare("SELECT timestamp AS value FROM agent_cache WHERE agent_name = ?")
      .get(agentName) as ScalarRow | undefined;
    const timestamp = Number(timestampRow?.value ?? 0);

    if (!timestamp) {
      return null;
    }

    const rows = db
      .prepare(
        `
          SELECT ${SESSION_HEAD_SELECT_COLUMNS}
          FROM sessions s
          WHERE s.agent_name = ? AND s.publication_id IS NULL
          ORDER BY s.activity_time DESC, s.session_id
        `,
      )
      .all(agentName) as SessionRow[];

    const sessions: SessionHead[] = [];
    const meta: Record<string, SessionCacheMeta> = {};

    for (const row of rows) {
      const session = sessionFromRow(row);
      sessions.push(session);

      if (row.meta_json) {
        meta[session.id] = JSON.parse(row.meta_json) as SessionCacheMeta;
      }
    }

    return { sessions, meta, timestamp };
  });
}

export function loadCachedSessions(agentName: string): CachedResult | null {
  const outcome = readCachedSessions(agentName);
  return outcome.status === "success" ? outcome.value : null;
}

export function loadCachedSessionHeads(
  references: readonly SessionReference[],
): ReferencedSessionHead[] {
  if (references.length === 0 || !hasCacheStorage()) return [];

  const unique = new Map<string, SessionReference>();
  for (const reference of references) {
    const normalized = normalizeSessionReference(reference);
    const key = formatSessionReference(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }

  const outcome = withCacheDbReadOnly((db) => {
    const resolved: ReferencedSessionHead[] = [];
    const normalized = [...unique.values()];
    for (let offset = 0; offset < normalized.length; offset += SESSION_REFERENCE_QUERY_CHUNK_SIZE) {
      const chunk = normalized.slice(offset, offset + SESSION_REFERENCE_QUERY_CHUNK_SIZE);
      const values = chunk.map(() => "(?, ?)").join(", ");
      const params = chunk.flatMap((reference) => [reference.agentName, reference.sessionId]);
      const rows = db
        .prepare(
          `
              WITH requested(agent_name, session_id) AS (
                VALUES ${values}
              )
              SELECT ${SESSION_HEAD_SELECT_COLUMNS}
              FROM requested r
              JOIN sessions s
                ON s.agent_name = r.agent_name
                AND s.session_id = r.session_id
                AND s.publication_id IS NULL
            `,
        )
        .all(...params) as SessionRow[];

      for (const row of rows) {
        resolved.push({
          reference: normalizeSessionReference({
            agentName: String(row.agent_name ?? ""),
            sessionId: String(row.session_id ?? ""),
          }),
          session: sessionFromRow(row),
        });
      }
    }
    return resolved;
  });
  return outcome.status === "success" ? outcome.value : [];
}

export function readAgentCacheInitialization(
  agentName: string,
  indexVersion = CACHE_INITIALIZATION_VERSION,
): CacheReadOutcome<boolean> {
  if (!hasCacheStorage()) {
    return { status: "success", value: false };
  }

  return withCacheDbReadOnly((db) => {
    if (!tableExists(db, "cache_initialization")) return false;
    const row = db
      .prepare(
        `
          SELECT index_version
          FROM cache_initialization
          WHERE agent_name = ?
        `,
      )
      .get(agentName) as { index_version?: string } | undefined;
    return row?.index_version === indexVersion;
  });
}

export function isAgentCacheInitialized(
  agentName: string,
  indexVersion = CACHE_INITIALIZATION_VERSION,
): boolean {
  const outcome = readAgentCacheInitialization(agentName, indexVersion);
  return outcome.status === "success" && outcome.value;
}

/**
 * Marks the cache as warm/usable so refreshes can rely on incremental checks
 * instead of a raw full scan. This is deliberately independent of full-history
 * reconciliation: a first scan may be bounded to a display window, so
 * last_sync_at defaults to 0 (never synced) here and is only advanced by
 * markAgentFullSyncCompleted once a genuine unbounded pass completes.
 */
export function markAgentCacheInitialized(
  agentName: string,
  indexVersion = CACHE_INITIALIZATION_VERSION,
): void {
  withCacheDb((db) => {
    db.prepare(
      `
        INSERT INTO cache_initialization(agent_name, initialized_at, index_version, last_sync_at)
        VALUES (?, ?, ?, 0)
        ON CONFLICT(agent_name) DO UPDATE SET
          index_version = excluded.index_version
      `,
    ).run(agentName, Date.now(), indexVersion);
  });
}

/**
 * Mark a full-history reconciliation as incomplete until it commits.
 * Returns whether the write reached disk, like saveCachedSessions.
 */
export function markAgentFullSyncStarted(agentName: string): boolean {
  const persisted = withCacheDb((db) => {
    db.prepare(
      `
        UPDATE cache_initialization
        SET last_sync_at = 0
        WHERE agent_name = ?
      `,
    ).run(agentName);
    return true;
  });
  return persisted ?? false;
}

/** Return the last durable source position reached by an incomplete full sync. */
export function getAgentFullSyncCursor(agentName: string): string | null {
  if (!hasCacheStorage()) return null;

  const outcome = withCacheDbReadOnly((db) => {
    const row = db
      .prepare("SELECT value FROM cache_meta WHERE key = ?")
      .get(`${FULL_SYNC_CURSOR_PREFIX}${agentName}`) as { value?: string } | undefined;
    return row?.value || null;
  });
  return outcome.status === "success" ? outcome.value : null;
}

/**
 * Persist a full-sync cursor only after the corresponding checkpoint is
 * durable. Returns whether the write reached disk — a dropped cursor means
 * every restart re-walks the whole history, so callers must not report the
 * checkpoint as durable on false.
 */
export function markAgentFullSyncProgress(agentName: string, cursor: string): boolean {
  if (!cursor) return true;

  const persisted = withCacheDb((db) => {
    db.prepare(
      `
        INSERT INTO cache_meta(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    ).run(`${FULL_SYNC_CURSOR_PREFIX}${agentName}`, cursor);
    return true;
  });
  return persisted ?? false;
}

export function readAgentLastFullSyncAt(agentName: string): CacheReadOutcome<number | null> {
  if (!hasCacheStorage()) {
    return { status: "success", value: null };
  }

  return withCacheDbReadOnly((db) => {
    if (!tableExists(db, "cache_initialization")) return null;
    const row = db
      .prepare(
        `
          SELECT last_sync_at
          FROM cache_initialization
          WHERE agent_name = ?
        `,
      )
      .get(agentName) as { last_sync_at?: number } | undefined;
    return row?.last_sync_at || null;
  });
}

/** Timestamp of the agent's last full (unbounded) history reconciliation, or null if none yet. */
export function getAgentLastFullSyncAt(agentName: string): number | null {
  const outcome = readAgentLastFullSyncAt(agentName);
  return outcome.status === "success" ? outcome.value : null;
}

/**
 * Record that a full (unbounded) history reconciliation just completed for
 * this agent. Returns whether the write reached disk.
 */
export function markAgentFullSyncCompleted(agentName: string): boolean {
  const completedAt = Date.now();
  const persisted = withCacheDb((db) => {
    db.transaction(() => {
      // Upsert: on a fresh cache the initialization row may not exist yet,
      // and a bare UPDATE would silently record nothing (last_sync_at would
      // read back as "never synced" and re-trigger a full backfill).
      db.prepare(
        `
          INSERT INTO cache_initialization(agent_name, initialized_at, index_version, last_sync_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(agent_name) DO UPDATE SET
            last_sync_at = excluded.last_sync_at
        `,
      ).run(agentName, completedAt, CACHE_INITIALIZATION_VERSION, completedAt);
      db.prepare("DELETE FROM cache_meta WHERE key = ?").run(
        `${FULL_SYNC_CURSOR_PREFIX}${agentName}`,
      );
    }).immediate();
    return true;
  });
  return persisted ?? false;
}

function loadCachedSessionEntryBase(
  db: SQLiteDatabase,
  agentName: string,
  sessionId: string,
): CachedSessionEntryBase | null {
  const row = db
    .prepare(
      `
        SELECT
          sessions.*,
          documents.detail_version AS detail_version
        FROM sessions
        LEFT JOIN session_documents AS documents
          ON documents.agent_name = sessions.agent_name
          AND documents.session_id = sessions.session_id
        WHERE sessions.agent_name = ?
          AND sessions.session_id = ?
          AND sessions.publication_id IS NULL
      `,
    )
    .get(agentName, sessionId) as SessionRow | undefined;

  if (!row) return null;

  const pendingReindex =
    db
      .prepare("SELECT 1 FROM pending_reindex WHERE agent_name = ? AND session_id = ?")
      .get(agentName, sessionId) != null;
  const fileActivityRows = db
    .prepare(
      `
        SELECT agent_name, session_id, project_identity_key, path, kind, count, latest_time
        FROM session_file_activity
        WHERE agent_name = ? AND session_id = ?
        ORDER BY latest_time DESC, count DESC, path
        LIMIT 500
      `,
    )
    .all(agentName, sessionId) as FileActivityRow[];

  return {
    data: {
      ...sessionFromRow(row),
      reference: { agentName, sessionId },
      file_activity: fileActivityRows.map((activityRow) => fileActivityFromRow(activityRow)),
    },
    meta: parseCachedSessionMeta(row.meta_json),
    detailVersion: typeof row.detail_version === "string" ? row.detail_version : null,
    pendingReindex,
  };
}

function readCachedSessionMessageRows(
  db: SQLiteDatabase,
  agentName: string,
  sessionId: string,
  startIndex: number,
): CachedMessageRow[] {
  return db
    .prepare(
      `
        SELECT
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
          nickname
        FROM messages
        WHERE agent_name = ? AND session_id = ? AND message_index >= ?
        ORDER BY message_index
      `,
    )
    .all(agentName, sessionId, startIndex) as CachedMessageRow[];
}

export function loadCachedSessionRawEntry(
  agentName: string,
  sessionId: string,
): CachedSessionRawEntry | null {
  if (!hasCacheStorage()) return null;

  const outcome = withCacheDbReadOnly((db) => {
    const entry = loadCachedSessionEntryBase(db, agentName, sessionId);
    return entry
      ? { ...entry, messageRows: readCachedSessionMessageRows(db, agentName, sessionId, 0) }
      : null;
  });
  return outcome.status === "success" ? outcome.value : null;
}

function readCachedSessionMessageDigest(
  db: SQLiteDatabase,
  agentName: string,
  sessionId: string,
  messageCount: number,
): string | null {
  if (!Number.isSafeInteger(messageCount) || messageCount <= 0) return null;
  const row = db
    .prepare(
      `
        SELECT content_chain_digest
        FROM messages
        WHERE agent_name = ? AND session_id = ? AND message_index = ?
      `,
    )
    .get(agentName, sessionId, messageCount - 1) as { content_chain_digest?: string | null };
  return typeof row?.content_chain_digest === "string" ? row.content_chain_digest : null;
}

export function readCachedSessionCursor<T>(
  agentName: string,
  sessionId: string,
  read: (entry: CachedSessionCursorEntry, cursor: CachedSessionCursorReader) => T,
): T | null {
  if (!hasCacheStorage()) return null;

  // A deferred transaction keeps cursor metadata and suffix rows in one snapshot.
  const outcome = withCacheDbReadOnly((db) =>
    db.transaction(() => {
      const entryBase = loadCachedSessionEntryBase(db, agentName, sessionId);
      if (!entryBase) return null;
      const messageState = db
        .prepare(
          `
            SELECT
              COUNT(*) AS message_count,
              (
                SELECT content_chain_digest
                FROM messages
                WHERE agent_name = ? AND session_id = ?
                ORDER BY message_index DESC
                LIMIT 1
              ) AS content_chain_digest
            FROM messages
            WHERE agent_name = ? AND session_id = ?
          `,
        )
        .get(agentName, sessionId, agentName, sessionId) as {
        message_count?: number;
        content_chain_digest?: string | null;
      };
      const entry: CachedSessionCursorEntry = {
        ...entryBase,
        messageCount: Number(messageState.message_count ?? 0),
        messageDigest:
          typeof messageState.content_chain_digest === "string"
            ? messageState.content_chain_digest
            : null,
      };
      return read(entry, {
        messageDigest: (messageCount) =>
          readCachedSessionMessageDigest(db, agentName, sessionId, messageCount),
        messageRows: (startIndex) =>
          Number.isSafeInteger(startIndex) && startIndex >= 0
            ? readCachedSessionMessageRows(db, agentName, sessionId, startIndex)
            : [],
      });
    })(),
  );
  return outcome.status === "success" ? outcome.value : null;
}

export function loadCachedSessionDataEntry(
  agentName: string,
  sessionId: string,
): CachedSessionDataEntry | null {
  const entry = loadCachedSessionRawEntry(agentName, sessionId);
  if (!entry) return null;
  return {
    data: {
      ...entry.data,
      messages: entry.pendingReindex
        ? []
        : entry.messageRows.map((messageRow) => messageFromCachedRow(messageRow)),
    },
    meta: entry.meta,
  };
}

export function loadCachedSessionData(agentName: string, sessionId: string): SessionDetail | null {
  return loadCachedSessionDataEntry(agentName, sessionId)?.data ?? null;
}

/**
 * Returns whether the write reached disk; on `false`, callers must not mark the cache initialized
 * or a full sync complete.
 */
export function saveCachedSessions(
  agentName: string,
  sessions: SessionHead[],
  meta: Record<string, SessionCacheMeta> = {},
  options: SaveCachedSessionsOptions = {},
): boolean {
  assertSessionProjectIdentities(agentName, sessions);
  const persisted = withCacheDb((db) => {
    db.transaction(() => {
      writeCachedSessionSnapshot(db, agentName, sessions, meta, options);
      advanceAnalyticsRevision(db);
    }).immediate();
    deleteLegacyCacheFile();
    return true;
  });

  return persisted ?? false;
}

export function writeCachedSessionSnapshot(
  db: SQLiteDatabase,
  agentName: string,
  sessions: SessionHead[],
  meta: Record<string, SessionCacheMeta> = {},
  options: SaveCachedSessionsOptions = {},
): void {
  const completeness = options.completeness ?? "complete";
  const deleteSession = db.prepare("DELETE FROM sessions WHERE agent_name = ? AND session_id = ?");
  const deleteSearchDocument = db.prepare(
    "DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?",
  );
  const deleteMessages = db.prepare("DELETE FROM messages WHERE agent_name = ? AND session_id = ?");
  const deleteModelCost = db.prepare(
    "DELETE FROM session_model_cost WHERE agent_name = ? AND session_id = ?",
  );
  const deleteCostSummary = db.prepare(
    "DELETE FROM session_cost_summary WHERE agent_name = ? AND session_id = ?",
  );
  const deleteMessageTools = db.prepare(
    "DELETE FROM message_tools WHERE agent_name = ? AND session_id = ?",
  );
  const deleteFileActivity = db.prepare(
    "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
  );
  const upsertAgent = db.prepare(`
    INSERT INTO agent_cache(agent_name, timestamp)
    VALUES (?, ?)
    ON CONFLICT(agent_name) DO UPDATE SET timestamp = excluded.timestamp
  `);
  const upsertSession = prepareUpsertSession(db);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const existingSessionIds = db
    .prepare("SELECT session_id FROM sessions WHERE agent_name = ?")
    .all(agentName) as SessionRow[];

  upsertAgent.run(agentName, Date.now());

  const sessionIdsToDelete = new Set(options.removedSessionIds ?? []);
  if (completeness === "complete") {
    for (const row of existingSessionIds) {
      const sessionId = String(row.session_id);
      if (!sessionIds.has(sessionId)) sessionIdsToDelete.add(sessionId);
    }
  }
  for (const sessionId of sessionIdsToDelete) {
    deleteSearchDocument.run(agentName, sessionId);
    deleteMessageTools.run(agentName, sessionId);
    deleteMessages.run(agentName, sessionId);
    deleteModelCost.run(agentName, sessionId);
    deleteCostSummary.run(agentName, sessionId);
    deleteFileActivity.run(agentName, sessionId);
    deleteSession.run(agentName, sessionId);
  }

  sessions.forEach((session, index) => {
    const sessionMeta = meta[session.id];
    const metaJson = sessionMeta ? JSON.stringify(sessionMeta) : null;
    upsertSessionRow(
      upsertSession,
      agentName,
      session,
      metaJson,
      index,
      sourcePathFromMeta(sessionMeta),
    );
  });
}

/**
 * Returns whether the write reached disk. On `false`, callers may serve the in-memory result
 * but must not advance the persistence timestamp, initialization marker, or durable baseline.
 */
export function saveCachedSessionChanges(
  agentName: string,
  changes: PersistedSessionHeadChange[],
  removedSessionIds: string[],
  meta: Record<string, SessionCacheMeta> = {},
): boolean {
  assertSessionProjectIdentities(
    agentName,
    changes.map(({ session }) => session),
  );
  const persisted = withCacheDb((db) => {
    db.transaction(() => {
      writeCachedSessionChanges(db, agentName, changes, removedSessionIds, meta);
      if (changes.length > 0 || removedSessionIds.length > 0) {
        advanceAnalyticsRevision(db);
      }
    }).immediate();
    deleteLegacyCacheFile();
    return true;
  });

  return persisted ?? false;
}

export function writeCachedSessionChanges(
  db: SQLiteDatabase,
  agentName: string,
  changes: PersistedSessionHeadChange[],
  removedSessionIds: string[],
  meta: Record<string, SessionCacheMeta> = {},
): void {
  const deleteSession = db.prepare("DELETE FROM sessions WHERE agent_name = ? AND session_id = ?");
  const deleteSearchDocument = db.prepare(
    "DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?",
  );
  const deleteMessages = db.prepare("DELETE FROM messages WHERE agent_name = ? AND session_id = ?");
  const deleteModelCost = db.prepare(
    "DELETE FROM session_model_cost WHERE agent_name = ? AND session_id = ?",
  );
  const deleteCostSummary = db.prepare(
    "DELETE FROM session_cost_summary WHERE agent_name = ? AND session_id = ?",
  );
  const deleteMessageTools = db.prepare(
    "DELETE FROM message_tools WHERE agent_name = ? AND session_id = ?",
  );
  const deleteFileActivity = db.prepare(
    "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
  );
  const upsertAgent = db.prepare(`
    INSERT INTO agent_cache(agent_name, timestamp)
    VALUES (?, ?)
    ON CONFLICT(agent_name) DO UPDATE SET timestamp = excluded.timestamp
  `);
  const upsertSession = prepareUpsertSession(db);

  upsertAgent.run(agentName, Date.now());

  for (const sessionId of new Set(removedSessionIds)) {
    deleteSearchDocument.run(agentName, sessionId);
    deleteMessageTools.run(agentName, sessionId);
    deleteMessages.run(agentName, sessionId);
    deleteModelCost.run(agentName, sessionId);
    deleteCostSummary.run(agentName, sessionId);
    deleteFileActivity.run(agentName, sessionId);
    deleteSession.run(agentName, sessionId);
  }

  for (const { session, sortIndex } of changes) {
    const sessionMeta = meta[session.id];
    if (!sessionMeta) {
      getCoreDiagnostics()?.warn("cache.session_meta_missing", {
        agent: agentName,
        session_id: session.id,
      });
    }
    const metaJson = sessionMeta ? JSON.stringify(sessionMeta) : null;
    upsertSessionRow(
      upsertSession,
      agentName,
      session,
      metaJson,
      sortIndex,
      sourcePathFromMeta(sessionMeta),
    );
  }
}

export function clearCache(): void {
  closeCacheStorage();
  if (!hasCacheStorage()) {
    deleteLegacyCacheFile();
    return;
  }

  withCacheDb((db) => {
    db.transaction(() => {
      db.exec(`
        DELETE FROM agent_cache;
        DELETE FROM cache_initialization;
        DELETE FROM cached_sessions;
        DELETE FROM pending_reindex;
        DELETE FROM search_index_publication_entries;
        DELETE FROM session_documents;
        DELETE FROM session_file_activity;
        DELETE FROM message_tools;
        DELETE FROM messages;
        DELETE FROM session_model_cost;
        DELETE FROM session_cost_summary;
        DELETE FROM sessions;
        DELETE FROM project_sessions;
        -- analytics_revision is an invalidation counter, not cached data.
        DELETE FROM cache_meta WHERE key <> 'analytics_revision';
      `);
      advanceAnalyticsRevision(db);
    }).immediate();
  });
  closeCacheStorage();

  deleteLegacyCacheFile();

  const cachePath = getCachePath();
  const walPath = `${cachePath}-wal`;
  const shmPath = `${cachePath}-shm`;

  for (const filePath of [walPath, shmPath]) {
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Ignore sidecar cleanup errors
    }
  }
}

export function getCacheInfo(): { lastScanTime: number | null; size: number } {
  if (!hasCacheStorage()) {
    return { lastScanTime: null, size: 0 };
  }

  const info = withCacheDb((db) => {
    const timestampRow = db.prepare("SELECT MAX(timestamp) AS value FROM agent_cache").get() as
      | ScalarRow
      | undefined;
    const sizeRow = db
      .prepare("SELECT COUNT(*) AS value FROM sessions WHERE publication_id IS NULL")
      .get() as ScalarRow | undefined;

    const lastScanTime = Number(timestampRow?.value ?? 0) || null;
    const size = Number(sizeRow?.value ?? 0);

    return { lastScanTime, size };
  });

  return info ?? { lastScanTime: null, size: 0 };
}
