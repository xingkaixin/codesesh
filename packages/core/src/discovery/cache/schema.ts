/**
 * Schema, migrations, and the read/write DB handle factory. withCacheDb runs
 * ensureSchema on every write open, so all feature modules inherit migration.
 */
import type { ProjectIdentityKind, SessionHead } from "../../types/index.js";
import { computeIdentity, realFs } from "../../projects/index.js";
import { extractSessionFileActivity } from "../../utils/file-activity.js";
import { getCoreDiagnostics } from "../../utils/diagnostics.js";
import {
  columnExists,
  getUserVersion,
  openDb,
  openDbReadOnly,
  runSchemaMigrations,
  setUserVersion,
  tableExists,
  type DatabaseRow,
  type SQLiteDatabase,
} from "../../utils/sqlite.js";
import {
  getCachePath,
  getFtsIntegrityCheckedPath,
  getSchemaEnsuredPath,
  setFtsIntegrityCheckedPath,
  setSchemaEnsuredPath,
  type CacheRow,
} from "./db.js";
import {
  messageFromBackfillRow,
  prepareInsertFileActivity,
  prepareInsertMessageTool,
  prepareUpsertSession,
  sourcePathFromMetaJson,
  toolNamesFromMetadataJson,
  upsertSessionRow,
  writeFileActivityRows,
  type MessageBackfillRow,
  type SessionRow,
} from "./messages.js";

export const CACHE_SCHEMA_VERSION = 14;
export interface IndexedSearchRow extends DatabaseRow {
  session_id?: string;
  content_hash?: string;
  indexed_message_count?: number;
}

export interface MessageCountRow extends DatabaseRow {
  session_id?: string;
  value?: number;
}

export interface MessageToolBackfillRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  message_index?: number;
  tool_metadata_json?: string | null;
}

export interface ProjectBackfillSessionRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  session_json?: string;
  meta_json?: string | null;
  sort_index?: number;
}

export interface ProjectBackfillDocumentRow extends DatabaseRow {
  id?: number;
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
  activity_time?: number;
}

export interface ProjectIdentityRefreshRow extends DatabaseRow {
  id?: number;
  agent_name?: string;
  session_id?: string;
  directory?: string;
}

export function withCacheDb<T>(fn: (db: SQLiteDatabase) => T): T | null {
  const cachePath = getCachePath();
  const db = openDb(cachePath);
  if (!db) return null;

  try {
    if (getSchemaEnsuredPath() !== cachePath) {
      ensureSchema(db, cachePath);
      setSchemaEnsuredPath(cachePath);
    }
    return fn(db);
  } catch (error) {
    getCoreDiagnostics()?.warn("cache.write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    db.close();
  }
}

export function withCacheDbReadOnly<T>(fn: (db: SQLiteDatabase) => T): T | null {
  const db = openDbReadOnly(getCachePath());
  if (!db) return null;

  try {
    return fn(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export function createCacheTables(db: SQLiteDatabase): void {
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

    CREATE TABLE IF NOT EXISTS cache_initialization (
      agent_name TEXT PRIMARY KEY,
      initialized_at INTEGER NOT NULL,
      index_version TEXT NOT NULL,
      last_sync_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_reindex (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );
  `);
}

export function createSessionTables(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      source_path TEXT,
      directory TEXT NOT NULL,
      project_identity_kind TEXT NOT NULL,
      project_identity_key TEXT NOT NULL,
      project_display_name TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER,
      activity_time INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      total_input_tokens INTEGER NOT NULL,
      total_output_tokens INTEGER NOT NULL,
      total_cache_read_tokens INTEGER,
      total_cache_create_tokens INTEGER,
      total_cost REAL NOT NULL,
      cost_source TEXT,
      total_tokens INTEGER,
      model_usage_json TEXT,
      smart_tags_json TEXT,
      smart_tags_source_updated_at INTEGER,
      meta_json TEXT,
      PRIMARY KEY (agent_name, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity
      ON sessions(agent_name, activity_time);

    CREATE INDEX IF NOT EXISTS idx_sessions_project
      ON sessions(project_identity_kind, project_identity_key, activity_time);

    CREATE TABLE IF NOT EXISTS messages (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_completed INTEGER,
      agent TEXT,
      mode TEXT,
      model TEXT,
      provider TEXT,
      tokens_json TEXT,
      cost REAL,
      cost_source TEXT,
      parts_json TEXT NOT NULL,
      subagent_id TEXT,
      nickname TEXT,
      content_text TEXT NOT NULL,
      tool_metadata_json TEXT,
      PRIMARY KEY (agent_name, session_id, message_index),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES sessions(agent_name, session_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(agent_name, session_id, message_index);
  `);

  createMessageToolTables(db);
}

export function createMessageToolTables(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_tools (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id, message_index, tool_name),
      FOREIGN KEY (agent_name, session_id, message_index)
        REFERENCES messages(agent_name, session_id, message_index)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_message_tools_filter
      ON message_tools(tool_name, agent_name, session_id);
  `);
}

export function createMessageSearchTables(db: SQLiteDatabase): void {
  if (!tableExists(db, "messages")) {
    createSessionTables(db);
  }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content_text,
      content='messages',
      content_rowid='rowid'
    );
  `);

  createMessageSearchTriggers(db);
}

export function createMessageSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text)
      VALUES (new.rowid, new.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text)
      VALUES ('delete', old.rowid, old.content_text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text)
      VALUES ('delete', old.rowid, old.content_text);
      INSERT INTO messages_fts(rowid, content_text)
      VALUES (new.rowid, new.content_text);
    END;
  `);
}

export function dropMessageSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
  `);
}

export function createFileActivityTables(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_file_activity (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_identity_key TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL,
      latest_time INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id, project_identity_key, path, kind),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES sessions(agent_name, session_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_file_activity_project_latest
      ON session_file_activity(project_identity_key, latest_time);

    CREATE INDEX IF NOT EXISTS idx_file_activity_latest
      ON session_file_activity(latest_time DESC, count DESC, path);

    CREATE INDEX IF NOT EXISTS idx_file_activity_agent_latest
      ON session_file_activity(agent_name, latest_time DESC, count DESC, path);

    CREATE INDEX IF NOT EXISTS idx_file_activity_project_latest_ordered
      ON session_file_activity(project_identity_key, latest_time DESC, count DESC, path);

    CREATE INDEX IF NOT EXISTS idx_file_activity_path
      ON session_file_activity(path);

    CREATE INDEX IF NOT EXISTS idx_file_activity_kind
      ON session_file_activity(kind);
  `);

  createFileActivityPathSearchTables(db);
}

export function createFileActivityPathSearchTables(db: SQLiteDatabase): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_file_activity_path_fts USING fts5(
      path,
      content='session_file_activity',
      content_rowid='rowid',
      tokenize='trigram'
    );
  `);

  createFileActivityPathSearchTriggers(db);
}

export function createFileActivityPathSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS session_file_activity_path_ai
    AFTER INSERT ON session_file_activity BEGIN
      INSERT INTO session_file_activity_path_fts(rowid, path)
      VALUES (new.rowid, new.path);
    END;

    CREATE TRIGGER IF NOT EXISTS session_file_activity_path_ad
    AFTER DELETE ON session_file_activity BEGIN
      INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts, rowid, path)
      VALUES ('delete', old.rowid, old.path);
    END;

    CREATE TRIGGER IF NOT EXISTS session_file_activity_path_au
    AFTER UPDATE ON session_file_activity BEGIN
      INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts, rowid, path)
      VALUES ('delete', old.rowid, old.path);
      INSERT INTO session_file_activity_path_fts(rowid, path)
      VALUES (new.rowid, new.path);
    END;
  `);
}

export function rebuildFileActivityPathIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_file_activity_path_fts")) {
    return;
  }
  db.exec(
    "INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts) VALUES ('rebuild')",
  );
}

export function createSearchTables(db: SQLiteDatabase): void {
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
      indexed_message_count INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(agent_name, session_id)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS session_documents_fts USING fts5(
      title,
      content_text,
      content='session_documents',
      content_rowid='id'
    );
  `);

  createSearchTriggers(db);
}

export function createSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
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

export function addIndexedMessageCount(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents")) return;

  if (!columnExists(db, "session_documents", "indexed_message_count")) {
    db.exec(
      "ALTER TABLE session_documents ADD COLUMN indexed_message_count INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!tableExists(db, "messages")) return;

  db.exec(`
    UPDATE session_documents
    SET indexed_message_count = (
      SELECT COUNT(*)
      FROM messages
      WHERE messages.agent_name = session_documents.agent_name
        AND messages.session_id = session_documents.session_id
    )
  `);
}

export function dropSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS session_documents_ai;
    DROP TRIGGER IF EXISTS session_documents_ad;
    DROP TRIGGER IF EXISTS session_documents_au;
  `);
}

export function ensureProjectColumns(db: SQLiteDatabase): void {
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

export function createProjectTables(db: SQLiteDatabase): void {
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
  `);
  createProjectGroupsView(db);
}

export function createProjectGroupsView(db: SQLiteDatabase): void {
  if (!tableExists(db, "sessions")) {
    db.exec(`
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
    return;
  }

  db.exec(`
    CREATE VIEW IF NOT EXISTS project_groups_v AS
      SELECT
        project_identity_kind AS identity_kind,
        project_identity_key AS identity_key,
        MIN(project_display_name) AS display_name,
        GROUP_CONCAT(DISTINCT agent_name) AS sources_csv,
        COUNT(*) AS session_count,
        MAX(activity_time) AS last_activity
      FROM sessions
      GROUP BY project_identity_kind, project_identity_key;
  `);
}

export function recreateProjectGroupsView(db: SQLiteDatabase): void {
  db.exec("DROP VIEW IF EXISTS project_groups_v");
  createProjectGroupsView(db);
}

export function createLatestCacheSchema(db: SQLiteDatabase): void {
  createCacheTables(db);
  createSessionTables(db);
  createMessageSearchTables(db);
  createFileActivityTables(db);
  createSearchTables(db);
  createProjectTables(db);
}

export function recreateSearchIndexSchema(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS session_documents_ai;
    DROP TRIGGER IF EXISTS session_documents_ad;
    DROP TRIGGER IF EXISTS session_documents_au;
    DROP TABLE IF EXISTS session_documents_fts;
  `);
  createSearchTables(db);
  rebuildSearchIndex(db);
}

export function readLegacyCacheVersion(db: SQLiteDatabase): number {
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

export function inferCacheSchemaVersion(db: SQLiteDatabase): number {
  if (columnExists(db, "session_documents", "indexed_message_count")) {
    return 14;
  }
  if (tableExists(db, "message_tools")) {
    return 11;
  }
  if (tableExists(db, "session_file_activity_path_fts")) {
    return 10;
  }
  if (tableExists(db, "messages_fts")) {
    return 9;
  }
  if (tableExists(db, "session_file_activity")) {
    return 8;
  }
  if (tableExists(db, "sessions") || tableExists(db, "messages")) {
    return 7;
  }
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

export function getCurrentCacheSchemaVersion(db: SQLiteDatabase): number {
  const userVersion = getUserVersion(db);
  if (userVersion > 0) {
    return userVersion;
  }

  const legacyVersion = readLegacyCacheVersion(db);
  return Math.max(legacyVersion, inferCacheSchemaVersion(db));
}

export function hasAnyCacheSchema(db: SQLiteDatabase): boolean {
  return [
    "cache_meta",
    "agent_cache",
    "cached_sessions",
    "sessions",
    "messages",
    "message_tools",
    "session_file_activity",
    "session_file_activity_path_fts",
    "session_documents",
    "session_documents_fts",
    "project_sessions",
  ].some((table) => tableExists(db, table));
}

export function backfillProjectSessions(db: SQLiteDatabase): void {
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

export function backfillSessionDocumentProjects(db: SQLiteDatabase): void {
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

export function migrateProjectIdentity(db: SQLiteDatabase): void {
  createProjectTables(db);
  backfillProjectSessions(db);
  backfillSessionDocumentProjects(db);
}

export function refreshProjectIdentities(db: SQLiteDatabase): void {
  if (
    tableExists(db, "sessions") &&
    columnExists(db, "sessions", "project_identity_key") &&
    columnExists(db, "sessions", "directory")
  ) {
    const rows = db
      .prepare("SELECT agent_name, session_id, directory FROM sessions")
      .all() as ProjectIdentityRefreshRow[];
    const update = db.prepare(`
      UPDATE sessions
      SET
        project_identity_kind = ?,
        project_identity_key = ?,
        project_display_name = ?
      WHERE agent_name = ? AND session_id = ?
    `);
    const updateFileActivity =
      tableExists(db, "session_file_activity") &&
      columnExists(db, "session_file_activity", "project_identity_key")
        ? db.prepare(`
            UPDATE session_file_activity
            SET project_identity_key = ?
            WHERE agent_name = ? AND session_id = ?
          `)
        : null;

    for (const row of rows) {
      const identity = computeIdentity(String(row.directory ?? ""), realFs);
      update.run(identity.kind, identity.key, identity.displayName, row.agent_name, row.session_id);
      updateFileActivity?.run(identity.key, row.agent_name, row.session_id);
    }
  }

  if (
    tableExists(db, "project_sessions") &&
    columnExists(db, "project_sessions", "identity_key") &&
    columnExists(db, "project_sessions", "directory")
  ) {
    const rows = db
      .prepare("SELECT agent_name, session_id, directory FROM project_sessions")
      .all() as ProjectIdentityRefreshRow[];
    const update = db.prepare(`
      UPDATE project_sessions
      SET
        identity_kind = ?,
        identity_key = ?,
        display_name = ?
      WHERE agent_name = ? AND session_id = ?
    `);

    for (const row of rows) {
      const identity = computeIdentity(String(row.directory ?? ""), realFs);
      update.run(identity.kind, identity.key, identity.displayName, row.agent_name, row.session_id);
    }
  }

  backfillSessionDocumentProjects(db);
  recreateProjectGroupsView(db);
}

export function backfillStructuredSessions(db: SQLiteDatabase): void {
  createSessionTables(db);
  recreateProjectGroupsView(db);
  const upsertSession = prepareUpsertSession(db);

  if (tableExists(db, "cached_sessions")) {
    const rows = db
      .prepare(
        "SELECT agent_name, session_id, session_json, meta_json, rowid AS sort_index FROM cached_sessions ORDER BY agent_name, rowid",
      )
      .all() as CacheRow[];

    for (const row of rows) {
      if (!row.agent_name || !row.session_json) {
        continue;
      }

      try {
        const session = JSON.parse(row.session_json) as SessionHead;
        upsertSessionRow(
          upsertSession,
          String(row.agent_name),
          session,
          row.meta_json ?? null,
          Number(row.sort_index ?? 0),
          sourcePathFromMetaJson(row.meta_json),
        );
      } catch {
        continue;
      }
    }
  }

  if (!tableExists(db, "session_documents")) {
    return;
  }

  const documentRows = db
    .prepare(
      `
        SELECT
          d.agent_name,
          d.session_id,
          d.slug,
          d.title,
          d.directory,
          d.project_identity_kind,
          d.project_identity_key,
          d.project_display_name,
          d.time_created,
          d.time_updated,
          d.activity_time,
          d.id
        FROM session_documents d
        LEFT JOIN sessions s ON s.agent_name = d.agent_name AND s.session_id = d.session_id
        WHERE s.session_id IS NULL
        ORDER BY d.id
      `,
    )
    .all() as ProjectBackfillDocumentRow[];

  for (const row of documentRows) {
    const directory = String(row.directory ?? "");
    const identity =
      row.project_identity_key && row.project_identity_kind && row.project_display_name
        ? {
            kind: row.project_identity_kind,
            key: String(row.project_identity_key),
            displayName: String(row.project_display_name),
          }
        : computeIdentity(directory, realFs);

    upsertSessionRow(
      upsertSession,
      String(row.agent_name),
      {
        id: String(row.session_id),
        slug: String(row.slug),
        title: String(row.title),
        directory,
        project_identity: identity,
        time_created: Number(row.time_created ?? row.activity_time ?? 0),
        time_updated: row.time_updated == null ? undefined : Number(row.time_updated),
        stats: {
          message_count: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost: 0,
        },
      },
      null,
      Number(row.id ?? 0),
      null,
    );
  }
}

export function backfillMessageTools(db: SQLiteDatabase): void {
  createMessageToolTables(db);
  if (!tableExists(db, "messages")) {
    return;
  }

  db.exec("DELETE FROM message_tools");
  const rows = db
    .prepare(
      `
        SELECT agent_name, session_id, message_index, tool_metadata_json
        FROM messages
        WHERE tool_metadata_json IS NOT NULL
      `,
    )
    .all() as MessageToolBackfillRow[];
  const insertTool = prepareInsertMessageTool(db);

  for (const row of rows) {
    if (!row.agent_name || !row.session_id || row.message_index == null) {
      continue;
    }

    for (const toolName of toolNamesFromMetadataJson(row.tool_metadata_json)) {
      insertTool.run(row.agent_name, row.session_id, row.message_index, toolName);
    }
  }
}

export function backfillFileActivity(db: SQLiteDatabase): void {
  createFileActivityTables(db);
  if (!tableExists(db, "sessions") || !tableExists(db, "messages")) {
    return;
  }

  const sessions = db
    .prepare(
      `
        SELECT agent_name, session_id, project_identity_key
        FROM sessions
        ORDER BY agent_name, session_id
      `,
    )
    .all() as SessionRow[];
  const loadMessages = db.prepare(`
    SELECT
      message_id,
      role,
      time_created,
      time_completed,
      agent,
      mode,
      model,
      provider,
      parts_json,
      subagent_id,
      nickname
    FROM messages
    WHERE agent_name = ? AND session_id = ?
    ORDER BY message_index
  `);
  const deleteActivity = db.prepare(
    "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
  );
  const insertActivity = prepareInsertFileActivity(db);

  for (const session of sessions) {
    if (!session.agent_name || !session.session_id || !session.project_identity_key) {
      continue;
    }

    try {
      const rows = loadMessages.all(session.agent_name, session.session_id) as MessageBackfillRow[];
      const messages = rows.map((row) => messageFromBackfillRow(row));
      const activities = extractSessionFileActivity(
        String(session.agent_name),
        String(session.session_id),
        String(session.project_identity_key),
        messages,
      );
      deleteActivity.run(session.agent_name, session.session_id);
      writeFileActivityRows(insertActivity, activities);
    } catch {
      continue;
    }
  }
}

export function invalidateSearchContentHashes(db: SQLiteDatabase): void {
  if (
    tableExists(db, "session_documents") &&
    columnExists(db, "session_documents", "content_hash")
  ) {
    db.exec("UPDATE session_documents SET content_hash = ''");
  }
}

const CODEX_EXEC_DECODE_MIGRATION_KEY = "codex_exec_decode_migrated_v3";

/**
 * One-time: mark every cached Codex detail as pending re-index so code-mode
 * exec decoding takes effect on upgrade. The search content hash derives only
 * from head-level fields, none of which the decoder touches, so nothing would
 * otherwise trigger a refresh. Session rows carry huge content_text, so
 * rewriting them (or clearing a hash) is slow; instead we record just the
 * session ids in the lightweight pending_reindex table. loadCachedSessionData
 * treats a marked session as pending and re-parses its detail fresh on view;
 * the search index clears the marker as it repopulates each one. Gated by a
 * cache_meta flag; a fresh cache just records it.
 */
export function migrateCodexExecDecode(db: SQLiteDatabase): void {
  if (!tableExists(db, "cache_meta")) return;
  const done = db
    .prepare("SELECT value FROM cache_meta WHERE key = ?")
    .get(CODEX_EXEC_DECODE_MIGRATION_KEY);
  if (done) return;

  if (tableExists(db, "sessions") && tableExists(db, "pending_reindex")) {
    db.exec(
      "INSERT OR IGNORE INTO pending_reindex(agent_name, session_id) " +
        "SELECT agent_name, session_id FROM sessions WHERE agent_name = 'codex'",
    );
  }
  db.prepare(
    "INSERT INTO cache_meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
  ).run(CODEX_EXEC_DECODE_MIGRATION_KEY);
}

export function rebuildSearchIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents_fts")) {
    return;
  }
  db.exec("INSERT INTO session_documents_fts(session_documents_fts) VALUES ('rebuild')");
}

export function rebuildMessageSearchIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "messages_fts")) {
    return;
  }
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}

export function ensureFtsReady(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents_fts")) {
    createSearchTables(db);
  }
  createSearchTriggers(db);

  const needsMessageSearchRebuild = !tableExists(db, "messages_fts");
  createMessageSearchTables(db);
  if (needsMessageSearchRebuild) {
    rebuildMessageSearchIndex(db);
  }
}

export function ensureFtsConsistency(db: SQLiteDatabase): void {
  ensureFtsReady(db);
  const cachePath = getCachePath();
  if (getFtsIntegrityCheckedPath() === cachePath) {
    return;
  }

  try {
    db.exec(
      "INSERT INTO session_documents_fts(session_documents_fts, rank) VALUES ('integrity-check', 1)",
    );
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
    setFtsIntegrityCheckedPath(cachePath);
  } catch {
    rebuildSearchIndex(db);
    rebuildMessageSearchIndex(db);
    setFtsIntegrityCheckedPath(cachePath);
  }
}

export function setCacheSchemaVersion(db: SQLiteDatabase): void {
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

export function ensureSchema(db: SQLiteDatabase, dbPath: string): void {
  const currentVersion = getCurrentCacheSchemaVersion(db);
  if (currentVersion === 0 && !hasAnyCacheSchema(db)) {
    createLatestCacheSchema(db);
    setCacheSchemaVersion(db);
    migrateCodexExecDecode(db);
    return;
  }

  runSchemaMigrations(db, {
    dbPath,
    currentVersion,
    targetVersion: CACHE_SCHEMA_VERSION,
    backupLabel: "cache-migration",
    backupTables: [
      "agent_cache",
      "cache_initialization",
      "cached_sessions",
      "sessions",
      "messages",
      "message_tools",
      "session_file_activity",
      "session_documents",
      "project_sessions",
    ],
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
      { version: 7, migrate: backfillStructuredSessions },
      { version: 8, migrate: backfillFileActivity },
      {
        version: 9,
        migrate(db) {
          createMessageSearchTables(db);
          rebuildMessageSearchIndex(db);
        },
      },
      {
        version: 10,
        migrate(db) {
          createFileActivityPathSearchTables(db);
          rebuildFileActivityPathIndex(db);
        },
      },
      {
        version: 11,
        migrate(db) {
          backfillMessageTools(db);
        },
      },
      {
        version: 12,
        migrate(db) {
          refreshProjectIdentities(db);
        },
      },
      { version: 13, migrate: createCacheTables },
      { version: 14, migrate: addIndexedMessageCount },
    ],
  });

  createLatestCacheSchema(db);

  if (getUserVersion(db) <= CACHE_SCHEMA_VERSION) {
    setCacheSchemaVersion(db);
  }

  migrateCodexExecDecode(db);
}
