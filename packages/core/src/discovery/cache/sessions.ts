/**
 * Cache persistence: load / save / clear / info / initialization tracking.
 */
import { existsSync, rmSync, unlinkSync } from "node:fs";
import type { SessionData, SessionHead } from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import { tableExists } from "../../utils/sqlite.js";
import {
  getCachePath,
  getLegacyCachePath,
  hasCacheStorage,
  setFtsIntegrityCheckedPath,
  type ScalarRow,
  type SessionCacheMeta,
  type SessionHeadChange,
} from "./db.js";
import { withCacheDb, withCacheDbReadOnly } from "./schema.js";
import {
  messageFromCachedRow,
  prepareUpsertCachedSession,
  prepareUpsertProjectSession,
  prepareUpsertSession,
  sessionFromRow,
  sourcePathFromMeta,
  upsertSessionRow,
  writeProjectSessionRow,
  type CachedMessageRow,
  type SessionRow,
} from "./messages.js";
import { fileActivityFromRow, type FileActivityRow } from "./file-activity.js";

export const CACHE_INITIALIZATION_VERSION = "session-cache-v2";
export interface CachedResult {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  timestamp: number;
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

export function loadCachedSessions(agentName: string): CachedResult | null {
  if (!hasCacheStorage()) {
    return null;
  }

  return withCacheDb((db) => {
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
          SELECT
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
          FROM sessions
          WHERE agent_name = ?
          ORDER BY sort_index, activity_time DESC
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

export function isAgentCacheInitialized(
  agentName: string,
  indexVersion = CACHE_INITIALIZATION_VERSION,
): boolean {
  if (!hasCacheStorage()) {
    return false;
  }

  return (
    withCacheDbReadOnly((db) => {
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
    }) ?? false
  );
}

export function markAgentCacheInitialized(
  agentName: string,
  indexVersion = CACHE_INITIALIZATION_VERSION,
): void {
  withCacheDb((db) => {
    const now = Date.now();
    db.prepare(
      `
        INSERT INTO cache_initialization(agent_name, initialized_at, index_version, last_sync_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_name) DO UPDATE SET
          index_version = excluded.index_version,
          last_sync_at = excluded.last_sync_at
      `,
    ).run(agentName, now, indexVersion, now);
  });
}

export function loadCachedSessionData(agentName: string, sessionId: string): SessionData | null {
  if (!hasCacheStorage()) {
    return null;
  }

  return withCacheDbReadOnly((db) => {
    const row = db
      .prepare(
        `
          SELECT
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
          FROM sessions
          WHERE agent_name = ? AND session_id = ?
        `,
      )
      .get(agentName, sessionId) as SessionRow | undefined;

    if (!row) {
      return null;
    }

    const messageRows = db
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
            subagent_id,
            nickname
          FROM messages
          WHERE agent_name = ? AND session_id = ?
          ORDER BY message_index
        `,
      )
      .all(agentName, sessionId) as CachedMessageRow[];

    const head = sessionFromRow(row);
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
      ...head,
      messages: messageRows.map((messageRow) => messageFromCachedRow(messageRow)),
      file_activity: fileActivityRows.map((activityRow) => fileActivityFromRow(activityRow)),
    };
  });
}

export function saveCachedSessions(
  agentName: string,
  sessions: SessionHead[],
  meta: Record<string, SessionCacheMeta> = {},
): void {
  withCacheDb((db) => {
    const deleteAgent = db.prepare("DELETE FROM agent_cache WHERE agent_name = ?");
    const deleteLegacySessions = db.prepare("DELETE FROM cached_sessions WHERE agent_name = ?");
    const deleteSession = db.prepare(
      "DELETE FROM sessions WHERE agent_name = ? AND session_id = ?",
    );
    const deleteSearchDocument = db.prepare(
      "DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?",
    );
    const deleteMessages = db.prepare(
      "DELETE FROM messages WHERE agent_name = ? AND session_id = ?",
    );
    const deleteMessageTools = db.prepare(
      "DELETE FROM message_tools WHERE agent_name = ? AND session_id = ?",
    );
    const deleteFileActivity = db.prepare(
      "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
    );
    const deleteProjectSession = db.prepare(
      "DELETE FROM project_sessions WHERE agent_name = ? AND session_id = ?",
    );
    const deleteProjectSessions = db.prepare("DELETE FROM project_sessions WHERE agent_name = ?");
    const upsertAgent = db.prepare(`
      INSERT INTO agent_cache(agent_name, timestamp)
      VALUES (?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET timestamp = excluded.timestamp
    `);
    const upsertCachedSession = prepareUpsertCachedSession(db);
    const upsertSession = prepareUpsertSession(db);
    const upsertProjectSession = prepareUpsertProjectSession(db);

    const write = db.transaction(() => {
      const timestamp = Date.now();
      const sessionIds = new Set(sessions.map((session) => session.id));
      const existingSessionIds = db
        .prepare("SELECT session_id FROM sessions WHERE agent_name = ?")
        .all(agentName) as SessionRow[];
      deleteAgent.run(agentName);
      deleteLegacySessions.run(agentName);
      deleteProjectSessions.run(agentName);
      upsertAgent.run(agentName, timestamp);

      for (const row of existingSessionIds) {
        const sessionId = String(row.session_id);
        if (!sessionIds.has(sessionId)) {
          deleteSearchDocument.run(agentName, sessionId);
          deleteMessageTools.run(agentName, sessionId);
          deleteMessages.run(agentName, sessionId);
          deleteFileActivity.run(agentName, sessionId);
          deleteProjectSession.run(agentName, sessionId);
          deleteSession.run(agentName, sessionId);
        }
      }

      sessions.forEach((session, index) => {
        const identity = session.project_identity ?? computeIdentity(session.directory, realFs);
        const sessionMeta = meta[session.id];
        const metaJson = sessionMeta ? JSON.stringify(sessionMeta) : null;
        upsertCachedSession.run(agentName, session.id, JSON.stringify(session), metaJson);
        upsertSessionRow(
          upsertSession,
          agentName,
          session,
          metaJson,
          index,
          sourcePathFromMeta(sessionMeta),
        );
        writeProjectSessionRow(upsertProjectSession, agentName, session, identity);
      });
    });

    write();
    deleteLegacyCacheFile();
  });
}

export function saveCachedSessionChanges(
  agentName: string,
  changes: SessionHeadChange[],
  removedSessionIds: string[],
  meta: Record<string, SessionCacheMeta> = {},
): void {
  if (changes.length === 0 && removedSessionIds.length === 0) {
    return;
  }

  withCacheDb((db) => {
    const deleteLegacySession = db.prepare(
      "DELETE FROM cached_sessions WHERE agent_name = ? AND session_id = ?",
    );
    const deleteSession = db.prepare(
      "DELETE FROM sessions WHERE agent_name = ? AND session_id = ?",
    );
    const deleteSearchDocument = db.prepare(
      "DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?",
    );
    const deleteMessages = db.prepare(
      "DELETE FROM messages WHERE agent_name = ? AND session_id = ?",
    );
    const deleteMessageTools = db.prepare(
      "DELETE FROM message_tools WHERE agent_name = ? AND session_id = ?",
    );
    const deleteFileActivity = db.prepare(
      "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
    );
    const deleteProjectSession = db.prepare(
      "DELETE FROM project_sessions WHERE agent_name = ? AND session_id = ?",
    );
    const upsertAgent = db.prepare(`
      INSERT INTO agent_cache(agent_name, timestamp)
      VALUES (?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET timestamp = excluded.timestamp
    `);
    const upsertCachedSession = prepareUpsertCachedSession(db);
    const upsertSession = prepareUpsertSession(db);
    const upsertProjectSession = prepareUpsertProjectSession(db);

    const write = db.transaction(() => {
      upsertAgent.run(agentName, Date.now());

      for (const sessionId of new Set(removedSessionIds)) {
        deleteLegacySession.run(agentName, sessionId);
        deleteSearchDocument.run(agentName, sessionId);
        deleteMessageTools.run(agentName, sessionId);
        deleteMessages.run(agentName, sessionId);
        deleteFileActivity.run(agentName, sessionId);
        deleteProjectSession.run(agentName, sessionId);
        deleteSession.run(agentName, sessionId);
      }

      for (const { session, sortIndex } of changes) {
        const identity = session.project_identity ?? computeIdentity(session.directory, realFs);
        const sessionMeta = meta[session.id];
        const metaJson = sessionMeta ? JSON.stringify(sessionMeta) : null;
        upsertCachedSession.run(agentName, session.id, JSON.stringify(session), metaJson);
        upsertSessionRow(
          upsertSession,
          agentName,
          session,
          metaJson,
          sortIndex,
          sourcePathFromMeta(sessionMeta),
        );
        writeProjectSessionRow(upsertProjectSession, agentName, session, identity);
      }
    });

    write();
    deleteLegacyCacheFile();
  });
}

export function clearCache(): void {
  setFtsIntegrityCheckedPath(null);
  if (!hasCacheStorage()) {
    deleteLegacyCacheFile();
    return;
  }

  withCacheDb((db) => {
    db.exec(`
      DELETE FROM agent_cache;
      DELETE FROM cache_initialization;
      DELETE FROM cached_sessions;
      DELETE FROM session_documents;
      DELETE FROM session_file_activity;
      DELETE FROM message_tools;
      DELETE FROM messages;
      DELETE FROM sessions;
      DELETE FROM project_sessions;
    `);
  });

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
    const sizeRow = db.prepare("SELECT COUNT(*) AS value FROM sessions").get() as
      | ScalarRow
      | undefined;

    const lastScanTime = Number(timestampRow?.value ?? 0) || null;
    const size = Number(sizeRow?.value ?? 0);

    return { lastScanTime, size };
  });

  return info ?? { lastScanTime: null, size: 0 };
}
