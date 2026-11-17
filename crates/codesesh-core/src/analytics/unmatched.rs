use crate::{
    model::MessageTokens,
    pricing::{Pricing, normalize_override_model_key, strip_service_tier},
    search::{QueryScope, scope_where},
    storage::StoredPricing,
    wire::UnmatchedModelStat,
};
use anyhow::Result;
use rusqlite::{Connection, functions::FunctionFlags, params_from_iter, types::Value};
use std::collections::{BTreeSet, HashMap, HashSet};

// A display message can merge several models, so matching totals alone cannot justify its buckets.
const TIMED_USAGE_SQL: &str = "
    c.input_tokens = s.total_input_tokens
    AND (c.output_tokens = s.total_output_tokens OR c.output_tokens + c.reasoning_tokens = s.total_output_tokens)
    AND c.cache_read_tokens = COALESCE(s.total_cache_read_tokens, 0)
    AND c.cache_create_tokens = COALESCE(s.total_cache_create_tokens, 0)
    AND c.input_tokens + s.total_output_tokens = COALESCE(s.total_tokens, s.total_input_tokens + s.total_output_tokens)
    AND c.untimed_input_tokens = 0
    AND c.untimed_output_tokens = 0
    AND c.untimed_reasoning_tokens = 0
    AND c.untimed_cache_read_tokens = 0
    AND c.untimed_cache_create_tokens = 0
    AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each(s.meta_json, '$.rustPricing.messages') pricing_message
        -- CROSS JOIN pins the JSON iterator as the outer loop; otherwise SQLite rescans meta_json per message.
        CROSS JOIN messages m ON m.source_node_id = s.source_node_id
                             AND m.agent_name = s.agent_name
                             AND m.session_id = s.session_id
                             AND m.message_index = CAST(pricing_message.key AS INTEGER)
        JOIN jsonb_each(pricing_message.value, '$.inputs') cost_input
        WHERE NOT codesesh_pricing_models_match(json_extract(cost_input.value, '$.model'), m.model)
    )
";

#[derive(Default)]
struct ModelAcc {
    display_model: String,
    agents: BTreeSet<String>,
    sessions: HashSet<(String, String, String)>,
    input_tokens: f64,
    output_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    total_tokens: f64,
}

pub fn query_unmatched_models(
    connection: &Connection,
    scope: &QueryScope,
    from: Option<f64>,
    to: Option<f64>,
    pricing: &Pricing,
) -> Result<Vec<UnmatchedModelStat>> {
    connection.create_scalar_function(
        "codesesh_pricing_models_match",
        2,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let input: Option<String> = context.get(0)?;
            let message: Option<String> = context.get(1)?;
            Ok(input == message
                || input.as_deref().and_then(normalize_override_model_key)
                    == message.as_deref().and_then(normalize_override_model_key))
        },
    )?;
    let (scope_sql, scope_params) = scope_where(connection, scope)?;
    let mut acc: HashMap<String, ModelAcc> = HashMap::new();
    collect_bucket_unmatched(
        connection,
        &scope_sql,
        &scope_params,
        from,
        to,
        pricing,
        &mut acc,
    )?;
    collect_meta_unmatched(
        connection,
        &scope_sql,
        &scope_params,
        from,
        to,
        pricing,
        &mut acc,
    )?;

    let mut stats: Vec<UnmatchedModelStat> = acc
        .into_iter()
        .map(|(model_key, entry)| UnmatchedModelStat {
            model_key,
            display_model: entry.display_model,
            agents: entry.agents.into_iter().collect(),
            session_count: entry.sessions.len(),
            input_tokens: entry.input_tokens,
            output_tokens: entry.output_tokens,
            cache_read_tokens: entry.cache_read_tokens,
            cache_write_tokens: entry.cache_write_tokens,
            total_tokens: entry.total_tokens,
        })
        .collect();
    stats.sort_by(|left, right| {
        right
            .total_tokens
            .total_cmp(&left.total_tokens)
            .then_with(|| right.session_count.cmp(&left.session_count))
            .then_with(|| left.model_key.cmp(&right.model_key))
    });
    Ok(stats)
}

fn collect_bucket_unmatched(
    connection: &Connection,
    scope_sql: &str,
    scope_params: &[Value],
    from: Option<f64>,
    to: Option<f64>,
    pricing: &Pricing,
    acc: &mut HashMap<String, ModelAcc>,
) -> Result<()> {
    let mut params = scope_params.to_vec();
    let mut window = String::new();
    if let Some(from) = from {
        window.push_str(" AND b.bucket_start >= ?");
        params.push(Value::Real(from));
    }
    if let Some(to) = to {
        window.push_str(" AND b.bucket_start <= ?");
        params.push(Value::Real(to));
    }
    // Materializing keeps JSON validation from repeating for every usage bucket.
    let sql = format!(
        "WITH usage AS MATERIALIZED (
         SELECT b.source_node_id, b.agent_name, b.session_id, b.model,
                SUM(b.input_tokens) AS input_tokens, SUM(b.output_tokens) AS output_tokens,
                SUM(CASE WHEN c.output_tokens = s.total_output_tokens THEN 0 ELSE b.reasoning_tokens END) AS reasoning_tokens,
                SUM(b.cache_read_tokens) AS cache_read_tokens, SUM(b.cache_create_tokens) AS cache_create_tokens
         FROM session_usage_bucket b
         JOIN sessions s ON s.source_node_id = b.source_node_id
                        AND s.agent_name = b.agent_name
                        AND s.session_id = b.session_id
         JOIN session_cost_summary c ON c.source_node_id = s.source_node_id
                                    AND c.agent_name = s.agent_name
                                    AND c.session_id = s.session_id
         WHERE s.publication_id IS NULL
           AND b.cost_source = ''
           AND b.model <> ''
           AND (b.input_tokens > 0 OR b.output_tokens > 0 OR b.reasoning_tokens > 0 OR b.cache_read_tokens > 0 OR b.cache_create_tokens > 0)
           {scope_sql}
           {window}
         GROUP BY b.source_node_id, b.agent_name, b.session_id, b.model
         )
         SELECT b.source_node_id, b.agent_name, b.session_id, b.model,
                b.input_tokens, b.output_tokens, b.reasoning_tokens,
                b.cache_read_tokens, b.cache_create_tokens
         FROM usage b
         JOIN sessions s ON s.source_node_id = b.source_node_id
                        AND s.agent_name = b.agent_name
                        AND s.session_id = b.session_id
         JOIN session_cost_summary c ON c.source_node_id = s.source_node_id
                                    AND c.agent_name = s.agent_name
                                    AND c.session_id = s.session_id
         WHERE ({TIMED_USAGE_SQL})
           AND (s.cost_source IS NOT 'recorded' OR json_array_length(s.meta_json, '$.rustPricing.head.inputs') > 0)"
    );
    let mut stmt = connection.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, f64>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, f64>(6)?,
            row.get::<_, f64>(7)?,
            row.get::<_, f64>(8)?,
        ))
    })?;
    for row in rows {
        let (
            node_id,
            agent_name,
            session_id,
            raw_model,
            input,
            output,
            reasoning,
            cache_read,
            cache_write,
        ) = row?;
        let tokens = MessageTokens {
            input: Some(input),
            output: Some(output),
            reasoning: (reasoning > 0.0).then_some(reasoning),
            cache_read: (cache_read > 0.0).then_some(cache_read),
            cache_create: (cache_write > 0.0).then_some(cache_write),
            cache_create_1h: None,
        };
        record_unmatched_tokens(
            acc,
            pricing,
            &node_id,
            &agent_name,
            &session_id,
            &raw_model,
            &tokens,
        );
    }
    Ok(())
}

fn collect_meta_unmatched(
    connection: &Connection,
    scope_sql: &str,
    scope_params: &[Value],
    from: Option<f64>,
    to: Option<f64>,
    pricing: &Pricing,
    acc: &mut HashMap<String, ModelAcc>,
) -> Result<()> {
    let mut params = scope_params.to_vec();
    let mut window = String::new();
    if let Some(from) = from {
        window.push_str(" AND s.activity_time >= ?");
        params.push(Value::Real(from));
    }
    if let Some(to) = to {
        window.push_str(" AND s.activity_time <= ?");
        params.push(Value::Real(to));
    }
    let sql = format!(
        "SELECT s.source_node_id, s.agent_name, s.session_id, s.meta_json
         FROM sessions s
         WHERE s.publication_id IS NULL
           AND s.meta_json LIKE '%\"rustPricing\"%'
           AND NOT EXISTS (
               SELECT 1 FROM session_cost_summary c
               WHERE c.source_node_id = s.source_node_id
                 AND c.agent_name = s.agent_name
                 AND c.session_id = s.session_id
                 AND ({TIMED_USAGE_SQL})
           )
           {scope_sql}
           {window}"
    );
    let mut stmt = connection.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(params), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (node_id, agent_name, session_id, raw_meta) = row?;
        if !raw_meta.contains("\"cost\":null") && !raw_meta.contains("\"cost\": null") {
            continue;
        }
        let Ok(stored) = serde_json::from_str::<StoredPricing>(&raw_meta) else {
            continue;
        };
        if stored.state.version != 1 {
            continue;
        }
        for input in &stored.state.head.inputs {
            if input.cost.is_some() {
                continue;
            }
            let Some(raw_model) = input.model.as_deref() else {
                continue;
            };
            record_unmatched_tokens(
                acc,
                pricing,
                &node_id,
                &agent_name,
                &session_id,
                raw_model,
                &input.tokens,
            );
        }
    }
    Ok(())
}

fn positive(value: Option<f64>) -> f64 {
    value.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0)
}

fn record_unmatched_tokens(
    acc: &mut HashMap<String, ModelAcc>,
    pricing: &Pricing,
    node_id: &str,
    agent_name: &str,
    session_id: &str,
    raw_model: &str,
    tokens: &MessageTokens,
) {
    let Some(model_key) = normalize_override_model_key(raw_model) else {
        return;
    };
    if pricing.resolve(&model_key).is_some() {
        return;
    }
    let input_tokens = positive(tokens.input);
    let output_tokens = positive(tokens.output) + positive(tokens.reasoning);
    let cache_read_tokens = positive(tokens.cache_read);
    let cache_write_tokens = positive(tokens.cache_create);
    let total_tokens = input_tokens + output_tokens;
    if total_tokens <= 0.0 && cache_read_tokens <= 0.0 && cache_write_tokens <= 0.0 {
        return;
    }

    let entry = acc.entry(model_key.clone()).or_insert_with(|| {
        let stripped = strip_service_tier(raw_model);
        ModelAcc {
            display_model: if stripped.is_empty() {
                model_key.clone()
            } else {
                stripped.to_owned()
            },
            ..Default::default()
        }
    });
    entry.agents.insert(agent_name.to_owned());
    entry.sessions.insert((
        node_id.to_owned(),
        agent_name.to_owned(),
        session_id.to_owned(),
    ));
    entry.input_tokens += input_tokens;
    entry.output_tokens += output_tokens;
    entry.cache_read_tokens += cache_read_tokens;
    entry.cache_write_tokens += cache_write_tokens;
    entry.total_tokens += total_tokens;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        agents::ParsedSession,
        model::{
            CostSource, DetailFreshness, Message, MessagePart, ProjectIdentity, Role,
            SessionDetail, SessionHead, SessionReference, SessionStats,
        },
        pricing::PricingController,
        state::ModelPriceOverrideRecord,
        storage::Cache,
        wire::{PricingOverrideKind, PricingRatePerMillion},
    };
    use std::path::PathBuf;

    struct TestSession<'a> {
        node_id: &'a str,
        agent: &'a str,
        id: &'a str,
        directory: &'a str,
        time: f64,
        messages: Vec<Message>,
        head_inputs_model: Option<(&'a str, MessageTokens)>,
    }

    fn make_session(spec: TestSession<'_>, pricing: &Pricing) -> ParsedSession {
        let TestSession {
            node_id,
            agent,
            id,
            directory,
            time,
            messages,
            head_inputs_model,
        } = spec;
        let mut stats = SessionStats {
            message_count: messages.len(),
            ..Default::default()
        };
        if let Some((model, tokens)) = head_inputs_model {
            stats.total_input_tokens = tokens.input.unwrap_or(0.0);
            stats.total_output_tokens =
                tokens.output.unwrap_or(0.0) + tokens.reasoning.unwrap_or(0.0);
            stats.total_cache_read_tokens = tokens.cache_read;
            stats.total_cache_create_tokens = tokens.cache_create;
            if let Some(cost) = pricing.estimate_aggregate_tracked(
                Some(model),
                &tokens,
                0.0,
                &mut stats.cost_inputs,
            ) {
                stats.total_cost = cost;
                stats.cost_source = Some(CostSource::Estimated);
            }
        } else {
            for message in &messages {
                if let Some(t) = &message.tokens {
                    stats.total_input_tokens += t.input.unwrap_or(0.0);
                    stats.total_output_tokens +=
                        t.output.unwrap_or(0.0) + t.reasoning.unwrap_or(0.0);
                    stats.total_cache_read_tokens = Some(
                        stats.total_cache_read_tokens.unwrap_or(0.0) + t.cache_read.unwrap_or(0.0),
                    );
                    stats.total_cache_create_tokens = Some(
                        stats.total_cache_create_tokens.unwrap_or(0.0)
                            + t.cache_create.unwrap_or(0.0),
                    );
                }
                stats.total_cost += message.cost.unwrap_or(0.0);
                stats
                    .cost_inputs
                    .extend(message.cost_inputs.iter().cloned());
                if message.cost_source == Some(CostSource::Estimated) {
                    stats.cost_source = Some(CostSource::Estimated);
                }
            }
        }
        let head = SessionHead {
            version: None,
            summary_files: None,
            reference: SessionReference {
                source_node_id: node_id.into(),
                agent_name: agent.into(),
                session_id: id.into(),
            },
            title: id.into(),
            directory: directory.into(),
            display_title: None,
            parent_reference: None,
            project_identity: ProjectIdentity {
                kind: "git".into(),
                key: format!("repo:{directory}"),
                display_name: directory.into(),
            },
            recorded_git_remotes: Vec::new(),
            project_identity_resolver_revision: None,
            project_identity_input_signature: None,
            time_created: time,
            time_updated: time,
            stats,
            model_usage: None,
            smart_tags: Vec::new(),
            smart_tags_source_updated_at: None,
            smart_tags_classifier_revision: None,
        };
        ParsedSession {
            source: PathBuf::from(format!("{directory}/{id}.jsonl")),
            head: head.clone(),
            detail: SessionDetail {
                head,
                messages,
                detail_freshness: DetailFreshness::Fresh,
                message_cursor: None,
                message_update: None,
                file_activity: Vec::new(),
            },
        }
    }

    fn assistant_message(
        id: &str,
        time: f64,
        model: &str,
        tokens: MessageTokens,
        pricing: &Pricing,
    ) -> Message {
        let mut cost_inputs = Vec::new();
        let cost = pricing.estimate_tracked(Some(model), &tokens, 0.0, &mut cost_inputs);
        Message {
            id: id.into(),
            agent: None,
            role: Role::Assistant,
            time_created: time,
            time_completed: Some(time),
            mode: None,
            model: Some(strip_service_tier(model).to_owned()),
            provider: None,
            tokens: Some(tokens),
            cost,
            cost_source: cost.map(|_| CostSource::Estimated),
            cost_breakdown: None,
            cost_inputs,
            parts: vec![MessagePart::Text {
                text: "ok".into(),
                time_created: Some(time),
            }],
            subagent_id: None,
            nickname: None,
            automated: None,
        }
    }

    #[test]
    fn codex_model_changes_follow_dashboard_windows_without_counting_head_copies() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("rollout-model-change.jsonl");
        let lines = [
            serde_json::json!({"type":"session_meta","timestamp":900000,"payload":{"cwd":"/tmp/project","model":"acme/old"}}),
            serde_json::json!({"type":"event_msg","timestamp":900000,"payload":{"type":"thread_settings_applied","thread_settings":{"service_tier":"priority"}}}),
            serde_json::json!({"type":"response_item","timestamp":900001,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Old"}]}}),
            serde_json::json!({"type":"response_item","timestamp":900002,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Old answer"}]}}),
            serde_json::json!({"type":"event_msg","timestamp":900003,"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1100},"last_token_usage":{"input_tokens":1000,"output_tokens":100,"reasoning_output_tokens":25}}}}),
            serde_json::json!({"type":"turn_context","timestamp":1800000,"payload":{"model":"gpt-5.4"}}),
            serde_json::json!({"type":"response_item","timestamp":1800001,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"New"}]}}),
            serde_json::json!({"type":"response_item","timestamp":1800002,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"New answer"}]}}),
            serde_json::json!({"type":"event_msg","timestamp":1800003,"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1210},"last_token_usage":{"input_tokens":100,"output_tokens":10}}}}),
        ];
        std::fs::write(
            &path,
            lines
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let pricing = Pricing::bundled();
        let detail = crate::agents::parse_codex(&path, &HashMap::new(), &pricing)
            .unwrap()
            .unwrap();
        let mut session = ParsedSession {
            source: path,
            head: detail.head.clone(),
            detail,
        };
        let mut cache = Cache::open(None).unwrap();
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        for (from, to, expected_tokens, expected_unmatched) in [
            (900000.0, 1799999.0, 1100.0, 1100.0),
            (1800000.0, 2699999.0, 110.0, 0.0),
            (900000.0, 2699999.0, 1210.0, 1100.0),
        ] {
            let unmatched = query_unmatched_models(
                cache.connection(),
                &QueryScope::default(),
                Some(from),
                Some(to),
                &pricing,
            )
            .unwrap();
            assert_eq!(
                unmatched.iter().map(|m| m.total_tokens).sum::<f64>(),
                expected_unmatched
            );
            if expected_unmatched > 0.0 {
                assert_eq!(unmatched.len(), 1);
                assert_eq!(unmatched[0].model_key, "acme/old");
                assert_eq!(unmatched[0].session_count, 1);
                assert_eq!(unmatched[0].output_tokens, 100.0);
            }
            let scope = crate::analytics::DashboardScope::default();
            let zone = "UTC".parse().unwrap();
            let (dashboard, _) = crate::analytics::dashboard_response(
                cache.connection(),
                &cache.snapshot().unwrap(),
                &crate::analytics::DashboardResponseOptions {
                    aggregate: crate::analytics::DashboardOptions {
                        by_agent_names: &["codex".into()],
                        scope: &scope,
                        from: Some(from),
                        to,
                        agent_info: None,
                        compare: None,
                        cost_facts: None,
                        time_zone: &zone,
                    },
                    days: 1,
                    query_scope: None,
                },
            )
            .unwrap();
            assert_eq!(dashboard.aggregate.totals.tokens, expected_tokens);
        }
    }

    #[test]
    fn merged_model_usage_keeps_each_unmatched_model() {
        for (second_model, display_model, expected_models) in [
            ("gpt-5.4", "gpt-5.4", vec![("acme/first", 1100.0)]),
            (
                "acme/second",
                "acme/first",
                vec![("acme/first", 1100.0), ("acme/second", 110.0)],
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().join("sessions/project");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("summary.json"),
                serde_json::json!({"info":{"id":"merged","cwd":"/tmp/project"},"created_at":"1970-01-01T00:15:00Z","current_model_id":display_model}).to_string(),
            ).unwrap();
            let update = |time, kind: &str, mut fields: serde_json::Value| {
                fields["sessionUpdate"] = kind.into();
                serde_json::json!({
                    "method":if kind == "turn_completed" { "_x.ai/session/update" } else { "session/update" },
                    "params":{"update":fields,"_meta":{"agentTimestampMs":time,"promptId":"p"}}
                })
            };
            let records = [
                update(
                    900001,
                    "user_message_chunk",
                    serde_json::json!({"content":{"type":"text","text":"Hi"}}),
                ),
                update(
                    900002,
                    "agent_message_chunk",
                    serde_json::json!({"content":{"type":"text","text":"Hello"}}),
                ),
                update(
                    900003,
                    "turn_completed",
                    serde_json::json!({"usage":{
                        "inputTokens":1100,"outputTokens":110,"totalTokens":1210,
                        "modelUsage":{
                            "acme/first":{"inputTokens":1000,"outputTokens":100,"totalTokens":1100},
                            (second_model):{"inputTokens":100,"outputTokens":10,"totalTokens":110}
                        }
                    }}),
                ),
            ];
            std::fs::write(
                dir.join("updates.jsonl"),
                records
                    .iter()
                    .map(serde_json::Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
            .unwrap();
            let pricing = Pricing::bundled();
            let mut sessions = crate::agents::grok::scan(root.path(), &pricing).unwrap();
            assert_eq!(sessions.len(), 1);
            let mut cache = Cache::open(None).unwrap();
            cache.publish(&mut sessions).unwrap();
            for (from, to) in [(None, None), (Some(900000.0), Some(1799999.0))] {
                let unmatched = query_unmatched_models(
                    cache.connection(),
                    &QueryScope::default(),
                    from,
                    to,
                    &pricing,
                )
                .unwrap();
                assert_eq!(
                    unmatched
                        .iter()
                        .map(|m| (m.model_key.as_str(), m.total_tokens))
                        .collect::<Vec<_>>(),
                    expected_models,
                );
                assert!(unmatched.iter().all(|m| m.session_count == 1));
            }
        }
    }

    #[test]
    fn incomplete_or_untimed_message_usage_falls_back_to_head_once() {
        let pricing = Pricing::bundled();
        let partial = serde_json::from_value(serde_json::json!({"input":100,"output":10})).unwrap();
        let total: MessageTokens =
            serde_json::from_value(serde_json::json!({"input":1000,"output":100})).unwrap();
        for (message_time, message_tokens) in [(900000.0, partial), (0.0, total.clone())] {
            let message =
                assistant_message("m", message_time, "acme/unknown", message_tokens, &pricing);
            let mut session = make_session(
                TestSession {
                    node_id: "local",
                    agent: "pi",
                    id: "incomplete",
                    directory: "/tmp/project",
                    time: 1800000.0,
                    messages: vec![message],
                    head_inputs_model: Some(("acme/unknown", total.clone())),
                },
                &pricing,
            );
            let mut cache = Cache::open(None).unwrap();
            cache.publish(std::slice::from_mut(&mut session)).unwrap();
            assert!(
                query_unmatched_models(
                    cache.connection(),
                    &QueryScope::default(),
                    Some(900000.0),
                    Some(1799999.0),
                    &pricing
                )
                .unwrap()
                .is_empty()
            );
            let current = query_unmatched_models(
                cache.connection(),
                &QueryScope::default(),
                Some(1800000.0),
                Some(2699999.0),
                &pricing,
            )
            .unwrap();
            assert_eq!(current.len(), 1);
            assert_eq!(current[0].total_tokens, 1100.0);
            assert_eq!(current[0].session_count, 1);
        }
    }

    #[test]
    fn aggregates_bucket_head_scoped_windowed_and_clears_after_zero_override() {
        let home = tempfile::tempdir().unwrap();
        let controller = PricingController::load(home.path());
        let pricing = controller.snapshot().unwrap().pricing;

        let tok_a = MessageTokens {
            input: Some(1_000.0),
            output: Some(200.0),
            reasoning: Some(50.0),
            cache_read: Some(400.0),
            cache_create: Some(100.0),
            cache_create_1h: None,
        };
        let tok_b = MessageTokens {
            input: Some(500.0),
            output: Some(100.0),
            reasoning: None,
            cache_read: None,
            cache_create: None,
            cache_create_1h: None,
        };
        let t_in = 1_800_000.0;
        let t_old = 900_000.0;

        let pi_msg = assistant_message("m1", t_in, "Custom_Unmatched", tok_a.clone(), &pricing);
        let pi_sess = make_session(
            TestSession {
                node_id: "local",
                agent: "pi",
                id: "pi-1",
                directory: "/work/app-a",
                time: t_in,
                messages: vec![pi_msg],
                head_inputs_model: None,
            },
            &pricing,
        );
        let droid_sess = make_session(
            TestSession {
                node_id: "local",
                agent: "droid",
                id: "droid-1",
                directory: "/work/app-a",
                time: t_in,
                messages: Vec::new(),
                head_inputs_model: Some(("Custom_Unmatched@fast", tok_b.clone())),
            },
            &pricing,
        );
        let codex_msg = assistant_message("m2", t_in, "Other_Model", tok_b.clone(), &pricing);
        let codex_sess = make_session(
            TestSession {
                node_id: "worker-1",
                agent: "codex",
                id: "codex-1",
                directory: "/work/app-b",
                time: t_in,
                messages: vec![codex_msg],
                head_inputs_model: None,
            },
            &pricing,
        );
        let old_sess = make_session(
            TestSession {
                node_id: "local",
                agent: "droid",
                id: "droid-old",
                directory: "/work/app-a",
                time: t_old,
                messages: Vec::new(),
                head_inputs_model: Some(("Custom_Unmatched", tok_b.clone())),
            },
            &pricing,
        );
        // Recorded opencode fork should not double-count copied unmatched message inputs.
        let mut opencode_fork_msg =
            assistant_message("m3", t_in, "Forked_Only", tok_b.clone(), &pricing);
        opencode_fork_msg.cost = Some(0.0);
        let mut opencode_fork = make_session(
            TestSession {
                node_id: "local",
                agent: "opencode",
                id: "fork-1",
                directory: "/work/app-a",
                time: t_in,
                messages: vec![opencode_fork_msg],
                head_inputs_model: None,
            },
            &pricing,
        );
        opencode_fork.head.stats.cost_inputs.clear();
        opencode_fork.detail.head.stats.cost_inputs.clear();
        opencode_fork.head.stats.cost_source = Some(CostSource::Recorded);
        opencode_fork.detail.head.stats.cost_source = Some(CostSource::Recorded);

        let mut cache = Cache::open(None).unwrap();
        cache
            .publish(&mut [pi_sess, droid_sess, codex_sess, old_sess, opencode_fork])
            .unwrap();

        let all = query_unmatched_models(
            cache.connection(),
            &QueryScope::default(),
            Some(1_500_000.0),
            Some(2_000_000.0),
            &pricing,
        )
        .unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].model_key, "custom-unmatched");
        assert_eq!(all[0].agents, vec!["droid", "pi"]);
        assert_eq!(all[0].session_count, 2);
        assert_eq!(all[0].input_tokens, 1_500.0);
        assert_eq!(all[0].output_tokens, 350.0);
        assert_eq!(all[0].cache_read_tokens, 400.0);
        assert_eq!(all[0].cache_write_tokens, 100.0);
        assert_eq!(all[0].total_tokens, 1_850.0);
        assert_eq!(all[1].model_key, "other-model");

        let scoped = query_unmatched_models(
            cache.connection(),
            &QueryScope {
                source_node_id: Some("worker-1".into()),
                agents: vec!["codex".into()],
                project_scope: Some(crate::projects::create_project_scope_matcher("/work/app-b")),
            },
            None,
            None,
            &pricing,
        )
        .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].model_key, "other-model");

        let zero_snap = controller
            .replace_overrides(vec![ModelPriceOverrideRecord {
                model_key: "custom-unmatched".into(),
                display_model: "Custom_Unmatched".into(),
                kind: PricingOverrideKind::Manual,
                target_model: None,
                rates: Some(PricingRatePerMillion {
                    input: 0.0,
                    output: 0.0,
                    cache_read: 0.0,
                    cache_write: 0.0,
                }),
                acknowledged_official_hash: None,
                acknowledged_official_json: None,
                created_at: 1,
                updated_at: 1,
            }])
            .unwrap();
        for agent in ["pi", "droid"] {
            cache.reprice(agent, &zero_snap.pricing).unwrap();
        }
        let after_zero = query_unmatched_models(
            cache.connection(),
            &QueryScope::default(),
            Some(1_500_000.0),
            Some(2_000_000.0),
            &zero_snap.pricing,
        )
        .unwrap();
        assert_eq!(after_zero.len(), 1);
        assert_eq!(after_zero[0].model_key, "other-model");
    }
}
