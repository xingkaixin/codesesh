
    WITH normalized AS (
      SELECT
        agent_name,
        session_id,
        COALESCE(time_completed, 0) <= 0 AND COALESCE(time_created, 0) <= 0 AS untimed,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.input'), 0) AS INTEGER), 0) AS input_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.output'), 0) AS INTEGER), 0) AS output_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.reasoning'), 0) AS INTEGER), 0) AS reasoning_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_read'), 0) AS INTEGER), 0) AS cache_read_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_create'), 0) AS INTEGER), 0) AS cache_create_tokens,
        CASE WHEN cost > 0 THEN cost ELSE 0 END AS normalized_cost
      FROM messages
      WHERE agent_name = ? AND session_id = ?
    )
    INSERT INTO session_cost_summary(
      agent_name,
      session_id,
      message_count,
      untimed_message_count,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cache_read_tokens,
      cache_create_tokens,
      untimed_input_tokens,
      untimed_output_tokens,
      untimed_reasoning_tokens,
      untimed_cache_read_tokens,
      untimed_cache_create_tokens,
      message_cost,
      untimed_message_cost
    )
    SELECT
      agent_name,
      session_id,
      COUNT(*),
      SUM(CASE WHEN untimed THEN 1 ELSE 0 END),
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(reasoning_tokens),
      SUM(cache_read_tokens),
      SUM(cache_create_tokens),
      SUM(CASE WHEN untimed THEN input_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN output_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN reasoning_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_read_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_create_tokens ELSE 0 END),
      SUM(normalized_cost),
      SUM(CASE WHEN untimed THEN normalized_cost ELSE 0 END)
    FROM normalized
    GROUP BY agent_name, session_id
  