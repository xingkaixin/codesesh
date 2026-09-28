use super::*;
use crate::{
    agents::ParsedSession,
    discovery::{AgentScanner, PathEnvironment},
};
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
    assert_eq!(store.queue_status().unwrap().batches, 2);
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
fn title_only_changes_do_not_requeue_message_content() {
    let (_dir, mut store, mut scanner) = setup();
    let mut batch = scanner.refresh(None).unwrap();
    store.save_batch("codex", &mut batch).unwrap();
    drain(&mut store);
    batch.sessions[0].head.title = "New title".into();
    batch.sessions[0].detail.head.title = "New title".into();
    store.save_batch("codex", &mut batch).unwrap();
    assert_eq!(store.queue_status().unwrap().batches, 1);
    assert!(matches!(
        store.next_upload().unwrap().unwrap().operation,
        Operation::Metadata { .. }
    ));
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
    assert_eq!(store.queue_status().unwrap().batches, 2);
}

#[test]
fn chunked_snapshot_round_trips_and_bad_receipt_cannot_skip_ahead() {
    let (_dir, mut store, mut scanner) = setup();
    let mut batch = scanner.refresh(None).unwrap();
    let session: &mut ParsedSession = &mut batch.sessions[0];
    session.detail.messages[0].parts = vec![crate::contract::MessagePart::Text {
        text: "x".repeat(CHUNK_BYTES * 3),
        time_created: None,
    }];
    store.save_batch("codex", &mut batch).unwrap();
    let mut payload = Vec::new();
    let stream = store.stream_id().unwrap();
    while let Some(next) = store.next_upload().unwrap() {
        assert!(
            store
                .acknowledge(&stream, next.sequence + 1, &next.digest)
                .is_err()
        );
        match &next.operation {
            Operation::SnapshotChunk { data, .. } => payload.extend(STANDARD.decode(data).unwrap()),
            Operation::SnapshotCommit {
                bytes,
                digest: expected,
                ..
            } => {
                assert_eq!(*bytes, payload.len() as u64);
                assert_eq!(*expected, digest(&payload));
                let captured: CapturedSession = serde_json::from_slice(&payload).unwrap();
                assert_eq!(
                    captured.into_parsed().unwrap().detail.messages[0].parts,
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
    store.save_batch("codex", &mut batch).unwrap();
    let old_stream = store.stream_id().unwrap();
    let chunk = store.next_upload().unwrap().unwrap();
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
    assert_eq!(store.queue_status().unwrap().batches, 2);
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
