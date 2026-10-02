use crate::{
    contract::{Message, MessagePart},
    storage::{Cache, detail_with_cursor, tests::source},
};
use serde_json::json;

fn tool(name: &str, time: f64) -> Message {
    serde_json::from_value(json!({
        "id":"duplicate", "role":"assistant", "time_created":time,
        "model":"model", "cost":0.25, "cost_source":"recorded",
        "parts":[{"type":"tool","tool":name,"state":{"status":"completed","input":{"file_path":"src/file.rs"}}}]
    })).unwrap()
}

fn matches_full_rebuild(cache: &Cache, session: &crate::agents::ParsedSession) {
    let mut fresh = Cache::open(None).unwrap();
    fresh.publish(&mut [session.clone()]).unwrap();
    let reference = &session.head.reference;
    let actual = cache
        .detail(cache.head(reference).unwrap().unwrap())
        .unwrap();
    let expected = fresh
        .detail(fresh.head(reference).unwrap().unwrap())
        .unwrap();
    assert_eq!(
        serde_json::to_value(actual).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    let facts = |cache: &Cache| {
        serde_json::to_value(
            crate::analytics::load_cost_facts(cache.connection(), None, None, true).unwrap(),
        )
        .unwrap()
    };
    assert_eq!(facts(cache), facts(&fresh));
}

#[test]
fn append_preserves_existing_message_rows_and_rewrites_or_truncations_match_a_full_rebuild() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "reuse");
    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: "oldneedle".into(),
        time_created: None,
    }];
    session.detail.messages.push(tool("Read", 2.0));
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let cursor = session.detail.message_cursor.clone();
    cache.connection().execute_batch("
        CREATE TRIGGER protect_insert BEFORE INSERT ON messages WHEN new.message_index<2 BEGIN SELECT RAISE(ABORT,'prefix inserted'); END;
        CREATE TRIGGER protect_update BEFORE UPDATE ON messages WHEN old.message_index<2 BEGIN SELECT RAISE(ABORT,'prefix updated'); END;
        CREATE TRIGGER protect_delete BEFORE DELETE ON messages WHEN old.message_index<2 BEGIN SELECT RAISE(ABORT,'prefix deleted'); END;
        CREATE TRIGGER protect_session BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'session deleted'); END;
    ").unwrap();
    session.detail.messages.push(tool("Write", 3.0));
    session.head.title = "Changed title".into();
    session.head.stats.message_count = 3;
    session.detail.head = session.head.clone();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let update = detail_with_cursor(cache.connection(), session.head.clone(), cursor.as_deref())
        .unwrap()
        .unwrap();
    assert_eq!(update.message_update.as_deref(), Some("append"));
    assert_eq!(update.messages.len(), 1);
    matches_full_rebuild(&cache, &session);
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    cache.connection().execute_batch("DROP TRIGGER protect_insert; DROP TRIGGER protect_update; DROP TRIGGER protect_delete; DROP TRIGGER protect_session;").unwrap();

    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: "newneedle".into(),
        time_created: None,
    }];
    session.detail.messages[1] = tool("Edit", 4.0);
    session.detail.messages.truncate(2);
    session.head.stats.message_count = 2;
    session.detail.head = session.head.clone();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    matches_full_rebuild(&cache, &session);
    let reset = detail_with_cursor(cache.connection(), session.head.clone(), cursor.as_deref())
        .unwrap()
        .unwrap();
    assert_eq!(reset.message_update.as_deref(), Some("reset"));
    let tools: Vec<String> = cache
        .connection()
        .prepare("SELECT tool_name FROM message_tools ORDER BY tool_name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(tools, ["edit"]);
    for (word, count) in [("oldneedle", 0), ("newneedle", 1)] {
        assert_eq!(cache.connection().query_row("SELECT COUNT(*) FROM session_documents_fts WHERE session_documents_fts MATCH ?", [word], |r| r.get::<_, i64>(0)).unwrap(), count);
    }
    session.detail.messages.clear();
    session.head.stats.message_count = 0;
    session.detail.head = session.head.clone();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    matches_full_rebuild(&cache, &session);
}

#[test]
fn reindex_parser_changes_legacy_digests_and_repricing_force_body_replacement() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "rebuild");
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    for invalidate in [
        "UPDATE sessions SET meta_json=json_set(meta_json,'$.rustPricingRevision',1)",
        "UPDATE sessions SET meta_json=json_set(meta_json,'$.parserVersion','old-parser')",
        "INSERT INTO pending_reindex SELECT source_node_id,agent_name,session_id FROM sessions",
        "UPDATE messages SET content_chain_digest=NULL",
        "UPDATE sessions SET meta_json='{}'",
        "UPDATE sessions SET meta_json='invalid'",
    ] {
        cache.connection().execute_batch(invalidate).unwrap();
        cache
            .connection()
            .execute("UPDATE messages SET cost=999", [])
            .unwrap();
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        matches_full_rebuild(&cache, &session);
    }
}

#[test]
fn append_failure_rolls_back_messages_metadata_facts_and_checkpoint() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "rollback");
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let before = session.clone();
    session.detail.messages.push(tool("Write", 2.0));
    session.head.title = "Not committed".into();
    session.detail.head = session.head.clone();
    cache.connection().execute_batch("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON cache_meta WHEN new.key='rust_sync_checkpoint:codex' BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END;").unwrap();
    let checkpoint = Some(json!({"offset":1}));
    assert!(
        cache
            .apply_checkpoint(
                std::slice::from_mut(&mut session),
                &[],
                "codex",
                &checkpoint,
                false
            )
            .is_err()
    );
    assert_eq!(session.detail.message_cursor, before.detail.message_cursor);
    matches_full_rebuild(&cache, &before);
    assert_eq!(
        cache
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM cache_meta WHERE key='rust_sync_checkpoint:codex'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    cache
        .connection()
        .execute_batch("DROP TRIGGER reject_checkpoint")
        .unwrap();
    cache
        .apply_checkpoint(
            std::slice::from_mut(&mut session),
            &[],
            "codex",
            &checkpoint,
            false,
        )
        .unwrap();
    matches_full_rebuild(&cache, &session);
}
