
    CREATE TABLE local_runtime_sessions (
      session_id TEXT PRIMARY KEY, columnar_version INTEGER DEFAULT 3, title TEXT,
      workspace_dir TEXT DEFAULT '/work/project', parent_session_id TEXT,
      created_at_ms INTEGER DEFAULT 1000, updated_at_ms INTEGER DEFAULT 2000,
      agent_name TEXT DEFAULT 'coder', status TEXT DEFAULT 'idle', archived INTEGER DEFAULT 0,
      visibility TEXT DEFAULT 'visible', session_kind TEXT DEFAULT 'conversation',
      extra_data_json TEXT DEFAULT '{}', record_json TEXT DEFAULT '{}'
    );
    CREATE TABLE local_runtime_message_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, msg_id TEXT, role TEXT,
      turn_id TEXT, source TEXT, created_at_ms INTEGER, data_json TEXT,
      UNIQUE(session_id, msg_id)
    );
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_id TEXT, model TEXT,
      ts INTEGER DEFAULT 3000, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0, cost_usd REAL
    );
  