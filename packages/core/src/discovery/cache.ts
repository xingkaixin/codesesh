/**
 * 扫描结果缓存 - 使用 SQLite 持久化扫描结果，为后续 FTS 复用同一存储。
 */

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionData, SessionHead } from "../types/index.js";
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

interface IndexedSearchRow extends DatabaseRow {
  session_id?: string;
  content_hash?: string;
}

interface SearchResultRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  slug?: string;
  title?: string;
  directory?: string;
  time_created?: number;
  time_updated?: number | null;
  snippet?: string | null;
}

export interface SearchResult {
  agentName: string;
  session: SessionHead;
  snippet: string;
}

export interface SearchOptions {
  agent?: string;
  cwd?: string;
  from?: number;
  to?: number;
  limit?: number;
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

    CREATE TABLE IF NOT EXISTS session_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER,
      activity_time INTEGER NOT NULL,
      content_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(agent_name, session_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS session_documents_fts USING fts5(
      title,
      content_text,
      content='session_documents',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS session_documents_ai AFTER INSERT ON session_documents BEGIN
      INSERT INTO session_documents_fts(rowid, title, content_text)
      VALUES (new.id, new.title, new.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS session_documents_ad AFTER DELETE ON session_documents BEGIN
      INSERT INTO session_documents_fts(session_documents_fts, rowid, title, content_text)
      VALUES ('delete', old.id, old.title, old.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS session_documents_au AFTER UPDATE ON session_documents BEGIN
      INSERT INTO session_documents_fts(session_documents_fts, rowid, title, content_text)
      VALUES ('delete', old.id, old.title, old.content_text);
      INSERT INTO session_documents_fts(rowid, title, content_text)
      VALUES (new.id, new.title, new.content_text);
    END;
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
    DELETE FROM session_documents;
    INSERT INTO session_documents_fts(session_documents_fts) VALUES ('rebuild');
    INSERT INTO cache_meta(key, value)
    VALUES ('version', '${CACHE_VERSION}')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);
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
    session.stats.total_cost,
    session.stats.total_tokens ?? 0,
  ]);
}

function escapeFtsTerm(value: string): string {
  return value.replaceAll('"', '""');
}

function toFtsQuery(input: string): string {
  const tokens = input.match(/"[^"]+"|\S+/g) ?? [];
  return tokens
    .map((token) => {
      if (/^OR$/i.test(token)) {
        return "OR";
      }
      if (token.startsWith('"') && token.endsWith('"')) {
        return `"${escapeFtsTerm(token.slice(1, -1))}"`;
      }
      return `"${escapeFtsTerm(token)}"`;
    })
    .join(" ");
}

function appendPlainText(value: unknown, chunks: string[]): void {
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

function buildSessionContent(session: SessionData): string {
  const chunks: string[] = [];

  appendPlainText(session.title, chunks);

  for (const message of session.messages) {
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
  }

  return chunks.join("\n");
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

export function syncSessionSearchIndex(
  agentName: string,
  sessions: SessionHead[],
  loadSessionData: (sessionId: string) => SessionData,
): void {
  if (!hasCacheStorage()) {
    return;
  }

  withCacheDb((db) => {
    const existingRows = db
      .prepare(
        "SELECT session_id, content_hash FROM session_documents WHERE agent_name = ? ORDER BY id",
      )
      .all(agentName) as IndexedSearchRow[];
    const existingMap = new Map(
      existingRows.map((row) => [String(row.session_id), String(row.content_hash ?? "")]),
    );
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    const toDelete = existingRows
      .map((row) => String(row.session_id))
      .filter((sessionId) => !sessionMap.has(sessionId));
    const toUpsert = sessions.filter(
      (session) => existingMap.get(session.id) !== sessionContentHash(session),
    );

    const loaded = toUpsert
      .map((session) => {
        try {
        const data = loadSessionData(session.id);
        return {
          session,
          contentText: buildSessionContent(data),
          contentHash: sessionContentHash(session),
        };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const deleteRow = db.prepare(
      "DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?",
    );
    const upsertRow = db.prepare(`
      INSERT INTO session_documents(
        agent_name,
        session_id,
        slug,
        title,
        directory,
        time_created,
        time_updated,
        activity_time,
        content_text,
        content_hash,
        indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_name, session_id) DO UPDATE SET
        slug = excluded.slug,
        title = excluded.title,
        directory = excluded.directory,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated,
        activity_time = excluded.activity_time,
        content_text = excluded.content_text,
        content_hash = excluded.content_hash,
        indexed_at = excluded.indexed_at
    `);

    const write = db.transaction(() => {
      for (const sessionId of toDelete) {
        deleteRow.run(agentName, sessionId);
      }

      for (const entry of loaded) {
        const activityTime = entry.session.time_updated ?? entry.session.time_created;
        upsertRow.run(
          agentName,
          entry.session.id,
          entry.session.slug,
          entry.session.title,
          entry.session.directory,
          entry.session.time_created,
          entry.session.time_updated ?? null,
          activityTime,
          entry.contentText,
          entry.contentHash,
          Date.now(),
        );
      }
    });

    write();
  });
}

export function searchSessions(query: string, options: SearchOptions = {}): SearchResult[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || !hasCacheStorage()) {
    return [];
  }

  const ftsQuery = toFtsQuery(normalizedQuery);

  const results = withCacheDb((db) => {
    const rows = db
      .prepare(
        `
          SELECT
            d.agent_name,
            d.session_id,
            d.slug,
            d.title,
            d.directory,
            d.time_created,
            d.time_updated,
            COALESCE(
              NULLIF(snippet(session_documents_fts, 1, '<mark>', '</mark>', ' … ', 18), ''),
              highlight(session_documents_fts, 0, '<mark>', '</mark>')
            ) AS snippet
          FROM session_documents_fts
          JOIN session_documents d ON d.id = session_documents_fts.rowid
          WHERE session_documents_fts MATCH ?
            AND (? IS NULL OR d.agent_name = ?)
            AND (? IS NULL OR LOWER(d.directory) LIKE ?)
            AND (? IS NULL OR d.activity_time >= ?)
            AND (? IS NULL OR d.activity_time <= ?)
          ORDER BY bm25(session_documents_fts, 8.0, 1.0), d.activity_time DESC
          LIMIT ?
        `,
      )
      .all(
        ftsQuery,
        options.agent ?? null,
        options.agent ?? null,
        options.cwd?.toLowerCase() ?? null,
        options.cwd ? `%${options.cwd.toLowerCase()}%` : null,
        options.from ?? null,
        options.from ?? null,
        options.to ?? null,
        options.to ?? null,
        options.limit ?? 50,
      ) as SearchResultRow[];

    return rows.map((row) => ({
      agentName: String(row.agent_name),
      session: {
        id: String(row.session_id),
        slug: String(row.slug),
        title: String(row.title),
        directory: String(row.directory),
        time_created: Number(row.time_created),
        time_updated: row.time_updated == null ? undefined : Number(row.time_updated),
        stats: {
          message_count: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost: 0,
        },
      },
      snippet: String(row.snippet ?? ""),
    }));
  });

  return results ?? [];
}
