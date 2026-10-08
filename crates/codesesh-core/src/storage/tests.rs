use super::*;
use crate::contract::MessagePart;
use std::collections::HashMap;

pub(super) fn source(root: &Path, id: &str) -> ParsedSession {
    let path = root.join(format!("rollout-{id}.jsonl"));
    std::fs::write(&path, concat!(
            "{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
            "{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Fixture 中文 🔎\"}]}}\n"
        )).unwrap();
    let detail =
        crate::agents::codex::parse(&path, &HashMap::new(), &crate::pricing::Pricing::bundled())
            .unwrap()
            .unwrap();
    ParsedSession {
        source: path,
        head: detail.head.clone(),
        detail,
    }
}

#[test]
fn source_nodes_isolate_content_search_and_updates() {
    let root = tempfile::tempdir().unwrap();
    let mut local = source(root.path(), "shared");
    let mut remote = local.clone();
    remote.head.reference.source_node_id = "worker-a".into();
    remote.detail.head.reference = remote.head.reference.clone();
    remote.head.title = "Remote title".into();
    remote.detail.head.title = remote.head.title.clone();
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut local)).unwrap();
    cache.publish(std::slice::from_mut(&mut remote)).unwrap();
    let snapshot = cache.snapshot().unwrap();
    assert_eq!(snapshot.len(), 2);
    assert_eq!(cache.agent_snapshot("codex").unwrap().len(), 1);
    assert_eq!(cache.json_baseline().unwrap().heads.len(), 1);
    assert_eq!(cache.messages(&local.head.reference).unwrap(), 1);
    assert_eq!(cache.messages(&remote.head.reference).unwrap(), 1);
    let results =
        crate::search::search_sessions(cache.connection(), "Fixture", &Default::default()).unwrap();
    assert_eq!(results.len(), 2);
    assert_ne!(results[0].reference, results[1].reference);
    remote.head.title = "Updated remote".into();
    remote.detail.head.title = remote.head.title.clone();
    cache.publish(std::slice::from_mut(&mut remote)).unwrap();
    let updated = cache
        .refresh_snapshot(&snapshot, &[remote.head.reference.clone()])
        .unwrap();
    assert_eq!(updated.len(), 2);
    assert_eq!(
        cache.head(&local.head.reference).unwrap().unwrap().title,
        local.head.title
    );
    assert_eq!(
        cache.head(&remote.head.reference).unwrap().unwrap().title,
        "Updated remote"
    );
    let facts = crate::analytics::load_cost_facts(cache.connection(), None, None, true).unwrap();
    assert_eq!(facts.sessions.len(), 2);
    cache.remove(&[remote.head.reference.clone()]).unwrap();
    assert_eq!(cache.snapshot().unwrap().len(), 1);
    assert!(cache.head(&local.head.reference).unwrap().is_some());
}

#[test]
fn schema36_text_parts_are_compressed_in_place() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "large");
    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: "compressible needle ".repeat(500),
        time_created: None,
    }];
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let db = cache.connection();
    let encoding = |db: &Connection| -> String {
        db.query_row("SELECT typeof(parts_json) FROM messages", [], |row| {
            row.get(0)
        })
        .unwrap()
    };
    assert_eq!(encoding(db), "blob");
    let parts: String = db
        .query_row("SELECT parts_json FROM messages", [], |row| {
            Ok(body::unpack(row.get_ref(0)?)?.into_owned())
        })
        .unwrap();
    db.execute("UPDATE messages SET parts_json=?", [parts])
        .unwrap();
    db.execute_batch(
        "PRAGMA user_version=36; DELETE FROM cache_meta WHERE key='message_parts_zstd_v1';",
    )
    .unwrap();
    assert_eq!(encoding(db), "text");
    let detail = serde_json::to_value(cache.detail(session.head.clone()).unwrap()).unwrap();
    schema::ensure(db, None).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        CACHE_SCHEMA_VERSION
    );
    assert_eq!(encoding(db), "blob");
    assert_eq!(
        serde_json::to_value(cache.detail(session.head.clone()).unwrap()).unwrap(),
        detail
    );
}

type UsageBucketRow = (i64, String, String, i64, i64, f64);

fn usage_buckets(db: &Connection) -> Vec<UsageBucketRow> {
    db.prepare("SELECT bucket_start,model,cost_source,message_count,input_tokens,cost FROM session_usage_bucket ORDER BY bucket_start,model,cost_source")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

fn bucketed_session(root: &Path) -> ParsedSession {
    let mut session = source(root, "buckets");
    let message = |fields: serde_json::Value| {
        let mut message = serde_json::json!({"role":"assistant","agent":null,"time_completed":null,"mode":null,"provider":null,"parts":[]});
        message
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        serde_json::from_value(message).unwrap()
    };
    let start = BUCKET_START;
    session.detail.messages = vec![
        message(
            serde_json::json!({"id":"first","time_created":start,"model":"m1","cost_source":"recorded","tokens":{"input":10,"output":2},"cost":1.0}),
        ),
        message(
            serde_json::json!({"id":"negative","time_created":start + 899_999,"model":"m1","cost_source":"recorded","tokens":{"input":-5,"output":2},"cost":-1.0}),
        ),
        message(
            serde_json::json!({"id":"other-model","time_created":start + 10,"model":"m2","cost_source":"estimated","tokens":{"input":3,"output":2},"cost":0.25}),
        ),
        message(
            serde_json::json!({"id":"unpriced","time_created":start + 20,"model":null,"tokens":{"input":4,"output":2},"cost":0.0}),
        ),
        message(
            serde_json::json!({"id":"next","time_created":start + 900_000,"model":"m1","cost_source":"recorded","tokens":{"input":7,"output":2},"cost":0.5}),
        ),
        message(
            serde_json::json!({"id":"untimed","time_created":0,"model":"m1","tokens":{"input":100,"output":2},"cost":9.0}),
        ),
    ];
    session
}

const BUCKET_START: i64 = 1_790_326_800_000;

#[test]
fn usage_buckets_follow_rewrites_and_removal() {
    let root = tempfile::tempdir().unwrap();
    let mut session = bucketed_session(root.path());
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let next = BUCKET_START + 900_000;
    assert_eq!(
        usage_buckets(cache.connection()),
        vec![
            (BUCKET_START, "".into(), "".into(), 1, 4, 0.0),
            (BUCKET_START, "m1".into(), "recorded".into(), 2, 10, 1.0),
            (BUCKET_START, "m2".into(), "estimated".into(), 1, 3, 0.25),
            (next, "m1".into(), "recorded".into(), 1, 7, 0.5),
        ]
    );
    session.detail.messages.truncate(1);
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    assert_eq!(
        usage_buckets(cache.connection()),
        vec![(BUCKET_START, "m1".into(), "recorded".into(), 1, 10, 1.0)]
    );
    cache.remove(&[session.head.reference.clone()]).unwrap();
    assert!(usage_buckets(cache.connection()).is_empty());
}

#[test]
fn schema37_builds_usage_buckets_in_place() {
    let root = tempfile::tempdir().unwrap();
    let mut session = bucketed_session(root.path());
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let db = cache.connection();
    let expected = usage_buckets(db);
    db.execute_batch(
        "DROP TABLE session_usage_bucket; DELETE FROM cache_meta WHERE key='usage_buckets_v1';
        ALTER TABLE session_cost_summary ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=37;",
    )
    .unwrap();
    for _ in 0..2 {
        schema::ensure(db, None).unwrap();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            CACHE_SCHEMA_VERSION
        );
        assert_eq!(usage_buckets(db), expected);
        assert!(
            db.prepare("SELECT revision FROM session_cost_summary")
                .is_err()
        );
    }
}

#[test]
fn schema36_read_index_patch_preserves_rows_and_uses_covering_plans() {
    let root = tempfile::tempdir().unwrap();
    let mut local = source(root.path(), "shared");
    let mut remote = local.clone();
    remote.head.reference.source_node_id = "worker-a".into();
    remote.detail.head.reference = remote.head.reference.clone();
    remote.head.version = Some("version".into());
    remote.head.summary_files = Some(serde_json::json!(["/fixture/file.rs"]));
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut local)).unwrap();
    cache.publish(std::slice::from_mut(&mut remote)).unwrap();
    let db = cache.connection();
    db.execute_batch("DELETE FROM cache_meta WHERE key IN ('covering_read_indexes_v1','usage_time_index_retired_v1','visible_sessions_index_v1');
        DROP INDEX idx_sessions_heads;
        DROP INDEX idx_sessions_visible;
        CREATE INDEX idx_messages_usage_time ON messages(
            CASE WHEN time_completed > 0 THEN time_completed WHEN time_created > 0 THEN time_created END,
            agent_name,session_id,message_index,model,tokens_json,cost,cost_source);
        DROP INDEX idx_messages_user_activity;
        CREATE INDEX idx_messages_user_activity ON messages(time_created,agent_name,session_id)
            WHERE role='user' AND automated=0 AND time_created>0;").unwrap();
    let heads = serde_json::to_value(cache.snapshot().unwrap()).unwrap();
    let facts =
        serde_json::to_value(crate::analytics::load_cost_facts(db, None, None, true).unwrap())
            .unwrap();
    for _ in 0..2 {
        schema::ensure(db, None).unwrap();
        assert_eq!(
            serde_json::to_value(cache.snapshot().unwrap()).unwrap(),
            heads
        );
        assert_eq!(
            serde_json::to_value(crate::analytics::load_cost_facts(db, None, None, true).unwrap())
                .unwrap(),
            facts
        );
        assert!(
            db.prepare("SELECT 1 FROM messages INDEXED BY idx_messages_usage_time")
                .is_err()
        );
        for (sql, index) in [
            (format!("SELECT {} FROM sessions WHERE publication_id IS NULL ORDER BY activity_time DESC,agent_name,session_id", snapshot::HEAD_COLUMNS), "idx_sessions_heads"),
            ("SELECT c.message_cost FROM session_cost_summary c JOIN sessions s ON s.source_node_id=c.source_node_id AND s.agent_name=c.agent_name AND s.session_id=c.session_id AND s.publication_id IS NULL".into(), "idx_sessions_visible"),
            ("SELECT source_node_id,agent_name,session_id,time_created FROM messages INDEXED BY idx_messages_user_activity WHERE role='user' AND automated=0 AND time_created>0".into(), "idx_messages_user_activity"),
        ] {
            let plan: Vec<String> = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap()
                .query_map([], |row| row.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
            assert!(plan.iter().any(|line| line.contains(&format!("COVERING INDEX {index}"))), "{plan:?}");
        }
    }
}

#[test]
fn schema35_history_migrates_to_local_without_losing_messages() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cache.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixtures/schema-35.sql"))
        .unwrap();
    db.execute_batch("PRAGMA user_version=35;
        INSERT INTO cache_meta VALUES('version','35');
        INSERT INTO sessions(agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost)
        VALUES('codex','old','Old history','/project','path','/project','project',100,100,1,0,0,0);
        INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text)
        VALUES('codex','old',0,'message','user',100,'[]','Archived body');
        UPDATE sessions SET head_meta_json='{\"rustHeadVersion\":\"preserved\"}';
        INSERT INTO session_documents(agent_name,session_id,title,content_text,content_hash,indexed_message_count,indexed_at)
        VALUES('codex','old','Old history','Archived body','old',1,100);").unwrap();
    drop(db);
    for _ in 0..2 {
        let cache = Cache::open(Some(&path)).unwrap();
        let head = cache.snapshot().unwrap().pop().unwrap();
        assert_eq!(head.reference.source_node_id, "local");
        assert_eq!(head.reference.session_id, "old");
        assert_eq!(head.version.as_deref(), Some("preserved"));
        assert_eq!(cache.messages(&head.reference).unwrap(), 1);
        assert_eq!(
            crate::search::search_sessions(cache.connection(), "Archived", &Default::default())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            cache
                .connection
                .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );
    }
}

#[test]
fn publication_rolls_back_without_exposing_cursors() {
    let root = tempfile::tempdir().unwrap();
    let mut sessions = vec![source(root.path(), "first"), source(root.path(), "second")];
    let mut cache = Cache::open(None).unwrap();
    cache.connection.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON messages WHEN NEW.session_id = 'rollout-second' BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;").unwrap();
    assert!(cache.publish(&mut sessions).is_err());
    assert_eq!(
        cache.messages(&sessions[0].detail.head.reference).unwrap(),
        0
    );
    assert!(
        sessions
            .iter()
            .all(|session| session.detail.message_cursor.is_none())
    );
    cache
        .connection
        .execute_batch("DROP TRIGGER reject_second")
        .unwrap();
    cache.publish(&mut sessions).unwrap();
    assert_eq!(
        cache.messages(&sessions[0].detail.head.reference).unwrap(),
        1
    );
    assert!(
        sessions
            .iter()
            .all(|session| session.detail.message_cursor.is_some())
    );
}

#[test]
fn schema_and_materialized_messages_survive_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cache.db");
    let mut sessions = vec![source(root.path(), "persisted")];
    let mut cache = Cache::open(Some(&path)).unwrap();
    cache.publish(&mut sessions).unwrap();
    drop(cache);
    let cache = Cache::open(Some(&path)).unwrap();
    assert_eq!(
        cache.messages(&sessions[0].detail.head.reference).unwrap(),
        1
    );
    let count: i64 = cache
        .connection
        .query_row(
            "SELECT count(*) FROM message_fts WHERE message_fts MATCH 'Fixture'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        cache
            .connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        CACHE_SCHEMA_VERSION
    );
    cache.connection.execute("INSERT INTO session_file_activity VALUES('local','codex','rollout-persisted','/fixture','/fixture/中文.txt','read',1,1)",[]).unwrap();
    let count: i64 = cache.connection.query_row("SELECT count(*) FROM session_file_activity_path_fts WHERE session_file_activity_path_fts MATCH 'fixture'",[],|row|row.get(0)).unwrap();
    assert_eq!(count, 1);
}
#[test]
fn deletion_rolls_back_when_a_later_write_fails() {
    let root = tempfile::tempdir().unwrap();
    let mut existing = vec![source(root.path(), "existing")];
    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut existing).unwrap();
    let removed = existing[0].head.reference.clone();
    cache.connection.execute_batch("CREATE TRIGGER reject_write BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'failure'); END;").unwrap();
    let mut incoming = vec![source(root.path(), "incoming")];
    assert!(
        cache
            .apply(&mut incoming, std::slice::from_ref(&removed))
            .is_err()
    );
    assert_eq!(cache.snapshot().unwrap()[0].reference, removed);
    assert_eq!(cache.messages(&removed).unwrap(), 1);
    cache
        .connection
        .execute_batch("DROP TRIGGER reject_write")
        .unwrap();
    cache
        .apply(&mut incoming, std::slice::from_ref(&removed))
        .unwrap();
    assert_eq!(cache.messages(&removed).unwrap(), 0);
    assert_eq!(cache.snapshot().unwrap().len(), 1);
    let rollup: i64 = cache
        .connection
        .query_row(
            "SELECT message_count FROM session_cost_summary",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(rollup, 1);
    assert_eq!(
        cache
            .connection
            .query_row(
                "SELECT COUNT(*) FROM message_fts WHERE message_fts MATCH 'Fixture'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}
#[test]
fn cursor_reads_only_matching_suffix_and_resets_after_rewrite() {
    let root = tempfile::tempdir().unwrap();
    let mut sessions = vec![source(root.path(), "cursor")];
    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut sessions).unwrap();
    let head = sessions[0].head.clone();
    let previous = sessions[0].detail.message_cursor.clone().unwrap();
    let unchanged = detail_with_cursor(cache.connection(), head.clone(), Some(&previous))
        .unwrap()
        .unwrap();
    assert!(unchanged.messages.is_empty());
    assert_eq!(unchanged.message_update.as_deref(), Some("append"));
    let zero = cursor::encode(0, &cursor::initial(&head.reference)).unwrap();
    assert_eq!(
        detail_with_cursor(cache.connection(), head.clone(), Some(&zero))
            .unwrap()
            .unwrap()
            .messages
            .len(),
        1
    );
    sessions[0].detail.messages[0].id = "rewritten".into();
    cache.publish(&mut sessions).unwrap();
    let rewritten = detail_with_cursor(cache.connection(), head, Some(&previous))
        .unwrap()
        .unwrap();
    assert_eq!(rewritten.message_update.as_deref(), Some("reset"));
    assert_eq!(rewritten.messages[0].id, "rewritten");
}

#[test]
fn checkpoint_and_initialization_publish_with_session_commit() {
    let root = tempfile::tempdir().unwrap();
    let mut sessions = vec![source(root.path(), "checkpoint")];
    let mut cache = Cache::open(None).unwrap();
    let checkpoint = Some(serde_json::json!({"offset":1}));
    cache
        .apply_checkpoint(&mut sessions, &[], "codex", &checkpoint, false)
        .unwrap();
    assert_eq!(
        cache
            .connection
            .query_row(
                "SELECT value FROM cache_meta WHERE key='rust_sync_checkpoint:codex'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "{\"offset\":1}"
    );
    sessions[0].detail.messages[0].id = "rewritten".into();
    cache.connection.execute_batch("CREATE TRIGGER reject_write BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'failure'); END;").unwrap();
    assert!(
        cache
            .apply_checkpoint(&mut sessions, &[], "codex", &None, true)
            .is_err()
    );
    assert_eq!(
        cache
            .connection
            .query_row("SELECT count(*) FROM cache_initialization", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    cache
        .connection
        .execute_batch("DROP TRIGGER reject_write")
        .unwrap();
    cache
        .apply_checkpoint(&mut sessions, &[], "codex", &None, true)
        .unwrap();
    assert_eq!(
        cache
            .connection
            .query_row("SELECT count(*) FROM cache_initialization", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        1
    );
    assert_eq!(
        cache
            .connection
            .query_row(
                "SELECT count(*) FROM cache_meta WHERE key='rust_sync_checkpoint:codex'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
#[test]
fn fractional_source_times_survive_sqlite_and_message_cursor() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("fractional.db");
    let mut sessions = vec![source(root.path(), "fractional")];
    let session = &mut sessions[0];
    session.head.time_created = 1_790_326_527_892.125;
    session.head.time_updated = 1_790_326_527_892.875;
    session.head.smart_tags_source_updated_at = Some(session.head.time_updated);
    session.detail.head = session.head.clone();
    session.detail.messages[0].time_created = session.head.time_created;
    session.detail.messages[0].time_completed = Some(session.head.time_updated);
    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: "fractional".into(),
        time_created: Some(session.head.time_created),
    }];
    let expected = session.head.clone();
    let mut cache = Cache::open(Some(&path)).unwrap();
    cache.publish(&mut sessions).unwrap();
    let expected_cursor = sessions[0].detail.message_cursor.clone();
    drop(cache);
    let cache = Cache::open_read_only(&path).unwrap();
    let head = cache.head(&expected.reference).unwrap().unwrap();
    assert_eq!(head, expected);
    let detail = cache.detail(head).unwrap().unwrap();
    assert_eq!(detail.message_cursor, expected_cursor);
    assert_eq!(
        detail.messages[0].time_completed,
        Some(expected.time_updated)
    );
    assert_eq!(
        detail.messages[0].parts,
        sessions[0].detail.messages[0].parts
    );
    assert_eq!(
        cache
            .connection
            .query_row("SELECT typeof(time_created) FROM sessions", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "real"
    );
}

#[test]
fn detail_visitor_streams_messages_and_stops_before_reading_the_next_row() {
    let root = tempfile::tempdir().unwrap();
    let mut sessions = vec![source(root.path(), "stream")];
    let mut second = sessions[0].detail.messages[0].clone();
    second.id = "second".into();
    sessions[0].detail.messages.push(second);
    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut sessions).unwrap();
    let head = sessions[0].head.clone();
    let expected = detail_from_connection(cache.connection(), head.clone())
        .unwrap()
        .unwrap();
    let mut received = Vec::new();
    let mut streamed = visit_detail_messages(cache.connection(), head.clone(), None, |message| {
        received.push(message);
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert!(streamed.messages.is_empty());
    streamed.messages = received;
    assert_eq!(
        serde_json::to_value(streamed).unwrap(),
        serde_json::to_value(&expected).unwrap()
    );
    let unchanged = visit_detail_messages(
        cache.connection(),
        head.clone(),
        expected.message_cursor.as_deref(),
        |_| anyhow::bail!("unchanged cursor emitted a row"),
    )
    .unwrap()
    .unwrap();
    assert_eq!(unchanged.message_update.as_deref(), Some("append"));
    cache
        .connection
        .execute(
            "UPDATE messages SET parts_json='invalid JSON' WHERE message_index=1",
            [],
        )
        .unwrap();
    let result = visit_detail_messages(cache.connection(), head, None, |_| {
        anyhow::bail!("consumer disconnected")
    });
    assert_eq!(result.err().unwrap().to_string(), "consumer disconnected");
}

#[test]
fn json_index_rejects_a_stale_baseline_without_publishing_rows_or_markers() {
    let root = tempfile::tempdir().unwrap();
    let mut cache = Cache::open(None).unwrap();
    let baseline = cache.json_baseline().unwrap();
    let mut first = vec![source(root.path(), "current")];
    cache.publish(&mut first).unwrap();
    let mut stale = vec![source(root.path(), "stale")];
    assert!(
        !cache
            .apply_json_index(
                &mut stale,
                &[],
                &[("codex".into(), "stale-inventory".into())],
                &baseline.revision
            )
            .unwrap()
    );
    let after = cache.json_baseline().unwrap();
    assert_eq!(after.heads.len(), 1);
    assert_eq!(after.heads[0].reference, first[0].head.reference);
    assert!(after.fingerprints.is_empty());
    assert!(stale[0].detail.message_cursor.is_none());
}

#[test]
fn refreshed_snapshot_matches_durable_order_updates_and_removals() {
    let root = tempfile::tempdir().unwrap();
    let mut sessions = vec![
        source(root.path(), "b"),
        source(root.path(), "a"),
        source(root.path(), "c"),
    ];
    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut sessions).unwrap();
    let previous = cache.snapshot().unwrap();
    let removed = sessions[1].head.reference.clone();
    sessions[0].head.title = "Changed".into();
    sessions[0].head.time_updated += 1000.0;
    let changed = sessions[0].head.reference.clone();
    cache.apply(&mut sessions[..1], &[removed]).unwrap();
    let refreshed = cache.refresh_snapshot(&previous, &[changed]).unwrap();
    assert_eq!(
        serde_json::to_value(&refreshed).unwrap(),
        serde_json::to_value(cache.snapshot().unwrap()).unwrap()
    );
    assert_eq!(refreshed[0].title, "Changed");
    cache
        .apply(
            &mut [],
            &refreshed
                .iter()
                .map(|head| head.reference.clone())
                .collect::<Vec<_>>(),
        )
        .unwrap();
    assert!(cache.refresh_snapshot(&refreshed, &[]).unwrap().is_empty());
}

#[test]
fn refreshed_snapshot_observes_other_connections() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cache.db");
    let mut sessions = vec![source(root.path(), "external")];
    let mut cache = Cache::open(Some(&path)).unwrap();
    cache.publish(&mut sessions).unwrap();
    let previous = cache.snapshot().unwrap();
    let other = Connection::open(&path).unwrap();
    other
        .execute("UPDATE sessions SET title='External change'", [])
        .unwrap();
    let refreshed = cache.refresh_snapshot(&previous, &[]).unwrap();
    assert_eq!(refreshed[0].title, "External change");
    assert_eq!(
        serde_json::to_value(refreshed).unwrap(),
        serde_json::to_value(cache.snapshot().unwrap()).unwrap()
    );
}

#[test]
fn snapshot_preserves_head_metadata_without_pricing_details() {
    let root = tempfile::tempdir().unwrap();
    let mut sessions = vec![source(root.path(), "metadata")];
    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut sessions).unwrap();
    cache
        .connection
        .execute("UPDATE sessions SET meta_json='invalid pricing JSON'", [])
        .unwrap();
    for summary in [
        None,
        Some(serde_json::Value::Null),
        Some(serde_json::json!([{"path": "src/main.rs"}])),
    ] {
        let mut metadata = serde_json::json!({
            "rustHeadVersion": "fixture-version",
            "rustPricing": {"messages": [{"nested": [true, null, {"cost": 0.5}]}]},
        });
        if let Some(summary) = &summary {
            metadata["rustHeadSummaryFiles"] = summary.clone();
        }
        cache
            .connection
            .execute(
                "UPDATE sessions SET head_meta_json=?",
                [metadata.to_string()],
            )
            .unwrap();
        let heads = cache.snapshot().unwrap();
        assert_eq!(heads[0].version.as_deref(), Some("fixture-version"));
        assert_eq!(heads[0].summary_files, summary);
        let head = cache.head(&heads[0].reference).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(head).unwrap(),
            serde_json::to_value(&heads[0]).unwrap()
        );
    }
    for metadata in [
        None,
        Some("null"),
        Some("{}"),
        Some(r#"{"rustHeadVersion":42}"#),
    ] {
        cache
            .connection
            .execute("UPDATE sessions SET head_meta_json=?", [metadata])
            .unwrap();
        let heads = cache.snapshot().unwrap();
        assert_eq!(heads[0].version, None);
        assert_eq!(heads[0].summary_files, None);
    }
    cache
        .connection
        .execute(
            "UPDATE sessions SET head_meta_json=?",
            [r#"{"rustPricing":[invalid]}"#],
        )
        .unwrap();
    assert!(cache.snapshot().is_err());
}

#[test]
fn schema34_migration_preserves_heads_content_and_indexes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cache.db");
    let mut cache = Cache::open(Some(&path)).unwrap();
    let mut sessions = vec![
        source(root.path(), "absent"),
        source(root.path(), "null"),
        source(root.path(), "files"),
    ];
    sessions[1].head.version = Some("fixture-version".into());
    sessions[1].head.summary_files = Some(serde_json::Value::Null);
    sessions[2].head.summary_files = Some(serde_json::json!([{"path":"src/main.rs"}]));
    cache.publish(&mut sessions).unwrap();
    let expected = serde_json::to_value(cache.snapshot().unwrap()).unwrap();
    let objects = |db: &rusqlite::Connection| {
        db.prepare("SELECT name,0 FROM sqlite_master WHERE rootpage>0 ORDER BY name")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    let original_objects = objects(&cache.connection);
    let content: String = cache
        .connection
        .query_row(
            "SELECT group_concat(content_text) FROM messages",
            [],
            |row| row.get(0),
        )
        .unwrap();
    for session in &sessions {
        let reference = &session.head.reference;
        let metadata: String = cache
            .connection
            .query_row(
                "SELECT meta_json FROM sessions WHERE agent_name=? AND session_id=?",
                params![reference.agent_name, reference.session_id],
                |row| row.get(0),
            )
            .unwrap();
        let mut metadata: serde_json::Value = serde_json::from_str(&metadata).unwrap();
        if let Some(version) = &session.head.version {
            metadata["rustHeadVersion"] = version.clone().into();
        }
        if let Some(summary) = &session.head.summary_files {
            metadata["rustHeadSummaryFiles"] = summary.clone();
        }
        cache
            .connection
            .execute(
                "UPDATE sessions SET meta_json=? WHERE agent_name=? AND session_id=?",
                params![
                    metadata.to_string(),
                    reference.agent_name,
                    reference.session_id
                ],
            )
            .unwrap();
    }
    cache.connection.execute_batch("DROP INDEX idx_sessions_heads; ALTER TABLE sessions DROP COLUMN head_meta_json; PRAGMA user_version=34; UPDATE cache_meta SET value='34' WHERE key='version';").unwrap();
    drop(cache);
    for _ in 0..2 {
        let mut cache = Cache::open(Some(&path)).unwrap();
        assert_eq!(
            serde_json::to_value(cache.snapshot().unwrap()).unwrap(),
            expected
        );
        assert_eq!(objects(&cache.connection), original_objects);
        assert_eq!(
            cache
                .connection
                .query_row(
                    "SELECT group_concat(content_text) FROM messages",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            content
        );
        assert_eq!(
            cache
                .connection
                .query_row(
                    "SELECT count(*) FROM message_fts WHERE message_fts MATCH 'Fixture'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        assert_eq!(
            cache
                .connection
                .query_row(
                    "SELECT value FROM cache_meta WHERE key='version'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            CACHE_SCHEMA_VERSION.to_string()
        );
        let baseline = cache.json_baseline().unwrap();
        for head in baseline.heads {
            assert_eq!(
                serde_json::to_value(&head).unwrap(),
                serde_json::to_value(cache.head(&head.reference).unwrap().unwrap()).unwrap()
            );
        }
    }
    assert!(std::fs::read_dir(root.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("cache-migration")
    }));
}

#[test]
fn schema34_failed_backfill_rolls_back_column_and_versions() {
    let root = tempfile::tempdir().unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache
        .publish(&mut [source(root.path(), "valid"), source(root.path(), "invalid")])
        .unwrap();
    cache.connection.execute_batch("DROP INDEX idx_sessions_heads; ALTER TABLE sessions DROP COLUMN head_meta_json; PRAGMA user_version=34; UPDATE cache_meta SET value='34' WHERE key='version'; UPDATE sessions SET meta_json='invalid' WHERE rowid=2;").unwrap();
    assert!(super::schema::ensure(&cache.connection, None).is_err());
    assert_eq!(
        cache
            .connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        34
    );
    assert_eq!(
        cache
            .connection
            .query_row(
                "SELECT value FROM cache_meta WHERE key='version'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "34"
    );
    assert_eq!(
        cache
            .connection
            .query_row(
                "SELECT count(*) FROM pragma_table_info('sessions') WHERE name='head_meta_json'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        cache
            .connection
            .query_row("SELECT meta_json FROM sessions WHERE rowid=2", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap(),
        "invalid"
    );
    cache
        .connection
        .execute("UPDATE sessions SET meta_json='{}' WHERE rowid=2", [])
        .unwrap();
    super::schema::ensure(&cache.connection, None).unwrap();
    assert_eq!(cache.snapshot().unwrap().len(), 2);
}

#[test]
fn schema_backup_reports_real_page_progress_and_is_not_repeated() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixtures/schema-35.sql"))
        .unwrap();
    db.execute_batch("PRAGMA user_version=35; INSERT INTO cache_meta VALUES('version','35');")
        .unwrap();
    drop(db);
    let mut events = Vec::new();
    let cache = Cache::open_with_progress(Some(&path), |event| {
        events.push(event);
        Ok(())
    })
    .unwrap();
    assert!(events.iter().any(|event| {
        event.phase.starts_with("Backing up schema 35")
            && event
                .total
                .is_some_and(|total| total > 0 && event.done == total)
    }));
    drop(cache);
    let count = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|file| {
            file.file_name()
                .to_string_lossy()
                .contains("cache-migration")
        })
        .count();
    assert_eq!(count, 1);
    let mut events = Vec::new();
    Cache::open_with_progress(Some(&path), |event| {
        events.push(event);
        Ok(())
    })
    .unwrap();
    assert!(events.is_empty());
}

#[test]
fn cancelled_backup_preserves_original_and_is_not_a_completed_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixtures/schema-35.sql"))
        .unwrap();
    db.execute_batch("PRAGMA user_version=35; INSERT INTO cache_meta VALUES('version','35');")
        .unwrap();
    drop(db);
    let result = Cache::open_with_progress(Some(&path), |event| {
        anyhow::ensure!(event.total.is_none(), "cancelled after backup page copy");
        Ok(())
    });
    assert!(result.is_err());
    let db = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        35
    );
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains("cache-migration")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert!(backups[0].path().to_string_lossy().ends_with(".partial"));
}
