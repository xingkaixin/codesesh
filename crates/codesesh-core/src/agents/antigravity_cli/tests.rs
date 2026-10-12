use super::*;
use crate::discovery::{AgentScanner, AgentSource, PathEnvironment};
use std::{collections::HashMap, sync::Arc};

fn fixture(root: &Path) -> PathBuf {
    std::fs::create_dir_all(root.join("conversations")).unwrap();
    let path = root.join("conversations/session.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixture.sql")).unwrap();
    let summaries = Connection::open(root.join("conversation_summaries.db")).unwrap();
    summaries.execute_batch("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT);").unwrap();
    let workspace = url::Url::from_file_path(root.join("agy-fixture")).unwrap();
    summaries.execute(
        "INSERT INTO conversation_summaries VALUES ('session', '', ?1, '2026-09-02 16:57:28.971105+00:00', '')",
        [json!([workspace.as_str()]).to_string()],
    ).unwrap();
    path
}

fn varint(tag: u32, value: u64) -> Vec<u8> {
    let mut buffer = Vec::new();
    prost::encoding::uint64::encode(tag, &value, &mut buffer);
    buffer
}

fn bytes(tag: u32, value: impl AsRef<[u8]>) -> Vec<u8> {
    let mut buffer = Vec::new();
    prost::encoding::bytes::encode(tag, &value.as_ref().to_vec(), &mut buffer);
    buffer
}

#[test]
fn usage_metadata_deduplicates_retries_and_prices_the_next_visible_message() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let usage = |response: &str, input, cache_read, visible, reasoning| {
        [
            varint(1, 7),
            varint(2, input),
            varint(3, visible + reasoning),
            varint(5, cache_read),
            bytes(7, format!("bot-{response}")),
            varint(9, reasoning),
            varint(10, visible),
            bytes(11, response),
        ]
        .concat()
    };
    let created = |seconds| bytes(1, [varint(1, seconds), varint(2, 500_000_000)].concat());
    let response = bytes(
        5,
        [
            created(1_788_000_000),
            bytes(9, usage("r1", 100, 40, 20, 10)),
            bytes(28, bytes(2, usage("r0", 50, 0, 5, 0))),
            bytes(28, bytes(2, usage("r1", 100, 40, 20, 10))),
        ]
        .concat(),
    );
    let tool = bytes(
        5,
        [
            created(1_788_000_001),
            bytes(4, [bytes(1, "call-2"), bytes(2, "list_dir")].concat()),
        ]
        .concat(),
    );
    let db = Connection::open(&path).unwrap();
    db.execute(
        "INSERT INTO gen_metadata VALUES (0, ?1)",
        [bytes(
            1,
            [varint(3, 7), bytes(19, "gemini-2.5-flash")].concat(),
        )],
    )
    .unwrap();
    db.execute("INSERT INTO steps VALUES (6, 15, 3, ?1)", [response])
        .unwrap();
    db.execute("INSERT INTO steps VALUES (7, 132, 3, ?1)", [tool])
        .unwrap();
    let scan_root = temp.path().join("conversations");
    let sessions = scan(&scan_root, temp.path(), &Pricing::bundled()).unwrap();
    let session = &sessions[0];
    let message = session.detail.messages.last().unwrap();
    assert_eq!(message.id, "session:7");
    assert_eq!(message.time_created, 1_788_000_001_500.0);
    assert_eq!(message.model.as_deref(), Some("gemini-2.5-flash"));
    assert_eq!(
        message.tokens,
        Some(MessageTokens {
            input: Some(190.0),
            output: Some(25.0),
            reasoning: Some(10.0),
            cache_read: Some(40.0),
            cache_create: Some(0.0),
        })
    );
    let stats = &session.head.stats;
    assert_eq!(stats.message_count, 4);
    assert_eq!(stats.total_input_tokens, 190.0);
    assert_eq!(stats.total_output_tokens, 35.0);
    assert_eq!(stats.total_tokens, Some(225.0));
    assert_eq!(stats.total_cache_read_tokens, Some(40.0));
    assert_eq!(stats.cost_source, Some(CostSource::Estimated));
    assert!(stats.total_cost > 0.0);
    assert_eq!(message.cost, Some(stats.total_cost));
    assert_eq!(
        session.head.model_usage,
        Some(BTreeMap::from([("gemini-2.5-flash".into(), 225.0)]))
    );
    crate::pricing::assert_cached_repricing(|pricing| {
        scan(&scan_root, temp.path(), pricing).unwrap()
    });
}

#[test]
fn native_steps_preserve_order_tools_and_unknown_usage() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let sessions = scan(
        &temp.path().join("conversations"),
        temp.path(),
        &Pricing::bundled(),
    )
    .unwrap();
    assert_eq!(sessions.len(), 1);
    let session = &sessions[0];
    assert_eq!(session.head.reference.agent_name, "antigravity-cli");
    assert_eq!(session.head.reference.session_id, "session");
    assert_eq!(session.head.title, "A title");
    assert_eq!(
        Path::new(&session.head.directory),
        temp.path().join("agy-fixture")
    );
    assert!(session.head.time_updated > 1_700_000_000_000.0);
    assert_eq!(
        session
            .detail
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        ["session:1", "session:2", "session:3"]
    );
    assert!(session.head.stats.total_tokens.is_none());
    assert!(session.head.stats.cost_source.is_none());
    let MessagePart::Tool { state, call_id, .. } = &session.detail.messages[2].parts[0] else {
        panic!("missing tool")
    };
    assert_eq!(call_id.as_deref(), Some("call-1"));
    assert_eq!(state.status, "unknown");
    assert_eq!(state.input, Some(json!({"path":"a"})));
    assert!(state.output.is_none());
    assert!(
        session
            .head
            .summary_files
            .as_ref()
            .unwrap()
            .as_str()
            .unwrap()
            .contains("1 unsupported steps")
    );
    let mut cache = crate::storage::Cache::open(None).unwrap();
    let mut sessions = sessions;
    cache.apply(&mut sessions, &[]).unwrap();
    let stored: String = cache
        .connection()
        .query_row(
            "SELECT parts_json FROM messages WHERE message_id='session:3'",
            [],
            |row| Ok(crate::storage::body::unpack(row.get_ref(0)?)?.into_owned()),
        )
        .unwrap();
    assert!(stored.contains("unknown"));
    assert_eq!(
        scan_paths(temp.path(), &Pricing::bundled(), &[path])
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn scanner_observes_wal_updates_and_preserves_cache_on_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let source = AgentSource {
        agent: "antigravity-cli".into(),
        data_root: temp.path().into(),
        scan_path: temp.path().join("conversations"),
    };
    let mut scanner = AgentScanner::new(
        source,
        temp.path().join("cache.db"),
        Arc::new(Pricing::bundled()),
    );
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 1);
    let reference = initial.sessions[0].head.reference.clone();
    initial.on_reject.take();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; UPDATE steps SET step_payload=X'a201090a0755706461746564' WHERE idx=2;").unwrap();
    let wal = PathBuf::from(format!("{}-wal", path.display()));
    let mut changed = scanner.refresh(Some(&[wal])).unwrap();
    assert!(changed.removed.is_empty());
    assert_eq!(changed.sessions.len(), 1);
    assert_eq!(
        changed.sessions[0].detail.messages[1].parts,
        [common::text("Updated", None)]
    );
    changed.on_reject.take();
    db.execute("UPDATE steps SET step_payload=X'a201ff' WHERE idx=2", [])
        .unwrap();
    assert!(scanner.refresh(Some(std::slice::from_ref(&path))).is_err());
    drop(db);
    std::fs::remove_file(&path).unwrap();
    let removed = scanner.refresh(Some(&[path])).unwrap();
    assert_eq!(removed.removed, [reference]);
}

#[test]
fn default_and_override_paths_select_cli_not_ide() {
    let root = tempfile::tempdir().unwrap();
    let mut environment = PathEnvironment {
        home: root.path().into(),
        cwd: root.path().into(),
        platform: "darwin".into(),
        variables: HashMap::new(),
    };
    assert_eq!(
        environment.source("antigravity-cli").unwrap().scan_path,
        root.path().join(".gemini/antigravity-cli/conversations")
    );
    environment.variables.insert(
        "AGY_CONVERSATIONS_DIR".into(),
        "~/backup/conversations".into(),
    );
    assert_eq!(
        environment.source("antigravity-cli").unwrap().scan_path,
        root.path().join("backup/conversations")
    );
}
