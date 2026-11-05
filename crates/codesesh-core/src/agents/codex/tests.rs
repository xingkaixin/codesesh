use super::*;
use std::io::Write;

#[test]
fn checkpoints_resume_appends_and_match_full_parses() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-000000000009.jsonl");
    let pricing = Pricing::bundled();
    let records = [
        serde_json::json!({"type":"session_meta","timestamp":1000,"payload":{"cwd":"/work","model":"gpt-5"}}),
        serde_json::json!({"type":"response_item","timestamp":2000,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Run the tests"}]}}),
        serde_json::json!({"type":"response_item","timestamp":3000,"payload":{"type":"function_call","name":"exec_command","call_id":"call-1","arguments":"{\"cmd\":\"cargo test\"}"}}),
        serde_json::json!({"type":"event_msg","timestamp":3500,"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":20}}}}),
        serde_json::json!({"type":"response_item","timestamp":4000,"payload":{"type":"function_call_output","call_id":"call-1","output":"ok"}}),
        serde_json::json!({"type":"response_item","timestamp":5000,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Tests pass"}]}}),
    ];
    let mut checkpoints = Checkpoints::default();
    let mut file = File::create(&path).unwrap();
    for record in &records {
        let line = format!("{record}\n");
        let (head, rest) = line.split_at(line.len() / 2);
        for chunk in [head, rest] {
            file.write_all(chunk.as_bytes()).unwrap();
            file.flush().unwrap();
            assert_eq!(
                checkpoints.parse(&path, &HashMap::new(), &pricing).unwrap(),
                parse(&path, &HashMap::new(), &pricing).unwrap()
            );
        }
    }
    std::fs::write(&path, format!("{}\n{}\n", records[0], records[5])).unwrap();
    assert_eq!(
        checkpoints.parse(&path, &HashMap::new(), &pricing).unwrap(),
        parse(&path, &HashMap::new(), &pricing).unwrap()
    );
}

#[test]
fn recorded_service_tier_prices_following_usage() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("sessions/rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-000000000010.jsonl");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut lines = vec![
        serde_json::json!({"type":"session_meta","timestamp":1000,"payload":{"cwd":"/work","model":"gpt-5.5"}}),
    ];
    for (step, tier) in [None, Some("priority"), Some("flex"), None]
        .into_iter()
        .enumerate()
    {
        let time = 2000 + step as u64 * 1000;
        let settings = match tier {
            Some(tier) => serde_json::json!({"service_tier":tier}),
            None => serde_json::json!({}),
        };
        lines.extend([
            serde_json::json!({"type":"event_msg","timestamp":time,"payload":{"type":"thread_settings_applied","thread_settings":settings}}),
            serde_json::json!({"type":"response_item","timestamp":time + 1,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Next"}]}}),
            serde_json::json!({"type":"response_item","timestamp":time + 2,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}),
            serde_json::json!({"type":"event_msg","timestamp":time + 3,"payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":(step + 1) * 1100},"last_token_usage":{"input_tokens":1000,"output_tokens":100}}}}),
        ]);
    }
    std::fs::write(
        &path,
        lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let pricing = Pricing::bundled();
    let tokens = serde_json::from_value(serde_json::json!({"input":1000,"output":100})).unwrap();
    let standard = pricing.estimate(Some("gpt-5.5"), &tokens, 0.0).unwrap();
    let sessions = scan(root.path(), &pricing).unwrap();
    let costs = sessions[0]
        .detail
        .messages
        .iter()
        .filter(|message| message.role == Role::Assistant)
        .map(|message| message.cost.unwrap())
        .collect::<Vec<_>>();
    assert_eq!(costs.len(), 4);
    for (cost, multiplier) in costs.into_iter().zip([1.0, 2.5, 0.5, 0.5]) {
        assert!((cost - standard * multiplier).abs() < 1e-8);
    }
    assert!((sessions[0].head.stats.total_cost - standard * 4.5).abs() < 1e-8);
    crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
}

#[test]
fn reopening_a_session_does_not_advance_activity_time() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let path = sessions.join("rollout-2026-01-01-00000000-0000-0000-0000-000000000001.jsonl");
    let mut file = File::create(&path).unwrap();
    for record in [
        serde_json::json!({"type":"session_meta","timestamp":1000,"payload":{"cwd":"/project"}}),
        serde_json::json!({"type":"response_item","timestamp":2000,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}),
        serde_json::json!({"type":"event_msg","timestamp":3000,"payload":{"type":"task_complete"}}),
    ] {
        writeln!(file, "{record}").unwrap();
    }
    let pricing = Pricing::bundled();
    let initial = scan(root.path(), &pricing).unwrap();
    assert_eq!(initial[0].head.time_updated, 3000.0);
    let previous = initial
        .iter()
        .map(crate::agents::SessionRecord::from)
        .collect::<Vec<_>>();
    for record in [
        serde_json::json!({"type":"event_msg","timestamp":4000,"payload":{"type":"thread_settings_applied"}}),
        serde_json::json!({"type":"turn_context","timestamp":5000,"payload":{"model":"gpt-5"}}),
        serde_json::json!({"type":"response_item","timestamp":6000,"payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"Environment settings"}]}}),
        serde_json::json!({"type":"world_state","timestamp":6001,"payload":{}}),
    ] {
        writeln!(file, "{record}").unwrap();
    }
    let full = scan(root.path(), &pricing).unwrap();
    let changed = scan_changed(
        root.path(),
        &pricing,
        std::slice::from_ref(&path),
        &previous,
        &mut Default::default(),
    )
    .unwrap();
    for result in [&full, &changed.upserts] {
        assert_eq!(result[0].head.time_updated, 3000.0);
        assert_eq!(result[0].head.smart_tags_source_updated_at, Some(3000.0));
        assert_eq!(result[0].detail.messages, initial[0].detail.messages);
    }
    writeln!(file, "{}", serde_json::json!({"type":"response_item","timestamp":7000,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Continue"}]}})).unwrap();
    let continued = scan_changed(
        root.path(),
        &pricing,
        &[path],
        &previous,
        &mut Default::default(),
    )
    .unwrap();
    assert_eq!(continued.upserts[0].head.time_updated, 7000.0);
    assert_eq!(continued.upserts[0].detail.messages.len(), 2);
}

#[test]
fn child_returns_are_merged_chronologically_in_full_and_incremental_scans() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let parent = "00000000-0000-0000-0000-000000000001";
    let child = "00000000-0000-0000-0000-000000000002";
    let mut parent_path = PathBuf::new();
    for (id, parent_id, messages) in [
        (
            parent,
            None,
            vec![(1000, "first"), (3000, "last"), (3000, "same-time")],
        ),
        (child, Some(parent), vec![(2000, "child result")]),
    ] {
        let mut records = vec![serde_json::json!({
            "type":"session_meta", "timestamp":500,
            "payload":{"id":id,"cwd":"/project","thread_source":parent_id.map(|_| "subagent"),"parent_thread_id":parent_id}
        })];
        for (time, text) in messages {
            records.push(serde_json::json!({
                "type":"response_item", "timestamp":time,
                "payload":{"type":"message","role":if parent_id.is_some() {"assistant"} else {"user"},"phase":"final_answer","content":[{"type":"output_text","text":text}]}
            }));
        }
        let path = sessions.join(format!("rollout-2026-01-01-{id}.jsonl"));
        let contents = records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(&path, contents).unwrap();
        if id == parent {
            parent_path = path;
        }
    }
    let pricing = Pricing::bundled();
    let full = scan(root.path(), &pricing).unwrap();
    let previous = full
        .iter()
        .map(crate::agents::SessionRecord::from)
        .collect::<Vec<_>>();
    for session in &full {
        let bytes = zstd::stream::encode_all(File::open(&session.source).unwrap(), 3).unwrap();
        std::fs::write(session.source.with_extension("jsonl.zst"), bytes).unwrap();
        std::fs::remove_file(&session.source).unwrap();
    }
    let compressed = scan(root.path(), &pricing).unwrap();
    let incremental = scan_changed(
        root.path(),
        &pricing,
        &[parent_path],
        &previous,
        &mut Default::default(),
    )
    .unwrap();
    for result in [&full, &compressed, &incremental.upserts] {
        let messages = &result
            .iter()
            .find(|session| session.head.reference.session_id == parent)
            .unwrap()
            .detail
            .messages;
        assert_eq!(
            messages
                .iter()
                .map(|message| message.time_created)
                .collect::<Vec<_>>(),
            [1000.0, 2000.0, 3000.0, 3000.0]
        );
        assert_eq!(messages[1].subagent_id.as_deref(), Some(child));
        let texts = messages
            .iter()
            .flat_map(|message| &message.parts)
            .filter_map(|part| match part {
                MessagePart::Text { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(texts, ["first", "child result", "last", "same-time"]);
    }
}

#[test]
fn remote_compaction_usage_is_counted_once() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("rollout-2026-01-01-00000000-0000-0000-0000-000000000001.jsonl");
    let count = |input: u64, total: u64| {
        serde_json::json!({"type":"event_msg","timestamp":900,"payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":total,"total_tokens":total},
            "last_token_usage":{"input_tokens":input,"total_tokens":input}
        }}})
    };
    let record = |id: &str, input: u64| serde_json::json!({"type":"token_usage_record","timestamp":900,"payload":{"response_id":id,"usage":{"input_tokens":input,"total_tokens":input}}});
    let compacted = |id: &str| serde_json::json!({"type":"compacted","timestamp":900,"payload":{"compaction_response_id":id,"replacement_history":[]}});
    let lines = [
        serde_json::json!({"type":"session_meta","timestamp":700,"payload":{"cwd":"/project"}}),
        serde_json::json!({"type":"turn_context","timestamp":800,"payload":{"model":"gpt-5"}}),
        record("normal", 10),
        count(10, 10),
        record("remote", 50),
        compacted("remote"),
        count(0, 10),
        record("local", 20),
        count(20, 30),
        compacted("local"),
    ];
    let contents = lines
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<String>();
    std::fs::write(&path, contents).unwrap();
    let detail = parse(&path, &HashMap::new(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    assert_eq!(detail.head.stats.total_input_tokens, 80.0);
}

#[test]
fn forked_rollouts_do_not_count_replayed_parent_usage() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let parent = "019e0000-0000-7000-8000-000000000001";
    let child = "019f0000-0000-7000-8000-000000000002";
    let usage = |input: u64, total: u64| {
        serde_json::json!({"type":"event_msg","timestamp":900,"payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":total,"total_tokens":total},
            "last_token_usage":{"input_tokens":input,"total_tokens":input}
        }}})
    };
    let parent_turn = serde_json::json!({"type":"turn_context","timestamp":800,"payload":{"turn_id":"019e0000-0001-7000-8000-000000000001","model":"gpt-5"}});
    let child_turn = serde_json::json!({"type":"turn_context","timestamp":900,"payload":{"turn_id":"019f0000-0001-7000-8000-000000000002","model":"gpt-5"}});
    for (id, lines) in [
        (
            parent,
            vec![
                serde_json::json!({"type":"session_meta","timestamp":700,"payload":{"id":parent,"cwd":"/project"}}),
                parent_turn.clone(),
                usage(100, 100),
            ],
        ),
        (
            child,
            vec![
                serde_json::json!({"type":"session_meta","timestamp":900,"payload":{"id":child,"forked_from_id":parent,"cwd":"/project","thread_source":"subagent","parent_thread_id":parent}}),
                parent_turn,
                usage(100, 100),
                child_turn,
                usage(7, 107),
            ],
        ),
    ] {
        let contents = lines
            .iter()
            .map(|line| format!("{line}\n"))
            .collect::<String>();
        std::fs::write(
            sessions.join(format!("rollout-2026-01-01-{id}.jsonl")),
            contents,
        )
        .unwrap();
    }
    let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
    let input = |id: &str| {
        sessions
            .iter()
            .find(|session| session.head.reference.session_id == id)
            .unwrap()
            .detail
            .head
            .stats
            .total_input_tokens
    };
    assert_eq!(input(child), 7.0);
    assert_eq!(input(parent), 107.0);
}

#[test]
fn parent_refresh_sees_a_child_that_changed_since_the_last_refresh() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let parent = "00000000-0000-0000-0000-000000000001";
    let child = "00000000-0000-0000-0000-000000000002";
    let write = |id: &str, parent_id: Option<&str>, text: &str| {
        let records = [
            serde_json::json!({"type":"session_meta","timestamp":500,"payload":{"id":id,"cwd":"/project","thread_source":parent_id.map(|_| "subagent"),"parent_thread_id":parent_id}}),
            serde_json::json!({"type":"response_item","timestamp":1000,"payload":{"type":"message","role":if parent_id.is_some() {"assistant"} else {"user"},"phase":"final_answer","content":[{"type":"output_text","text":text}]}}),
        ];
        let path = sessions.join(format!("rollout-2026-01-01-{id}.jsonl"));
        std::fs::write(&path, format!("{}\n{}\n", records[0], records[1])).unwrap();
        path
    };
    let parent_path = write(parent, None, "start");
    write(child, Some(parent), "child result");
    let pricing = Pricing::bundled();
    let previous = scan(root.path(), &pricing)
        .unwrap()
        .iter()
        .map(crate::agents::SessionRecord::from)
        .collect::<Vec<_>>();
    let mut checkpoints = Checkpoints::default();
    let mut child_text = || {
        scan_changed(
            root.path(),
            &pricing,
            std::slice::from_ref(&parent_path),
            &previous,
            &mut checkpoints,
        )
        .unwrap()
        .upserts[0]
            .detail
            .messages
            .iter()
            .filter(|message| message.subagent_id.as_deref() == Some(child))
            .flat_map(|message| &message.parts)
            .find_map(|part| match part {
                MessagePart::Text { text, .. } => Some(text.clone()),
                _ => None,
            })
    };
    assert_eq!(child_text().as_deref(), Some("child result"));
    write(child, Some(parent), "child result, revised");
    assert_eq!(child_text().as_deref(), Some("child result, revised"));
}

#[test]
fn partial_existing_source_is_not_a_deletion() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    let path = sessions.join("rollout-2026-01-01-00000000-0000-0000-0000-000000000001.jsonl");
    std::fs::write(&path, concat!(
        "{\"type\":\"session_meta\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"payload\":{\"cwd\":\"/project\"}}\n",
        "{\"type\":\"response_item\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}\n"
    )).unwrap();
    let pricing = Pricing::bundled();
    let previous = scan(root.path(), &pricing).unwrap();
    assert_eq!(previous.len(), 1);
    std::fs::write(&path, "{\"type\":").unwrap();
    assert!(
        scan_changed(
            root.path(),
            &pricing,
            std::slice::from_ref(&path),
            &previous
                .iter()
                .map(crate::agents::SessionRecord::from)
                .collect::<Vec<_>>(),
            &mut Default::default()
        )
        .is_err()
    );
    assert!(
        scan_changed(
            root.path(),
            &pricing,
            &[root.path().to_owned()],
            &previous
                .iter()
                .map(crate::agents::SessionRecord::from)
                .collect::<Vec<_>>(),
            &mut Default::default()
        )
        .is_err()
    );
    std::fs::remove_file(&path).unwrap();
    let deleted = scan_changed(
        root.path(),
        &pricing,
        &[path],
        &previous
            .iter()
            .map(crate::agents::SessionRecord::from)
            .collect::<Vec<_>>(),
        &mut Default::default(),
    )
    .unwrap();
    assert_eq!(deleted.removed, vec![previous[0].head.reference.clone()]);
    assert!(deleted.upserts.is_empty());
}

#[test]
fn plans_keep_their_turn_and_stay_pending_without_approval() {
    let root = tempfile::tempdir().unwrap();
    let path = root
        .path()
        .join("rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-000000000011.jsonl");
    let say = |time: u64, role: &str, text: &str| {
        let kind = if role == "user" {
            "input_text"
        } else {
            "output_text"
        };
        serde_json::json!({"type":"response_item","timestamp":time,"payload":{"type":"message","role":role,"content":[{"type":kind,"text":text}]}})
    };
    let records = [
        serde_json::json!({"type":"session_meta","timestamp":1000,"payload":{"cwd":"/work"}}),
        say(2000, "user", "Plan it"),
        say(3000, "assistant", "<proposed_plan>A</proposed_plan>"),
        say(4000, "user", "PLEASE IMPLEMENT THIS PLAN:\nA"),
        say(5000, "assistant", "Done <proposed_plan>B</proposed_plan>"),
        say(6000, "user", "Try another approach"),
        say(7000, "assistant", "<proposed_plan>C</proposed_plan>"),
    ];
    std::fs::write(
        &path,
        records.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
    let detail = parse(&path, &HashMap::new(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    let plans = detail
        .messages
        .iter()
        .enumerate()
        .flat_map(|(index, message)| message.parts.iter().map(move |part| (index, part)))
        .filter_map(|(index, part)| match part {
            MessagePart::Plan {
                text,
                approval_status,
                ..
            } => Some((index, text.as_str(), *approval_status)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let reply = detail
        .messages
        .iter()
        .position(|message| {
            matches!(&message.parts[0], MessagePart::Text { text, .. } if text == "Try another approach")
        })
        .unwrap();
    assert_eq!(
        plans
            .iter()
            .map(|(_, text, status)| (*text, *status))
            .collect::<Vec<_>>(),
        [
            ("A", PlanApprovalStatus::Success),
            ("B", PlanApprovalStatus::Pending),
            ("C", PlanApprovalStatus::Pending),
        ]
    );
    assert!(plans[1].0 < reply);
}
