use super::*;
use crate::discovery::{AgentScanner, AgentSource, PathEnvironment};
use std::sync::Arc;

fn write(path: &Path, records: &[Value]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let lines: Vec<_> = records.iter().map(Value::to_string).collect();
    std::fs::write(path, lines.join("\n") + "\n").unwrap();
}

fn ms(value: &str) -> f64 {
    time(&json!(value)).unwrap()
}

#[test]
fn jsonl_updates_replay_into_messages_tools_and_usage() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("tmp");
    std::fs::create_dir_all(root.join("codesesh")).unwrap();
    std::fs::write(root.join("codesesh/.project_root"), "/work/codesesh\n").unwrap();
    let thinking = json!({"id":"g1","timestamp":"2026-10-01T10:00:02.000Z","type":"gemini","content":"","thoughts":[{"subject":"Reading","description":"Open the file first.","timestamp":"2026-10-01T10:00:02.000Z"}],"tokens":null,"model":"gemini-2.5-pro"});
    let mut counted = thinking.clone();
    counted["tokens"] =
        json!({"input":1000,"output":50,"cached":400,"thoughts":30,"tool":10,"total":1090});
    let mut called = counted.clone();
    called["toolCalls"] = json!([
        {"id":"call-read","name":"read_file","args":{"file_path":"src/main.rs"},"status":"success","timestamp":"2026-10-01T10:00:03.000Z","result":[
            {"functionResponse":{"id":"call-read","name":"read_file","response":{"output":"fn main() {}"}}},
            {"functionResponse":{"id":"call-shell","name":"run_shell_command","response":{"output":"sibling"}}}
        ]},
        {"id":"call-shell","name":"run_shell_command","args":{"command":"cargo test"},"status":"error","timestamp":"2026-10-01T10:00:03.000Z","result":null}
    ]);
    write(
        &root.join("codesesh/chats/session-2026-10-01T10-00-abcd1234.jsonl"),
        &[
            json!({"sessionId":"abcd1234-0000-4000-8000-000000000001","projectHash":"hash","startTime":"2026-10-01T10:00:00.000Z","lastUpdated":"2026-10-01T10:00:00.000Z","kind":"main"}),
            json!({"id":"u1","timestamp":"2026-10-01T10:00:01.000Z","type":"user","content":[{"text":"Explain @src/main.rs\n--- Content from referenced files ---"}],"displayContent":[{"text":"Explain @src/main.rs"}]}),
            json!({"$set":{"lastUpdated":"2026-10-01T10:00:01.000Z"}}),
            thinking,
            counted,
            called,
            json!({"$patch":{"updates":[{"id":"g1","toolCalls":[{"id":"call-shell","result":[{"functionResponse":{"id":"call-shell","name":"run_shell_command","response":{"error":"exit 1"}}}]}]}]}}),
            json!({"id":"u2","timestamp":"2026-10-01T10:00:04.000Z","type":"user","content":[{"functionResponse":{"id":"call-read","name":"read_file","response":{"output":"fn main() {}"}}}]}),
            json!({"id":"g2","timestamp":"2026-10-01T10:00:05.000Z","type":"gemini","model":"gemini-2.5-pro","content":[{"text":"Plan","thought":true},{"text":" more","thought":true},{"text":"The file is empty."},{"functionCall":{"id":"call-ls","name":"list_directory","args":{"dir_path":"."}}}],"tokens":{"input":2000,"output":20,"cached":1500,"thoughts":0,"tool":0,"total":2020}}),
            json!({"id":"u3","timestamp":"2026-10-01T10:00:06.000Z","type":"user","content":[{"functionResponse":{"id":"call-ls","name":"list_directory","response":{"output":"src/"}}}]}),
            json!({"id":"u4","timestamp":"2026-10-01T10:00:07.000Z","type":"user","content":"<session_context>cwd</session_context>"}),
            json!({"id":"g3","timestamp":"2026-10-01T10:00:08.000Z","type":"gemini","content":"Rewound answer"}),
            json!({"$rewindTo":"g3"}),
            json!({"id":"g4","timestamp":"2026-10-01T10:00:09.000Z","type":"gemini","content":"Removed answer"}),
            json!({"$patch":{"removeIds":["g4"]}}),
            json!({"$set":{"summary":"Explain the main file","lastUpdated":"2026-10-01T10:00:10.000Z"}}),
        ],
    );
    write(
        &root.join("codesesh/checkpoint-saved.json"),
        &[
            json!({"sessionId":"ignored","projectHash":"hash","messages":[{"id":"x","type":"user","content":"Saved"}]}),
        ],
    );

    let sessions = scan(&root, &Pricing::bundled()).unwrap();
    crate::pricing::assert_cached_repricing(|pricing| scan(&root, pricing).unwrap());
    assert_eq!(sessions.len(), 1);
    let session = &sessions[0];
    assert_eq!(
        session.head.reference.session_id,
        "abcd1234-0000-4000-8000-000000000001"
    );
    assert_eq!(session.head.directory, "/work/codesesh");
    assert_eq!(session.head.title, "Explain the main file");
    assert_eq!(session.head.time_created, ms("2026-10-01T10:00:00.000Z"));
    assert_eq!(session.head.time_updated, ms("2026-10-01T10:00:10.000Z"));
    let messages = &session.detail.messages;
    assert_eq!(
        messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["u1", "g1", "g2", "u4"]
    );
    assert_eq!(
        messages[0].parts,
        [MessagePart::Text {
            text: "Explain @src/main.rs".into(),
            time_created: Some(ms("2026-10-01T10:00:01.000Z")),
        }]
    );
    assert_eq!(messages[3].automated, Some(true));

    let MessagePart::Reasoning { text, .. } = &messages[1].parts[0] else {
        panic!("missing thought summary")
    };
    assert_eq!(text, "**Reading** Open the file first.");
    let MessagePart::Tool { state, .. } = &messages[1].parts[1] else {
        panic!("missing read tool")
    };
    assert_eq!(state.status, "completed");
    assert_eq!(state.input, Some(json!({"file_path":"src/main.rs"})));
    assert_eq!(state.output, Some(json!("fn main() {}")));
    let MessagePart::Tool { state, .. } = &messages[1].parts[2] else {
        panic!("missing shell tool")
    };
    assert_eq!(state.status, "error");
    assert_eq!(state.error, Some(json!("exit 1")));
    assert_eq!(state.output, None);

    assert!(
        matches!(&messages[2].parts[0], MessagePart::Reasoning { text, .. } if text == "Plan more")
    );
    assert!(
        matches!(&messages[2].parts[1], MessagePart::Text { text, .. } if text == "The file is empty.")
    );
    let MessagePart::Tool { call_id, state, .. } = &messages[2].parts[2] else {
        panic!("missing content function call")
    };
    assert_eq!(call_id.as_deref(), Some("call-ls"));
    assert_eq!(state.status, "completed");
    assert_eq!(state.output, Some(json!("src/")));

    assert_eq!(
        messages[1].tokens,
        Some(MessageTokens {
            input: Some(1010.0),
            output: Some(50.0),
            reasoning: Some(30.0),
            cache_read: Some(400.0),
            ..Default::default()
        })
    );
    assert_eq!(messages[1].model.as_deref(), Some("gemini-2.5-pro"));
    assert_eq!(messages[1].cost_source, Some(CostSource::Estimated));
    let stats = &session.head.stats;
    assert_eq!(stats.total_input_tokens, 3010.0);
    assert_eq!(stats.total_output_tokens, 100.0);
    assert_eq!(stats.total_cache_read_tokens, Some(1900.0));
    assert!(stats.total_cost > 0.0);
    assert_eq!(
        session.head.model_usage,
        Some(BTreeMap::from([("gemini-2.5-pro".into(), 3110.0)]))
    );
}

#[test]
fn legacy_snapshots_subagents_and_scanner_updates() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".gemini/tmp");
    let legacy = root.join("0123abcd/chats/session-2025-09-18T02-45-legacy01.json");
    let record = json!({
        "sessionId":"legacy01-0000-4000-8000-000000000002",
        "projectHash":"0123abcd",
        "startTime":"2025-09-18T02:45:00.000Z",
        "lastUpdated":"2025-09-18T02:46:00.000Z",
        "messages":[
            {"id":"a","timestamp":"2025-09-18T02:45:01.000Z","type":"user","content":"Old question"},
            {"id":"b","timestamp":"2025-09-18T02:45:02.000Z","type":"gemini","content":"Old answer","model":"gemini-2.5-flash","tokens":{"input":10,"output":2,"cached":0,"thoughts":0,"tool":0,"total":12}}
        ]
    });
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    std::fs::write(&legacy, serde_json::to_string_pretty(&record).unwrap()).unwrap();
    let child = root.join("codesesh/chats/parent01-0000-4000-8000-000000000003/agent01.jsonl");
    write(
        &child,
        &[
            json!({"sessionId":"agent01","projectHash":"hash","startTime":"2026-10-01T10:00:00.000Z","kind":"subagent","directories":["/work/codesesh"]}),
            json!({"id":"t","timestamp":"2026-10-01T10:00:01.000Z","type":"user","content":[{"text":"Investigate the parser"}]}),
        ],
    );
    let broken = root.join("codesesh/chats/session-2026-10-02T09-00-broken01.jsonl");
    std::fs::write(&broken, "{\"truncated\":").unwrap();

    let mut scanner = AgentScanner::new(
        AgentSource {
            agent: "gemini-cli".into(),
            data_root: temp.path().join(".gemini"),
            scan_path: root.clone(),
        },
        temp.path().join("cache.db"),
        Arc::new(Pricing::bundled()),
    );
    let mut initial = scanner.refresh(None).unwrap();
    initial.on_reject.take();
    assert_eq!(initial.sessions.len(), 2);
    let old = initial
        .sessions
        .iter()
        .find(|s| s.source == legacy)
        .unwrap();
    assert_eq!(old.head.directory, "");
    assert_eq!(old.head.title, "Old question");
    assert_eq!(old.detail.messages.len(), 2);
    let reference = old.head.reference.clone();
    let subagent = initial.sessions.iter().find(|s| s.source == child).unwrap();
    assert_eq!(
        subagent.head.parent_reference.as_ref().unwrap().session_id,
        "parent01-0000-4000-8000-000000000003"
    );

    let resumed = legacy.with_extension("jsonl");
    let mut migrated = vec![
        json!({"sessionId":record["sessionId"],"projectHash":"0123abcd","startTime":record["startTime"],"lastUpdated":record["lastUpdated"]}),
    ];
    migrated.extend(record["messages"].as_array().unwrap().iter().cloned());
    migrated.push(json!({"id":"c","timestamp":"2026-10-03T08:00:00.000Z","type":"user","content":"Resumed question"}));
    write(&resumed, &migrated);
    let mut changed = scanner
        .refresh(Some(std::slice::from_ref(&resumed)))
        .unwrap();
    changed.on_reject.take();
    assert!(changed.removed.is_empty());
    assert_eq!(changed.sessions.len(), 1);
    assert_eq!(changed.sessions[0].source, resumed);
    assert_eq!(changed.sessions[0].head.reference, reference);
    assert_eq!(changed.sessions[0].detail.messages.len(), 3);

    std::fs::remove_file(&legacy).unwrap();
    std::fs::remove_file(&resumed).unwrap();
    let mut removed = scanner.refresh(Some(&[resumed])).unwrap();
    removed.on_reject.take();
    assert_eq!(removed.removed, [reference]);

    std::fs::write(&child, "{\"truncated\":").unwrap();
    assert!(scanner.refresh(Some(&[child])).is_err());
}

#[test]
fn default_and_override_paths_select_cli_chats() {
    let root = tempfile::tempdir().unwrap();
    let mut environment = PathEnvironment {
        home: root.path().into(),
        cwd: root.path().into(),
        platform: "darwin".into(),
        variables: HashMap::new(),
    };
    assert_eq!(
        environment.source("gemini-cli").unwrap().scan_path,
        root.path().join(".gemini/tmp")
    );
    environment
        .variables
        .insert("GEMINI_CLI_HOME".into(), "~/isolated".into());
    assert_eq!(
        environment.source("gemini-cli").unwrap().scan_path,
        root.path().join("isolated/.gemini/tmp")
    );
}
