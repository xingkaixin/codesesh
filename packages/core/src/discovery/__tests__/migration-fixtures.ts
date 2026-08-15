import type Database from "better-sqlite3";
import type { SessionHead } from "../../types/index.js";

export const EXPECTED_CACHE_SCHEMA_VERSION = 28;

export const RELEASE_CACHE_FIXTURES = [
  { version: 3, sourceTag: "v0.3.0" },
  { version: 4, sourceTag: "v0.4.0" },
  { version: 6, sourceTag: "v0.5.0" },
  { version: 8, sourceTag: "v0.6.0" },
  { version: 13, sourceTag: "v0.7.0" },
  { version: 14, sourceTag: "v0.14.0" },
  { version: 17, sourceTag: "v0.17.0" },
  { version: 18, sourceTag: "v1.0.0" },
] as const;

export type ReleaseCacheFixture = (typeof RELEASE_CACHE_FIXTURES)[number];

export interface MigrationFixtureSeed {
  agentName: string;
  session: SessionHead;
  sourcePath: string;
  searchContent: string;
  messageText: string;
  filePath: string;
  now: number;
}

export function hasStructuredMessages(fixture: ReleaseCacheFixture): boolean {
  return fixture.version >= 8;
}

export function expectedBackupCount(fixture: ReleaseCacheFixture): number {
  return [6, 15].filter((version) => version > fixture.version).length;
}

export function createReleaseCacheFixture(
  db: Database.Database,
  fixture: ReleaseCacheFixture,
  seed?: MigrationFixtureSeed,
): void {
  db.pragma("foreign_keys = ON");
  if (fixture.version <= 6) {
    createLegacySchema(db, fixture.version);
  } else {
    createNormalizedSchema(db, fixture.version);
  }
  stampVersion(db, fixture.version);
  if (!seed) return;

  seedSharedRows(db, fixture.version, seed);
  if (fixture.version <= 6) {
    seedLegacyRows(db, fixture.version, seed);
  } else {
    seedNormalizedRows(db, fixture.version, seed);
  }
}

function createLegacySchema(db: Database.Database, version: number): void {
  const projectColumns =
    version >= 6
      ? `
        project_identity_kind TEXT NOT NULL DEFAULT 'path',
        project_identity_key TEXT NOT NULL DEFAULT '',
        project_display_name TEXT NOT NULL DEFAULT '',`
      : "";

  db.exec(`
    CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE agent_cache (
      agent_name TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE cached_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      meta_json TEXT,
      PRIMARY KEY (agent_name, session_id)
    );

    CREATE TABLE session_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,${projectColumns}
      time_created INTEGER NOT NULL,
      time_updated INTEGER,
      activity_time INTEGER NOT NULL,
      content_text TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(agent_name, session_id)
    );

    CREATE VIRTUAL TABLE session_documents_fts USING fts5(
      title,
      content_text,
      content='session_documents',
      content_rowid='id'
    );

    CREATE TRIGGER session_documents_ai AFTER INSERT ON session_documents BEGIN
      INSERT INTO session_documents_fts(rowid, title, content_text)
      VALUES (new.id, new.title, new.content_text);
    END;

    CREATE TRIGGER session_documents_ad AFTER DELETE ON session_documents BEGIN
      INSERT INTO session_documents_fts(session_documents_fts, rowid, title, content_text)
      VALUES ('delete', old.id, old.title, old.content_text);
    END;

    CREATE TRIGGER session_documents_au AFTER UPDATE ON session_documents BEGIN
      INSERT INTO session_documents_fts(session_documents_fts, rowid, title, content_text)
      VALUES ('delete', old.id, old.title, old.content_text);
      INSERT INTO session_documents_fts(rowid, title, content_text)
      VALUES (new.id, new.title, new.content_text);
    END;
  `);

  if (version < 6) return;
  db.exec(`
    CREATE TABLE project_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      identity_kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      directory TEXT NOT NULL,
      activity_time INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );

    CREATE INDEX idx_project_sessions_identity
      ON project_sessions(identity_kind, identity_key);

    CREATE VIEW project_groups_v AS
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

function createNormalizedSchema(db: Database.Database, version: number): void {
  createNormalizedCacheTables(db, version);
  createNormalizedSessionTables(db, version);
  createNormalizedFileActivityTables(db, version);
  createNormalizedSearchTables(db, version);
  createNormalizedProjectTables(db, version);
}

function createNormalizedCacheTables(db: Database.Database, version: number): void {
  db.exec(`
    CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE agent_cache (
      agent_name TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE cached_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      meta_json TEXT,
      PRIMARY KEY (agent_name, session_id)
    );
  `);

  if (version >= 13) {
    db.exec(`
      CREATE TABLE cache_initialization (
        agent_name TEXT PRIMARY KEY,
        initialized_at INTEGER NOT NULL,
        index_version TEXT NOT NULL,
        last_sync_at INTEGER NOT NULL
      );
    `);
  }
  if (version >= 17) {
    db.exec(`
      CREATE TABLE pending_reindex (
        agent_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (agent_name, session_id)
      );
    `);
  }
}

function createNormalizedSessionTables(db: Database.Database, version: number): void {
  const parentColumns =
    version >= 18
      ? `
        parent_agent_name TEXT,
        parent_session_id TEXT,`
      : "";
  const partsFormatColumn = version >= 17 ? "parts_format_version INTEGER NOT NULL DEFAULT 0," : "";

  db.exec(`
    CREATE TABLE sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sort_index INTEGER NOT NULL DEFAULT 0,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      source_path TEXT,
      directory TEXT NOT NULL,${parentColumns}
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

    CREATE INDEX idx_sessions_agent_activity
      ON sessions(agent_name, activity_time);

    CREATE INDEX idx_sessions_project
      ON sessions(project_identity_kind, project_identity_key, activity_time);

    CREATE TABLE messages (
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
      ${partsFormatColumn}
      subagent_id TEXT,
      nickname TEXT,
      content_text TEXT NOT NULL,
      tool_metadata_json TEXT,
      PRIMARY KEY (agent_name, session_id, message_index),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES sessions(agent_name, session_id)
        ON DELETE CASCADE
    );

    CREATE INDEX idx_messages_session
      ON messages(agent_name, session_id, message_index);
  `);

  if (version >= 18) {
    db.exec("CREATE INDEX idx_sessions_parent ON sessions(parent_agent_name, parent_session_id)");
  }
  if (version < 13) return;

  db.exec(`
    CREATE TABLE message_tools (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id, message_index, tool_name),
      FOREIGN KEY (agent_name, session_id, message_index)
        REFERENCES messages(agent_name, session_id, message_index)
        ON DELETE CASCADE
    );

    CREATE INDEX idx_message_tools_filter
      ON message_tools(tool_name, agent_name, session_id);

    CREATE VIRTUAL TABLE messages_fts USING fts5(
      content_text,
      content='messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content_text)
      VALUES (new.rowid, new.content_text);
    END;

    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text)
      VALUES ('delete', old.rowid, old.content_text);
    END;

    CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content_text)
      VALUES ('delete', old.rowid, old.content_text);
      INSERT INTO messages_fts(rowid, content_text)
      VALUES (new.rowid, new.content_text);
    END;
  `);
}

function createNormalizedFileActivityTables(db: Database.Database, version: number): void {
  db.exec(`
    CREATE TABLE session_file_activity (
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

    CREATE INDEX idx_file_activity_project_latest
      ON session_file_activity(project_identity_key, latest_time);

    CREATE INDEX idx_file_activity_path ON session_file_activity(path);
    CREATE INDEX idx_file_activity_kind ON session_file_activity(kind);
  `);

  if (version < 13) return;
  db.exec(`
    CREATE INDEX idx_file_activity_latest
      ON session_file_activity(latest_time DESC, count DESC, path);
    CREATE INDEX idx_file_activity_agent_latest
      ON session_file_activity(agent_name, latest_time DESC, count DESC, path);
    CREATE INDEX idx_file_activity_project_latest_ordered
      ON session_file_activity(project_identity_key, latest_time DESC, count DESC, path);

    CREATE VIRTUAL TABLE session_file_activity_path_fts USING fts5(
      path,
      content='session_file_activity',
      content_rowid='rowid',
      tokenize='trigram'
    );

    CREATE TRIGGER session_file_activity_path_ai
    AFTER INSERT ON session_file_activity BEGIN
      INSERT INTO session_file_activity_path_fts(rowid, path)
      VALUES (new.rowid, new.path);
    END;

    CREATE TRIGGER session_file_activity_path_ad
    AFTER DELETE ON session_file_activity BEGIN
      INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts, rowid, path)
      VALUES ('delete', old.rowid, old.path);
    END;

    CREATE TRIGGER session_file_activity_path_au
    AFTER UPDATE ON session_file_activity BEGIN
      INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts, rowid, path)
      VALUES ('delete', old.rowid, old.path);
      INSERT INTO session_file_activity_path_fts(rowid, path)
      VALUES (new.rowid, new.path);
    END;
  `);
}

function createNormalizedSearchTables(db: Database.Database, version: number): void {
  if (version >= 17) {
    db.exec(`
      CREATE TABLE session_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_message_count INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        UNIQUE(agent_name, session_id)
      );
    `);
  } else {
    const indexedMessageCount = version >= 14 ? "indexed_message_count INTEGER NOT NULL," : "";
    db.exec(`
      CREATE TABLE session_documents (
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
        ${indexedMessageCount}
        indexed_at INTEGER NOT NULL,
        UNIQUE(agent_name, session_id)
      );
    `);
    db.exec(`
      ALTER TABLE session_documents
      ADD COLUMN project_identity_kind TEXT NOT NULL DEFAULT 'path';
      ALTER TABLE session_documents
      ADD COLUMN project_identity_key TEXT NOT NULL DEFAULT '';
      ALTER TABLE session_documents
      ADD COLUMN project_display_name TEXT NOT NULL DEFAULT '';
    `);
  }

  db.exec(`
    CREATE VIRTUAL TABLE session_documents_fts USING fts5(
      title,
      content_text,
      content='session_documents',
      content_rowid='id'
    );

    CREATE TRIGGER session_documents_ai AFTER INSERT ON session_documents BEGIN
      INSERT INTO session_documents_fts(rowid, title, content_text)
      VALUES (new.id, new.title, new.content_text);
    END;

    CREATE TRIGGER session_documents_ad AFTER DELETE ON session_documents BEGIN
      INSERT INTO session_documents_fts(session_documents_fts, rowid, title, content_text)
      VALUES ('delete', old.id, old.title, old.content_text);
    END;

    CREATE TRIGGER session_documents_au AFTER UPDATE ON session_documents BEGIN
      INSERT INTO session_documents_fts(session_documents_fts, rowid, title, content_text)
      VALUES ('delete', old.id, old.title, old.content_text);
      INSERT INTO session_documents_fts(rowid, title, content_text)
      VALUES (new.id, new.title, new.content_text);
    END;
  `);
}

function createNormalizedProjectTables(db: Database.Database, version: number): void {
  const parentFilter =
    version >= 18 ? "WHERE parent_agent_name IS NULL OR parent_session_id IS NULL" : "";
  db.exec(`
    CREATE TABLE project_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      identity_kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      directory TEXT NOT NULL,
      activity_time INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );

    CREATE INDEX idx_project_sessions_identity
      ON project_sessions(identity_kind, identity_key);

    CREATE VIEW project_groups_v AS
      SELECT
        project_identity_kind AS identity_kind,
        project_identity_key AS identity_key,
        MIN(project_display_name) AS display_name,
        GROUP_CONCAT(DISTINCT agent_name) AS sources_csv,
        COUNT(*) AS session_count,
        MAX(activity_time) AS last_activity
      FROM sessions
      ${parentFilter}
      GROUP BY project_identity_kind, project_identity_key;
  `);
}

function stampVersion(db: Database.Database, version: number): void {
  db.prepare("INSERT INTO cache_meta(key, value) VALUES ('version', ?)").run(String(version));
  if (version >= 8) {
    db.pragma(`user_version = ${version}`);
  }
}

function seedSharedRows(db: Database.Database, version: number, seed: MigrationFixtureSeed): void {
  const sessionJson = JSON.stringify(seed.session);
  const metaJson = JSON.stringify({ id: seed.session.id, sourcePath: seed.sourcePath });
  db.prepare("INSERT INTO agent_cache(agent_name, timestamp) VALUES (?, ?)").run(
    seed.agentName,
    seed.now,
  );
  db.prepare(
    "INSERT INTO cached_sessions(agent_name, session_id, session_json, meta_json) VALUES (?, ?, ?, ?)",
  ).run(seed.agentName, seed.session.id, sessionJson, metaJson);

  if (version >= 13) {
    db.prepare(
      `
        INSERT INTO cache_initialization(agent_name, initialized_at, index_version, last_sync_at)
        VALUES (?, ?, 'session-cache-v1', ?)
      `,
    ).run(seed.agentName, seed.now - 100, seed.now - 50);
  }
}

function seedLegacyRows(db: Database.Database, version: number, seed: MigrationFixtureSeed): void {
  const session = seed.session;
  if (version >= 6) {
    db.prepare(
      `
        INSERT INTO session_documents(
          agent_name, session_id, slug, title, directory,
          project_identity_kind, project_identity_key, project_display_name,
          time_created, time_updated, activity_time, content_text, content_hash, indexed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      seed.agentName,
      session.id,
      session.slug,
      session.title,
      session.directory,
      session.project_identity?.kind ?? "path",
      session.project_identity?.key ?? session.directory,
      session.project_identity?.displayName ?? session.directory,
      session.time_created,
      session.time_updated ?? null,
      session.time_updated ?? session.time_created,
      seed.searchContent,
      "legacy-content-hash",
      seed.now,
    );
    seedProjectSession(db, seed);
    return;
  }

  db.prepare(
    `
      INSERT INTO session_documents(
        agent_name, session_id, slug, title, directory, time_created, time_updated,
        activity_time, content_text, content_hash, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    seed.agentName,
    session.id,
    session.slug,
    session.title,
    session.directory,
    session.time_created,
    session.time_updated ?? null,
    session.time_updated ?? session.time_created,
    seed.searchContent,
    "legacy-content-hash",
    seed.now,
  );
}

function seedNormalizedRows(
  db: Database.Database,
  version: number,
  seed: MigrationFixtureSeed,
): void {
  const session = seed.session;
  const parentColumns = version >= 18 ? "parent_agent_name, parent_session_id," : "";
  const parentValues = version >= 18 ? "NULL, NULL," : "";
  db.prepare(
    `
      INSERT INTO sessions(
        agent_name, session_id, sort_index, slug, title, source_path, directory,
        ${parentColumns}
        project_identity_kind, project_identity_key, project_display_name,
        time_created, time_updated, activity_time, message_count,
        total_input_tokens, total_output_tokens, total_cache_read_tokens,
        total_cache_create_tokens, total_cost, cost_source, total_tokens,
        model_usage_json, smart_tags_json, smart_tags_source_updated_at, meta_json
      ) VALUES (
        @agentName, @sessionId, 0, @slug, @title, @sourcePath, @directory,
        ${parentValues}
        @projectKind, @projectKey, @projectDisplayName,
        @timeCreated, @timeUpdated, @activityTime, @messageCount,
        @inputTokens, @outputTokens, NULL, NULL, @totalCost, NULL, @totalTokens,
        NULL, NULL, NULL, @metaJson
      )
    `,
  ).run({
    agentName: seed.agentName,
    sessionId: session.id,
    slug: session.slug,
    title: session.title,
    sourcePath: seed.sourcePath,
    directory: session.directory,
    projectKind: session.project_identity?.kind ?? "path",
    projectKey: session.project_identity?.key ?? session.directory,
    projectDisplayName: session.project_identity?.displayName ?? session.directory,
    timeCreated: session.time_created,
    timeUpdated: session.time_updated ?? null,
    activityTime: session.time_updated ?? session.time_created,
    messageCount: session.stats.message_count,
    inputTokens: session.stats.total_input_tokens,
    outputTokens: session.stats.total_output_tokens,
    totalCost: session.stats.total_cost,
    totalTokens: session.stats.total_tokens ?? null,
    metaJson: JSON.stringify({ id: session.id, sourcePath: seed.sourcePath }),
  });

  const partsFormatColumn = version >= 17 ? "parts_format_version," : "";
  const partsFormatValue = version >= 17 ? "0," : "";
  db.prepare(
    `
      INSERT INTO messages(
        agent_name, session_id, message_index, message_id, role, time_created,
        parts_json, ${partsFormatColumn} content_text, tool_metadata_json
      ) VALUES (?, ?, 0, ?, 'assistant', ?, ?, ${partsFormatValue} ?, ?)
    `,
  ).run(
    seed.agentName,
    session.id,
    `${session.id}-message`,
    session.time_created,
    JSON.stringify([{ type: "text", text: seed.messageText }]),
    seed.messageText,
    JSON.stringify([{ tool: "Read" }]),
  );

  if (version >= 13) {
    db.prepare(
      `
        INSERT INTO message_tools(agent_name, session_id, message_index, tool_name)
        VALUES (?, ?, 0, 'read')
      `,
    ).run(seed.agentName, session.id);
  }

  db.prepare(
    `
      INSERT INTO session_file_activity(
        agent_name, session_id, project_identity_key, path, kind, count, latest_time
      ) VALUES (?, ?, ?, ?, 'read', 2, ?)
    `,
  ).run(
    seed.agentName,
    session.id,
    session.project_identity?.key ?? session.directory,
    seed.filePath,
    seed.now,
  );

  seedNormalizedSearchDocument(db, version, seed);
  seedProjectSession(db, seed);
}

function seedNormalizedSearchDocument(
  db: Database.Database,
  version: number,
  seed: MigrationFixtureSeed,
): void {
  const session = seed.session;
  if (version >= 17) {
    db.prepare(
      `
        INSERT INTO session_documents(
          agent_name, session_id, title, content_text, content_hash,
          indexed_message_count, indexed_at
        ) VALUES (?, ?, ?, ?, 'normalized-content-hash', 1, ?)
      `,
    ).run(seed.agentName, session.id, session.title, seed.searchContent, seed.now);
    return;
  }

  const indexedMessageColumn = version >= 14 ? "indexed_message_count," : "";
  const indexedMessageValue = version >= 14 ? "1," : "";
  db.prepare(
    `
      INSERT INTO session_documents(
        agent_name, session_id, slug, title, directory, time_created, time_updated,
        activity_time, content_text, content_hash, ${indexedMessageColumn} indexed_at,
        project_identity_kind, project_identity_key, project_display_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normalized-content-hash', ${indexedMessageValue} ?, ?, ?, ?)
    `,
  ).run(
    seed.agentName,
    session.id,
    session.slug,
    session.title,
    session.directory,
    session.time_created,
    session.time_updated ?? null,
    session.time_updated ?? session.time_created,
    seed.searchContent,
    seed.now,
    session.project_identity?.kind ?? "path",
    session.project_identity?.key ?? session.directory,
    session.project_identity?.displayName ?? session.directory,
  );
}

function seedProjectSession(db: Database.Database, seed: MigrationFixtureSeed): void {
  const session = seed.session;
  db.prepare(
    `
      INSERT INTO project_sessions(
        agent_name, session_id, identity_kind, identity_key,
        display_name, directory, activity_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    seed.agentName,
    session.id,
    session.project_identity?.kind ?? "path",
    session.project_identity?.key ?? session.directory,
    session.project_identity?.displayName ?? session.directory,
    session.directory,
    session.time_updated ?? session.time_created,
  );
}
