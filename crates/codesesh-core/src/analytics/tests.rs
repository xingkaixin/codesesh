use super::*;
use crate::contract::{ProjectIdentity, SessionReference, SessionStats};

fn head(id: &str, parent: Option<&str>, time: i64) -> SessionHead {
    SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
            agent_name: "codex".into(),
            session_id: id.into(),
        },
        title: id.into(),
        directory: "/project".into(),
        display_title: None,
        parent_reference: parent.map(|id| SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
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
        let facts = options.get("costFacts").map(|v| {
            CostFactsIndex::from(serde_json::from_value::<DashboardCostFacts>(v.clone()).unwrap())
        });
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
    let message = json!({"id":"user","role":"user","agent":null,"time_created":time-500,"time_completed":time as f64+1000.25,"mode":null,"model":"model","provider":null,"tokens":{"input":10.8,"output":2},"cost":1,"parts":[]});
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
            crate::agents::codex::ParsedSession {
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
    };
    let expected = build_dashboard(&sessions, &options);
    let actual = build_dashboard(
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
    assert_eq!(
        hours["counts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .sum::<u64>(),
        2
    );
    let empty = load_scoped_cost_facts(cache.connection(), &[], &scope, None, None, true).unwrap();
    assert!(empty.sessions.is_empty());
    assert!(empty.messages.is_empty());
}

#[test]
fn active_hours_work_does_not_grow_with_unrelated_message_history() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    let cache = crate::storage::Cache::open(None).unwrap();
    let db = cache.connection();
    db.execute_batch("INSERT INTO sessions(source_node_id,agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost)
        VALUES('local','codex','parent','Parent','/project','path','/project','project',100,200,1,0,0,0);
        INSERT INTO messages(source_node_id,agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text)
        VALUES('local','codex','parent',0,'current','user',200,'[]','Current user message');").unwrap();
    let sessions = cache.snapshot().unwrap();
    let steps = Arc::new(AtomicUsize::new(0));
    let counter = steps.clone();
    db.progress_handler(
        1,
        Some(move || {
            counter.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )
    .unwrap();
    let measure = || {
        steps.store(0, Ordering::Relaxed);
        let hours = active_hours(
            db,
            &sessions,
            &DashboardScope::default(),
            Some(150.0),
            250.0,
            "UTC".parse().unwrap(),
        )
        .unwrap();
        assert_eq!(
            hours["counts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_u64().unwrap())
                .sum::<u64>(),
            1
        );
        steps.load(Ordering::Relaxed)
    };
    let baseline = measure();
    db.execute_batch("WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<5000)
        INSERT INTO messages(source_node_id,agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text)
        SELECT 'local','codex','parent',n,'history-'||n,'user',100,'[]',printf('%2048s','history') FROM rows;
        WITH RECURSIVE rows(n) AS (VALUES(5001) UNION ALL SELECT n+1 FROM rows WHERE n<10000)
        INSERT INTO messages(source_node_id,agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text)
        SELECT 'local','codex','parent',n,'assistant-'||n,'assistant',200,'[]',printf('%2048s','assistant') FROM rows;").unwrap();
    let with_history = measure();
    assert!(
        with_history < baseline * 2,
        "query work grew from {baseline} to {with_history} steps"
    );
    db.progress_handler(0, None::<fn() -> bool>).unwrap();
    let all_time = active_hours(
        db,
        &sessions,
        &DashboardScope::default(),
        None,
        250.0,
        "UTC".parse().unwrap(),
    )
    .unwrap();
    assert_eq!(
        all_time["counts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .sum::<u64>(),
        5001
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
    let scoped = load_scoped_cost_facts(
        connection,
        &[],
        &DashboardScope::default(),
        None,
        None,
        true,
    )
    .unwrap();
    assert!(scoped.messages.is_empty());
    assert!(scoped.sessions.is_empty());
    assert!(!connection.is_autocommit());
    connection.execute_batch("ROLLBACK").unwrap();
    assert!(
        connection
            .prepare("SELECT * FROM transaction_probe")
            .is_err()
    );
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
        .publish(&mut [crate::agents::codex::ParsedSession {
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
                        "recorded" => Some(crate::contract::CostSource::Recorded),
                        "estimated" => Some(crate::contract::CostSource::Estimated),
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
        };
        assert_eq!(
            build_dashboard(&sessions, &options(&bucketed)),
            build_dashboard(&sessions, &options(&per_message))
        );
        assert_eq!(
            attach_project_metrics(&projects, &sessions, from, Some(to), Some(&bucketed)),
            attach_project_metrics(&projects, &sessions, from, Some(to), Some(&per_message))
        );
    }
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

#[test]
fn cost_facts_cache_follows_rewritten_and_removed_sessions() {
    fn parsed(id: &str, costs: &[f64]) -> crate::agents::codex::ParsedSession {
        let session = head(id, None, 1_000);
        let messages: Vec<_> = costs
            .iter()
            .enumerate()
            .map(|(index, cost)| json!({"id":format!("{id}-{index}"),"role":"assistant","agent":null,"time_created":1_000 + index as i64,"time_completed":null,"mode":null,"model":"model","provider":null,"tokens":{"input":10,"output":2},"cost":cost,"parts":[]}))
            .collect();
        let detail = serde_json::from_value(json!({"reference":session.reference,"title":session.title,"directory":session.directory,"project_identity":session.project_identity,"time_created":1_000,"time_updated":1_000,"stats":session.stats,"smart_tags":[],"messages":messages,"detail_freshness":"fresh","file_activity":[]})).unwrap();
        crate::agents::codex::ParsedSession {
            head: session,
            source: "/fixture/not-required".into(),
            detail,
        }
    }
    fn canonical(index: &CostFactsIndex) -> String {
        let mut sessions: Vec<_> = index.sessions.iter().collect();
        sessions.sort_by(|a, b| a.0.session_id.cmp(&b.0.session_id));
        format!("{sessions:?}")
    }
    let mut storage = crate::storage::Cache::open(None).unwrap();
    storage
        .publish(&mut [
            parsed("kept", &[1.0]),
            parsed("rewritten", &[1.0]),
            parsed("removed", &[1.0]),
        ])
        .unwrap();
    let mut cache = CostFactsCache::default();
    let full = |storage: &crate::storage::Cache| {
        canonical(&CostFactsIndex::from(
            load_cost_facts(storage.connection(), None, None, true).unwrap(),
        ))
    };
    assert_eq!(
        canonical(&cache.refresh(storage.connection()).unwrap()),
        full(&storage)
    );
    storage
        .publish(&mut [parsed("rewritten", &[1.0, 2.5])])
        .unwrap();
    storage
        .remove(&[head("removed", None, 1_000).reference])
        .unwrap();
    let refreshed = cache.refresh(storage.connection()).unwrap();
    assert_eq!(canonical(&refreshed), full(&storage));
    assert_eq!(refreshed.sessions.len(), 2);
}
