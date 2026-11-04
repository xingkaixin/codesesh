use super::*;
use serde_json::json;

fn fixture(rows: &[(&str, Value)]) -> tempfile::TempDir {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("globalStorage")).unwrap();
    let db = Connection::open(temp.path().join("globalStorage/state.vscdb")).unwrap();
    db.execute_batch("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .unwrap();
    for (key, value) in rows {
        db.execute(
            "INSERT INTO cursorDiskKV VALUES (?,?)",
            rusqlite::params![key, value.to_string()],
        )
        .unwrap();
    }
    temp
}
#[test]
fn insertion_order_model_inheritance_and_malformed_rows() {
    let root = fixture(&[
        (
            "composerData:c",
            json!({"composerId":"c","createdAt":1000,"lastSendTime":2500,"model":"gpt-4"}),
        ),
        ("composerData:empty", json!({"composerId":"empty"})),
        (
            "bubbleId:c:z",
            json!({"type":1,"text":"hello <system-reminder>secret</system-reminder>","modelInfo":{"modelName":"gpt-4"},"tokenCount":{"inputTokens":10}}),
        ),
        (
            "bubbleId:c:a",
            json!({"type":2,"text":"answer","tokenCount":{"outputTokens":5}}),
        ),
        (
            "bubbleId:c:x",
            json!({"type":1,"eventType":"queue_operation","text":"hidden"}),
        ),
        ("bubbleId:empty:a", json!("not an object")),
    ]);
    let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
    crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
    assert_eq!(sessions.len(), 1);
    let detail = &sessions[0].detail;
    assert_eq!(detail.head.title, "hello");
    assert_eq!(detail.head.time_updated, 2500.0);
    assert_eq!(
        detail
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["cursor-c-z", "cursor-c-a"]
    );
    assert_eq!(detail.messages[1].model.as_deref(), Some("gpt-4"));
    assert_eq!(detail.head.stats.total_input_tokens, 10.0);
    assert_eq!(detail.head.stats.total_output_tokens, 5.0);
    assert_eq!(detail.head.model_usage.as_ref().unwrap()["gpt-4"], 15.0);
}
#[test]
fn subagent_output_fixture_and_tool_error_semantics() {
    let sub: Value =
        serde_json::from_str(include_str!("fixtures/subagent-tool-output.json")).unwrap();
    let root = fixture(&[
        (
            "composerData:c",
            json!({"composerId":"c","subagentInfos":[{"id":"s","nickname":"Reader"}]}),
        ),
        ("bubble:s", sub),
        (
            "bubbleId:c:tool",
            json!({"type":2,"toolFormerData":{"name":"run_terminal_command_v2","status":"completed","result":{"message":"fine","stderr":"warning"}}}),
        ),
    ]);
    let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
    let messages = &sessions[0].detail.messages;
    assert_eq!(messages.len(), 2);
    let MessagePart::Tool { state, .. } = &messages[0].parts[0] else {
        panic!("tool missing")
    };
    assert_eq!(state.status, "completed");
    assert_eq!(state.error, None);
    assert_eq!(messages[1].subagent_id.as_deref(), Some("s"));
    let MessagePart::Tool { tool, state, .. } = &messages[1].parts[0] else {
        panic!("tool missing")
    };
    assert_eq!(tool, "read");
    assert_eq!(
        state.output.as_ref().unwrap(),
        &json!([
            {"type":"text","text":"first line","time_created":0.0},
            {"type":"text","text":"second line","time_created":0.0},
            {"type":"text","text":"third line","time_created":0.0},
        ])
    );
}
#[test]
fn workspace_mapping_decodes_uri_and_ignores_symlinks() {
    let root = fixture(&[
        ("composerData:c", json!({"composerId":"c"})),
        ("bubbleId:c:a", json!({"text":"hello"})),
    ]);
    let workspace = root.path().join("workspaceStorage/a");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(
        workspace.join("workspace.json"),
        r#"{"folder":"file:///project%20one"}"#,
    )
    .unwrap();
    let db = Connection::open(workspace.join("state.vscdb")).unwrap();
    db.execute_batch("CREATE TABLE ItemTable(key TEXT,value TEXT); INSERT INTO ItemTable VALUES ('composer.composerData','{\"allComposers\":[{\"composerId\":\"c\"}]}')").unwrap();
    #[cfg(unix)]
    {
        let external = tempfile::tempdir().unwrap();
        std::fs::write(
            external.path().join("workspace.json"),
            r#"{"folder":"file:///wrong-project"}"#,
        )
        .unwrap();
        let external_db = Connection::open(external.path().join("state.vscdb")).unwrap();
        external_db.execute_batch("CREATE TABLE ItemTable(key TEXT,value TEXT); INSERT INTO ItemTable VALUES ('composer.composerData','[{\"composerId\":\"c\"}]')").unwrap();
        std::os::unix::fs::symlink(external.path(), root.path().join("workspaceStorage/z-link"))
            .unwrap();
        assert_eq!(
            workspace_paths(root.path()).get("c"),
            Some(&normalize_path("/project one"))
        );
    }
    let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
    assert_eq!(
        sessions[0].detail.head.directory,
        normalize_path("/project one")
    );
    assert_eq!(decode_uri("%GG"), None);
}

#[test]
fn incremental_bubble_updates_children_and_deletions() {
    let root = fixture(&[
        (
            "composerData:a",
            json!({"composerId":"a","subagentInfos":[{"id":"child"}]}),
        ),
        ("composerData:b", json!({"composerId":"b"})),
        ("bubbleId:a:1", json!({"text":"one"})),
        ("bubbleId:b:1", json!({"text":"two"})),
        (
            "bubble:child",
            json!({"chatMessages":[{"role":"assistant","text":"child one"}]}),
        ),
    ]);
    let pricing = Pricing::bundled();
    let mut sync = CursorSync::default();
    assert_eq!(
        sync.refresh(root.path(), &pricing).unwrap().upserts.len(),
        2
    );
    assert!(
        sync.refresh(root.path(), &pricing)
            .unwrap()
            .upserts
            .is_empty()
    );
    let home = tempfile::tempdir().unwrap();
    let controller = crate::pricing::PricingController::load(home.path());
    controller
        .stage_remote(&json!({"openai":{"models":{"gpt-4o":{"cost":{"input":123,"output":8}}}}}))
        .unwrap();
    controller.publish_pending().unwrap();
    assert!(
        sync.refresh(root.path(), &controller.snapshot().unwrap().pricing)
            .unwrap()
            .upserts
            .is_empty()
    );
    let db = Connection::open(root.path().join("globalStorage/state.vscdb")).unwrap();
    db.execute(
        "UPDATE cursorDiskKV SET value=? WHERE key='bubble:child'",
        [json!({"chatMessages":[{"role":"assistant","text":"child two"}]}).to_string()],
    )
    .unwrap();
    let delta = sync.refresh(root.path(), &pricing).unwrap();
    assert_eq!(delta.upserts.len(), 1);
    assert_eq!(delta.upserts[0].head.reference.session_id, "a");
    assert!(
        matches!(&delta.upserts[0].detail.messages[1].parts[0],MessagePart::Text{text,..} if text=="child two")
    );
    db.execute("DELETE FROM cursorDiskKV WHERE key='bubbleId:b:1'", [])
        .unwrap();
    let delta = sync.refresh(root.path(), &pricing).unwrap();
    assert!(delta.upserts.is_empty());
    assert_eq!(delta.removed[0].session_id, "b");
    db.execute("DELETE FROM cursorDiskKV WHERE key='composerData:a'", [])
        .unwrap();
    let delta = sync.refresh(root.path(), &pricing).unwrap();
    assert!(delta.upserts.is_empty());
    assert_eq!(delta.removed[0].session_id, "a");
}
#[test]
fn incremental_read_failure_does_not_accept_a_new_fingerprint() {
    let root = fixture(&[
        ("composerData:a", json!({"composerId":"a"})),
        ("bubbleId:a:1", json!({"text":"one"})),
    ]);
    let pricing = Pricing::bundled();
    let mut sync = CursorSync::default();
    sync.refresh(root.path(), &pricing).unwrap();
    let db = Connection::open(root.path().join("globalStorage/state.vscdb")).unwrap();
    db.execute_batch("ALTER TABLE cursorDiskKV RENAME TO temporarily_unavailable")
        .unwrap();
    assert!(sync.refresh(root.path(), &pricing).is_err());
    db.execute_batch("ALTER TABLE temporarily_unavailable RENAME TO cursorDiskKV")
        .unwrap();
    let delta = sync.refresh(root.path(), &pricing).unwrap();
    assert!(delta.upserts.is_empty());
    assert!(delta.removed.is_empty());
    drop(db);
    std::fs::remove_file(root.path().join("globalStorage/state.vscdb")).unwrap();
    let delta = sync.refresh(root.path(), &pricing).unwrap();
    assert_eq!(delta.removed[0].session_id, "a");
}

#[test]
fn paged_snapshot_detects_shared_child_changes_between_pages_and_row_reordering() {
    let root = fixture(&[
        (
            "composerData:a",
            json!({"composerId":"a","subagentInfos":[{"id":"shared"}]}),
        ),
        (
            "composerData:b",
            json!({"composerId":"b","subagentInfos":[{"id":"shared"}]}),
        ),
        ("bubbleId:a:1", json!({"text":"first"})),
        ("bubbleId:a:2", json!({"text":"second"})),
        ("bubbleId:b:1", json!({"text":"other"})),
        (
            "bubble:shared",
            json!({"chatMessages":[{"role":"assistant","text":"old"}]}),
        ),
    ]);
    let pricing = Pricing::bundled();
    let mut sync = CursorSync::default();
    sync.scan_selected(
        root.path(),
        &pricing,
        &std::collections::HashSet::from(["a".into()]),
    )
    .unwrap();
    let db = Connection::open(root.path().join("globalStorage/state.vscdb")).unwrap();
    db.execute(
        "UPDATE cursorDiskKV SET value=?1 WHERE key='bubble:shared'",
        [json!({"chatMessages":[{"role":"assistant","text":"new"}]}).to_string()],
    )
    .unwrap();
    sync.scan_selected(
        root.path(),
        &pricing,
        &std::collections::HashSet::from(["b".into()]),
    )
    .unwrap();
    let delta = sync.refresh(root.path(), &pricing).unwrap();
    assert_eq!(delta.upserts.len(), 1);
    assert_eq!(delta.upserts[0].head.reference.session_id, "a");
    assert!(
        matches!(&delta.upserts[0].detail.messages[2].parts[0],MessagePart::Text{text,..} if text=="new")
    );
    assert!(
        sync.refresh(root.path(), &pricing)
            .unwrap()
            .upserts
            .is_empty()
    );
    db.execute(
        "INSERT OR REPLACE INTO cursorDiskKV VALUES('bubbleId:a:1',?1)",
        [json!({"text":"first"}).to_string()],
    )
    .unwrap();
    let delta = sync.refresh(root.path(), &pricing).unwrap();
    assert_eq!(delta.upserts.len(), 1);
    assert_eq!(delta.upserts[0].detail.messages[0].id, "cursor-a-2");
    assert_eq!(delta.upserts[0].detail.messages[1].id, "cursor-a-1");
}

#[test]
fn refresh_selected_defers_history_without_losing_its_changes() {
    let root = fixture(&[
        ("composerData:live", json!({"composerId":"live"})),
        ("composerData:history", json!({"composerId":"history"})),
        ("bubbleId:live:1", json!({"text":"live"})),
        ("bubbleId:history:1", json!({"text":"old"})),
    ]);
    let pricing = Pricing::bundled();
    let mut sync = CursorSync::default();
    let eligible = std::collections::HashSet::from(["live".into()]);
    sync.scan_selected(root.path(), &pricing, &eligible)
        .unwrap();
    let db = Connection::open(root.path().join("globalStorage/state.vscdb")).unwrap();
    db.execute(
        "UPDATE cursorDiskKV SET value=?1 WHERE key='bubbleId:history:1'",
        [json!({"text":"changed history"}).to_string()],
    )
    .unwrap();
    assert!(
        sync.refresh_selected(root.path(), &pricing, &eligible)
            .unwrap()
            .upserts
            .is_empty()
    );
    assert!(
        sync.refresh_selected(root.path(), &pricing, &eligible)
            .unwrap()
            .upserts
            .is_empty()
    );
    let completed = sync.refresh(root.path(), &pricing).unwrap();
    assert_eq!(completed.upserts.len(), 1);
    assert_eq!(completed.upserts[0].head.reference.session_id, "history");
    assert!(
        matches!(&completed.upserts[0].detail.messages[0].parts[0],MessagePart::Text{text,..} if text=="changed history")
    );
}
