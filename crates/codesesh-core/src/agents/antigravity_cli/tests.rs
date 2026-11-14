use super::*;
use crate::discovery::{AgentScanner, AgentSource};
use std::sync::Arc;

fn fixture(root: &Path) -> PathBuf {
    std::fs::create_dir_all(root.join("conversations")).unwrap();
    let path = root.join("conversations/session.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixture.sql")).unwrap();
    let summaries = Connection::open(root.join("conversation_summaries.db")).unwrap();
    summaries.execute_batch("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, agent_name TEXT);").unwrap();
    let workspace = url::Url::from_file_path(root.join("agy-fixture")).unwrap();
    summaries.execute(
        "INSERT INTO conversation_summaries (conversation_id,title,workspace_uris,last_modified_time,parent_conversation_id) VALUES ('session', '', ?1, '2026-09-02 16:57:28.971105+00:00', '')",
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
fn native_tool_results_keep_new_and_legacy_evidence_without_guessing_success() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let db = Connection::open(&path).unwrap();
    db.execute("DELETE FROM steps", []).unwrap();
    let cases = [
        (
            132,
            "read_file",
            bytes(140, bytes(2, bytes(1, "10: const x = 1;"))),
            "10: const x = 1;",
        ),
        (
            132,
            "run_command",
            bytes(
                140,
                bytes(
                    2,
                    bytes(1, "Command exited with code 1.\nCommand output:\nfailed"),
                ),
            ),
            "Command exited with code 1.\nCommand output:\nfailed",
        ),
        (
            8,
            "view_file",
            bytes(14, bytes(4, "const pattern = /\\n/;")),
            "const pattern = /\\n/;",
        ),
        (
            21,
            "run_command",
            bytes(28, [varint(6, 0), bytes(21, bytes(1, "done\r\n"))].concat()),
            "done\r\n",
        ),
        (
            38,
            "call_mcp_tool",
            bytes(
                47,
                bytes(3, r#"{"width":728,"screenshot":{"mimeType":"image/png"}}"#),
            ),
            r#"{"width":728,"screenshot":{"mimeType":"image/png"}}"#,
        ),
    ];
    for (index, (kind, name, result, _)) in cases.iter().enumerate() {
        let call = bytes(
            5,
            bytes(
                4,
                [bytes(1, format!("call-{index}")), bytes(2, name)].concat(),
            ),
        );
        db.execute(
            "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (?1,?2,3,?3)",
            rusqlite::params![index as i64, kind, [call, result.clone()].concat()],
        )
        .unwrap();
    }
    let sessions = scan_paths(&Pricing::bundled(), &[path]).unwrap();
    let messages = &sessions[0].detail.messages;
    assert_eq!(messages.len(), cases.len());
    for (message, (_, name, _, expected)) in messages.iter().zip(cases) {
        let MessagePart::Tool { tool, state, .. } = &message.parts[0] else {
            panic!("missing tool");
        };
        assert_eq!(tool, name);
        assert_eq!(state.status, ToolPartStatus::Unknown);
        assert_eq!(state.output, Some(Value::String(expected.into())));
        assert!(state.error.is_none());
    }
}

#[test]
fn explicit_tool_errors_survive_column_and_payload_forms() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let db = Connection::open(&path).unwrap();
    db.execute("DELETE FROM steps", []).unwrap();
    let error = [
        bytes(
            2,
            "invalid line range: StartLine 170 is greater than EndLine 100",
        ),
        bytes(
            3,
            "invalid line range: StartLine 170 is greater than EndLine 100",
        ),
    ]
    .concat();
    for index in 0..2 {
        let payload = [
            bytes(
                5,
                bytes(
                    4,
                    [
                        bytes(2, "read_file"),
                        bytes(3, r#"{"Path":"/repo/a.ts","StartLine":170,"EndLine":100}"#),
                    ]
                    .concat(),
                ),
            ),
            bytes(140, bytes(2, bytes(1, "partial output"))),
            if index == 1 {
                bytes(31, &error)
            } else {
                Vec::new()
            },
        ]
        .concat();
        db.execute(
            "INSERT INTO steps (idx,step_type,status,step_payload,error_details) VALUES (?1,132,7,?2,?3)",
            rusqlite::params![index, payload, (index == 0).then_some(&error)],
        ).unwrap();
    }
    let sessions = scan_paths(&Pricing::bundled(), &[path]).unwrap();
    for message in &sessions[0].detail.messages {
        let MessagePart::Tool { state, .. } = &message.parts[0] else {
            panic!("missing tool")
        };
        assert_eq!(state.status, ToolPartStatus::Error);
        assert_eq!(state.output, Some(json!("partial output")));
        assert_eq!(
            state.error,
            Some(json!(
                "invalid line range: StartLine 170 is greater than EndLine 100"
            ))
        );
    }
}

#[test]
fn child_names_fall_back_without_replacing_titles_or_session_identity() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let db = Connection::open(&path).unwrap();
    db.execute("DELETE FROM steps", []).unwrap();
    db.execute(
        "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (0,132,3,?1)",
        [[
            bytes(5, bytes(4, [bytes(2, "swarm"), bytes(3, r#"{"action":"add","name":"worker","brief":"Check parsing"}"#)].concat())),
            bytes(140, bytes(2, bytes(1, "Created At: 2026-11-14T10:00:00+08:00\nCompleted At: 2026-11-14T10:00:01+08:00\n{\"status\":\"added\",\"name\":\"worker\",\"conversation_id\":\"child-id\"}"))),
        ].concat()],
    ).unwrap();
    let summaries = Connection::open(temp.path().join("conversation_summaries.db")).unwrap();
    summaries
        .execute("UPDATE conversation_summaries SET agent_name='worker'", [])
        .unwrap();
    let title = || {
        scan_paths(&Pricing::bundled(), std::slice::from_ref(&path))
            .unwrap()
            .remove(0)
    };
    let root = title();
    assert_eq!(root.head.title, "Untitled Session");
    assert_eq!(
        root.detail.messages[0].subagent_id.as_deref(),
        Some("child-id")
    );
    summaries
        .execute(
            "UPDATE conversation_summaries SET parent_conversation_id='parent-id'",
            [],
        )
        .unwrap();
    let child = title();
    assert_eq!(child.head.title, "worker");
    assert_eq!(child.head.reference.session_id, "session");
    assert_eq!(
        child.head.parent_reference.as_ref().unwrap().session_id,
        "parent-id"
    );
    summaries
        .execute(
            "UPDATE conversation_summaries SET title='Summary title'",
            [],
        )
        .unwrap();
    assert_eq!(title().head.title, "Summary title");
    db.execute(
        "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (1,23,3,?1)",
        [bytes(30, bytes(4, "Updated title"))],
    )
    .unwrap();
    assert_eq!(title().head.title, "Updated title");
}

#[test]
fn acp_reads_native_workspace_and_model_without_a_summary_store() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    std::fs::remove_file(temp.path().join("conversation_summaries.db")).unwrap();
    let workspace = temp.path().join("acp-project");
    let workspace_uri = url::Url::from_file_path(&workspace).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DELETE FROM steps; CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);").unwrap();
    db.execute(
        "INSERT INTO trajectory_metadata_blob VALUES ('session', ?1)",
        [[
            bytes(7, "https://example.invalid"),
            bytes(7, workspace_uri.as_str()),
        ]
        .concat()],
    )
    .unwrap();
    let usage = [
        varint(2, 21_889),
        varint(3, 6_004),
        varint(9, 4_897),
        varint(10, 1_107),
    ]
    .concat();
    db.execute(
        "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (0,14,3,?1)",
        [bytes(19, bytes(2, "Find ACP history"))],
    )
    .unwrap();
    db.execute(
        "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (1,15,3,?1)",
        [[
            bytes(
                5,
                [
                    bytes(9, &usage),
                    bytes(24, bytes(8, "gemini-2.5-flash-high")),
                ]
                .concat(),
            ),
            bytes(20, bytes(1, "Found it")),
        ]
        .concat()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO gen_metadata VALUES (0,?1)",
        [bytes(
            1,
            [
                varint(3, 326),
                bytes(4, usage),
                bytes(19, "gemini-2.5-flash-n"),
            ]
            .concat(),
        )],
    )
    .unwrap();
    drop(db);

    let sessions = scan(&temp.path().join("conversations"), &Pricing::bundled()).unwrap();
    let session = &sessions[0];
    assert_eq!(session.head.directory, workspace.to_string_lossy());
    assert_eq!(session.head.title, "Find ACP history");
    assert_eq!(session.head.stats.message_count, 2);
    assert_eq!(session.head.stats.total_tokens, Some(27_893.0));
    assert_eq!(session.head.stats.total_input_tokens, 21_889.0);
    assert_eq!(session.head.stats.total_output_tokens, 6_004.0);
    assert_eq!(
        session.detail.messages[1].model.as_deref(),
        Some("gemini-2.5-flash-high")
    );
    assert_eq!(session.head.stats.cost_source, Some(CostSource::Estimated));
    assert!(session.head.stats.total_cost > 0.0);

    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE trajectory_metadata_blob SET data=X'3aff'", [])
        .unwrap();
    assert!(scan(&temp.path().join("conversations"), &Pricing::bundled()).is_err());
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
    db.execute(
        "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (6, 15, 3, ?1)",
        [response],
    )
    .unwrap();
    db.execute(
        "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (7, 132, 3, ?1)",
        [tool],
    )
    .unwrap();
    let scan_root = temp.path().join("conversations");
    let sessions = scan(&scan_root, &Pricing::bundled()).unwrap();
    let session = &sessions[0];
    let message = session.detail.messages.last().unwrap();
    assert_eq!(message.id, "session:7");
    assert_eq!(message.time_created, 1_788_000_001_500.0);
    assert_eq!(message.model.as_deref(), Some("gemini-2.5-flash"));
    // The struct update keeps this literal compiling when MessageTokens gains fields.
    #[allow(clippy::needless_update)]
    let expected = MessageTokens {
        input: Some(190.0),
        output: Some(25.0),
        reasoning: Some(10.0),
        cache_read: Some(40.0),
        cache_create: Some(0.0),
        ..Default::default()
    };
    assert_eq!(message.tokens, Some(expected));
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
    crate::pricing::assert_cached_repricing(|pricing| scan(&scan_root, pricing).unwrap());
}

#[test]
fn native_steps_preserve_order_tools_and_unknown_usage() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let sessions = scan(&temp.path().join("conversations"), &Pricing::bundled()).unwrap();
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
    assert_eq!(state.status, crate::model::ToolPartStatus::Unknown);
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
    assert_eq!(scan_paths(&Pricing::bundled(), &[path]).unwrap().len(), 1);
}

#[test]
fn scanner_observes_wal_updates_and_preserves_cache_on_corruption() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path());
    let source = AgentSource {
        antigravity_profiles: None,
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
fn multi_workspace_selection_inherits_parent_and_refreshes_from_history() {
    let temp = tempfile::tempdir().unwrap();
    let conversations = temp.path().join("conversations");
    std::fs::create_dir_all(&conversations).unwrap();
    let aux_dir = temp.path().join("aux-space");
    let project_dir = temp.path().join("proj-space");
    let unrelated_dir = temp.path().join("other-space");
    let aux_uri = url::Url::from_file_path(&aux_dir).unwrap();
    let project_uri = url::Url::from_file_path(&project_dir).unwrap();
    let workspaces_json = json!([aux_uri.as_str(), project_uri.as_str()]).to_string();

    let summaries = Connection::open(temp.path().join("conversation_summaries.db")).unwrap();
    summaries
        .execute_batch(
            "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, agent_name TEXT);",
        )
        .unwrap();

    let create_session = |id: &str, parent: &str, steps: Vec<(i64, Vec<u8>)>| -> PathBuf {
        let db_path = conversations.join(format!("{id}.db"));
        let db = Connection::open(&db_path).unwrap();
        db.execute_batch(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, step_payload BLOB, error_details BLOB);
             CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);",
        )
        .unwrap();
        for (idx, payload) in steps {
            db.execute(
                "INSERT INTO steps (idx,step_type,status,step_payload) VALUES (?1, ?2, 3, ?3)",
                rusqlite::params![idx, if idx == 0 { 14 } else { 132 }, payload],
            )
            .unwrap();
        }
        summaries
            .execute(
                "INSERT INTO conversation_summaries (conversation_id,title,workspace_uris,last_modified_time,parent_conversation_id) VALUES (?1, '', ?2, '2026-09-02 16:57:28.971105+00:00', ?3)",
                [id, &workspaces_json, parent],
            )
            .unwrap();
        db_path
    };

    let file_ctx_uri = url::Url::from_file_path(project_dir.join("src/main.rs")).unwrap();
    let user_items_prompt = bytes(
        19,
        [
            bytes(3, bytes(1, "Check ")),
            bytes(
                3,
                [
                    bytes(1, "@main.rs"),
                    bytes(2, bytes(1, bytes(5, file_ctx_uri.as_str()))),
                ]
                .concat(),
            ),
        ]
        .concat(),
    );
    create_session("ctx-session", "", vec![(0, user_items_prompt)]);

    let cmd_input =
        json!({"command": format!("cd {} && cargo test", project_dir.display())}).to_string();
    create_session(
        "cmd-session",
        "",
        vec![
            (0, bytes(19, bytes(2, "Run tests"))),
            (
                1,
                bytes(
                    5,
                    bytes(
                        4,
                        [
                            bytes(1, "call-cmd"),
                            bytes(2, "run_command"),
                            bytes(3, cmd_input),
                        ]
                        .concat(),
                    ),
                ),
            ),
        ],
    );

    let parent_tool = json!({"path": project_dir.join("Cargo.toml")}).to_string();
    create_session(
        "parent-z",
        "",
        vec![
            (0, bytes(19, bytes(2, "Parent"))),
            (
                1,
                bytes(
                    5,
                    bytes(
                        4,
                        [
                            bytes(1, "call-parent"),
                            bytes(2, "read_file"),
                            bytes(3, parent_tool),
                        ]
                        .concat(),
                    ),
                ),
            ),
        ],
    );

    let unrelated_tool = json!({"path": unrelated_dir.join("notes.md")}).to_string();
    let child_db = create_session(
        "child-a",
        "parent-z",
        vec![
            (0, bytes(19, bytes(2, "Child"))),
            (
                1,
                bytes(
                    5,
                    bytes(
                        4,
                        [
                            bytes(1, "call-child"),
                            bytes(2, "read_file"),
                            bytes(3, unrelated_tool),
                        ]
                        .concat(),
                    ),
                ),
            ),
        ],
    );

    create_session("greeting", "", vec![(0, bytes(19, bytes(2, "Hello")))]);
    drop(summaries);

    let scanned = scan(&conversations, &Pricing::bundled()).unwrap();
    let dir_of = |sessions: &[ParsedSession], id: &str| {
        sessions
            .iter()
            .find(|s| s.head.reference.session_id == id)
            .unwrap()
            .head
            .directory
            .clone()
    };
    let project_str = project_dir.to_string_lossy().into_owned();
    let aux_str = aux_dir.to_string_lossy().into_owned();

    assert_eq!(dir_of(&scanned, "ctx-session"), project_str);
    assert_eq!(
        scanned
            .iter()
            .find(|s| s.head.reference.session_id == "ctx-session")
            .unwrap()
            .head
            .title,
        "Check @main.rs"
    );
    assert_eq!(dir_of(&scanned, "cmd-session"), project_str);
    assert_eq!(dir_of(&scanned, "parent-z"), project_str);
    assert_eq!(dir_of(&scanned, "child-a"), project_str);
    assert_eq!(dir_of(&scanned, "greeting"), aux_str);

    let standalone_child = scan_paths(&Pricing::bundled(), &[child_db]).unwrap();
    assert_eq!(standalone_child.len(), 1);
    assert_eq!(standalone_child[0].head.directory, project_str);

    let source = AgentSource {
        antigravity_profiles: None,
        agent: "antigravity-cli".into(),
        data_root: temp.path().into(),
        scan_path: conversations,
    };
    let history_path = temp.path().join("history.jsonl");
    assert!(source.watch_roots().contains(&history_path));

    let mut scanner = AgentScanner::new(
        source,
        temp.path().join("cache.db"),
        Arc::new(Pricing::bundled()),
    );
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(dir_of(&initial.sessions, "greeting"), aux_str);
    initial.on_reject.take();

    let history_lines = format!(
        "{{invalid-json\n{{\"workspace\":\"{}\"}}\n{}\n",
        project_dir.display(),
        json!({"conversationId": "greeting", "workspace": project_dir.to_string_lossy()}),
    );
    std::fs::write(&history_path, history_lines).unwrap();

    let refreshed = scanner.refresh(Some(&[history_path])).unwrap();
    assert_eq!(dir_of(&refreshed.sessions, "greeting"), project_str);
}
