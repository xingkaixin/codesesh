use super::*;
use crate::model::{ProjectIdentity, SessionReference, SessionStats};

fn head(id: &str, parent: Option<&str>, time: i64) -> SessionHead {
    SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            source_node_id: crate::model::local_source_node_id(),
            agent_name: "codex".into(),
            session_id: id.into(),
        },
        title: id.into(),
        directory: "/project".into(),
        display_title: None,
        parent_reference: parent.map(|id| SessionReference {
            source_node_id: crate::model::local_source_node_id(),
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
    let filtered = crate::session_list::filter_activity_window(&sessions, Some(150.0), Some(250.0));
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
    let result = dashboard(
        &sessions,
        &DashboardOptions {
            by_agent_names: &names,
            scope: &scope,
            from: Some(150.0),
            to: 250.0,
            agent_info: None,
            compare: None,
            cost_facts: None,
            time_zone: &"UTC".parse().unwrap(),
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
            message_count: 1,
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
    let facts = CostFactsIndex::from(facts);
    let result = dashboard(
        &[session],
        &DashboardOptions {
            by_agent_names: &names,
            scope: &scope,
            from: Some(150.0),
            to: 250.0,
            agent_info: None,
            compare: None,
            cost_facts: Some(&facts),
            time_zone: &"UTC".parse().unwrap(),
        },
    );
    assert_eq!(result["totals"]["sessions"], 0);
    assert_eq!(result["totals"]["messages"], 1);
    assert_eq!(result["totals"]["tokens"], 12.0);
    assert_eq!(result["totals"]["cost"], 1.0);
    assert_eq!(result["modelCost"][0]["costRecorded"], 1.0);
}

fn dashboard(sessions: &[SessionHead], options: &DashboardOptions<'_>) -> Value {
    serde_json::to_value(build_dashboard(sessions, options).unwrap()).unwrap()
}

#[test]
fn sqlite_facts_and_active_hours_respect_effective_time_and_automation() {
    let time = chrono::DateTime::parse_from_rfc3339("2026-03-08T07:30:00Z")
        .unwrap()
        .timestamp_millis();
    let mut session = head("database", None, time);
    session.stats.message_count = 3;
    let message = json!({"id":"user","role":"user","agent":null,"time_created":time-500,"time_completed":time as f64+1000.25,"mode":null,"model":"model","provider":null,"tokens":{"input":10.8,"output":2},"cost":1,"parts":[]});
    let mut automated = message.clone();
    automated["id"] = json!("automated");
    automated["automated"] = json!(true);
    let mut assistant = message.clone();
    assistant["id"] = json!("assistant");
    assistant["role"] = json!("assistant");
    let detail=serde_json::from_value(json!({"reference":session.reference,"title":session.title,"directory":session.directory,"project_identity":session.project_identity,"time_created":time,"time_updated":time,"stats":session.stats,"smart_tags":[],"messages":[message,automated,assistant],"detail_freshness":"fresh","file_activity":[]})).unwrap();
    let mut parsed = vec![crate::agents::ParsedSession {
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
    assert_eq!(facts.messages.len(), 1);
    assert_eq!(facts.messages[0].time, time as f64);
    assert_eq!(facts.messages[0].message_count, 3);
    assert_eq!(facts.messages[0].input_tokens, 30.0);
    assert_eq!(facts.sessions[0].input_tokens, 30.0);
    let outside = load_cost_facts(cache.connection(), None, Some((time - 1) as f64), true).unwrap();
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
    assert_eq!(hours.counts[1], 1);
    assert_eq!(hours.counts.iter().sum::<usize>(), 1);
}

#[test]
fn scoped_facts_preserve_descendants_and_reconciliation_without_reading_other_sources() {
    const BUCKET: i64 = 900_000;
    let mut parent = head("shared", None, 2 * BUCKET + 1_000);
    parent.reference.source_node_id = "worker-a".into();
    let mut child = head("child", None, 5 * BUCKET);
    child.reference.source_node_id = "worker-a".into();
    child.reference.agent_name = "claudecode".into();
    child.project_identity.key = "/child-project".into();
    child.parent_reference = Some(parent.reference.clone());
    let mut historical = head("historical", None, 9 * BUCKET);
    historical.reference.source_node_id = "worker-a".into();
    let local = head("shared", None, 2 * BUCKET + 1_000);
    let mut outside = head("outside", None, 2 * BUCKET + 1_000);
    outside.reference.source_node_id = "worker-a".into();
    outside.project_identity.key = "/other-project".into();
    let mut parsed: Vec<_> = [parent, child, historical, local, outside]
        .into_iter()
        .map(|mut head| {
            let times = if head.reference.session_id == "child" { vec![0] } else { vec![BUCKET, 2 * BUCKET] };
            head.stats.message_count = times.len();
            head.stats.total_input_tokens = times.len() as f64 * 10.0;
            head.stats.total_output_tokens = times.len() as f64 * 2.0;
            head.stats.total_cost = times.len() as f64;
            let messages: Vec<_> = times.into_iter().enumerate().map(|(index, time)| {
                json!({"id":format!("message-{index}"),"role":"user","agent":null,"time_created":time,"time_completed":null,"mode":null,"model":"model","provider":null,"tokens":{"input":10,"output":2},"cost":1,"parts":[]})
            }).collect();
            let mut detail = serde_json::to_value(&head).unwrap();
            detail["messages"] = json!(messages);
            detail["detail_freshness"] = json!("fresh");
            detail["file_activity"] = json!([]);
            crate::agents::ParsedSession {
                head,
                source: "/fixture/not-required".into(),
                detail: serde_json::from_value(detail).unwrap(),
            }
        }).collect();
    let mut cache = crate::storage::Cache::open(None).unwrap();
    cache.publish(&mut parsed).unwrap();
    let sessions: Vec<_> = cache
        .snapshot()
        .unwrap()
        .into_iter()
        .filter(|head| head.reference.source_node_id == "worker-a")
        .collect();
    let scope = DashboardScope {
        agent: Some("codex".into()),
        project_kind: Some("path".into()),
        project_key: Some("/project".into()),
    };
    let (from, to) = ((2 * BUCKET) as f64, (3 * BUCKET - 1) as f64);
    let all = load_cost_facts(cache.connection(), Some(BUCKET as f64), Some(to), true).unwrap();
    let scoped = load_scoped_cost_facts(
        cache.connection(),
        &sessions,
        &scope,
        Some(BUCKET as f64),
        Some(to),
        true,
    )
    .unwrap();
    assert_eq!(scoped.sessions.len(), 3);
    assert_eq!(scoped.messages.len(), 4);
    assert!(
        scoped
            .sessions
            .iter()
            .any(|summary| summary.reference.agent_name == "claudecode")
    );
    assert!(
        scoped
            .sessions
            .iter()
            .all(|summary| summary.reference.source_node_id == "worker-a")
    );
    let (all, scoped) = (CostFactsIndex::from(all), CostFactsIndex::from(scoped));
    let options = DashboardOptions {
        by_agent_names: &["codex".into(), "claudecode".into()],
        scope: &scope,
        from: Some(from),
        to,
        agent_info: None,
        compare: Some((BUCKET as f64, from - 1.0)),
        cost_facts: Some(&all),
        time_zone: &"UTC".parse().unwrap(),
    };
    let expected = dashboard(&sessions, &options);
    let actual = dashboard(
        &sessions,
        &DashboardOptions {
            cost_facts: Some(&scoped),
            ..options
        },
    );
    assert_eq!(actual, expected);
    assert_eq!(actual["totals"]["cost"], 3.0);
    let hours = active_hours(
        cache.connection(),
        &sessions,
        &scope,
        Some(from),
        to,
        "UTC".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(hours.counts.iter().sum::<usize>(), 2);
    let empty = load_scoped_cost_facts(cache.connection(), &[], &scope, None, None, true).unwrap();
    assert!(empty.sessions.is_empty());
    assert!(empty.messages.is_empty());
}

#[test]
fn bucketed_facts_match_message_facts_on_aligned_windows() {
    const BUCKET: i64 = 900_000;
    const DAY: i64 = 86_400_000;
    let start = chrono::DateTime::parse_from_rfc3339("2026-03-08T00:00:00Z")
        .unwrap()
        .timestamp_millis();
    let spec = [
        (-1, "m1", "recorded", 7, 0, 0.5),
        (0, "m1", "recorded", 10, 4, 1.0),
        (10_000, "m2", "estimated", 3, 0, 0.25),
        (BUCKET - 1, "m1", "recorded", 5, 1, 0.125),
        (BUCKET, "m1", "", 6, 0, 0.0625),
        (DAY + 300_000, "m2", "recorded", 20, 8, 2.0),
        (2 * DAY, "m1", "estimated", 9, 0, 0.75),
    ];
    let mut session = head("buckets", None, start + DAY);
    session.stats = SessionStats {
        message_count: spec.len(),
        total_input_tokens: spec.iter().map(|m| m.3 as f64).sum(),
        total_output_tokens: 2.0 * spec.len() as f64,
        total_cache_read_tokens: Some(spec.iter().map(|m| m.4 as f64).sum()),
        total_cost: spec.iter().map(|m| m.5).sum(),
        ..SessionStats::default()
    };
    let messages: Vec<_> = spec.iter().enumerate().map(|(index, (offset, model, source, input, cache_read, cost))| {
        json!({"id":format!("m{index}"),"role":"assistant","agent":null,"time_created":start + offset,"time_completed":null,"mode":null,"model":model,"provider":null,"tokens":{"input":input,"output":2,"cache_read":cache_read},"cost":cost,"cost_source":(!source.is_empty()).then_some(source),"parts":[]})
    }).collect();
    let mut detail = serde_json::to_value(&session).unwrap();
    detail["messages"] = json!(messages);
    detail["detail_freshness"] = json!("fresh");
    detail["file_activity"] = json!([]);
    let mut cache = crate::storage::Cache::open(None).unwrap();
    cache
        .publish(&mut [crate::agents::ParsedSession {
            head: session.clone(),
            source: "/fixture/not-required".into(),
            detail: serde_json::from_value(detail).unwrap(),
        }])
        .unwrap();
    let stored = load_cost_facts(cache.connection(), None, None, true).unwrap();
    assert!(stored.messages.len() < spec.len());
    let per_message = CostFactsIndex::from(DashboardCostFacts {
        messages: spec
            .iter()
            .map(
                |(offset, model, source, input, cache_read, cost)| MessageCostFact {
                    reference: session.reference.clone(),
                    time: (start + offset) as f64,
                    message_count: 1,
                    model: Some(model.to_string()),
                    input_tokens: *input as f64,
                    output_tokens: 2.0,
                    reasoning_tokens: 0.0,
                    cache_read_tokens: *cache_read as f64,
                    cache_create_tokens: 0.0,
                    cost: *cost,
                    cost_source: match *source {
                        "recorded" => Some(crate::model::CostSource::Recorded),
                        "estimated" => Some(crate::model::CostSource::Estimated),
                        _ => None,
                    },
                },
            )
            .collect(),
        sessions: stored.sessions.clone(),
    });
    let bucketed = CostFactsIndex::from(stored);
    let sessions = cache.snapshot().unwrap();
    let names = vec!["codex".into()];
    let scope = DashboardScope::default();
    let projects = vec![json!({"identityKind":"path","identityKey":"/project"})];
    let utc = "UTC".parse().unwrap();
    for (from, to, compare) in [
        (
            Some(start as f64),
            (start + 2 * DAY - 1) as f64,
            Some(((start - 2 * DAY) as f64, (start - 1) as f64)),
        ),
        (None, (start + 3 * DAY) as f64, None),
    ] {
        let options = |facts| DashboardOptions {
            by_agent_names: &names,
            scope: &scope,
            from,
            to,
            agent_info: None,
            compare,
            cost_facts: Some(facts),
            time_zone: &utc,
        };
        assert_eq!(
            dashboard(&sessions, &options(&bucketed)),
            dashboard(&sessions, &options(&per_message))
        );
        assert_eq!(
            attach_project_metrics(&projects, &sessions, from, Some(to), Some(&bucketed)),
            attach_project_metrics(&projects, &sessions, from, Some(to), Some(&per_message))
        );
    }
}
