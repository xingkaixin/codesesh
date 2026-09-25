
    CREATE TABLE new_sessions (
      id TEXT PRIMARY KEY, agent_id TEXT, title TEXT, project_dir TEXT,
      parent_session_id TEXT, is_draft INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 1000, updated_at INTEGER DEFAULT 2000, revision INTEGER DEFAULT 0
    );
    CREATE TABLE deepchat_sessions (id TEXT PRIMARY KEY, model_id TEXT, provider_id TEXT);
    CREATE TABLE deepchat_messages (
      id TEXT PRIMARY KEY, session_id TEXT, order_seq INTEGER, role TEXT, content TEXT,
      metadata TEXT, status TEXT DEFAULT 'sent', created_at INTEGER, updated_at INTEGER
    );
    CREATE INDEX message_session ON deepchat_messages(session_id, order_seq);
    CREATE TABLE deepchat_assistant_blocks (
      message_id TEXT, block_index INTEGER, block_type TEXT, status TEXT, text_content TEXT,
      tool_call_id TEXT, tool_name TEXT, tool_params TEXT, tool_response TEXT,
      image_mime_type TEXT, extra_json TEXT, updated_at INTEGER,
      PRIMARY KEY(message_id, block_index)
    );
    CREATE TABLE deepchat_user_messages (message_id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE deepchat_user_message_files (message_id TEXT, ordinal INTEGER, path TEXT, name TEXT);
    CREATE TABLE deepchat_user_message_links (message_id TEXT, ordinal INTEGER, url TEXT);
    CREATE TABLE deepchat_usage_stats (
      usage_id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
      model_id TEXT, provider_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      total_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
  