import { columnExists, tableExists, type SQLiteDatabase } from "../../utils/sqlite.js";

export function createCacheMetadataTables(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_cache (
      agent_name TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
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

export function createLegacyCacheTables(db: SQLiteDatabase): void {
  createCacheMetadataTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cached_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      meta_json TEXT,
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
      title TEXT NOT NULL,
      source_path TEXT,
      directory TEXT NOT NULL,
      parent_agent_name TEXT,
      parent_session_id TEXT,
      project_identity_kind TEXT NOT NULL,
      project_identity_key TEXT NOT NULL,
      project_display_name TEXT NOT NULL,
      project_identity_resolver_revision TEXT,
      project_identity_input_signature TEXT,
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
      smart_tags_classifier_revision TEXT,
      meta_json TEXT,
      publication_id TEXT,
      PRIMARY KEY (agent_name, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent_activity_order
      ON sessions(agent_name, activity_time DESC, session_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_activity
      ON sessions(activity_time DESC, agent_name, session_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_project
      ON sessions(project_identity_kind, project_identity_key, activity_time);

    CREATE INDEX IF NOT EXISTS idx_sessions_parent
      ON sessions(parent_agent_name, parent_session_id);

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
      parts_format_version INTEGER NOT NULL DEFAULT 0,
      content_chain_digest TEXT,
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

  createMessageUsageIndex(db);
  createSessionModelCostTable(db);
  createSessionCostSummaryTable(db);
  createMessageToolTables(db);
}

export function createMessageUsageIndex(db: SQLiteDatabase): void {
  // Keep analytics reads off message rows containing large transcript payloads.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_usage_time
      ON messages(
        CASE
          WHEN time_completed > 0 THEN time_completed
          WHEN time_created > 0 THEN time_created
        END,
        agent_name,
        session_id,
        message_index,
        model,
        tokens_json,
        cost,
        cost_source
      );
  `);
}

/**
 * Per-(session, model) cost rollup maintained in the same transaction that
 * writes message rows, so dashboard model-cost aggregation reads
 * sessions×models rows instead of scanning the full messages table (CS-270).
 */
export function createSessionModelCostTable(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_model_cost (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      model TEXT NOT NULL,
      cost REAL NOT NULL,
      cost_recorded REAL NOT NULL,
      PRIMARY KEY (agent_name, session_id, model),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES sessions(agent_name, session_id)
        ON DELETE CASCADE
    );
  `);
}

function createSessionCostSummaryTable(db: SQLiteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_cost_summary (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      untimed_message_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      untimed_input_tokens INTEGER NOT NULL DEFAULT 0,
      untimed_output_tokens INTEGER NOT NULL DEFAULT 0,
      untimed_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      untimed_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      untimed_cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      message_cost REAL NOT NULL,
      untimed_message_cost REAL NOT NULL,
      PRIMARY KEY (agent_name, session_id),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES sessions(agent_name, session_id)
        ON DELETE CASCADE
    );
  `);
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

export function dropLegacyMessageSearchIndex(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;
    DROP TABLE IF EXISTS messages_fts;
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

function createFileActivityPathSearchTriggers(db: SQLiteDatabase): void {
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
      title TEXT NOT NULL,
      content_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_message_count INTEGER NOT NULL,
      detail_version TEXT NOT NULL DEFAULT '',
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

/**
 * Covers the search-index freshness probe (see readSearchIndexState) so it never
 * has to read past content_text in the document rows.
 *
 * Created only once the schema has reached the target version: createSearchTables
 * doubles as the v4 migration and still sees the legacy column set there.
 */
export function createSearchStateIndex(db: SQLiteDatabase): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_documents_state
      ON session_documents(
        agent_name,
        session_id,
        content_hash,
        indexed_message_count,
        detail_version
      )
  `);
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

export function addDetailVersion(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents")) return;
  createCacheMetadataTables(db);
  if (!columnExists(db, "session_documents", "detail_version")) {
    db.exec("ALTER TABLE session_documents ADD COLUMN detail_version TEXT NOT NULL DEFAULT ''");
  }
  if (tableExists(db, "sessions") && tableExists(db, "pending_reindex")) {
    db.exec(`
      INSERT OR IGNORE INTO pending_reindex(agent_name, session_id)
      SELECT agent_name, session_id FROM sessions
    `);
  }
}

export function addProjectIdentityProvenance(db: SQLiteDatabase): void {
  if (!tableExists(db, "sessions")) return;
  if (!columnExists(db, "sessions", "project_identity_resolver_revision")) {
    db.exec("ALTER TABLE sessions ADD COLUMN project_identity_resolver_revision TEXT");
  }
  if (!columnExists(db, "sessions", "project_identity_input_signature")) {
    db.exec("ALTER TABLE sessions ADD COLUMN project_identity_input_signature TEXT");
  }
  if (!columnExists(db, "sessions", "smart_tags_classifier_revision")) {
    db.exec("ALTER TABLE sessions ADD COLUMN smart_tags_classifier_revision TEXT");
  }
}

export function addSessionPublicationId(db: SQLiteDatabase): void {
  if (!tableExists(db, "sessions")) return;
  if (!columnExists(db, "sessions", "publication_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN publication_id TEXT");
  }
  recreateProjectGroupsView(db);
}

export function dropSearchTriggers(db: SQLiteDatabase): void {
  db.exec(`
    DROP TRIGGER IF EXISTS session_documents_ai;
    DROP TRIGGER IF EXISTS session_documents_ad;
    DROP TRIGGER IF EXISTS session_documents_au;
  `);
}

const LEGACY_SESSION_DOCUMENT_COLUMNS = [
  ["slug", "TEXT NOT NULL DEFAULT ''"],
  ["directory", "TEXT NOT NULL DEFAULT ''"],
  ["time_created", "INTEGER NOT NULL DEFAULT 0"],
  ["time_updated", "INTEGER"],
  ["activity_time", "INTEGER NOT NULL DEFAULT 0"],
  ["project_identity_kind", "TEXT NOT NULL DEFAULT 'path'"],
  ["project_identity_key", "TEXT NOT NULL DEFAULT ''"],
  ["project_display_name", "TEXT NOT NULL DEFAULT ''"],
] as const;

export function ensureLegacySessionDocumentColumns(db: SQLiteDatabase): void {
  if (!tableExists(db, "session_documents")) {
    return;
  }

  for (const [name, definition] of LEGACY_SESSION_DOCUMENT_COLUMNS) {
    if (!columnExists(db, "session_documents", name)) {
      db.exec(`ALTER TABLE session_documents ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function createLegacyProjectTables(db: SQLiteDatabase): void {
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

  const hasParentReference =
    columnExists(db, "sessions", "parent_agent_name") &&
    columnExists(db, "sessions", "parent_session_id");
  const predicates = [
    ...(hasParentReference ? ["parent_agent_name IS NULL OR parent_session_id IS NULL"] : []),
    ...(columnExists(db, "sessions", "publication_id") ? ["publication_id IS NULL"] : []),
  ];
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
      ${predicates.length > 0 ? `WHERE ${predicates.map((predicate) => `(${predicate})`).join(" AND ")}` : ""}
      GROUP BY project_identity_kind, project_identity_key;
  `);
}

export function recreateProjectGroupsView(db: SQLiteDatabase): void {
  db.exec("DROP VIEW IF EXISTS project_groups_v");
  createProjectGroupsView(db);
}
