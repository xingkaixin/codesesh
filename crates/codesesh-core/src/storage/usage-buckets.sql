
    WITH timed AS (
      SELECT
        source_node_id,
        agent_name,
        session_id,
        CASE WHEN time_completed > 0 THEN time_completed WHEN time_created > 0 THEN time_created END AS effective_time,
        COALESCE(model, '') AS model,
        CASE WHEN cost_source IN ('recorded', 'estimated') THEN cost_source ELSE '' END AS cost_source,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.input'), 0) AS INTEGER), 0) AS input_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.output'), 0) AS INTEGER), 0) AS output_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.reasoning'), 0) AS INTEGER), 0) AS reasoning_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_read'), 0) AS INTEGER), 0) AS cache_read_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_create'), 0) AS INTEGER), 0) AS cache_create_tokens,
        CASE WHEN cost > 0 THEN cost ELSE 0 END AS cost
      FROM messages
      WHERE source_node_id = ? AND agent_name = ? AND session_id = ?
    )
    INSERT INTO session_usage_bucket(
      bucket_start,
      source_node_id,
      agent_name,
      session_id,
      model,
      cost_source,
      message_count,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cache_read_tokens,
      cache_create_tokens,
      cost
    )
    SELECT
      -- Every current UTC offset is a multiple of 15 minutes, so day-aligned windows never split a bucket.
      CAST(effective_time / 900000 AS INTEGER) * 900000 AS bucket,
      source_node_id,
      agent_name,
      session_id,
      model,
      cost_source,
      COUNT(*),
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(reasoning_tokens),
      SUM(cache_read_tokens),
      SUM(cache_create_tokens),
      SUM(cost)
    FROM timed
    WHERE effective_time IS NOT NULL
    GROUP BY source_node_id, agent_name, session_id, bucket, model, cost_source

