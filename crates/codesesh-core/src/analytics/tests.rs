use super::*;
use crate::contract::{ProjectIdentity, SessionReference, SessionStats};

fn head(id: &str, parent: Option<&str>, time: i64) -> SessionHead {
    SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            agent_name: "codex".into(),
            session_id: id.into(),
        },
        title: id.into(),
        directory: "/project".into(),
        display_title: None,
        parent_reference: parent.map(|id| SessionReference {
            agent_name: "codex".into(),
            session_id: id.into(),
        }),
        project_identity: ProjectIdentity {
            kind: "path".into(),
            key: "/project".into(),
            display_name: "project".into(),
        },
        project_identity_resolver_revision: None,
        project_identity_input_signature: None,
        time_created: time as f64,
        time_updated: time as f64,
        stats: SessionStats {
            message_count: 1,
            total_input_tokens: 10.0,
            total_output_tokens: 2.0,
            total_cost: 1.0,
            ..SessionStats::default()
        },
        model_usage: None,
        smart_tags: vec![],
        smart_tags_source_updated_at: None,
        smart_tags_classifier_revision: None,
    }
}

#[test]
fn descendants_follow_parent_window_and_cycle_becomes_orphans() {
    let sessions = vec![
        head("parent", None, 200),
        head("child", Some("parent"), 500),
        head("a", Some("b"), 100),
        head("b", Some("a"), 300),
    ];
    let filtered = crate::query::filter_activity_window(&sessions, Some(150.0), Some(250.0));
    assert_eq!(
        filtered
            .iter()
            .map(|s| s.title.as_str())
            .collect::<Vec<_>>(),
        vec!["parent", "child"]
    );
    let tree = SessionTree::new(&sessions);
    assert_eq!(tree.entries, vec![0, 2, 3]);
}

#[test]
fn dashboard_includes_descendants_but_counts_only_entries() {
    let sessions = vec![
        head("parent", None, 200),
        head("child", Some("parent"), 500),
    ];
    let names = vec!["codex".into()];
    let scope = DashboardScope::default();
    let result = build_dashboard(
        &sessions,
        &DashboardOptions {
            by_agent_names: &names,
            scope: &scope,
            from: Some(150.0),
            to: 250.0,
            agent_info: None,
            compare: None,
            cost_facts: None,
        },
    );
    assert_eq!(result["totals"]["sessions"], 1);
    assert_eq!(result["totals"]["messages"], 2);
    assert_eq!(result["totals"]["tokens"], 24.0);
    assert_eq!(result["totals"]["cost"], 2.0);
    assert_eq!(result["modelCost"], Value::Null);
}

#[test]
fn reconciled_messages_attribute_cost_to_message_time() {
    let mut session = head("parent", None, 500);
    session.stats.message_count = 1;
    let reference = session.reference.clone();
    let facts = DashboardCostFacts {
        messages: vec![MessageCostFact {
            reference: reference.clone(),
            time: 200.0,
            model: Some("model".into()),
            input_tokens: 10.0,
            output_tokens: 2.0,
            reasoning_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_create_tokens: 0.0,
            cost: 1.0,
            cost_source: None,
        }],
        sessions: vec![SessionCostSummary {
            reference,
            message_count: 1,
            untimed_message_count: 0,
            input_tokens: 10.0,
            output_tokens: 2.0,
            reasoning_tokens: 0.0,
            cache_read_tokens: 0.0,
            cache_create_tokens: 0.0,
            untimed_input_tokens: 0.0,
            untimed_output_tokens: 0.0,
            untimed_reasoning_tokens: 0.0,
            untimed_cache_read_tokens: 0.0,
            untimed_cache_create_tokens: 0.0,
            message_cost: 1.0,
            untimed_message_cost: 0.0,
            model_costs: vec![],
        }],
    };
    let names = vec!["codex".into()];
    let scope = DashboardScope::default();
    let result = build_dashboard(
        &[session],
        &DashboardOptions {
            by_agent_names: &names,
            scope: &scope,
            from: Some(150.0),
            to: 250.0,
            agent_info: None,
            compare: None,
            cost_facts: Some(&facts),
        },
    );
    assert_eq!(result["totals"]["sessions"], 0);
    assert_eq!(result["totals"]["messages"], 1);
    assert_eq!(result["totals"]["tokens"], 12.0);
    assert_eq!(result["totals"]["cost"], 1.0);
    assert_eq!(result["modelCost"][0]["costRecorded"], 1.0);
}

#[test]
fn matches_node_reference_for_ranking_windows_and_cost_reconciliation() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
    for (index, fixture) in fixtures.iter().enumerate() {
        let sessions: Vec<SessionHead> =
            serde_json::from_value(fixture["sessions"].clone()).unwrap();
        let options = &fixture["options"];
        let names: Vec<String> = serde_json::from_value(options["byAgentNames"].clone()).unwrap();
        let scope: DashboardScope = serde_json::from_value(options["scope"].clone()).unwrap();
        let facts = options
            .get("costFacts")
            .map(|v| serde_json::from_value::<DashboardCostFacts>(v.clone()).unwrap());
        let actual = build_dashboard(
            &sessions,
            &DashboardOptions {
                by_agent_names: &names,
                scope: &scope,
                from: options["from"].as_f64(),
                to: options["to"].as_f64().unwrap(),
                agent_info: None,
                compare: options
                    .get("compare")
                    .map(|c| (c["from"].as_f64().unwrap(), c["to"].as_f64().unwrap())),
                cost_facts: facts.as_ref(),
            },
        );
        assert_json_equivalent(&actual, &fixture["expected"], &format!("case {index}"));
        let projects = attach_project_metrics(
            fixture["projects"].as_array().unwrap(),
            &sessions,
            options["from"].as_f64(),
            options["to"].as_f64(),
            facts.as_ref(),
        );
        assert_json_equivalent(
            &json!(projects),
            &fixture["expectedProjects"],
            &format!("projects {index}"),
        );
        assert_json_equivalent(
            &summarize_projects(&projects),
            &fixture["expectedSummary"],
            &format!("summary {index}"),
        );
    }
}

fn assert_json_equivalent(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{path}"),
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(a.len(), b.len(), "{path}: {actual} != {expected}");
            for (key, value) in b {
                assert_json_equivalent(&a[key], value, &format!("{path}.{key}"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                assert_json_equivalent(a, b, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}

#[test]
fn sqlite_facts_and_active_hours_respect_effective_time_and_automation() {
    let time = chrono::DateTime::parse_from_rfc3339("2026-03-08T07:30:00Z")
        .unwrap()
        .timestamp_millis();
    let mut session = head("database", None, time);
    session.stats.message_count = 3;
    let message = json!({"id":"user","role":"user","agent":null,"time_created":time,"time_completed":time as f64+1000.25,"mode":null,"model":"model","provider":null,"tokens":{"input":10.8,"output":2},"cost":1,"parts":[]});
    let mut automated = message.clone();
    automated["id"] = json!("automated");
    automated["automated"] = json!(true);
    let mut assistant = message.clone();
    assistant["id"] = json!("assistant");
    assistant["role"] = json!("assistant");
    let detail=serde_json::from_value(json!({"reference":session.reference,"title":session.title,"directory":session.directory,"project_identity":session.project_identity,"time_created":time,"time_updated":time,"stats":session.stats,"smart_tags":[],"messages":[message,automated,assistant],"detail_freshness":"fresh","file_activity":[]})).unwrap();
    let mut parsed = vec![crate::agents::codex::ParsedSession {
        head: session.clone(),
        source: "/fixture/not-required".into(),
        detail,
    }];
    let mut cache = crate::storage::Cache::open(None).unwrap();
    cache.publish(&mut parsed).unwrap();
    let facts = load_cost_facts(
        cache.connection(),
        Some(time as f64),
        Some((time + 1001) as f64),
        true,
    )
    .unwrap();
    assert_eq!(facts.messages.len(), 3);
    assert_eq!(facts.messages[0].time, time as f64 + 1000.25);
    assert_eq!(facts.messages[0].input_tokens, 10.0);
    assert_eq!(facts.sessions[0].input_tokens, 30.0);
    let outside =
        load_cost_facts(cache.connection(), None, Some((time + 1000) as f64), true).unwrap();
    assert!(outside.messages.is_empty());
    assert_eq!(outside.sessions.len(), 1);
    let hours = active_hours(
        cache.connection(),
        &[session],
        &DashboardScope::default(),
        None,
        (time + 1000) as f64,
        "America/New_York".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(hours["counts"][1], 1);
    assert_eq!(
        hours["counts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .sum::<u64>(),
        1
    );
}

#[test]
fn fractional_activity_stays_outside_the_inclusive_boundary() {
    let mut session = head("fractional", None, 1000);
    session.time_updated = 1000.25;
    assert!(
        crate::query::filter_activity_window(&[session.clone()], None, Some(1000.0)).is_empty()
    );
    assert_eq!(
        crate::query::filter_activity_window(&[session], Some(1000.25), Some(1000.25)).len(),
        1
    );
}

#[test]
fn cost_facts_reuse_the_callers_transaction_without_committing_it() {
    let cache = crate::storage::Cache::open(None).unwrap();
    let connection = cache.connection();
    connection
        .execute_batch("BEGIN DEFERRED; CREATE TABLE transaction_probe(value TEXT);")
        .unwrap();
    let facts = load_cost_facts(connection, None, None, true).unwrap();
    assert!(facts.messages.is_empty());
    assert!(facts.sessions.is_empty());
    assert!(!connection.is_autocommit());
    connection.execute_batch("ROLLBACK").unwrap();
    assert!(
        connection
            .prepare("SELECT * FROM transaction_probe")
            .is_err()
    );
}

#[test]
fn empty_project_rollup_serializes_positive_zero() {
    let result = build_dashboard(
        &[],
        &DashboardOptions {
            by_agent_names: &[],
            scope: &DashboardScope::default(),
            from: None,
            to: 0.0,
            agent_info: None,
            compare: None,
            cost_facts: None,
        },
    );
    for field in ["tokens", "cost"] {
        let value = result["projectRollup"][field].as_f64().unwrap();
        assert_eq!(value, 0.0);
        assert!(!value.is_sign_negative());
    }
}
