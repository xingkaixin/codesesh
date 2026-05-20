/**
 * 扫描结果缓存 - 使用 SQLite 持久化扫描结果，为后续 FTS 复用同一存储。
 */

import { existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  FileActivityKind,
  Message,
  MessagePart,
  ProjectIdentity,
  ProjectGroup,
  ProjectIdentityKind,
  SessionFileActivity,
  SessionData,
  SessionHead,
  SmartTag,
} from "../types/index.js";
import { buildProjectGroups, computeIdentity, realFs } from "../projects/index.js";
import { extractSessionFileActivity } from "../utils/file-activity.js";
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

const CACHE_SCHEMA_VERSION = 9;
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILENAME = "codesesh.db";
const LEGACY_CACHE_FILENAME = "scan-cache.json";
const SEARCH_INDEX_BULK_SYNC_THRESHOLD = 100;
let ftsIntegrityCheckedPath: string | null = null;

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

export interface SessionHeadChange {
  session: SessionHead;
  sortIndex: number;
}

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

interface ScalarRow extends DatabaseRow {
  value?: number;
}

interface CacheRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  session_json?: string;
  meta_json?: string | null;
  sort_index?: number;
}

type SQLiteStatement = ReturnType<SQLiteDatabase["prepare"]>;

interface SessionRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  sort_index?: number;
  slug?: string;
  title?: string;
  source_path?: string | null;
  directory?: string;
  project_identity_kind?: ProjectIdentityKind;
  project_identity_key?: string;
  project_display_name?: string;
  time_created?: number;
  time_updated?: number | null;
  activity_time?: number;
  message_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number | null;
  total_cache_create_tokens?: number | null;
  total_cost?: number;
  cost_source?: SessionHead["stats"]["cost_source"] | null;
  total_tokens?: number | null;
  model_usage_json?: string | null;
  smart_tags_json?: string | null;
  smart_tags_source_updated_at?: number | null;
  meta_json?: string | null;
}

interface IndexedSearchRow extends DatabaseRow {
  session_id?: string;
  content_hash?: string;
}

interface MessageCountRow extends DatabaseRow {
  session_id?: string;
  value?: number;
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

interface MessageBackfillRow extends DatabaseRow {
  message_id?: string;
  role?: Message["role"];
  time_created?: number;
  time_completed?: number | null;
  agent?: string | null;
  mode?: string | null;
  model?: string | null;
  provider?: string | null;
  parts_json?: string;
  subagent_id?: string | null;
  nickname?: string | null;
}

interface SearchResultRow extends DatabaseRow {
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

interface FileActivityRow extends SearchResultRow {
  project_identity_key?: string;
  path?: string;
  kind?: FileActivityKind;
  count?: number;
  latest_time?: number;
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
  meta_json?: string | null;
  sort_index?: number;
}

interface ProjectBackfillDocumentRow extends DatabaseRow {
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

interface StructuredMessageRecord {
  index: number;
  id: string;
  role: Message["role"];
  timeCreated: number;
  timeCompleted?: number | null;
  agent?: string | null;
  mode?: string | null;
  model?: string | null;
  provider?: string | null;
  tokensJson?: string | null;
  cost?: number | null;
  costSource?: string | null;
  partsJson: string;
  subagentId?: string | null;
  nickname?: string | null;
  contentText: string;
  toolMetadataJson?: string | null;
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

export interface FileActivityOptions {
  agent?: string;
  sessionId?: string;
  projectKey?: string;
  project?: string;
  cwd?: string;
  path?: string;
  kind?: FileActivityKind;
  from?: number;
  to?: number;
  limit?: number;
}

export interface FileActivityResult extends SessionFileActivity {
  session: SessionHead;
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

function createSessionTables(db: SQLiteDatabase): void {
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
}

function createMessageSearchTables(db: SQLiteDatabase): void {
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

function createMessageSearchTriggers(db: SQLiteDatabase): void {
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

function dropMessageSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
  `);
}

function createFileActivityTables(db: SQLiteDatabase): void {
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

    CREATE INDEX IF NOT EXISTS idx_file_activity_path
      ON session_file_activity(path);

    CREATE INDEX IF NOT EXISTS idx_file_activity_kind
      ON session_file_activity(kind);
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
  `);

  createSearchTriggers(db);
}

function createSearchTriggers(db: SQLiteDatabase): void {
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

function dropSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS session_documents_ai;
    DROP TRIGGER IF EXISTS session_documents_ad;
    DROP TRIGGER IF EXISTS session_documents_au;
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
  `);
  createProjectGroupsView(db);
}

function createProjectGroupsView(db: SQLiteDatabase): void {
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

function recreateProjectGroupsView(db: SQLiteDatabase): void {
  db.exec("DROP VIEW IF EXISTS project_groups_v");
  createProjectGroupsView(db);
}

function createLatestCacheSchema(db: SQLiteDatabase): void {
  createCacheTables(db);
  createSessionTables(db);
  createMessageSearchTables(db);
  createFileActivityTables(db);
  createSearchTables(db);
  createProjectTables(db);
}

function stringifyOptionalJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseOptionalJson<T>(value: unknown): T | undefined {
  return value == null ? undefined : (JSON.parse(String(value)) as T);
}

function sourcePathFromMeta(meta: SessionCacheMeta | undefined): string | null {
  return typeof meta?.sourcePath === "string" ? meta.sourcePath : null;
}

function sourcePathFromMetaJson(metaJson: string | null | undefined): string | null {
  if (!metaJson) return null;
  const meta = JSON.parse(metaJson) as SessionCacheMeta;
  return sourcePathFromMeta(meta);
}

function prepareUpsertCachedSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO cached_sessions(agent_name, session_id, session_json, meta_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      session_json = excluded.session_json,
      meta_json = excluded.meta_json
  `);
}

function prepareUpsertProjectSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
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
}

function prepareUpsertSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO sessions(
      agent_name,
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
      activity_time,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id) DO UPDATE SET
      sort_index = excluded.sort_index,
      slug = excluded.slug,
      title = excluded.title,
      source_path = excluded.source_path,
      directory = excluded.directory,
      project_identity_kind = excluded.project_identity_kind,
      project_identity_key = excluded.project_identity_key,
      project_display_name = excluded.project_display_name,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated,
      activity_time = excluded.activity_time,
      message_count = excluded.message_count,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cache_create_tokens = excluded.total_cache_create_tokens,
      total_cost = excluded.total_cost,
      cost_source = excluded.cost_source,
      total_tokens = excluded.total_tokens,
      model_usage_json = excluded.model_usage_json,
      smart_tags_json = excluded.smart_tags_json,
      smart_tags_source_updated_at = excluded.smart_tags_source_updated_at,
      meta_json = excluded.meta_json
  `);
}

function prepareUpsertIndexedSession(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO sessions(
      agent_name,
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
      activity_time,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      message_count = excluded.message_count,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cache_create_tokens = excluded.total_cache_create_tokens,
      total_cost = excluded.total_cost,
      cost_source = excluded.cost_source,
      total_tokens = excluded.total_tokens,
      model_usage_json = excluded.model_usage_json,
      smart_tags_json = excluded.smart_tags_json,
      smart_tags_source_updated_at = excluded.smart_tags_source_updated_at
  `);
}

function upsertSessionRow(
  statement: SQLiteStatement,
  agentName: string,
  session: SessionHead,
  metaJson: string | null,
  sortIndex: number,
  sourcePath: string | null,
): void {
  const identity = session.project_identity ?? computeIdentity(session.directory, realFs);
  const activityTime = session.time_updated ?? session.time_created;
  statement.run(
    agentName,
    session.id,
    sortIndex,
    session.slug,
    session.title,
    sourcePath,
    session.directory,
    identity.kind,
    identity.key,
    identity.displayName,
    session.time_created,
    session.time_updated ?? null,
    activityTime,
    session.stats.message_count,
    session.stats.total_input_tokens,
    session.stats.total_output_tokens,
    session.stats.total_cache_read_tokens ?? null,
    session.stats.total_cache_create_tokens ?? null,
    session.stats.total_cost,
    session.stats.cost_source ?? null,
    session.stats.total_tokens ?? null,
    stringifyOptionalJson(session.model_usage),
    stringifyOptionalJson(session.smart_tags),
    session.smart_tags_source_updated_at ?? null,
    metaJson,
  );
}

function prepareInsertFileActivity(db: SQLiteDatabase): SQLiteStatement {
  return db.prepare(`
    INSERT INTO session_file_activity(
      agent_name,
      session_id,
      project_identity_key,
      path,
      kind,
      count,
      latest_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
}

function writeFileActivityRows(
  statement: SQLiteStatement,
  activities: SessionFileActivity[],
): void {
  for (const activity of activities) {
    statement.run(
      activity.agent_name,
      activity.session_id,
      activity.project_identity_key,
      activity.path,
      activity.kind,
      activity.count,
      activity.latest_time,
    );
  }
}

function writeProjectSessionRow(
  statement: SQLiteStatement,
  agentName: string,
  session: SessionHead,
  identity: ProjectIdentity,
): void {
  statement.run(
    agentName,
    session.id,
    identity.kind,
    identity.key,
    identity.displayName,
    session.directory,
    session.time_updated ?? session.time_created,
  );
}

function sessionFromRow(row: SessionRow): SessionHead {
  const session: SessionHead = {
    id: String(row.session_id),
    slug: String(row.slug),
    title: String(row.title),
    directory: String(row.directory),
    time_created: Number(row.time_created),
    stats: {
      message_count: Number(row.message_count ?? 0),
      total_input_tokens: Number(row.total_input_tokens ?? 0),
      total_output_tokens: Number(row.total_output_tokens ?? 0),
      total_cost: Number(row.total_cost ?? 0),
    },
  };

  if (row.project_identity_key) {
    session.project_identity = {
      kind: row.project_identity_kind ?? "path",
      key: String(row.project_identity_key),
      displayName: String(row.project_display_name ?? ""),
    };
  }
  if (row.time_updated != null) {
    session.time_updated = Number(row.time_updated);
  }
  if (row.total_cache_read_tokens != null) {
    session.stats.total_cache_read_tokens = Number(row.total_cache_read_tokens);
  }
  if (row.total_cache_create_tokens != null) {
    session.stats.total_cache_create_tokens = Number(row.total_cache_create_tokens);
  }
  if (row.cost_source) {
    session.stats.cost_source = row.cost_source;
  }
  if (row.total_tokens != null) {
    session.stats.total_tokens = Number(row.total_tokens);
  }

  const modelUsage = parseOptionalJson<Record<string, number>>(row.model_usage_json);
  if (modelUsage) {
    session.model_usage = modelUsage;
  }

  const smartTags = parseOptionalJson<SessionHead["smart_tags"]>(row.smart_tags_json);
  if (smartTags) {
    session.smart_tags = smartTags;
  }
  if (row.smart_tags_source_updated_at != null) {
    session.smart_tags_source_updated_at = Number(row.smart_tags_source_updated_at);
  }

  return session;
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
    "sessions",
    "messages",
    "session_file_activity",
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

function backfillStructuredSessions(db: SQLiteDatabase): void {
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

function messageFromBackfillRow(row: MessageBackfillRow): Message {
  const role = row.role === "assistant" || row.role === "tool" ? row.role : "user";
  return {
    id: String(row.message_id ?? ""),
    role,
    agent: row.agent ?? null,
    time_created: Number(row.time_created ?? 0),
    time_completed: row.time_completed == null ? null : Number(row.time_completed),
    mode: row.mode ?? null,
    model: row.model ?? null,
    provider: row.provider ?? null,
    parts: JSON.parse(String(row.parts_json ?? "[]")) as MessagePart[],
    subagent_id: row.subagent_id ?? undefined,
    nickname: row.nickname ?? undefined,
  };
}

function backfillFileActivity(db: SQLiteDatabase): void {
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

function rebuildMessageSearchIndex(db: SQLiteDatabase): void {
  if (!tableExists(db, "messages_fts")) {
    return;
  }
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}

function shouldBulkSyncSearchIndex(options: SearchIndexSyncOptions, changedCount: number): boolean {
  if (options.isBulk != null) {
    return options.isBulk;
  }

  const threshold = options.bulkThreshold ?? SEARCH_INDEX_BULK_SYNC_THRESHOLD;
  return threshold > 0 && changedCount >= threshold;
}

function ensureFtsReady(db: SQLiteDatabase): void {
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

function ensureFtsConsistency(db: SQLiteDatabase): void {
  ensureFtsReady(db);
  const cachePath = getCachePath();
  if (ftsIntegrityCheckedPath === cachePath) {
    return;
  }

  try {
    db.exec(
      "INSERT INTO session_documents_fts(session_documents_fts, rank) VALUES ('integrity-check', 1)",
    );
    db.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)");
    ftsIntegrityCheckedPath = cachePath;
  } catch {
    rebuildSearchIndex(db);
    rebuildMessageSearchIndex(db);
    ftsIntegrityCheckedPath = cachePath;
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
    backupTables: [
      "agent_cache",
      "cached_sessions",
      "sessions",
      "messages",
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
    ],
  });

  createLatestCacheSchema(db);

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

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value != null));
}

function summarizeToolPart(part: MessagePart): Record<string, unknown> {
  const state =
    part.state == null
      ? undefined
      : compactRecord({
          status: part.state.status,
          error: part.state.error,
          metadata: part.state.metadata,
        });

  return compactRecord({
    type: part.type,
    tool: part.tool,
    title: part.title,
    nickname: part.nickname,
    callID: part.callID,
    approval_status: part.approval_status,
    state,
  });
}

function buildMessageText(message: Message): string {
  const chunks: string[] = [];

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

  return chunks.join("\n");
}

function normalizeMessages(session: SessionData): StructuredMessageRecord[] {
  return session.messages.map((message, index) => {
    const toolMetadata = message.parts
      .filter((part) => part.type === "tool")
      .map((part) => summarizeToolPart(part));

    return {
      index,
      id: message.id || `${session.id}:${index}`,
      role: message.role,
      timeCreated: message.time_created,
      timeCompleted: message.time_completed ?? null,
      agent: message.agent ?? null,
      mode: message.mode ?? null,
      model: message.model ?? null,
      provider: message.provider ?? null,
      tokensJson: stringifyOptionalJson(message.tokens),
      cost: message.cost ?? null,
      costSource: message.cost_source ?? null,
      partsJson: JSON.stringify(message.parts),
      subagentId: message.subagent_id ?? null,
      nickname: message.nickname ?? null,
      contentText: buildMessageText(message),
      toolMetadataJson: toolMetadata.length > 0 ? JSON.stringify(toolMetadata) : null,
    };
  });
}

function buildSessionContentFromMessages(
  title: string | null | undefined,
  messages: StructuredMessageRecord[],
): string {
  const chunks: string[] = [];
  appendPlainText(title, chunks);
  for (const message of messages) {
    appendPlainText(message.contentText, chunks);
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
  ftsIntegrityCheckedPath = null;
  if (!hasCacheStorage()) {
    deleteLegacyCacheFile();
    return;
  }

  withCacheDb((db) => {
    db.exec(`
      DELETE FROM agent_cache;
      DELETE FROM cached_sessions;
      DELETE FROM session_documents;
      DELETE FROM session_file_activity;
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
  const deleteFileActivity = db.prepare(
    "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
  );
  const upsertIndexedSession = prepareUpsertIndexedSession(db);
  const insertFileActivity = prepareInsertFileActivity(db);
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
    deleteMessages.run(agentName, sessionId, 0);
  }

  for (const entry of entries) {
    const activityTime = entry.session.time_updated ?? entry.session.time_created;
    upsertSessionRow(upsertIndexedSession, agentName, entry.session, null, entry.sortIndex, null);
    deleteFileActivity.run(agentName, entry.session.id);
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

function sessionHeadFromSearchRow(row: SearchResultRow): SessionHead {
  return sessionFromRow(row as SessionRow);
}

function mergeSearchLists<T>(left: T[] | undefined, right: T[] | undefined): T[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function mergeSearchQueryOptions(query: string, options: SearchOptions) {
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

function sessionMatchesSearchCost(session: SessionHead, options: SearchOptions): boolean {
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

function likePattern(value: string): string {
  return `%${value
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, "\\$&")}%`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    clauses.push(
      "EXISTS (SELECT 1 FROM messages m WHERE m.agent_name = s.agent_name AND m.session_id = s.session_id AND LOWER(m.tool_metadata_json) LIKE ? ESCAPE '\\')",
    );
    params.push(likePattern(tool));
  }
  if (options.file || options.fileKind) {
    const fileClauses = ["fa.agent_name = s.agent_name", "fa.session_id = s.session_id"];
    if (options.file) {
      fileClauses.push("LOWER(fa.path) LIKE ? ESCAPE '\\'");
      params.push(likePattern(options.file));
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

function normalizeFilePathSearch(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

function fileActivityFilters(options: FileActivityOptions): {
  projectKey: string | null;
  projectLike: string | null;
  cwdKey: string | null;
  cwdLike: string | null;
  pathLike: string | null;
} {
  const path = options.path ? normalizeFilePathSearch(options.path) : "";
  return {
    projectKey: options.projectKey ?? null,
    projectLike: options.project ? likePattern(options.project) : null,
    cwdKey: options.cwd ? computeIdentity(options.cwd, realFs).key : null,
    cwdLike: options.cwd ? likePattern(options.cwd) : null,
    pathLike: path ? likePattern(path) : null,
  };
}

function fileActivityFromRow(row: FileActivityRow): SessionFileActivity {
  return {
    agent_name: String(row.agent_name),
    session_id: String(row.session_id),
    project_identity_key: String(row.project_identity_key ?? ""),
    path: String(row.path ?? ""),
    kind: (row.kind ?? "read") as FileActivityKind,
    count: Number(row.count ?? 0),
    latest_time: Number(row.latest_time ?? 0),
  };
}

export function listFileActivity(options: FileActivityOptions = {}): FileActivityResult[] {
  if (!hasCacheStorage()) {
    return [];
  }

  const filters = fileActivityFilters(options);
  const rows = withCacheDb(
    (db) =>
      db
        .prepare(
          `
          SELECT
            fa.agent_name,
            fa.session_id,
            fa.project_identity_key,
            fa.path,
            fa.kind,
            fa.count,
            fa.latest_time,
            s.slug,
            s.title,
            s.directory,
            s.project_identity_kind,
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
            s.total_tokens
          FROM session_file_activity fa
          JOIN sessions s ON s.agent_name = fa.agent_name AND s.session_id = fa.session_id
          WHERE (? IS NULL OR fa.agent_name = ?)
            AND (? IS NULL OR fa.session_id = ?)
            AND (? IS NULL OR fa.project_identity_key = ?)
            AND (? IS NULL OR LOWER(fa.project_identity_key) LIKE ? ESCAPE '\\' OR LOWER(s.project_display_name) LIKE ? ESCAPE '\\' OR LOWER(s.directory) LIKE ? ESCAPE '\\')
            AND (? IS NULL OR s.project_identity_key = ? OR LOWER(s.directory) LIKE ? ESCAPE '\\')
            AND (? IS NULL OR LOWER(fa.path) LIKE ? ESCAPE '\\')
            AND (? IS NULL OR fa.kind = ?)
            AND (? IS NULL OR fa.latest_time >= ?)
            AND (? IS NULL OR fa.latest_time <= ?)
          ORDER BY fa.latest_time DESC, fa.count DESC, fa.path
          LIMIT ?
        `,
        )
        .all(
          options.agent ?? null,
          options.agent ?? null,
          options.sessionId ?? null,
          options.sessionId ?? null,
          filters.projectKey,
          filters.projectKey,
          filters.projectLike,
          filters.projectLike,
          filters.projectLike,
          filters.projectLike,
          filters.cwdKey,
          filters.cwdKey,
          filters.cwdLike,
          filters.pathLike,
          filters.pathLike,
          options.kind ?? null,
          options.kind ?? null,
          options.from ?? null,
          options.from ?? null,
          options.to ?? null,
          options.to ?? null,
          options.limit ?? 50,
        ) as FileActivityRow[],
  );

  return (rows ?? []).map((row) => ({
    ...fileActivityFromRow(row),
    session: sessionHeadFromSearchRow(row),
  }));
}

export function listSessionFileActivity(
  agentName: string,
  sessionId: string,
): SessionFileActivity[] {
  return listFileActivity({ agent: agentName, sessionId, limit: 500 }).map(
    ({ session: _session, ...activity }) => activity,
  );
}

function highlightFilePath(path: string, query: string): string {
  const needle = normalizeFilePathSearch(query);
  if (!needle) return path;
  const lower = path.toLowerCase();
  const index = lower.indexOf(needle.toLowerCase());
  if (index < 0) return path;
  return `${path.slice(0, index)}<mark>${path.slice(index, index + needle.length)}</mark>${path.slice(
    index + needle.length,
  )}`;
}

export function searchFileActivitySessions(
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const search = mergeSearchQueryOptions(query, options);
  const path = normalizeFilePathSearch(search.options.file ?? search.text);
  if (!path) return [];

  const rows = listFileActivity({
    agent: search.options.agent,
    projectKey: search.options.projectKey,
    project: search.options.project,
    cwd: search.options.cwd,
    path,
    kind: search.options.fileKind,
    from: search.options.from,
    to: search.options.to,
    limit: (search.options.limit ?? 50) * 3,
  });
  const seen = new Set<string>();
  const results: SearchResult[] = [];

  for (const row of rows) {
    const key = `${row.agent_name}/${row.session_id}`;
    if (seen.has(key)) continue;
    if (!sessionMatchesSearchCost(row.session, search.options)) continue;
    seen.add(key);
    results.push({
      agentName: row.agent_name,
      session: row.session,
      snippet: `${row.kind} ${highlightFilePath(row.path, path)} · ${row.count} events`,
      matchType: "file_path",
    });
    if (results.length >= (search.options.limit ?? 50)) break;
  }

  return results;
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
