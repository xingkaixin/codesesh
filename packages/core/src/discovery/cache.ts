/**
 * 扫描结果缓存 - 使用 SQLite 持久化扫描结果，为后续 FTS 复用同一存储。
 */

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionHead } from "../types/index.js";
import { openDb, type DatabaseRow } from "../utils/sqlite.js";

const CACHE_VERSION = 3;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILENAME = "codesesh.db";
const LEGACY_CACHE_FILENAME = "scan-cache.json";

export interface SessionCacheMeta {
  id: string;
  sourcePath: string;
  [key: string]: unknown;
}

export interface CachedResult {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  timestamp: number;
}

interface ScalarRow extends DatabaseRow {
  value?: number;
}

interface CacheRow extends DatabaseRow {
  session_json?: string;
  meta_json?: string | null;
}

function getCacheDir(): string {
  return join(homedir(), ".cache", "codesesh");
}

function getCachePath(): string {
  return join(getCacheDir(), CACHE_FILENAME);
}

function getLegacyCachePath(): string {
  return join(getCacheDir(), LEGACY_CACHE_FILENAME);
}

function hasCacheStorage(): boolean {
  return existsSync(getCachePath());
}

function withCacheDb<T>(fn: (db: NonNullable<ReturnType<typeof openDb>>) => T): T | null {
  const db = openDb(getCachePath());
  if (!db) return null;

  try {
    ensureSchema(db);
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function ensureSchema(db: NonNullable<ReturnType<typeof openDb>>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_cache (
      agent_name TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cached_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      meta_json TEXT,
      PRIMARY KEY (agent_name, session_id)
    );
  `);

  const versionRow = db.prepare("SELECT value FROM cache_meta WHERE key = 'version'").get() as
    | DatabaseRow
    | undefined;
  const version = Number(versionRow?.value ?? 0);

  if (version === CACHE_VERSION) {
    return;
  }

  db.exec(`
    DELETE FROM agent_cache;
    DELETE FROM cached_sessions;
    INSERT INTO cache_meta(key, value)
    VALUES ('version', '${CACHE_VERSION}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
}

function deleteLegacyCacheFile(): void {
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

    if (!timestamp || Date.now() - timestamp > CACHE_TTL) {
      return null;
    }

    const rows = db
      .prepare(
        `
          SELECT session_json, meta_json
          FROM cached_sessions
          WHERE agent_name = ?
          ORDER BY rowid
        `,
      )
      .all(agentName) as CacheRow[];

    const sessions: SessionHead[] = [];
    const meta: Record<string, SessionCacheMeta> = {};

    for (const row of rows) {
      if (!row.session_json) {
        continue;
      }

      const session = JSON.parse(row.session_json) as SessionHead;
      sessions.push(session);

      if (row.meta_json) {
        meta[session.id] = JSON.parse(row.meta_json) as SessionCacheMeta;
      }
    }

    return { sessions, meta, timestamp };
  });
}

export function saveCachedSessions(
  agentName: string,
  sessions: SessionHead[],
  meta: Record<string, SessionCacheMeta> = {},
): void {
  withCacheDb((db) => {
    const deleteAgent = db.prepare("DELETE FROM agent_cache WHERE agent_name = ?");
    const deleteSessions = db.prepare("DELETE FROM cached_sessions WHERE agent_name = ?");
    const upsertAgent = db.prepare(`
      INSERT INTO agent_cache(agent_name, timestamp)
      VALUES (?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET timestamp = excluded.timestamp
    `);
    const insertSession = db.prepare(`
      INSERT INTO cached_sessions(agent_name, session_id, session_json, meta_json)
      VALUES (?, ?, ?, ?)
    `);

    const write = db.transaction(() => {
      const timestamp = Date.now();
      deleteAgent.run(agentName);
      deleteSessions.run(agentName);
      upsertAgent.run(agentName, timestamp);

      for (const session of sessions) {
        insertSession.run(
          agentName,
          session.id,
          JSON.stringify(session),
          meta[session.id] ? JSON.stringify(meta[session.id]) : null,
        );
      }
    });

    write();
    deleteLegacyCacheFile();
  });
}

export function clearCache(): void {
  if (!hasCacheStorage()) {
    deleteLegacyCacheFile();
    return;
  }

  withCacheDb((db) => {
    db.exec(`
      DELETE FROM agent_cache;
      DELETE FROM cached_sessions;
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
    const timestampRow = db
      .prepare("SELECT MAX(timestamp) AS value FROM agent_cache")
      .get() as ScalarRow | undefined;
    const sizeRow = db
      .prepare("SELECT COUNT(*) AS value FROM cached_sessions")
      .get() as ScalarRow | undefined;

    const lastScanTime = Number(timestampRow?.value ?? 0) || null;
    const size = Number(sizeRow?.value ?? 0);

    return { lastScanTime, size };
  });

  return info ?? { lastScanTime: null, size: 0 };
}
