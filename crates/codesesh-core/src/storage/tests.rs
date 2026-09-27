use super::*;
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
    let count: i64 = cache.connection.query_row("SELECT count(*) FROM session_documents_fts WHERE session_documents_fts MATCH 'Fixture'", [], |row|row.get(0)).unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        cache
            .connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        34
    );
    cache.connection.execute("INSERT INTO session_file_activity VALUES('codex','rollout-persisted','/fixture','/fixture/中文.txt','read',1,1)",[]).unwrap();
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
    assert_eq!(cache.connection.query_row("SELECT COUNT(*) FROM session_documents_fts WHERE session_documents_fts MATCH 'Fixture'",[],|row|row.get::<_,i64>(0)).unwrap(),1);
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
#[ignore = "Driven by the isolated Node/Rust cache-roundtrip contract test"]
fn external_cache_compatibility_probe() {
    let input = std::env::var("CODESESH_CACHE_PROBE_INPUT").expect("isolated probe input file");
    let input: serde_json::Value = serde_json::from_slice(&std::fs::read(input).unwrap()).unwrap();
    let path = Path::new(input["path"].as_str().unwrap());
    let cache = Cache::open(Some(path)).unwrap();
    let heads = cache.snapshot().unwrap();
    let details = heads
        .iter()
        .map(|head| cache.detail(head.clone()).unwrap())
        .collect::<Vec<_>>();
    std::fs::write(
        input["output"].as_str().unwrap(),
        serde_json::to_vec(&serde_json::json!({"heads":heads,"details":details})).unwrap(),
    )
    .unwrap();
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
            .execute("UPDATE sessions SET meta_json=?", [metadata.to_string()])
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
            .execute("UPDATE sessions SET meta_json=?", [metadata])
            .unwrap();
        let heads = cache.snapshot().unwrap();
        assert_eq!(heads[0].version, None);
        assert_eq!(heads[0].summary_files, None);
    }
    cache
        .connection
        .execute(
            "UPDATE sessions SET meta_json=?",
            [r#"{"rustPricing":[invalid]}"#],
        )
        .unwrap();
    assert!(cache.snapshot().is_err());
}
