
    CREATE TABLE agent_workspace (id TEXT PRIMARY KEY, path TEXT);
    INSERT INTO agent_workspace VALUES ('workspace', '/work/project');
    CREATE TABLE agent_session (
      id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT DEFAULT 'workspace',
      created_at INTEGER DEFAULT 1000, updated_at INTEGER DEFAULT 2000,
      last_activity_at INTEGER DEFAULT 3000, deleted_at INTEGER
    );
    CREATE TABLE topic (
      id TEXT PRIMARY KEY, name TEXT, active_node_id TEXT,
      created_at INTEGER DEFAULT 1000, updated_at INTEGER DEFAULT 2000,
      last_activity_at INTEGER DEFAULT 3000, deleted_at INTEGER
    );
    CREATE TABLE agent_session_message (
      id TEXT PRIMARY KEY, session_id TEXT, role TEXT, data TEXT, stats TEXT,
      model_id TEXT, message_snapshot TEXT, status TEXT DEFAULT 'success',
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
    );
    CREATE INDEX agent_message_session ON agent_session_message(session_id, created_at, id);
    CREATE TABLE message (
      id TEXT PRIMARY KEY, topic_id TEXT, parent_id TEXT, role TEXT, data TEXT, stats TEXT,
      model_id TEXT, message_snapshot TEXT, status TEXT DEFAULT 'success',
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
    );
    CREATE INDEX message_topic ON message(topic_id, created_at, id);
  