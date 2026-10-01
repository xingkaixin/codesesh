CREATE INDEX idx_sessions_heads ON sessions(
    activity_time DESC, agent_name, session_id, publication_id,
    source_node_id, title, directory, parent_agent_name, parent_session_id,
    project_identity_kind, project_identity_key, project_display_name,
    project_identity_resolver_revision, project_identity_input_signature,
    time_created, time_updated, message_count, total_input_tokens,
    total_output_tokens, total_cost, total_cache_read_tokens,
    total_cache_create_tokens, total_tokens, cost_source, model_usage_json,
    smart_tags_json, smart_tags_source_updated_at,
    smart_tags_classifier_revision, head_meta_json
);

DROP INDEX IF EXISTS idx_messages_usage_time;
CREATE INDEX idx_messages_usage_time ON messages(
    CASE
      WHEN time_completed > 0 THEN time_completed
      WHEN time_created > 0 THEN time_created
    END,
    agent_name, session_id, message_index, model, tokens_json, cost,
    cost_source, source_node_id
);

DROP INDEX IF EXISTS idx_messages_user_activity;
CREATE INDEX idx_messages_user_activity ON messages(
    time_created, agent_name, session_id, source_node_id, role, automated
) WHERE role = 'user' AND automated = 0 AND time_created > 0;
