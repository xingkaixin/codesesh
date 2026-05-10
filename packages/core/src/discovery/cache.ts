/**
 * 扫描结果缓存 - 使用 SQLite 持久化扫描结果，为后续 FTS 复用同一存储。
 */

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ProjectGroup,
  ProjectIdentityKind,
  SessionData,
  SessionHead,
} from "../types/index.js";
import { buildProjectGroups, computeIdentity, realFs } from "../projects/index.js";
import {
  columnExists,
  getUserVersion,
  openDb,
  runSchemaMigrations,
  setUserVersion,
  tableExists,
  type DatabaseRow,
  type SQLiteDatabase,
} from "../utils/sqlite.js";

const CACHE_SCHEMA_VERSION = 6;
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

interface ProjectGroupRow extends DatabaseRow {
  identity_kind?: ProjectIdentityKind;
  identity_key?: string;
  display_name?: string;
  sources_csv?: string | null;
  session_count?: number;
  last_activity?: number | null;
}

interface ProjectBackfillSessionRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  session_json?: string;
}

interface ProjectBackfillDocumentRow extends DatabaseRow {
  id?: number;
  directory?: string;
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

function withCacheDb<T>(fn: (db: SQLiteDatabase) => T): T | null {
  const cachePath = getCachePath();
  const db = openDb(cachePath);
  if (!db) return null;

  try {
    ensureSchema(db, cachePath);
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function createCacheTables(db: SQLiteDatabase): void {
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
}

function createSearchTables(db: SQLiteDatabase): void {
  db.exec(`
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
}

function ensureProjectColumns(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents")) {
    return;
  }

  if (!columnExists(db, "session_documents", "project_identity_kind")) {
    db.exec(
      "ALTER TABLE session_documents ADD COLUMN project_identity_kind TEXT NOT NULL DEFAULT 'path'",
    );
  }
  if (!columnExists(db, "session_documents", "project_identity_key")) {
    db.exec(
      "ALTER TABLE session_documents ADD COLUMN project_identity_key TEXT NOT NULL DEFAULT ''",
    );
  }
  if (!columnExists(db, "session_documents", "project_display_name")) {
    db.exec(
      "ALTER TABLE session_documents ADD COLUMN project_display_name TEXT NOT NULL DEFAULT ''",
    );
  }
}

function createProjectTables(db: SQLiteDatabase): void {
  ensureProjectColumns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      identity_kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      directory TEXT NOT NULL,
      activity_time INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_project_sessions_identity
      ON project_sessions(identity_kind, identity_key);

    CREATE VIEW IF NOT EXISTS project_groups_v AS
      SELECT
        identity_kind,
        identity_key,
        MIN(display_name) AS display_name,
        GROUP_CONCAT(DISTINCT agent_name) AS sources_csv,
        COUNT(*) AS session_count,
        MAX(activity_time) AS last_activity
      FROM project_sessions
      GROUP BY identity_kind, identity_key;
  `);
}

function createLatestCacheSchema(db: SQLiteDatabase): void {
  createCacheTables(db);
  createSearchTables(db);
  createProjectTables(db);
}

function recreateSearchIndexSchema(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS session_documents_ai;
    DROP TRIGGER IF EXISTS session_documents_ad;
    DROP TRIGGER IF EXISTS session_documents_au;
    DROP TABLE IF EXISTS session_documents_fts;
  `);
  createSearchTables(db);
  rebuildSearchIndex(db);
}

function readLegacyCacheVersion(db: SQLiteDatabase): number {
  if (
    !tableExists(db, "cache_meta") ||
    !columnExists(db, "cache_meta", "key") ||
    !columnExists(db, "cache_meta", "value")
  ) {
    return 0;
  }

  const versionRow = db.prepare("SELECT value FROM cache_meta WHERE key = 'version'").get() as
    | DatabaseRow
    | undefined;
  return Number(versionRow?.value ?? 0);
}

function inferCacheSchemaVersion(db: SQLiteDatabase): number {
  if (
    tableExists(db, "project_sessions") ||
    columnExists(db, "session_documents", "project_identity_key")
  ) {
    return 5;
  }
  if (tableExists(db, "session_documents")) {
    return 4;
  }
  if (tableExists(db, "cached_sessions") || tableExists(db, "agent_cache")) {
    return 3;
  }
  return 0;
}

function getCurrentCacheSchemaVersion(db: SQLiteDatabase): number {
  const userVersion = getUserVersion(db);
  if (userVersion > 0) {
    return userVersion;
  }

  const legacyVersion = readLegacyCacheVersion(db);
  return Math.max(legacyVersion, inferCacheSchemaVersion(db));
}

function hasAnyCacheSchema(db: SQLiteDatabase): boolean {
  return [
    "cache_meta",
    "agent_cache",
    "cached_sessions",
    "session_documents",
    "session_documents_fts",
    "project_sessions",
  ].some((table) => tableExists(db, table));
}

function backfillProjectSessions(db: SQLiteDatabase): void {
  if (!tableExists(db, "cached_sessions") || !tableExists(db, "project_sessions")) {
    return;
  }

  const rows = db
    .prepare("SELECT agent_name, session_id, session_json FROM cached_sessions")
    .all() as ProjectBackfillSessionRow[];
  const upsert = db.prepare(`
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

  for (const row of rows) {
    if (!row.session_json || !row.agent_name || !row.session_id) {
      continue;
    }

    try {
      const session = JSON.parse(row.session_json) as SessionHead;
      const identity = session.project_identity ?? computeIdentity(session.directory, realFs);
      upsert.run(
        row.agent_name,
        row.session_id,
        identity.kind,
        identity.key,
        identity.displayName,
        session.directory,
        session.time_updated ?? session.time_created,
      );
    } catch {
      continue;
    }
  }
}

function backfillSessionDocumentProjects(db: SQLiteDatabase): void {
  if (
    !tableExists(db, "session_documents") ||
    !columnExists(db, "session_documents", "project_identity_key")
  ) {
    return;
  }

  const rows = db
    .prepare("SELECT id, directory FROM session_documents")
    .all() as ProjectBackfillDocumentRow[];
  const update = db.prepare(`
    UPDATE session_documents
    SET
      project_identity_kind = ?,
      project_identity_key = ?,
      project_display_name = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    const identity = computeIdentity(String(row.directory ?? ""), realFs);
    update.run(identity.kind, identity.key, identity.displayName, Number(row.id));
  }
}

function migrateProjectIdentity(db: SQLiteDatabase): void {
  createProjectTables(db);
  backfillProjectSessions(db);
  backfillSessionDocumentProjects(db);
}

function invalidateSearchContentHashes(db: SQLiteDatabase): void {
  if (
    tableExists(db, "session_documents") &&
    columnExists(db, "session_documents", "content_hash")
  ) {
    db.exec("UPDATE session_documents SET content_hash = ''");
  }
}

function rebuildSearchIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents_fts")) {
    return;
  }
  db.exec("INSERT INTO session_documents_fts(session_documents_fts) VALUES ('rebuild')");
}

function ensureFtsConsistency(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents_fts")) {
    createSearchTables(db);
  }

  try {
    db.exec(
      "INSERT INTO session_documents_fts(session_documents_fts, rank) VALUES ('integrity-check', 1)",
    );
  } catch {
    rebuildSearchIndex(db);
  }
}

function setCacheSchemaVersion(db: SQLiteDatabase): void {
  createCacheTables(db);
  setUserVersion(db, CACHE_SCHEMA_VERSION);
  db.prepare(
    `
      INSERT INTO cache_meta(key, value)
      VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run(String(CACHE_SCHEMA_VERSION));
}

function ensureSchema(db: SQLiteDatabase, dbPath: string): void {
  const currentVersion = getCurrentCacheSchemaVersion(db);
  if (currentVersion === 0 && !hasAnyCacheSchema(db)) {
    createLatestCacheSchema(db);
    setCacheSchemaVersion(db);
    return;
  }

  runSchemaMigrations(db, {
    dbPath,
    currentVersion,
    targetVersion: CACHE_SCHEMA_VERSION,
    backupLabel: "cache-migration",
    backupTables: ["agent_cache", "cached_sessions", "session_documents", "project_sessions"],
    migrations: [
      { version: 3, migrate: createCacheTables },
      { version: 4, migrate: createSearchTables },
      { version: 5, migrate: migrateProjectIdentity },
      {
        version: 6,
        destructive: true,
        migrate(db) {
          createLatestCacheSchema(db);
          recreateSearchIndexSchema(db);
          invalidateSearchContentHashes(db);
        },
      },
    ],
  });

  createLatestCacheSchema(db);
  ensureFtsConsistency(db);

  if (getUserVersion(db) <= CACHE_SCHEMA_VERSION) {
    setCacheSchemaVersion(db);
  }
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
    const deleteProjectSessions = db.prepare("DELETE FROM project_sessions WHERE agent_name = ?");
    const upsertAgent = db.prepare(`
      INSERT INTO agent_cache(agent_name, timestamp)
      VALUES (?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET timestamp = excluded.timestamp
    `);
    const insertSession = db.prepare(`
      INSERT INTO cached_sessions(agent_name, session_id, session_json, meta_json)
      VALUES (?, ?, ?, ?)
    `);
    const insertProjectSession = db.prepare(`
      INSERT INTO project_sessions(
        agent_name,
        session_id,
        identity_kind,
        identity_key,
        display_name,
        directory,
        activity_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const write = db.transaction(() => {
      const timestamp = Date.now();
      deleteAgent.run(agentName);
      deleteSessions.run(agentName);
      deleteProjectSessions.run(agentName);
      upsertAgent.run(agentName, timestamp);

      for (const session of sessions) {
        const identity = session.project_identity ?? computeIdentity(session.directory, realFs);
        insertSession.run(
          agentName,
          session.id,
          JSON.stringify(session),
          meta[session.id] ? JSON.stringify(meta[session.id]) : null,
        );
        insertProjectSession.run(
          agentName,
          session.id,
          identity.kind,
          identity.key,
          identity.displayName,
          session.directory,
          session.time_updated ?? session.time_created,
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
    const sizeRow = db.prepare("SELECT COUNT(*) AS value FROM cached_sessions").get() as
      | ScalarRow
      | undefined;

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

    const write = db.transaction(() => {
      for (const sessionId of toDelete) {
        deleteRow.run(agentName, sessionId);
      }

      for (const entry of loaded) {
        const activityTime = entry.session.time_updated ?? entry.session.time_created;
        const identity =
          entry.session.project_identity ?? computeIdentity(entry.session.directory, realFs);
        upsertRow.run(
          agentName,
          entry.session.id,
          entry.session.slug,
          entry.session.title,
          entry.session.directory,
          identity.kind,
          identity.key,
          identity.displayName,
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
            AND (? IS NULL OR d.project_identity_key = ? OR LOWER(d.directory) LIKE ?)
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
        options.cwd ?? null,
        options.cwd ? computeIdentity(options.cwd, realFs).key : null,
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

export function listCachedProjectGroups(sessions?: SessionHead[]): ProjectGroup[] {
  if (sessions) {
    return buildProjectGroups(sessions);
  }

  if (!hasCacheStorage()) {
    return [];
  }

  const groups = withCacheDb((db) => {
    const rows = db
      .prepare(
        `
          SELECT identity_kind, identity_key, display_name, sources_csv, session_count, last_activity
          FROM project_groups_v
          ORDER BY
            CASE identity_kind WHEN 'loose' THEN 1 ELSE 0 END,
            last_activity IS NULL,
            last_activity DESC
        `,
      )
      .all() as ProjectGroupRow[];

    return rows.map((row) => ({
      identityKind: row.identity_kind ?? "path",
      identityKey: String(row.identity_key ?? ""),
      displayName: String(row.display_name ?? ""),
      sources: String(row.sources_csv ?? "")
        .split(",")
        .filter(Boolean)
        .sort(),
      sessionCount: Number(row.session_count ?? 0),
      lastActivity: row.last_activity == null ? null : Number(row.last_activity),
    }));
  });

  return groups ?? [];
}
