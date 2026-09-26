CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

CREATE TABLE agent_cache (
      agent_name TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

CREATE TABLE cache_initialization (
      agent_name TEXT PRIMARY KEY,
      initialized_at INTEGER NOT NULL,
      index_version TEXT NOT NULL,
      last_sync_at INTEGER NOT NULL
    );

CREATE TABLE pending_reindex (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );

CREATE TABLE sessions (
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

CREATE INDEX idx_sessions_agent_activity_order
      ON sessions(agent_name, activity_time DESC, session_id);

CREATE INDEX idx_sessions_activity
      ON sessions(activity_time DESC, agent_name, session_id);

CREATE INDEX idx_sessions_project
      ON sessions(project_identity_kind, project_identity_key, activity_time);

CREATE INDEX idx_sessions_parent
      ON sessions(parent_agent_name, parent_session_id);

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
      parts_format_version INTEGER NOT NULL DEFAULT 0,
      content_chain_digest TEXT,
      subagent_id TEXT,
      nickname TEXT,
      automated INTEGER NOT NULL DEFAULT 0,
      content_text TEXT NOT NULL,
      tool_metadata_json TEXT,
      PRIMARY KEY (agent_name, session_id, message_index),
      FOREIGN KEY (agent_name, session_id)
        REFERENCES sessions(agent_name, session_id)
        ON DELETE CASCADE
    );

CREATE INDEX idx_messages_session
      ON messages(agent_name, session_id, message_index);

CREATE INDEX idx_messages_usage_time
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

CREATE TABLE session_model_cost (
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

CREATE TABLE session_cost_summary (
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

CREATE INDEX idx_file_activity_latest
      ON session_file_activity(latest_time DESC, count DESC, path);

CREATE INDEX idx_file_activity_agent_latest
      ON session_file_activity(agent_name, latest_time DESC, count DESC, path);

CREATE INDEX idx_file_activity_project_latest_ordered
      ON session_file_activity(project_identity_key, latest_time DESC, count DESC, path);

CREATE INDEX idx_file_activity_path
      ON session_file_activity(path);

CREATE INDEX idx_file_activity_kind
      ON session_file_activity(kind);

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

CREATE TABLE session_documents (
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

CREATE TRIGGER session_documents_au AFTER UPDATE OF title, content_text ON session_documents BEGIN
      INSERT INTO session_documents_fts(session_documents_fts, rowid, title, content_text)
      VALUES ('delete', old.id, old.title, old.content_text);
      INSERT INTO session_documents_fts(rowid, title, content_text)
      VALUES (new.id, new.title, new.content_text);
    END;

CREATE INDEX idx_messages_user_activity
    ON messages(time_created, agent_name, session_id)
    WHERE role = 'user' AND automated = 0 AND time_created > 0;

CREATE INDEX idx_session_documents_state
      ON session_documents(
        agent_name,
        session_id,
        content_hash,
        indexed_message_count,
        detail_version
      )
  ;

CREATE VIEW project_groups_v AS
      SELECT
        project_identity_kind AS identity_kind,
        project_identity_key AS identity_key,
        MIN(project_display_name) AS display_name,
        GROUP_CONCAT(DISTINCT agent_name) AS sources_csv,
        COUNT(*) AS session_count,
        MAX(activity_time) AS last_activity
      FROM sessions
      WHERE (parent_agent_name IS NULL OR parent_session_id IS NULL) AND (publication_id IS NULL)
      GROUP BY project_identity_kind, project_identity_key;
