use super::*;
use serde_json::json;
use tempfile::TempDir;

fn database(v2: bool) -> (TempDir, Connection) {
    let temp = TempDir::new().unwrap();
    let db = Connection::open(temp.path().join("opencode.db")).unwrap();
    if v2 {
        db.execute_batch("CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,fork_session_id TEXT,title TEXT,directory TEXT DEFAULT '/project',path TEXT,version TEXT DEFAULT '2.0.15',summary_files INTEGER DEFAULT 0,time_created INTEGER DEFAULT 1000,time_updated INTEGER DEFAULT 2000,cost REAL DEFAULT 0,tokens_input INTEGER DEFAULT 0,tokens_output INTEGER DEFAULT 0,tokens_reasoning INTEGER DEFAULT 0,tokens_cache_read INTEGER DEFAULT 0,tokens_cache_write INTEGER DEFAULT 0); CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER DEFAULT 1000,time_updated INTEGER DEFAULT 2000,data TEXT);").unwrap();
    } else {
        db.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,directory TEXT,version TEXT,summary_files TEXT,slug TEXT); CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,data TEXT,time_created INTEGER); CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,data TEXT,time_created INTEGER);").unwrap();
    }
    (temp, db)
}
fn message(db: &Connection, id: &str, session: &str, kind: &str, seq: i64, data: Value) {
    db.execute(
        "INSERT INTO session_message(id,session_id,type,seq,data) VALUES(?1,?2,?3,?4,?5)",
        rusqlite::params![id, session, kind, seq, data.to_string()],
    )
    .unwrap();
}
#[test]
fn v2_preserves_sequence_tools_tokens_children_and_source() {
    let (temp, db) = database(true);
    db.execute_batch("INSERT INTO session_v2(id)VALUES('root'); INSERT INTO session_v2(id,parent_id)VALUES('child','root'),('cycle-a','cycle-b'),('cycle-b','cycle-a'); UPDATE session_v2 SET tokens_input=10,tokens_output=3,tokens_reasoning=2,tokens_cache_read=4,tokens_cache_write=1,cost=0.25 WHERE id='root';").unwrap();
    message(
        &db,
        "assistant",
        "root",
        "assistant",
        2,
        json!({"agent":"build","model":{"id":"test-model","providerID":"test"},"time":{"completed":2500},"tokens":{"input":10,"output":3,"reasoning":2,"cache":{"read":4,"write":1}},"cost":0.25,"content":[{"type":"reasoning","text":"Think"},{"type":"tool","name":"subagent","id":"tool-1","state":{"status":"completed","input":{"path":"src/lib.rs"},"content":[{"type":"text","text":"done"}],"metadata":{"sessionID":"child"}}},{"type":"text","text":"Done"}]}),
    );
    message(
        &db,
        "user",
        "root",
        "user",
        1,
        json!({"text":"Implement parser"}),
    );
    message(
        &db,
        "child-user",
        "child",
        "user",
        1,
        json!({"text":"Child"}),
    );
    message(&db, "hidden", "cycle-a", "user", 1, json!({"text":"Cycle"}));
    drop(db);
    let path = temp.path().join("opencode.db");
    let before = std::fs::read(&path).unwrap();
    let sessions = scan(temp.path(), &Pricing::bundled()).unwrap();
    assert_eq!(sessions.len(), 2);
    let session = sessions
        .iter()
        .find(|s| s.head.reference.session_id == "root")
        .unwrap();
    assert_eq!(session.head.title, "Implement parser");
    assert_eq!(
        session
            .detail
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["user", "assistant"]
    );
    assert_eq!(session.head.stats.total_tokens, Some(20.0));
    assert_eq!(
        session.head.model_usage.as_ref().unwrap()["test-model"],
        20.0
    );
    assert_eq!(
        session.detail.messages[1].subagent_id.as_deref(),
        Some("child")
    );
    assert_eq!(session.detail.messages[1].time_completed, Some(2500.0));
    assert_eq!(session.detail.head.version.as_deref(), Some("2.0.15"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}
#[test]
fn v2_rejects_incomplete_migrations_and_corruption() {
    let (temp, db) = database(true);
    db.execute_batch("INSERT INTO session_v2(id) VALUES('root');CREATE TABLE session(id TEXT);INSERT INTO session VALUES('old');CREATE TABLE kv(key TEXT,value TEXT);INSERT INTO kv VALUES('migration.v1-v2','{\"phase\":\"messages\"}');").unwrap();
    assert!(
        scan(temp.path(), &Pricing::bundled())
            .err()
            .unwrap()
            .to_string()
            .contains("not complete")
    );
    db.execute("UPDATE kv SET value=?1", ["{\"phase\":\"completed\"}"])
        .unwrap();
    message(&db, "bad", "root", "assistant", 0, json!({}));
    assert!(
        scan(temp.path(), &Pricing::bundled())
            .err()
            .unwrap()
            .to_string()
            .contains("Invalid OpenCode V2 content")
    );
}
#[test]
fn v1_normalizes_legacy_tool_state_and_hides_internal_parts() {
    let (temp, db) = database(false);
    db.execute_batch("INSERT INTO session(id,parent_id,title,time_created,time_updated,directory,version,summary_files) VALUES('root',NULL,'',1000,2000,'/project','1.0',NULL);")
        .unwrap();
    db.execute(
        "INSERT INTO message VALUES('m1','root',?1,1100)",
        [json!({"role":"user","cost":0.5,"tokens":{"input":15,"output":8}}).to_string()],
    )
    .unwrap();
    for (id, data) in [
        (
            "p1",
            json!({"type":"text","text":"<system-reminder>secret</system-reminder>"}),
        ),
        ("p2", json!({"type":"text","text":"Implement fixture"})),
        (
            "p3",
            json!({"type":"tool","title":"tool: edit","callID":"call1","state":{"status":"success","arguments":{"path":"a.rs","text":"<command-args>visible</command-args>"},"result":"done","duration":12}}),
        ),
    ] {
        db.execute(
            "INSERT INTO part VALUES(?1,'m1',?2,1100)",
            rusqlite::params![id, data.to_string()],
        )
        .unwrap();
    }
    let sessions = scan(temp.path(), &Pricing::bundled()).unwrap();
    let session = &sessions[0];
    assert_eq!(session.head.title, "Implement fixture");
    assert_eq!(session.head.stats.total_cost, 0.5);
    assert_eq!(session.detail.messages[0].parts.len(), 2);
    match &session.detail.messages[0].parts[1] {
        MessagePart::Tool { tool, state, .. } => {
            assert_eq!(tool, "edit");
            assert_eq!(state.status, "completed");
            assert_eq!(state.metadata.as_ref().unwrap()["duration"], 12);
            assert_eq!(state.input.as_ref().unwrap()["text"], "visible");
        }
        _ => panic!("expected tool"),
    }
}

#[test]
fn child_usage_only_changes_detail_and_counts_invisible_child_usage() {
    let (temp, db) = database(false);
    db.execute_batch("INSERT INTO session(id,parent_id,title,time_created,time_updated,directory,version,summary_files) VALUES('root',NULL,'Root',1000,2000,'/project',NULL,NULL),('child','root','Child',1000,2000,'/project',NULL,NULL),('grandchild','child','Grandchild',1000,2000,'/project',NULL,NULL);").unwrap();
    for (id, session, cost) in [
        ("root-message", "root", 1.0),
        ("child-message", "child", 2.0),
        ("grandchild-message", "grandchild", 4.0),
    ] {
        db.execute(
            "INSERT INTO message VALUES(?1,?2,?3,1100)",
            rusqlite::params![
                id,
                session,
                json!({"role":"assistant","cost":cost,"tokens":{"input":10,"output":3}})
                    .to_string()
            ],
        )
        .unwrap();
        if session != "grandchild" {
            db.execute(
                "INSERT INTO part VALUES(?1,?1,?2,1100)",
                rusqlite::params![id, json!({"type":"text","text":"visible"}).to_string()],
            )
            .unwrap();
        }
    }
    let sessions = scan(temp.path(), &Pricing::bundled()).unwrap();
    let root = sessions
        .iter()
        .find(|s| s.head.reference.session_id == "root")
        .unwrap();
    assert_eq!(root.head.stats.total_cost, 1.0);
    assert_eq!(root.detail.head.stats.total_cost, 7.0);
    assert_eq!(root.head.stats.message_count, 1);
    assert_eq!(root.detail.head.stats.message_count, 1);
    assert_eq!(root.detail.head.stats.total_input_tokens, 30.0);
    let pricing = Pricing::bundled();
    let mut first = refresh(temp.path(), &pricing, None).unwrap();
    first.release_bodies();
    assert!(
        refresh(temp.path(), &pricing, Some(&first))
            .unwrap()
            .upserts
            .is_empty()
    );
    db.execute(
        "UPDATE message SET data=?1 WHERE session_id='child'",
        [json!({"role":"assistant","cost":8,"tokens":{"input":20,"output":4}}).to_string()],
    )
    .unwrap();
    let next = refresh(temp.path(), &pricing, Some(&first)).unwrap();
    assert_eq!(next.decoded.len(), 2);
    assert_eq!(next.upserts.len(), 2);
    let root = next
        .sessions
        .iter()
        .find(|s| s.head.reference.session_id == "root")
        .unwrap();
    assert_eq!(root.head.stats.total_cost, 1.0);
    assert_eq!(root.detail.head.stats.total_cost, 13.0);
    assert_eq!(root.detail.messages.len(), 1);
    let mut next = next;
    next.release_bodies();
    db.execute("DELETE FROM session WHERE id='child'", [])
        .unwrap();
    let deleted = refresh(temp.path(), &pricing, Some(&next)).unwrap();
    let root = deleted
        .upserts
        .iter()
        .find(|s| s.head.reference.session_id == "root")
        .unwrap();
    assert_eq!(root.detail.messages.len(), 1);
}

#[test]
fn zcode_uses_nested_database_and_agent_identity() {
    let (temp, db) = database(false);
    db.execute_batch("INSERT INTO session(id,parent_id,title,time_created,time_updated,directory,version,summary_files) VALUES('root',NULL,'ZCode',1000,2000,'/project',NULL,NULL);DROP TABLE message;DROP TABLE part;").unwrap();
    drop(db);
    std::fs::create_dir_all(temp.path().join("cli/db")).unwrap();
    std::fs::rename(
        temp.path().join("opencode.db"),
        temp.path().join("cli/db/db.sqlite"),
    )
    .unwrap();
    let sessions = crate::agents::zcode::scan(temp.path(), &Pricing::bundled()).unwrap();
    assert_eq!(sessions[0].head.reference.agent_name, "zcode");
}

#[test]
fn incremental_reuses_unchanged_sessions_and_handles_wal_edits_and_deletions() {
    let (temp, db) = database(true);
    db.execute_batch("PRAGMA journal_mode=WAL;INSERT INTO session_v2(id)VALUES('one'),('two');")
        .unwrap();
    message(&db, "one-user", "one", "user", 1, json!({"text":"aaaa"}));
    message(&db, "two-user", "two", "user", 1, json!({"text":"keep"}));
    let pricing = Pricing::bundled();
    let mut first = refresh(temp.path(), &pricing, None).unwrap();
    assert_eq!(first.decoded.len(), 2);
    assert_eq!(first.upserts.len(), 2);
    first.release_bodies();
    let mut unchanged = refresh(temp.path(), &pricing, Some(&first)).unwrap();
    assert!(unchanged.decoded.is_empty());
    assert!(unchanged.upserts.is_empty());
    db.execute(
        "UPDATE session_message SET data=?1 WHERE id='one-user'",
        [json!({"text":"bbbb"}).to_string()],
    )
    .unwrap();
    unchanged.release_bodies();
    let mut changed = refresh(temp.path(), &pricing, Some(&unchanged)).unwrap();
    assert_eq!(changed.decoded.len(), 1);
    assert_eq!(changed.decoded[0].session_id, "one");
    assert_eq!(changed.upserts.len(), 1);
    assert_eq!(changed.upserts[0].head.title, "bbbb");
    db.execute("DELETE FROM session_message WHERE session_id='one'", [])
        .unwrap();
    changed.release_bodies();
    let removed = refresh(temp.path(), &pricing, Some(&changed)).unwrap();
    assert_eq!(removed.removed, [reference("opencode", "one".into())]);
    assert_eq!(removed.sessions.len(), 1);
    db.execute(
        "UPDATE session_message SET data='broken' WHERE session_id='two'",
        [],
    )
    .unwrap();
    assert!(refresh(temp.path(), &pricing, Some(&removed)).is_err());
    assert_eq!(removed.sessions[0].head.title, "keep");
}

#[test]
fn preserves_fractional_database_and_message_timestamps() {
    let (temp, db) = database(true);
    db.execute_batch(
        "INSERT INTO session_v2(id,time_created,time_updated)VALUES('root',1000.25,2000.75)",
    )
    .unwrap();
    message(
        &db,
        "assistant",
        "root",
        "assistant",
        1,
        json!({"time":{"completed":1600.5},"content":[{"type":"tool","name":"read","time":{"created":1500.25},"state":{"status":"completed","input":{"path":"a.rs"}}}]}),
    );
    db.execute_batch("UPDATE session_message SET time_created=1200.125")
        .unwrap();
    let parsed = scan(temp.path(), &Pricing::bundled()).unwrap();
    assert_eq!(parsed[0].head.time_created, 1000.25);
    assert_eq!(parsed[0].head.time_updated, 2000.75);
    assert_eq!(parsed[0].detail.messages[0].time_created, 1200.125);
    assert_eq!(parsed[0].detail.messages[0].time_completed, Some(1600.5));
    let MessagePart::Tool { time_created, .. } = &parsed[0].detail.messages[0].parts[0] else {
        panic!("expected tool")
    };
    assert_eq!(*time_created, Some(1500.25));
}

#[test]
fn pages_database_subtrees_without_decoding_unselected_history() {
    let (temp, db) = database(true);
    db.execute_batch("INSERT INTO session_v2(id,time_updated)VALUES('hot',3000.5),('cold',1000.25);INSERT INTO session_v2(id,parent_id,time_updated)VALUES('child','hot',2000.5)").unwrap();
    message(
        &db,
        "hot-message",
        "hot",
        "user",
        1,
        json!({"text":"Recent"}),
    );
    message(
        &db,
        "child-message",
        "child",
        "user",
        1,
        json!({"text":"Related"}),
    );
    message(
        &db,
        "cold-message",
        "cold",
        "assistant",
        1,
        json!({"content":"malformed"}),
    );
    let path = temp.path().join("opencode.db");
    let pricing = Pricing::bundled();
    assert_eq!(
        enumerate_session_keys(&path, "opencode", true).unwrap(),
        vec![("hot".into(), 3000.5), ("cold".into(), 1000.25)]
    );
    let first = scan_selected_snapshot(
        &path,
        "opencode",
        true,
        &pricing,
        &HashSet::from(["hot".into()]),
        None,
    )
    .unwrap();
    assert_eq!(first.sessions.len(), 2);
    assert_eq!(first.decoded.len(), 2);
    assert!(
        scan_selected_snapshot(
            &path,
            "opencode",
            true,
            &pricing,
            &HashSet::from(["cold".into()]),
            Some(&first)
        )
        .is_err()
    );
    assert_eq!(first.sessions.len(), 2);
    db.execute(
        "UPDATE session_message SET data=?1,type='user' WHERE session_id='cold'",
        [json!({"text":"History"}).to_string()],
    )
    .unwrap();
    let complete = scan_selected_snapshot(
        &path,
        "opencode",
        true,
        &pricing,
        &HashSet::from(["cold".into()]),
        Some(&first),
    )
    .unwrap();
    assert_eq!(complete.sessions.len(), 3);
    assert_eq!(complete.upserts.len(), 1);
    assert_eq!(complete.decoded, [reference("opencode", "cold".into())]);
    let refresh = refresh_database(&path, "opencode", true, &pricing, Some(&complete)).unwrap();
    assert!(refresh.decoded.is_empty());
    assert!(refresh.upserts.is_empty());
    db.execute_batch("DELETE FROM session_message WHERE session_id IN ('hot','child');DELETE FROM session_v2 WHERE id IN ('hot','child')").unwrap();
    let removed = scan_selected_snapshot(
        &path,
        "opencode",
        true,
        &pricing,
        &HashSet::from(["hot".into()]),
        Some(&complete),
    )
    .unwrap();
    assert_eq!(removed.removed.len(), 2);
    assert_eq!(removed.sessions.len(), 1);
    assert_eq!(removed.sessions[0].head.reference.session_id, "cold");
}

#[test]
fn v1_pages_only_selected_message_parts_and_related_usage() {
    let (temp, db) = database(false);
    db.execute_batch("INSERT INTO session(id,parent_id,title,time_created,time_updated,directory) VALUES('hot',NULL,'Hot',1000,3000,'/project'),('child','hot','Child',1000,2000,'/project'),('cold',NULL,'Cold',1000,1000,'/project');INSERT INTO message VALUES('hot-message','hot','{\"role\":\"assistant\",\"cost\":1}',1000),('child-message','child','{\"role\":\"assistant\",\"cost\":2}',1000),('cold-message','cold','invalid JSON',1000);INSERT INTO part VALUES('hot-part','hot-message','{\"type\":\"text\",\"text\":\"Visible\"}',1000),('cold-part','cold-message','invalid JSON',1000)").unwrap();
    let path = temp.path().join("opencode.db");
    assert_eq!(
        enumerate_session_keys(&path, "opencode", false)
            .unwrap()
            .len(),
        2
    );
    let result = scan_selected_snapshot(
        &path,
        "opencode",
        false,
        &Pricing::bundled(),
        &HashSet::from(["hot".into()]),
        None,
    )
    .unwrap();
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].head.stats.total_cost, 1.0);
    assert_eq!(result.sessions[0].detail.head.stats.total_cost, 3.0);
    assert_eq!(result.decoded.len(), 2);
}

#[test]
fn refreshes_eligible_roots_without_touching_pending_cold_history() {
    let (temp, db) = database(true);
    db.execute_batch("INSERT INTO session_v2(id,time_updated)VALUES('hot',3000),('cold',1000)")
        .unwrap();
    message(
        &db,
        "hot-message",
        "hot",
        "user",
        1,
        json!({"text":"Recent"}),
    );
    message(
        &db,
        "cold-message",
        "cold",
        "assistant",
        1,
        json!({"content":"malformed"}),
    );
    let path = temp.path().join("opencode.db");
    let pricing = Pricing::bundled();
    let initial = scan_selected_snapshot(
        &path,
        "opencode",
        true,
        &pricing,
        &HashSet::from(["hot".into()]),
        None,
    )
    .unwrap();
    db.execute(
        "UPDATE session_message SET data=?1 WHERE session_id='hot'",
        [json!({"text":"Changed"}).to_string()],
    )
    .unwrap();
    db.execute_batch("INSERT INTO session_v2(id,time_updated)VALUES('new',4000)")
        .unwrap();
    message(
        &db,
        "new-message",
        "new",
        "user",
        1,
        json!({"text":"New session"}),
    );
    let eligible = HashSet::from(["hot".into(), "new".into()]);
    let changed =
        refresh_selected_database(&path, "opencode", true, &pricing, &eligible, Some(&initial))
            .unwrap();
    assert_eq!(changed.sessions.len(), 2);
    assert_eq!(changed.upserts.len(), 2);
    assert_eq!(changed.decoded.len(), 2);
    assert!(
        changed
            .sessions
            .iter()
            .all(|session| session.head.reference.session_id != "cold")
    );
    let unchanged =
        refresh_selected_database(&path, "opencode", true, &pricing, &eligible, Some(&changed))
            .unwrap();
    assert!(unchanged.decoded.is_empty());
    assert!(unchanged.upserts.is_empty());
    db.execute_batch(
        "DELETE FROM session_v2 WHERE id='hot';DELETE FROM session_message WHERE session_id='hot'",
    )
    .unwrap();
    let removed = refresh_selected_database(
        &path,
        "opencode",
        true,
        &pricing,
        &eligible,
        Some(&unchanged),
    )
    .unwrap();
    assert_eq!(removed.removed, [reference("opencode", "hot".into())]);
    assert_eq!(removed.sessions.len(), 1);
    assert_eq!(removed.sessions[0].head.reference.session_id, "new");
}
