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
