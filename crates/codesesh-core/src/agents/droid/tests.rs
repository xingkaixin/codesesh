use super::*;
use crate::discovery::{AgentScanner, PathEnvironment};
use std::{collections::HashMap, sync::Arc};

const MAIN: &str = "d0000000-0000-4000-8000-00000000000a";
const SUBAGENT: &str = "d0000000-0000-4000-8000-00000000000b";

fn write(path: &Path, records: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let lines: Vec<_> = records.iter().map(Value::to_string).collect();
    fs::write(path, lines.join("\n") + "\n").unwrap();
}

fn record(id: &str, time: &str, role: &str, content: Value) -> Value {
    json!({"type":"message","id":id,"timestamp":time,"message":{"role":role,"content":content}})
}

fn fixture(factory: &Path) -> PathBuf {
    write(
        &factory.join("settings.json"),
        &[
            json!({"customModels":[{"id":"custom:Sonnet-[Proxy]-0","model":"claude-sonnet-4-5","displayName":"Sonnet [Proxy]"}]}),
        ],
    );
    let main = factory.join(format!("sessions/-tmp-droid/{MAIN}.jsonl"));
    let mut hidden = record(
        "m2",
        "2026-09-27T08:00:01.000Z",
        "user",
        json!([{"type":"text","text":"Hidden context"}]),
    );
    hidden["message"]["visibility"] = "llm_only".into();
    write(
        &main,
        &[
            json!({"type":"session_start","id":MAIN,"title":"New Session","owner":"me","cwd":"/tmp/droid","lastCwd":"/tmp/droid/app"}),
            record(
                "m1",
                "2026-09-27T08:00:00.000Z",
                "user",
                json!([{"type":"text","text":"<system-reminder>Environment</system-reminder>"},{"type":"text","text":"Fix the build"}]),
            ),
            hidden,
            record(
                "m3",
                "2026-09-27T08:00:05.000Z",
                "assistant",
                json!([
                    {"type":"thinking","thinking":"Check the logs","signature":"s"},
                    {"type":"text","text":"Running checks"},
                    {"type":"tool_use","id":"t1","name":"Execute","input":{"command":"make"}},
                    {"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/tmp/droid/app/main.rs"}}
                ]),
            ),
            record(
                "m4",
                "2026-09-27T08:00:09.000Z",
                "user",
                json!([
                    {"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"Error: make failed"},
                    {"type":"tool_result","tool_use_id":"t2","content":[{"type":"text","text":"fn main() {}"}]}
                ]),
            ),
            json!({"type":"todo_state","id":"todo","timestamp":"2026-09-27T08:00:10.000Z","todos":[]}),
            record(
                "m5",
                "2026-09-27T08:01:00.000Z",
                "assistant",
                json!("Fixed"),
            ),
        ],
    );
    write(
        &main.with_extension("settings.json"),
        &[
            json!({"model":"custom:Sonnet-[Proxy]-0","tokenUsage":{"inputTokens":100,"outputTokens":50,"cacheCreationTokens":10,"cacheReadTokens":1000,"thinkingTokens":20}}),
        ],
    );
    write(
        &factory.join(format!("sessions/{SUBAGENT}.jsonl")),
        &[
            json!({"type":"session_start","id":SUBAGENT,"title":"Explore","owner":"me","callingSessionId":MAIN}),
            record(
                "s1",
                "2026-09-27T08:00:06.000Z",
                "user",
                json!("Look around"),
            ),
        ],
    );
    main
}

#[test]
fn reads_transcript_tools_and_session_usage() {
    let temp = tempfile::tempdir().unwrap();
    let factory = temp.path().join(".factory");
    fixture(&factory);
    let scan_root = factory.join("sessions");
    let sessions = scan(&scan_root, &factory, &Pricing::bundled()).unwrap();
    crate::pricing::assert_cached_repricing(|pricing| scan(&scan_root, &factory, pricing).unwrap());
    assert_eq!(sessions.len(), 2);
    let main = sessions
        .iter()
        .find(|session| session.head.reference.session_id == MAIN)
        .unwrap();
    assert_eq!(main.head.title, "Fix the build");
    assert_eq!(main.head.directory, "/tmp/droid/app");
    assert_eq!(main.head.time_created, 1790496000000.0);
    assert_eq!(main.head.time_updated, 1790496060000.0);
    let messages = &main.detail.messages;
    assert_eq!(messages.len(), 3);
    assert!(
        matches!(&messages[0].parts[..], [MessagePart::Text { text, .. }] if text == "Fix the build")
    );
    assert!(
        matches!(&messages[1].parts[0], MessagePart::Reasoning { text, .. } if text == "Check the logs")
    );
    let MessagePart::Tool { state, .. } = &messages[1].parts[2] else {
        panic!()
    };
    assert_eq!(state.status, "error");
    assert_eq!(
        state.output.as_ref().unwrap()[0]["text"],
        "Error: make failed"
    );
    let MessagePart::Tool { state, .. } = &messages[1].parts[3] else {
        panic!()
    };
    assert_eq!(state.status, "completed");
    assert_eq!(state.output.as_ref().unwrap()[0]["text"], "fn main() {}");
    assert!(matches!(&messages[2].parts[..], [MessagePart::Text { text, .. }] if text == "Fixed"));

    let stats = &main.head.stats;
    assert_eq!(stats.total_input_tokens, 1110.0);
    assert_eq!(stats.total_output_tokens, 50.0);
    assert_eq!(stats.total_cache_read_tokens, Some(1000.0));
    assert_eq!(stats.total_cache_create_tokens, Some(10.0));
    assert!((stats.total_cost - 0.0013875).abs() < 1e-12);
    assert_eq!(stats.cost_source, Some(CostSource::Estimated));
    assert!(stats.cost_inputs[0].aggregate);
    assert_eq!(
        main.head.model_usage,
        Some(BTreeMap::from([("claude-sonnet-4-5".into(), 1160.0)]))
    );

    let subagent = sessions
        .iter()
        .find(|session| session.head.reference.session_id == SUBAGENT)
        .unwrap();
    assert_eq!(subagent.head.title, "Explore");
    assert_eq!(
        subagent.head.parent_reference.as_ref().unwrap().session_id,
        MAIN
    );
    assert_eq!(subagent.head.stats.total_input_tokens, 0.0);
    assert_eq!(subagent.head.stats.cost_source, None);
}

#[test]
fn scanner_follows_settings_corruption_and_deletion() {
    let temp = tempfile::tempdir().unwrap();
    let mut environment = PathEnvironment {
        home: temp.path().into(),
        cwd: temp.path().into(),
        platform: "darwin".into(),
        variables: HashMap::new(),
    };
    assert_eq!(
        environment.source("droid").unwrap().scan_path,
        temp.path().join(".factory/sessions")
    );
    environment
        .variables
        .insert("FACTORY_HOME_OVERRIDE".into(), "~/moved".into());
    let source = environment.source("droid").unwrap();
    assert_eq!(source.data_root, temp.path().join("moved/.factory"));
    let main = fixture(&source.data_root);
    fs::remove_file(source.scan_path.join(format!("{SUBAGENT}.jsonl"))).unwrap();
    let mut scanner = AgentScanner::new(
        source,
        temp.path().join("cache.db"),
        Arc::new(Pricing::bundled()),
    );
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 1);
    let reference = initial.sessions[0].head.reference.clone();
    initial.on_reject.take();

    let settings = main.with_extension("settings.json");
    write(
        &settings,
        &[
            json!({"model":"claude-sonnet-4-5","tokenUsage":{"inputTokens":2000,"outputTokens":300,"cacheCreationTokens":0,"cacheReadTokens":0,"thinkingTokens":0}}),
        ],
    );
    let mut changed = scanner.refresh(Some(&[settings])).unwrap();
    assert!(changed.removed.is_empty());
    assert_eq!(changed.sessions[0].head.stats.total_input_tokens, 2000.0);
    changed.on_reject.take();

    fs::write(&main, "broken\n").unwrap();
    assert!(scanner.refresh(Some(std::slice::from_ref(&main))).is_err());
    fs::remove_file(&main).unwrap();
    let removed = scanner.refresh(Some(&[main])).unwrap();
    assert_eq!(removed.removed, [reference]);
}
