use super::*;
use crate::model::MessagePart;
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
    let snapshot: Vec<_> = cache
        .snapshot()
        .unwrap()
        .into_iter()
        .map(Arc::new)
        .collect();
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
        assert!(head.recorded_git_remotes.is_empty());
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
    let previous: Vec<_> = cache
        .snapshot()
        .unwrap()
        .into_iter()
        .map(Arc::new)
        .collect();
    let unchanged_ref = sessions[2].head.reference.clone();
    let unchanged_prev = previous
        .iter()
        .find(|head| head.reference == unchanged_ref)
        .unwrap()
        .clone();
    let removed = sessions[1].head.reference.clone();
    sessions[0].head.title = "Changed".into();
    sessions[0].head.time_updated += 1000.0;
    let changed = sessions[0].head.reference.clone();
    cache.apply(&mut sessions[..1], &[removed]).unwrap();
    let refreshed = cache.refresh_snapshot(&previous, &[changed]).unwrap();
    let refreshed_values: Vec<_> = refreshed.iter().map(|head| (**head).clone()).collect();
    assert_eq!(
        serde_json::to_value(&refreshed_values).unwrap(),
        serde_json::to_value(cache.snapshot().unwrap()).unwrap()
    );
    assert_eq!(refreshed[0].title, "Changed");
    let unchanged_after = refreshed
        .iter()
        .find(|head| head.reference == unchanged_ref)
        .unwrap();
    assert!(Arc::ptr_eq(&unchanged_prev, unchanged_after));
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
fn batched_refresh_snapshot_matches_full_snapshot_across_chunks_and_reuses_unchanged_arcs() {
    let root = tempfile::tempdir().unwrap();
    let template = source(root.path(), "batch");
    let total = 300usize;
    let mut sessions: Vec<_> = (0..total)
        .map(|index| {
            let mut session = template.clone();
            session.head.reference.session_id = format!("batch-{index:04}");
            session.detail.head.reference = session.head.reference.clone();
            session.head.title = format!("Initial {index}");
            session.detail.head.title = session.head.title.clone();
            session.head.time_created = 1_700_000_000_000.0 + (index as f64) * 1000.0;
            session.head.time_updated = session.head.time_created;
            session.detail.head.time_created = session.head.time_created;
            session.detail.head.time_updated = session.head.time_updated;
            session
        })
        .collect();
    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut sessions).unwrap();
    let previous: Vec<_> = cache
        .snapshot()
        .unwrap()
        .into_iter()
        .map(Arc::new)
        .collect();
    let previous_by_ref: HashMap<_, _> = previous
        .iter()
        .map(|head| (head.reference.clone(), head.clone()))
        .collect();

    // Update 270 sessions (> HEAD_BATCH_SIZE=250) and leave 30 untouched.
    let changed_count = 270usize;
    for session in &mut sessions[..changed_count] {
        session.head.title.push_str(" updated");
        session.detail.head.title = session.head.title.clone();
        session.head.time_updated += 500_000.0;
        session.detail.head.time_updated = session.head.time_updated;
    }
    let changed_refs: Vec<_> = sessions[..changed_count]
        .iter()
        .map(|session| session.head.reference.clone())
        .collect();
    cache.publish(&mut sessions[..changed_count]).unwrap();

    let refreshed = cache.refresh_snapshot(&previous, &changed_refs).unwrap();
    let durable = cache.snapshot().unwrap();
    let refreshed_values: Vec<_> = refreshed.iter().map(|head| (**head).clone()).collect();
    assert_eq!(
        serde_json::to_value(&refreshed_values).unwrap(),
        serde_json::to_value(&durable).unwrap()
    );
    let changed_set: std::collections::HashSet<_> = changed_refs.iter().collect();
    for head in &refreshed {
        let prev = &previous_by_ref[&head.reference];
        if changed_set.contains(&head.reference) {
            assert!(!Arc::ptr_eq(prev, head));
        } else {
            assert!(Arc::ptr_eq(prev, head));
        }
    }
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

#[test]
fn schema38_migrates_in_place_to_schema39_and_rebuilds_fts() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "v38");
    session.head.title = "Fix useAuth 数据库连接".into();
    session.detail.head.title = session.head.title.clone();
    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: "Investigate HTTPRequest and auth_token authentication".into(),
        time_created: None,
    }];
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let db = cache.connection();

    // Simulate a schema 38 database with legacy 1-column FTS tables, title triggers,
    // and the two redundant indexes retired in schema 39.
    db.execute_batch(
        "DROP TABLE message_fts;
         DROP TABLE session_title_fts;
         CREATE VIRTUAL TABLE message_fts USING fts5(content_text, content='', contentless_delete=1);
         CREATE VIRTUAL TABLE session_title_fts USING fts5(title, content='sessions', content_rowid='rowid');
         CREATE TRIGGER session_title_ai AFTER INSERT ON sessions BEGIN
           INSERT INTO session_title_fts(rowid, title) VALUES (new.rowid, new.title);
         END;
         CREATE TRIGGER session_title_ad AFTER DELETE ON sessions BEGIN
           INSERT INTO session_title_fts(session_title_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
         END;
         CREATE TRIGGER session_title_au AFTER UPDATE OF title ON sessions BEGIN
           INSERT INTO session_title_fts(session_title_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
           INSERT INTO session_title_fts(rowid, title) VALUES (new.rowid, new.title);
         END;
         CREATE INDEX idx_sessions_activity ON sessions(activity_time DESC, agent_name, session_id);
         CREATE INDEX idx_file_activity_project_latest ON session_file_activity(project_identity_key, latest_time);
         DELETE FROM cache_meta WHERE key IN ('message_fts_v2','message_fts_v2_cursor','redundant_indexes_retired_v1');
         INSERT OR REPLACE INTO cache_meta VALUES('message_fts_v1','1');
         PRAGMA user_version=38;
         UPDATE cache_meta SET value='38' WHERE key='version';",
    )
    .unwrap();

    for _ in 0..2 {
        schema::ensure(db, None).unwrap();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            CACHE_SCHEMA_VERSION
        );
        let redundant: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_sessions_activity','idx_file_activity_project_latest')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(redundant, 0);
        let old_triggers: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name IN ('session_title_ai','session_title_ad','session_title_au')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_triggers, 0);
        for query in ["auth", "request", "authenticat", "数据库"] {
            let results = crate::search::search_sessions(db, query, &Default::default()).unwrap();
            assert_eq!(results.len(), 1, "query={query}");
        }
    }
}

#[test]
fn single_upsert_persists_and_updates_all_session_columns() {
    let root = tempfile::tempdir().unwrap();
    let parent = source(root.path(), "parent");
    let mut child = source(root.path(), "child");
    child.head.parent_reference = Some(parent.head.reference.clone());
    child.head.stats.total_cache_read_tokens = Some(120.0);
    child.head.stats.total_cache_create_tokens = Some(45.0);
    child.head.stats.total_tokens = Some(500.0);
    child.head.stats.cost_source = Some(CostSource::Estimated);
    child.head.model_usage = Some(std::collections::BTreeMap::from([(
        "gpt-5.4".into(),
        120.0,
    )]));
    child.head.smart_tags = vec!["bugfix".into(), "testing".into()];
    child.head.version = Some("v1".into());
    child.head.summary_files = Some(serde_json::json!([{"path":"src/lib.rs"}]));
    child.head.recorded_git_remotes = vec!["https://github.com/example/repo.git".into()];
    child.detail.head = child.head.clone();

    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut [parent.clone(), child.clone()]).unwrap();
    let inserted = cache.head(&child.head.reference).unwrap().unwrap();
    assert_eq!(
        inserted.parent_reference,
        Some(parent.head.reference.clone())
    );
    assert_eq!(inserted.stats.total_cache_read_tokens, Some(120.0));
    assert_eq!(inserted.stats.total_cache_create_tokens, Some(45.0));
    assert_eq!(inserted.stats.total_tokens, Some(500.0));
    assert_eq!(inserted.stats.cost_source, Some(CostSource::Estimated));
    assert_eq!(inserted.model_usage, child.head.model_usage);
    assert_eq!(inserted.smart_tags, vec!["bugfix", "testing"]);
    assert_eq!(inserted.version.as_deref(), Some("v1"));
    assert_eq!(inserted.summary_files, child.head.summary_files);
    assert_eq!(
        inserted.recorded_git_remotes,
        vec!["https://github.com/example/repo.git"]
    );
    let meta_present: bool = cache
        .connection()
        .query_row(
            "SELECT meta_json IS NOT NULL AND head_meta_json IS NOT NULL FROM sessions WHERE session_id=?",
            [&child.head.reference.session_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(meta_present);

    // Trigger ON CONFLICT DO UPDATE (retaining existing messages path) and verify all columns update cleanly.
    child.head.title = "Updated child title".into();
    child.head.parent_reference = None;
    child.head.stats.total_cache_read_tokens = Some(240.0);
    child.head.stats.total_cache_create_tokens = None;
    child.head.stats.total_tokens = Some(900.0);
    child.head.stats.cost_source = Some(CostSource::Recorded);
    child.head.model_usage = Some(std::collections::BTreeMap::from([(
        "gpt-5.4".into(),
        360.0,
    )]));
    child.head.smart_tags = vec!["refactoring".into()];
    child.head.version = Some("v2".into());
    child.head.summary_files = None;
    child.head.recorded_git_remotes.clear();
    child.detail.head = child.head.clone();

    cache.publish(std::slice::from_mut(&mut child)).unwrap();
    let updated = cache.head(&child.head.reference).unwrap().unwrap();
    assert_eq!(updated.title, "Updated child title");
    assert_eq!(updated.parent_reference, None);
    assert_eq!(updated.stats.total_cache_read_tokens, Some(240.0));
    assert_eq!(updated.stats.total_cache_create_tokens, None);
    assert_eq!(updated.stats.total_tokens, Some(900.0));
    assert_eq!(updated.stats.cost_source, Some(CostSource::Recorded));
    assert_eq!(updated.model_usage, child.head.model_usage);
    assert_eq!(updated.smart_tags, vec!["refactoring"]);
    assert_eq!(updated.version.as_deref(), Some("v2"));
    assert_eq!(updated.summary_files, None);
    assert!(updated.recorded_git_remotes.is_empty());
}

#[test]
fn content_text_compresses_roundtrips_and_searches_with_fts_and_snippets() {
    assert_eq!(
        body::pack("").unwrap(),
        rusqlite::types::Value::Text(String::new())
    );
    assert!(matches!(
        body::pack("short").unwrap(),
        rusqlite::types::Value::Text(_)
    ));
    let compressible = "compressible needle 数据库连接 ".repeat(40);
    let packed = body::pack(&compressible).unwrap();
    let rusqlite::types::Value::Blob(bytes) = packed else {
        panic!("expected compressible text to pack as zstd blob");
    };
    assert_eq!(
        body::unpack(rusqlite::types::ValueRef::Blob(&bytes)).unwrap(),
        compressible
    );

    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "compressed-content");
    session.head.title = "Unrelated title".into();
    session.detail.head.title = session.head.title.clone();
    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: compressible.clone(),
        time_created: None,
    }];
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();

    let encoding: String = cache
        .connection()
        .query_row("SELECT typeof(content_text) FROM messages", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(encoding, "blob");

    for query in ["needle", "数据库连接"] {
        let hits =
            crate::search::search_sessions(cache.connection(), query, &Default::default()).unwrap();
        assert_eq!(hits.len(), 1, "query={query}");
        assert!(
            hits[0].snippet.contains(query),
            "snippet={}",
            hits[0].snippet
        );
    }

    // Rebuilding FTS must unpack compressed BLOB rows cleanly.
    cache.rebuild_search_indexes().unwrap();
    for query in ["needle", "数据库连接"] {
        let hits =
            crate::search::search_sessions(cache.connection(), query, &Default::default()).unwrap();
        assert_eq!(hits.len(), 1, "rebuilt query={query}");
        assert!(hits[0].snippet.contains(query));
    }

    // Exercise the `length(content_text)>0` fallback when an earlier message has empty text
    // and the next message is stored as a compressed BLOB.
    let db = cache.connection();
    db.execute(
        "INSERT INTO messages(source_node_id,agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text)
         VALUES('local','codex',?,1,'m-empty','user',100,'[]','')",
        [&session.head.reference.session_id],
    )
    .unwrap();
    let compressed_fallback = body::pack(&"fallback payload ".repeat(30)).unwrap();
    db.execute(
        "UPDATE messages SET message_index=2, content_text=? WHERE message_index=0",
        [&compressed_fallback],
    )
    .unwrap();
    db.execute(
        "UPDATE messages SET message_index=0 WHERE message_id='m-empty'",
        [],
    )
    .unwrap();
    // Point FTS hit for 'orphan' at rowid of m-empty (empty text) so resolve_message_match
    // falls back to the first non-empty message (message_index=2, compressed BLOB).
    let empty_rowid: i64 = db
        .query_row(
            "SELECT rowid FROM messages WHERE message_id='m-empty'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    db.execute(
        "INSERT INTO message_fts(rowid,content_text,code_tokens) VALUES(?,'orphan','')",
        [empty_rowid],
    )
    .unwrap();
    let fallback_hits = crate::search::search_sessions(db, "orphan", &Default::default()).unwrap();
    assert_eq!(fallback_hits.len(), 1);
    assert!(
        fallback_hits[0].snippet.contains("fallback payload"),
        "expected fallback to skip empty text and unpack compressed blob, got: {}",
        fallback_hits[0].snippet
    );
}

#[test]
fn existing_uncompressed_content_text_is_compressed_in_place() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "migrate-content");
    let long_text = "repeated searchable token 数据库 ".repeat(40);
    let mut short_msg = session.detail.messages[0].clone();
    short_msg.id = "short-msg".into();
    short_msg.parts = vec![MessagePart::Text {
        text: "hi".into(),
        time_created: None,
    }];
    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: long_text,
        time_created: None,
    }];
    session.detail.messages.push(short_msg);

    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let db = cache.connection();

    // Downgrade content_text back to uncompressed TEXT and clear completion marker.
    let unpacked: Vec<(i64, String)> = db
        .prepare("SELECT rowid, content_text FROM messages ORDER BY message_index")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, body::unpack(row.get_ref(1)?)?.into_owned()))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for (rowid, text) in &unpacked {
        db.execute(
            "UPDATE messages SET content_text=? WHERE rowid=?",
            params![text, rowid],
        )
        .unwrap();
    }
    db.execute_batch(
        "DELETE FROM cache_meta WHERE key IN ('content_text_zstd_v1','content_text_zstd_v1_cursor','search_text_v2');",
    )
    .unwrap();

    let types_before: Vec<String> = db
        .prepare("SELECT typeof(content_text) FROM messages ORDER BY message_index")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(types_before, vec!["text", "text"]);

    for _ in 0..2 {
        schema::ensure(db, None).unwrap();
        let types_after: Vec<String> = db
            .prepare("SELECT typeof(content_text) FROM messages ORDER BY message_index")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(types_after, vec!["blob", "text"]);
        let marker: String = db
            .query_row(
                "SELECT value FROM cache_meta WHERE key='content_text_zstd_v1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(marker, "1");
        let cursor_present: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM cache_meta WHERE key='content_text_zstd_v1_cursor'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cursor_present, 0);
        let hits = crate::search::search_sessions(db, "searchable", &Default::default()).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("searchable"));
    }
}

#[test]
fn schema39_upgrades_in_place_to_schema40_without_backup() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("cache.db");
    let pricing = crate::pricing::Pricing::bundled();
    let tokens = crate::model::MessageTokens {
        input: Some(1_000.0),
        output: Some(200.0),
        reasoning: None,
        cache_read: None,
        cache_create: None,
        cache_create_1h: None,
    };

    let mut unmatched = source(root.path(), "v39-unmatched");
    unmatched.detail.messages[0].parts = vec![MessagePart::Text {
        text: "v39 compressible body ".repeat(40),
        time_created: None,
    }];
    pricing.estimate_aggregate_tracked(
        Some("acme/v39-missing"),
        &tokens,
        0.0,
        &mut unmatched.head.stats.cost_inputs,
    );
    unmatched.head.stats.total_input_tokens = 1_000.0;
    unmatched.head.stats.total_output_tokens = 200.0;
    unmatched.detail.head = unmatched.head.clone();

    let mut priced = source(root.path(), "v39-priced");
    let cost = pricing
        .estimate_aggregate_tracked(
            Some("gpt-5.4"),
            &tokens,
            0.0,
            &mut priced.head.stats.cost_inputs,
        )
        .unwrap();
    priced.head.stats.total_cost = cost;
    priced.head.stats.cost_source = Some(CostSource::Estimated);
    priced.head.stats.total_input_tokens = 1_000.0;
    priced.head.stats.total_output_tokens = 200.0;
    priced.detail.head = priced.head.clone();

    // Message has an unmatched cost_input, while head has only priced inputs:
    // has_unmatched_pricing_meta must stay 0 because collect_meta_unmatched only reads head.inputs.
    let mut msg_only_unmatched = source(root.path(), "v39-msg-only");
    pricing.estimate_tracked(
        Some("acme/msg-only"),
        &tokens,
        0.0,
        &mut msg_only_unmatched.detail.messages[0].cost_inputs,
    );
    let head_cost = pricing
        .estimate_aggregate_tracked(
            Some("gpt-5.4"),
            &tokens,
            0.0,
            &mut msg_only_unmatched.head.stats.cost_inputs,
        )
        .unwrap();
    msg_only_unmatched.head.stats.total_cost = head_cost;
    msg_only_unmatched.head.stats.cost_source = Some(CostSource::Estimated);
    msg_only_unmatched.detail.head = msg_only_unmatched.head.clone();

    let mut cache = Cache::open(Some(&path)).unwrap();
    cache
        .publish(&mut [
            unmatched.clone(),
            priced.clone(),
            msg_only_unmatched.clone(),
        ])
        .unwrap();

    // Downgrade in-place to simulate an existing production schema-39 database.
    let db = cache.connection();
    let unpacked: Vec<(i64, String)> = db
        .prepare("SELECT rowid, content_text FROM messages")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, body::unpack(row.get_ref(1)?)?.into_owned()))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for (rowid, text) in unpacked {
        db.execute(
            "UPDATE messages SET content_text=? WHERE rowid=?",
            params![text, rowid],
        )
        .unwrap();
    }
    db.execute_batch(
        "DROP INDEX idx_sessions_unmatched_pricing_meta;
         ALTER TABLE sessions DROP COLUMN has_unmatched_pricing_meta;
         DELETE FROM cache_meta WHERE key IN (
             'unmatched_pricing_meta_index_v1',
             'unmatched_pricing_meta_v1',
             'unmatched_pricing_meta_v1_cursor',
             'content_text_zstd_v1',
             'content_text_zstd_v1_cursor'
         );
         PRAGMA user_version=39;
         UPDATE cache_meta SET value='39' WHERE key='version';",
    )
    .unwrap();
    drop(cache);

    for _ in 0..2 {
        let cache = Cache::open(Some(&path)).unwrap();
        let db = cache.connection();
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            CACHE_SCHEMA_VERSION
        );
        assert!(
            !std::fs::read_dir(root.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains("cache-migration")),
            "v39 -> v40 must upgrade in place without creating a backup file"
        );
        let index_exists: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_sessions_unmatched_pricing_meta'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_exists, 1);

        let flag = |id: &str| -> i64 {
            db.query_row(
                "SELECT has_unmatched_pricing_meta FROM sessions WHERE session_id=?",
                [id],
                |row| row.get(0),
            )
            .unwrap()
        };
        assert_eq!(flag(&unmatched.head.reference.session_id), 1);
        assert_eq!(flag(&priced.head.reference.session_id), 0);
        assert_eq!(flag(&msg_only_unmatched.head.reference.session_id), 0);

        let encoding: String = db
            .query_row(
                "SELECT typeof(content_text) FROM messages WHERE session_id=?",
                [&unmatched.head.reference.session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(encoding, "blob");

        let stats = crate::analytics::query_unmatched_models(
            db,
            &crate::search::QueryScope::default(),
            None,
            None,
            &pricing,
        )
        .unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].model_key, "acme/v39-missing");
    }
}

#[test]
fn schema41_migrates_source_fingerprints_in_place_and_live_edits_write_only_changed_key() {
    let root = tempfile::tempdir().unwrap();
    let sessions = root.path().join(".codex").join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let file_a = sessions.join("rollout-a.jsonl");
    let file_b = sessions.join("rollout-b.jsonl");
    let empty = sessions.join("rollout-empty.jsonl");
    let write_rollout = |path: &Path, text: &str| {
        std::fs::write(
            path,
            format!(
                "{}\n{}\n",
                serde_json::json!({"timestamp":"2026-09-01T10:00:00Z","type":"session_meta","payload":{"cwd":"/fixture"}}),
                serde_json::json!({"timestamp":"2026-09-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"text":text}]}}),
            ),
        )
        .unwrap();
    };
    write_rollout(&file_a, "First");
    write_rollout(&file_b, "Second");
    std::fs::write(&empty, "").unwrap();

    let env = crate::discovery::PathEnvironment {
        home: root.path().into(),
        cwd: root.path().into(),
        platform: "linux".into(),
        variables: Default::default(),
    };
    let source = env.source("codex").unwrap();
    let db_path = root.path().join("cache.db");
    let pricing = Arc::new(crate::pricing::Pricing::bundled());
    let mut cache = Cache::open(Some(&db_path)).unwrap();
    let mut scanner =
        crate::discovery::AgentScanner::new(source.clone(), db_path.clone(), pricing.clone());
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 2);
    cache
        .apply_checkpoint(
            &mut initial.sessions,
            &initial.removed,
            "codex",
            &initial.checkpoint,
            initial.complete,
        )
        .unwrap();
    initial.on_reject.take();

    // Downgrade to schema 41 with inline files/databaseSessions/emptySources in cache_meta.
    let saved_fps = source_fingerprints::load(
        cache.connection(),
        "source_fingerprints",
        "agent_name",
        "codex",
    )
    .unwrap();
    assert_eq!(saved_fps.files.len(), 3);
    assert!(
        saved_fps
            .empty_sources
            .contains(&empty.to_string_lossy().into_owned())
    );

    let state_raw: String = cache
        .connection()
        .query_row(
            "SELECT value FROM cache_meta WHERE key='rust_source_state:codex'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let mut legacy_state: serde_json::Value = serde_json::from_str(&state_raw).unwrap();
    assert!(legacy_state.get("files").is_none());
    assert!(legacy_state.get("databaseSessions").is_none());
    assert!(legacy_state.get("emptySources").is_none());
    legacy_state["files"] = serde_json::to_value(&saved_fps.files).unwrap();
    legacy_state["databaseSessions"] = serde_json::json!({"db-session-1": "db-fp-1"});
    legacy_state["emptySources"] = serde_json::to_value(&saved_fps.empty_sources).unwrap();
    cache
        .connection()
        .execute(
            "UPDATE cache_meta SET value=?1 WHERE key='rust_source_state:codex'",
            [legacy_state.to_string()],
        )
        .unwrap();
    cache
        .connection()
        .execute_batch(
            "DROP TABLE source_fingerprints;
             DELETE FROM cache_meta WHERE key='source_fingerprints_v1';
             PRAGMA user_version=41;
             UPDATE cache_meta SET value='41' WHERE key='version';",
        )
        .unwrap();
    drop(cache);

    let mut cache = Cache::open(Some(&db_path)).unwrap();
    assert_eq!(
        cache
            .connection()
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        CACHE_SCHEMA_VERSION
    );
    assert!(
        !std::fs::read_dir(root.path())
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .contains("cache-migration")),
        "v41 -> v42 must upgrade in place without creating a backup file"
    );
    let migrated_raw: String = cache
        .connection()
        .query_row(
            "SELECT value FROM cache_meta WHERE key='rust_source_state:codex'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let migrated_state: serde_json::Value = serde_json::from_str(&migrated_raw).unwrap();
    assert!(migrated_state.get("files").is_none());
    assert!(migrated_state.get("databaseSessions").is_none());
    assert!(migrated_state.get("emptySources").is_none());
    assert_eq!(migrated_state["historyComplete"], serde_json::json!(true));

    let migrated_fps = source_fingerprints::load(
        cache.connection(),
        "source_fingerprints",
        "agent_name",
        "codex",
    )
    .unwrap();
    assert_eq!(migrated_fps.files, saved_fps.files);
    assert_eq!(
        migrated_fps
            .database_sessions
            .get("db-session-1")
            .map(String::as_str),
        Some("db-fp-1")
    );
    assert_eq!(migrated_fps.empty_sources, saved_fps.empty_sources);

    // Warm restart sees all migrated fingerprints and parses nothing.
    let mut restarted = crate::discovery::AgentScanner::new(source, db_path, pricing);
    let mut warm = restarted.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    assert!(
        warm.checkpoint
            .as_ref()
            .and_then(|v| v.get("sourceStateDelta"))
            .is_none()
    );
    cache
        .apply_checkpoint(
            &mut warm.sessions,
            &warm.removed,
            "codex",
            &warm.checkpoint,
            warm.complete,
        )
        .unwrap();
    warm.on_reject.take();

    // A 1-file live edit writes ONLY the changed entry_key to source_fingerprints.
    cache
        .connection()
        .execute_batch(
            "CREATE TEMP TABLE fp_writes(entry_key TEXT NOT NULL);
             CREATE TEMP TRIGGER track_fp_ins AFTER INSERT ON source_fingerprints BEGIN INSERT INTO fp_writes VALUES(NEW.entry_key); END;
             CREATE TEMP TRIGGER track_fp_upd AFTER UPDATE ON source_fingerprints BEGIN INSERT INTO fp_writes VALUES(NEW.entry_key); END;
             CREATE TEMP TRIGGER track_fp_del AFTER DELETE ON source_fingerprints BEGIN INSERT INTO fp_writes VALUES(OLD.entry_key); END;",
        )
        .unwrap();
    write_rollout(&file_a, "Updated prompt content for file A");
    let mut edited = restarted
        .refresh(Some(std::slice::from_ref(&file_a)))
        .unwrap();
    assert_eq!(edited.sessions.len(), 1);
    let delta: source_fingerprints::SourceStateDelta = serde_json::from_value(
        edited
            .checkpoint
            .as_ref()
            .unwrap()
            .get("sourceStateDelta")
            .unwrap()
            .clone(),
    )
    .unwrap();
    assert!(!delta.reset);
    assert_eq!(delta.file_upserts.len(), 1);
    assert!(
        delta
            .file_upserts
            .contains_key(&file_a.to_string_lossy().into_owned())
    );

    cache
        .apply_checkpoint(
            &mut edited.sessions,
            &edited.removed,
            "codex",
            &edited.checkpoint,
            edited.complete,
        )
        .unwrap();
    edited.on_reject.take();

    let written_keys: Vec<String> = cache
        .connection()
        .prepare("SELECT entry_key FROM fp_writes")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(written_keys, vec![file_a.to_string_lossy().into_owned()]);

    // Non-complete checkpoint must strip sourceStateDelta before persisting rust_sync_checkpoint.
    let partial = serde_json::json!({
        "offset": 1,
        "total": 2,
        "sourceState": {"version": 1},
        "sourceStateDelta": {"fileUpserts": {"k": "v"}}
    });
    cache
        .apply_checkpoint(&mut [], &[], "codex", &Some(partial), false)
        .unwrap();
    let stored_checkpoint: String = cache
        .connection()
        .query_row(
            "SELECT value FROM cache_meta WHERE key='rust_sync_checkpoint:codex'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let stored_checkpoint: serde_json::Value = serde_json::from_str(&stored_checkpoint).unwrap();
    assert!(stored_checkpoint.get("sourceStateDelta").is_none());
}
