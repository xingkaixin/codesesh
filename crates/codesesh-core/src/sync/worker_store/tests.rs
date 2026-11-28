use super::*;
use crate::{
    agents::ParsedSession,
    discovery::{AgentScanner, PathEnvironment},
    sync::CapturedSession,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;

fn setup() -> (tempfile::TempDir, WorkerStore, AgentScanner) {
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join(".codex/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(sessions.join("rollout-one.jsonl"), concat!(
        "{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
        "{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Durable history\"}]}}\n"
    )).unwrap();
    let env = PathEnvironment {
        home: dir.path().into(),
        cwd: dir.path().into(),
        platform: "linux".into(),
        variables: Default::default(),
    };
    let path = dir.path().join("worker.db");
    let store = WorkerStore::open(&path).unwrap();
    let scanner = AgentScanner::for_worker(env.source("codex").unwrap(), path);
    (dir, store, scanner)
}

fn drain(store: &mut WorkerStore) {
    while let Some(next) = store.next_upload().unwrap() {
        store
            .acknowledge(&store.stream_id().unwrap(), next.sequence, &next.digest)
            .unwrap();
    }
}

#[test]
fn pending_content_survives_restart_and_confirmed_content_is_removed() {
    let (dir, mut store, mut scanner) = setup();
    let mut batch = scanner.refresh(None).unwrap();
    assert_eq!(batch.sessions.len(), 1);
    store.save_batch("codex", &mut batch).unwrap();
    let stream = store.stream_id().unwrap();
    let first = store.next_upload().unwrap().unwrap();
    assert!(
        store
            .acknowledge("wrong-stream", first.sequence, &first.digest)
            .is_err()
    );
    assert!(
        store
            .acknowledge(&stream, first.sequence, "wrong-content")
            .is_err()
    );
    assert_eq!(store.queue_status().unwrap().batches, 1);
    drop(store);
    let mut store = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    assert_eq!(store.stream_id().unwrap(), stream);
    assert_eq!(store.next_upload().unwrap().unwrap().digest, first.digest);
    drain(&mut store);
    assert_eq!(store.queue_status().unwrap().bytes, 0);
    assert_eq!(store.baseline("codex").unwrap().sessions.len(), 1);
    assert_eq!(
        store
            .db
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='messages'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    drop(scanner);
    let env = PathEnvironment {
        home: dir.path().into(),
        cwd: dir.path().into(),
        platform: "linux".into(),
        variables: Default::default(),
    };
    let mut restarted =
        AgentScanner::for_worker(env.source("codex").unwrap(), dir.path().join("worker.db"));
    let mut next = restarted
        .refresh_with_checkpoint(None, store.checkpoint("codex").unwrap().as_ref())
        .unwrap();
    store.save_batch("codex", &mut next).unwrap();
    assert_eq!(store.queue_status().unwrap().batches, 0);
}

#[test]
fn enqueue_failure_rolls_back_progress_and_can_retry() {
    let (_dir, mut store, mut scanner) = setup();
    let mut batch = scanner.refresh(None).unwrap();
    batch.checkpoint = Some(json!({"offset":1}));
    batch.complete = false;
    store.db.execute_batch("CREATE TRIGGER reject_progress BEFORE INSERT ON worker_sources BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    assert!(store.save_batch("codex", &mut batch).is_err());
    assert_eq!(store.queue_status().unwrap().batches, 0);
    assert!(store.checkpoint("codex").unwrap().is_none());
    assert!(store.baseline("codex").unwrap().sessions.is_empty());
    store
        .db
        .execute_batch("DROP TRIGGER reject_progress")
        .unwrap();
    store.save_batch("codex", &mut batch).unwrap();
    assert_eq!(store.checkpoint("codex").unwrap(), batch.checkpoint);
    assert_eq!(store.queue_status().unwrap().batches, 1);
}

#[test]
fn chunked_snapshot_round_trips_and_bad_receipt_cannot_skip_ahead() {
    let (_dir, mut store, mut scanner) = setup();
    let mut batch = scanner.refresh(None).unwrap();
    let session: &mut ParsedSession = &mut batch.sessions[0];
    session.detail.messages[0].parts = vec![crate::model::MessagePart::Text {
        text: "中文\n\"😀".repeat(CHUNK_BYTES / 3),
        time_created: None,
    }];
    session.head.title = "Latest head".into();
    session.head.stats.cost_inputs = vec![
        serde_json::from_value(json!({
            "model":"gpt-5", "tokens":{"input":7,"output":3,"cache_read":0,"cache_create":0},
            "web_search":0,"cost":null
        }))
        .unwrap(),
    ];
    session.detail.messages[0].cost_inputs = session.head.stats.cost_inputs.clone();
    session.detail.message_cursor = Some("cursor".into());
    session.detail.message_update = Some(crate::model::MessageUpdate::Append);
    session.detail.file_activity = vec![crate::model::SessionFileActivity {
        reference: session.head.reference.clone(),
        project_identity_key: session.head.project_identity.key.clone(),
        path: "src/中文.rs".into(),
        kind: "read".into(),
        count: 2,
        latest_time: 1000.0,
    }];
    let captured = CapturedSession::from_parsed(session.clone());
    let expected_payload = serde_json::to_vec(&captured).unwrap();
    let expected_hash = digest(
        &serde_json::to_vec(&(
            &captured.detail.messages,
            &captured.detail.file_activity,
            &captured.message_cost_inputs,
        ))
        .unwrap(),
    );
    let original = session.detail.clone();
    store.db.execute_batch("CREATE TRIGGER reject_chunk BEFORE INSERT ON worker_outbox WHEN json_extract(NEW.payload,'$.index')=1 BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    let error = store.save_batch("codex", &mut batch).unwrap_err();
    assert!(error.to_string().contains("disk failure"), "{error}");
    assert_eq!(store.queue_status().unwrap().batches, 0);
    assert!(store.baseline("codex").unwrap().sessions.is_empty());
    assert_eq!(batch.sessions[0].detail, original);
    store.db.execute_batch("DROP TRIGGER reject_chunk").unwrap();
    store.save_batch("codex", &mut batch).unwrap();
    let stored_hash: String = store
        .db
        .query_row("SELECT content_hash FROM worker_sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored_hash, expected_hash);
    let mut payload = Vec::new();
    let mut chunk_count = 0;
    let stream = store.stream_id().unwrap();
    while let Some(next) = store.next_upload().unwrap() {
        assert!(
            store
                .acknowledge(&stream, next.sequence + 1, &next.digest)
                .is_err()
        );
        match &next.operation {
            Operation::SnapshotChunk { data, index, .. } => {
                assert_eq!(*index, chunk_count);
                let bytes = STANDARD.decode(data).unwrap();
                assert!(!bytes.is_empty() && bytes.len() <= CHUNK_BYTES);
                payload.extend(bytes);
                chunk_count += 1;
            }
            Operation::SnapshotCommit {
                bytes,
                chunks,
                digest: expected,
                data,
                ..
            } => {
                assert!(data.is_none());
                assert_eq!(*bytes, payload.len() as u64);
                assert_eq!(*chunks, chunk_count);
                assert_eq!(*expected, digest(&payload));
                assert_eq!(payload, expected_payload);
                let captured: CapturedSession = serde_json::from_slice(&payload).unwrap();
                let parsed = captured.into_parsed().unwrap();
                assert_eq!(parsed.head.title, "Latest head");
                assert_eq!(
                    parsed.head.stats.cost_inputs,
                    batch.sessions[0].head.stats.cost_inputs
                );
                assert_eq!(
                    parsed.detail.messages[0].cost_inputs,
                    original.messages[0].cost_inputs
                );
                assert_eq!(
                    parsed.detail.messages[0].parts,
                    batch.sessions[0].detail.messages[0].parts
                );
            }
            _ => panic!("unexpected metadata operation"),
        }
        store
            .acknowledge(&stream, next.sequence, &next.digest)
            .unwrap();
    }
}

#[test]
fn re_pairing_preserves_pending_content_and_restarts_a_recovery_stream() {
    let (dir, mut store, mut scanner) = setup();
    let mut batch = scanner.refresh(None).unwrap();
    batch.sessions[0].detail.messages[0].parts = vec![crate::model::MessagePart::Text {
        text: "x".repeat(CHUNK_BYTES + 1024),
        time_created: None,
    }];
    store.save_batch("codex", &mut batch).unwrap();
    let queued = store.queue_status().unwrap().batches;
    assert!(queued > 2);
    let old_stream = store.stream_id().unwrap();
    let chunk = store.next_upload().unwrap().unwrap();
    assert!(matches!(chunk.operation, Operation::SnapshotChunk { .. }));
    store
        .acknowledge(&old_stream, chunk.sequence, &chunk.digest)
        .unwrap();
    store.set_pause(Some("CREDENTIAL_REVOKED")).unwrap();
    let grant = super::super::PairingGrant {
        node_id: "new-node".into(),
        credential: "new-credential".into(),
        hub_id: "new-hub".into(),
        epoch: "new-epoch".into(),
    };
    store.rebind("https://new-hub.example/", &grant).unwrap();
    drop(store);
    let mut store = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    assert_eq!(store.queue_status().unwrap().batches, queued);
    assert_eq!(store.next_upload().unwrap().unwrap().digest, chunk.digest);
    assert_eq!(store.confirmed_sequence().unwrap(), 0);
    assert!(store.pause_reason().unwrap().is_none());
    let recovery = store.recovery().unwrap().unwrap();
    assert_eq!(recovery.previous_stream, old_stream);
    assert_ne!(recovery.new_stream, old_stream);
    assert_eq!(store.binding().unwrap().unwrap().1.node_id, "new-node");
    store.update_origin("https://renamed-hub.example/").unwrap();
    assert_eq!(store.binding().unwrap().unwrap().1.node_id, "new-node");
    assert_eq!(store.stream_id().unwrap(), recovery.new_stream);
}

#[test]
fn worker_store_acknowledges_round_trip_metadata_digests_and_rejects_raw_digest() {
    let (_dir, mut store, mut scanner) = setup();
    let mut batch = scanner.refresh(None).unwrap();
    store.save_batch("codex", &mut batch).unwrap();
    drain(&mut store);

    batch.sessions[0].head.summary_files = Some(serde_json::Value::Null);
    batch.sessions[0].head.title = "With null summary".into();
    store.save_batch("codex", &mut batch).unwrap();

    let stored_digest: String = store
        .db
        .query_row("SELECT digest FROM worker_outbox", [], |row| row.get(0))
        .unwrap();
    let pending = store.next_upload().unwrap().unwrap();
    assert!(matches!(pending.operation, Operation::Metadata { .. }));
    assert_ne!(stored_digest, pending.digest);

    let stream = store.stream_id().unwrap();
    assert!(
        store
            .acknowledge(&stream, pending.sequence, &stored_digest)
            .is_err()
    );
    assert_eq!(store.queue_status().unwrap().batches, 1);

    store
        .acknowledge(&stream, pending.sequence, &pending.digest)
        .unwrap();
    assert_eq!(store.queue_status().unwrap().batches, 0);
}

#[test]
fn schema2_worker_migrates_source_fingerprints_in_place_and_updates_incrementally() {
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join(".codex/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let file_a = sessions.join("rollout-a.jsonl");
    let file_b = sessions.join("rollout-b.jsonl");
    let write_rollout = |path: &Path, text: &str| {
        std::fs::write(
            path,
            format!(
                "{}\n{}\n",
                json!({"timestamp":"2026-09-01T10:00:00Z","type":"session_meta","payload":{"cwd":"/fixture"}}),
                json!({"timestamp":"2026-09-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"text":text}]}}),
            ),
        )
        .unwrap();
    };
    write_rollout(&file_a, "First");
    write_rollout(&file_b, "Second");

    let env = PathEnvironment {
        home: dir.path().into(),
        cwd: dir.path().into(),
        platform: "linux".into(),
        variables: Default::default(),
    };
    let source = env.source("codex").unwrap();
    let db_path = dir.path().join("worker.db");
    let mut store = WorkerStore::open(&db_path).unwrap();
    let mut scanner = AgentScanner::for_worker(source.clone(), db_path.clone());
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 2);
    store.save_batch("codex", &mut initial).unwrap();

    // Rewrite worker.db back to schema 2 with inline files/databaseSessions/emptySources.
    let baseline = store.baseline("codex").unwrap();
    assert_eq!(baseline.fingerprints.files.len(), 2);
    let mut legacy_state = baseline.state.unwrap();
    legacy_state["files"] = serde_json::to_value(&baseline.fingerprints.files).unwrap();
    legacy_state["databaseSessions"] = json!({"db-1": "fp-db-1"});
    legacy_state["emptySources"] = json!(["empty-1"]);
    let legacy_checkpoint = json!({
        "offset": 1,
        "total": 2,
        "sourceState": legacy_state.clone()
    });
    store
        .db
        .execute(
            "UPDATE worker_sources SET state=?1, checkpoint=?2 WHERE agent='codex'",
            params![legacy_state.to_string(), legacy_checkpoint.to_string()],
        )
        .unwrap();
    store
        .db
        .execute_batch("DROP TABLE worker_source_fingerprints; PRAGMA user_version=2;")
        .unwrap();
    drop(store);

    let mut store = WorkerStore::open(&db_path).unwrap();
    assert_eq!(
        store
            .db
            .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
            .unwrap(),
        WORKER_SCHEMA_VERSION
    );
    let migrated_state: String = store
        .db
        .query_row(
            "SELECT state FROM worker_sources WHERE agent='codex'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let migrated_state: Value = serde_json::from_str(&migrated_state).unwrap();
    assert!(migrated_state.get("files").is_none());
    assert!(migrated_state.get("databaseSessions").is_none());
    assert!(migrated_state.get("emptySources").is_none());
    let migrated_checkpoint = store.checkpoint("codex").unwrap().unwrap();
    assert!(migrated_checkpoint["sourceState"].get("files").is_none());
    let migrated = store.baseline("codex").unwrap();
    assert_eq!(migrated.fingerprints.files, baseline.fingerprints.files);
    assert_eq!(
        migrated
            .fingerprints
            .database_sessions
            .get("db-1")
            .map(String::as_str),
        Some("fp-db-1")
    );
    assert!(migrated.fingerprints.empty_sources.contains("empty-1"));

    // Clear the test checkpoint so the restarted scanner performs a warm scan, then a 1-file edit.
    store
        .db
        .execute(
            "UPDATE worker_sources SET checkpoint=NULL WHERE agent='codex'",
            [],
        )
        .unwrap();
    let mut restarted = AgentScanner::for_worker(source, db_path);
    let mut warm = restarted.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    store.save_batch("codex", &mut warm).unwrap();

    store
        .db
        .execute_batch(
            "CREATE TEMP TABLE fp_writes(entry_key TEXT NOT NULL);
             CREATE TEMP TRIGGER track_wfp_ins AFTER INSERT ON worker_source_fingerprints BEGIN INSERT INTO fp_writes VALUES(NEW.entry_key); END;
             CREATE TEMP TRIGGER track_wfp_upd AFTER UPDATE ON worker_source_fingerprints BEGIN INSERT INTO fp_writes VALUES(NEW.entry_key); END;
             CREATE TEMP TRIGGER track_wfp_del AFTER DELETE ON worker_source_fingerprints BEGIN INSERT INTO fp_writes VALUES(OLD.entry_key); END;",
        )
        .unwrap();
    write_rollout(&file_a, "Updated worker file A");
    let mut edited = restarted
        .refresh(Some(std::slice::from_ref(&file_a)))
        .unwrap();
    assert_eq!(edited.sessions.len(), 1);
    edited.complete = false;
    store.save_batch("codex", &mut edited).unwrap();

    let written: Vec<String> = store
        .db
        .prepare("SELECT entry_key FROM fp_writes")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(written, vec![file_a.to_string_lossy().into_owned()]);
    assert!(
        store
            .checkpoint("codex")
            .unwrap()
            .unwrap()
            .get("sourceStateDelta")
            .is_none()
    );
}
