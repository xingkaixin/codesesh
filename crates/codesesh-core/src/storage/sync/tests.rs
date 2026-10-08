use super::*;
use crate::{runtime::ScanBatch, sync::WorkerStore};

fn transfer(cache: &mut Cache, worker: &mut WorkerStore, grant: &PairingGrant) {
    while let Some(pending) = worker.next_upload().unwrap() {
        let upload = Upload {
            epoch: grant.epoch.clone(),
            stream_id: worker.stream_id().unwrap(),
            sequence: pending.sequence,
            payload_version: pending.payload_version,
            digest: pending.digest,
            operation: pending.operation,
        };
        let receipt = cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .unwrap();
        let duplicate = cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .unwrap();
        assert_eq!(receipt.sequence, duplicate.sequence);
        worker
            .acknowledge(&receipt.stream_id, receipt.sequence, &receipt.digest)
            .unwrap();
    }
}

#[test]
fn pairing_is_one_time_and_revocation_keeps_history() {
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    assert!(cache.pairing_status(&token).unwrap().is_none());
    let stream = uuid::Uuid::new_v4().to_string();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &stream)
        .unwrap();
    assert_eq!(
        cache.pairing_status(&token).unwrap().as_deref(),
        Some(grant.node_id.as_str())
    );
    assert!(
        cache
            .pair_worker(&token, "Other", "1.1.1", &stream)
            .is_err()
    );
    assert_eq!(
        cache.authenticate_worker(&grant.credential).unwrap(),
        grant.node_id
    );
    assert!(cache.authenticate_worker("wrong").is_err());
    cache.revoke_worker(&grant.node_id).unwrap();
    assert!(cache.authenticate_worker(&grant.credential).is_err());
    assert!(cache.nodes().unwrap()[0].revoked);
    assert!(cache.initialize_hub("different-hub").is_err());
}

#[test]
fn receiver_deduplicates_and_metadata_does_not_rewrite_messages() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(Some(&dir.path().join("hub.db"))).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    let session = super::super::tests::source(dir.path(), "shared");
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: Vec::new(),
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    batch.sessions.push(session.clone());
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    assert!(cache.release_index_memory().unwrap());
    assert_eq!(
        cache.authenticate_worker(&grant.credential).unwrap(),
        grant.node_id
    );
    assert_eq!(cache.snapshot().unwrap().len(), 1);
    let head = cache.snapshot().unwrap().remove(0);
    assert_eq!(head.reference.source_node_id, grant.node_id);
    assert!(
        head.project_identity
            .key
            .starts_with(&format!("@{}/", grant.node_id))
    );
    let detail = cache.detail(head.clone()).unwrap().unwrap();
    cache.connection.execute_batch("CREATE TRIGGER forbid_message_rewrite BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'unexpected rewrite'); END;").unwrap();
    let source = &batch.sessions[0].source;
    let mut transcript = std::fs::read_to_string(source).unwrap();
    transcript.push_str(concat!(
        "{\"timestamp\":\"2026-09-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"<environment_context>Updated environment</environment_context>\"}]}}\n",
        "{\"timestamp\":\"2026-09-01T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"text\":\"Updated instructions\"}]}}\n"
    ));
    std::fs::write(source, transcript).unwrap();
    let updated = crate::agents::codex::parse(source, &Default::default(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    assert_eq!(updated.messages, session.detail.messages);
    assert_eq!(
        updated.head.stats.message_count,
        head.stats.message_count + 2
    );
    batch.sessions[0].head = updated.head.clone();
    batch.sessions[0].detail = updated;
    cache.connection.execute_batch("CREATE TRIGGER forbid_index_rewrite BEFORE UPDATE OF title ON session_documents BEGIN SELECT RAISE(ABORT,'unexpected index rewrite'); END;").unwrap();
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(
        cache
            .head(&head.reference)
            .unwrap()
            .unwrap()
            .stats
            .message_count,
        head.stats.message_count + 2
    );
    cache
        .connection
        .execute_batch("DROP TRIGGER forbid_index_rewrite")
        .unwrap();
    batch.sessions[0].head.title = "Renamed".into();
    worker.save_batch("codex", &mut batch).unwrap();
    assert!(matches!(
        worker.next_upload().unwrap().unwrap().operation,
        Operation::Metadata { .. }
    ));
    drop(worker);
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(worker.queue_status().unwrap().batches, 0);
    let renamed = cache.head(&head.reference).unwrap().unwrap();
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(renamed.stats.message_count, head.stats.message_count + 2);
    cache.rebuild_search_indexes().unwrap();
    assert!(cache.release_index_memory().unwrap());
    assert_eq!(
        crate::search::search_sessions(cache.connection(), "Renamed", &Default::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        cache.detail(renamed).unwrap().unwrap().messages,
        detail.messages
    );
}

#[test]
fn snapshot_validation_preserves_chunks_for_a_valid_retry() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let stream = worker.stream_id().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &stream)
        .unwrap();
    let mut session = super::super::tests::source(dir.path(), "chunked");
    session.detail.messages[0].parts = vec![crate::contract::MessagePart::Text {
        text: "中文 🔎".repeat(40_000),
        time_created: None,
    }];
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![session],
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    let commit = loop {
        let pending = worker.next_upload().unwrap().unwrap();
        let upload = Upload {
            epoch: grant.epoch.clone(),
            stream_id: stream.clone(),
            sequence: pending.sequence,
            payload_version: pending.payload_version,
            digest: pending.digest,
            operation: pending.operation,
        };
        if matches!(upload.operation, Operation::SnapshotCommit { .. }) {
            break upload;
        }
        let receipt = cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .unwrap();
        worker
            .acknowledge(&stream, receipt.sequence, &receipt.digest)
            .unwrap();
    };
    let Operation::SnapshotCommit {
        transfer_id,
        chunks,
        bytes,
        digest: expected,
        ..
    } = &commit.operation
    else {
        panic!("expected snapshot commit");
    };
    assert!(*chunks > 1);
    for (count, length, checksum, error) in [
        (chunks + 1, *bytes, expected.clone(), "SNAPSHOT_INCOMPLETE"),
        (
            *chunks,
            u64::MAX,
            expected.clone(),
            "SNAPSHOT_CHECKSUM_MISMATCH",
        ),
        (
            *chunks,
            *bytes,
            "0".repeat(64),
            "SNAPSHOT_CHECKSUM_MISMATCH",
        ),
    ] {
        let mut invalid = commit.clone();
        invalid.operation = Operation::SnapshotCommit {
            transfer_id: transfer_id.clone(),
            chunks: count,
            bytes: length,
            digest: checksum,
            base: None,
            messages: None,
        };
        invalid.digest = digest(&serde_json::to_vec(&invalid.operation).unwrap());
        assert_eq!(
            cache
                .receive_upload(&grant.node_id, &invalid, &Pricing::bundled())
                .unwrap_err()
                .to_string(),
            error
        );
        assert!(cache.snapshot().unwrap().is_empty());
        assert_eq!(
            cache
                .connection
                .query_row("SELECT COUNT(*) FROM hub_chunks", [], |row| row
                    .get::<_, u32>(0))
                .unwrap(),
            *chunks
        );
    }
    transfer(&mut cache, &mut worker, &grant);
    let head = cache.snapshot().unwrap().remove(0);
    assert_eq!(
        cache.detail(head).unwrap().unwrap().messages[0].parts,
        batch.sessions[0].detail.messages[0].parts
    );
    assert_eq!(
        cache
            .connection
            .query_row("SELECT COUNT(*) FROM hub_chunks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(worker.next_upload().unwrap().is_none());
}

#[test]
fn failed_commit_rolls_back_content_and_receipt_and_retries() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: Vec::new(),
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    batch
        .sessions
        .push(super::super::tests::source(dir.path(), "shared"));
    worker.save_batch("codex", &mut batch).unwrap();
    let first = worker.next_upload().unwrap().unwrap();
    let upload = Upload {
        epoch: grant.epoch.clone(),
        stream_id: worker.stream_id().unwrap(),
        sequence: first.sequence,
        payload_version: first.payload_version,
        digest: first.digest,
        operation: first.operation,
    };
    cache
        .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
        .unwrap();
    worker
        .acknowledge(&upload.stream_id, upload.sequence, &upload.digest)
        .unwrap();
    cache.connection.execute_batch("CREATE TRIGGER reject_receipt BEFORE UPDATE OF confirmed_sequence ON hub_nodes BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    let commit = worker.next_upload().unwrap().unwrap();
    let upload = Upload {
        epoch: grant.epoch.clone(),
        stream_id: worker.stream_id().unwrap(),
        sequence: commit.sequence,
        payload_version: commit.payload_version,
        digest: commit.digest,
        operation: commit.operation,
    };
    assert!(
        cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .is_err()
    );
    assert!(cache.snapshot().unwrap().is_empty());
    assert_eq!(
        cache
            .connection
            .query_row("SELECT COUNT(*) FROM hub_chunks", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    cache
        .connection
        .execute_batch("DROP TRIGGER reject_receipt")
        .unwrap();
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(cache.snapshot().unwrap().len(), 1);
    assert_eq!(
        cache
            .connection
            .query_row("SELECT COUNT(*) FROM hub_chunks", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn uploaded_sessions_publish_through_runtime_writer() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let path = dir.path().join("hub.db");
    let runtime = crate::runtime::Runtime::start(path, vec![], 1)
        .await
        .unwrap();
    let stream = worker.stream_id().unwrap();
    let grant = runtime
        .hub_control(move |cache| {
            cache.initialize_hub("hub-fixture")?;
            let token = cache.create_pairing_token()?;
            cache.pair_worker(&token, "Laptop", "1.1.1", &stream)
        })
        .await
        .unwrap();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![super::super::tests::source(dir.path(), "shared")],
        removed: vec![],
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    let pricing = crate::pricing::PricingController::load(dir.path());
    let mut events = runtime.subscribe();
    while let Some(pending) = worker.next_upload().unwrap() {
        let receipt = runtime
            .receive_upload(
                grant.credential.clone(),
                Upload {
                    epoch: grant.epoch.clone(),
                    stream_id: worker.stream_id().unwrap(),
                    sequence: pending.sequence,
                    payload_version: pending.payload_version,
                    digest: pending.digest,
                    operation: pending.operation,
                },
                pricing.snapshot().unwrap(),
            )
            .await
            .unwrap();
        worker
            .acknowledge(&receipt.stream_id, receipt.sequence, &receipt.digest)
            .unwrap();
    }
    assert_eq!(runtime.snapshot().len(), 1);
    runtime
        .hub_control(|cache| cache.rebuild_search_indexes())
        .await
        .unwrap();
    let credential = grant.credential.clone();
    let node = runtime
        .hub_control(move |cache| cache.authenticate_worker(&credential))
        .await
        .unwrap();
    assert_eq!(node, grant.node_id);
    match events.try_recv().unwrap() {
        crate::runtime::Event::Sessions {
            changed, removed, ..
        } => {
            assert_eq!(changed.len(), 1);
            assert_eq!(changed[0].reference.source_node_id, grant.node_id);
            assert!(removed.is_empty());
        }
        event => panic!("unexpected event {event:?}"),
    }
    let node = grant.node_id.clone();
    let stream = worker.stream_id().unwrap();
    let new = runtime
        .hub_control(move |cache| {
            let token = cache.create_replacement_token(&node)?;
            cache.pair_worker(&token, "Replacement", "1.1.1", &stream)
        })
        .await
        .unwrap();
    let operation = Operation::SnapshotChunk {
        transfer_id: uuid::Uuid::new_v4().to_string(),
        index: 0,
        data: "AA==".into(),
    };
    let late = Upload {
        epoch: grant.epoch.clone(),
        stream_id: worker.stream_id().unwrap(),
        sequence: 1,
        payload_version: 1,
        digest: digest(&serde_json::to_vec(&operation).unwrap()),
        operation,
    };
    let error = runtime
        .receive_upload(
            grant.credential.clone(),
            late.clone(),
            pricing.snapshot().unwrap(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("credential"));
    runtime
        .receive_upload(new.credential, late, pricing.snapshot().unwrap())
        .await
        .unwrap();
    assert_eq!(runtime.snapshot().len(), 1);
    runtime.shutdown().await.unwrap();
}

#[test]
fn rescan_request_is_durable_and_finishes_only_after_upload_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let worker_path = dir.path().join("worker.db");
    let mut worker = WorkerStore::open(&worker_path).unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![super::super::tests::source(dir.path(), "shared")],
        removed: vec![],
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    let task = cache
        .request_rescan(std::slice::from_ref(&grant.node_id), &[], "manual")
        .unwrap()
        .remove(0);
    assert!(worker.begin_rescan(&task, &["codex".into()]).unwrap());
    assert!(!worker.begin_rescan(&task, &["codex".into()]).unwrap());
    assert!(worker.rescan_scan_progress().unwrap().is_none());
    batch.complete = false;
    batch.checkpoint = Some(serde_json::json!({"offset": 1, "total": 2}));
    worker.save_batch("codex", &mut batch).unwrap();
    drop(worker);
    let mut worker = WorkerStore::open(&worker_path).unwrap();
    let mut hello = crate::sync::WorkerHello {
        collection_status: Some(crate::sync::CollectionStatus {
            sources: Some(
                [(
                    "codex".into(),
                    crate::discovery::AgentCollectionStatus {
                        presence: crate::discovery::SourcePresence::Available,
                        complete: false,
                        error: None,
                    },
                )]
                .into(),
            ),
            rescan: worker.rescan_scan_progress().unwrap(),
            active_agent: Some("codex".into()),
            last_success_at: Some(123),
            errors: [("claudecode".into(), "unreadable source".into())].into(),
        }),
        collection_complete: false,
        collection_error: None,
        epoch: Some(grant.epoch.clone()),
        confirmed_sequence: worker.confirmed_sequence().unwrap(),
        version: "1.1.1".into(),
        protocol_version: 1,
        payload_version: 1,
        stream_id: worker.stream_id().unwrap(),
        queue: worker.queue_status().unwrap(),
        rescan: worker.rescan_progress().unwrap(),
        host: None,
    };
    cache.worker_hello(&grant.node_id, &hello, "1.1.1").unwrap();
    assert_eq!(cache.rescan_tasks().unwrap()[0].status, "running");
    let scan = cache.nodes().unwrap()[0]
        .health
        .clone()
        .unwrap()
        .collection
        .rescan
        .unwrap();
    assert_eq!(scan.id, task.id);
    assert_eq!(scan.agent, "codex");
    assert_eq!((scan.completed, scan.total), (1, 2));
    batch.complete = true;
    batch.checkpoint = None;
    worker.save_batch("codex", &mut batch).unwrap();
    assert!(worker.rescan_scan_progress().unwrap().is_none());
    hello.collection_status.as_mut().unwrap().rescan = worker.rescan_scan_progress().unwrap();
    hello.collection_complete = true;
    hello.rescan = worker.rescan_progress().unwrap();
    hello.queue = worker.queue_status().unwrap();
    assert!(hello.rescan.as_ref().unwrap().target_sequence.is_some());
    cache.worker_hello(&grant.node_id, &hello, "1.1.1").unwrap();
    assert_eq!(cache.rescan_tasks().unwrap()[0].status, "uploading");
    let health = cache.nodes().unwrap()[0].health.clone().unwrap();
    assert_eq!(health.collection.active_agent.as_deref(), Some("codex"));
    assert_eq!(health.collection.last_success_at, Some(123));
    assert_eq!(health.collection.errors["claudecode"], "unreadable source");
    assert!(health.reported_at > 0);
    assert_eq!(
        health.collection.sources.as_ref().unwrap()["codex"].presence,
        crate::discovery::SourcePresence::Available
    );
    assert!(!health.collection.sources.as_ref().unwrap()["codex"].complete);
    let mut legacy_hello = hello.clone();
    let legacy_status =
        serde_json::json!({"activeAgent": null, "lastSuccessAt": null, "errors": {}});
    legacy_hello.collection_status = Some(serde_json::from_value(legacy_status.clone()).unwrap());
    assert!(
        legacy_hello
            .collection_status
            .as_ref()
            .unwrap()
            .rescan
            .is_none()
    );
    assert_eq!(
        serde_json::to_value(&legacy_hello.collection_status).unwrap(),
        legacy_status
    );
    legacy_hello.collection_status = None;
    cache
        .worker_hello(&grant.node_id, &legacy_hello, "1.1.1")
        .unwrap();
    assert!(cache.nodes().unwrap()[0].health.is_none());
    drop(worker);
    let mut worker = WorkerStore::open(&worker_path).unwrap();
    assert!(!worker.begin_rescan(&task, &["codex".into()]).unwrap());
    transfer(&mut cache, &mut worker, &grant);
    cache.worker_hello(&grant.node_id, &hello, "1.1.1").unwrap();
    assert_eq!(cache.rescan_tasks().unwrap()[0].status, "completed");
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn recovery_replays_acknowledged_chunks_and_rejects_old_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let mut grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    worker.bind("https://hub.example/", &grant).unwrap();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![super::super::tests::source(dir.path(), "shared")],
        removed: vec![],
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    let pending = worker.next_upload().unwrap().unwrap();
    let old = Upload {
        epoch: grant.epoch.clone(),
        stream_id: worker.stream_id().unwrap(),
        sequence: pending.sequence,
        payload_version: pending.payload_version,
        digest: pending.digest,
        operation: pending.operation,
    };
    cache
        .receive_upload(&grant.node_id, &old, &Pricing::bundled())
        .unwrap();
    worker
        .acknowledge(&old.stream_id, old.sequence, &old.digest)
        .unwrap();
    grant.epoch = cache.rotate_data_epoch().unwrap();
    let recovery = worker.prepare_recovery(&grant.epoch).unwrap();
    assert_eq!(worker.queue_status().unwrap().batches, 2);
    assert_eq!(
        worker.prepare_recovery(&grant.epoch).unwrap().new_stream,
        recovery.new_stream
    );
    cache.recover_worker(&grant.node_id, &recovery).unwrap();
    cache.recover_worker(&grant.node_id, &recovery).unwrap();
    assert_eq!(cache.rescan_tasks().unwrap().len(), 1);
    worker
        .finish_recovery("https://hub.example/", &grant)
        .unwrap();
    assert!(
        worker
            .acknowledge(&old.stream_id, old.sequence, &old.digest)
            .is_err()
    );
    assert!(
        cache
            .receive_upload(&grant.node_id, &old, &Pricing::bundled())
            .is_err()
    );
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn recovery_survives_another_epoch_change_before_acknowledgment() {
    for accepted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("worker.db");
        let mut worker = WorkerStore::open(&path).unwrap();
        let mut cache = Cache::open(None).unwrap();
        cache.initialize_hub("hub").unwrap();
        let token = cache.create_pairing_token().unwrap();
        let mut grant = cache
            .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
            .unwrap();
        worker.bind("https://hub.example/", &grant).unwrap();
        let initial = worker.prepare_recovery(&grant.epoch).unwrap();
        cache.recover_worker(&grant.node_id, &initial).unwrap();
        worker
            .finish_recovery("https://hub.example/", &grant)
            .unwrap();
        let mut batch = ScanBatch {
            source_presence: None,
            sessions: vec![super::super::tests::source(dir.path(), "queued")],
            removed: vec![],
            checkpoint: None,
            complete: true,
            on_reject: None,
            pricing: None,
        };
        worker.save_batch("codex", &mut batch).unwrap();
        let epoch = if accepted {
            cache.rotate_data_epoch().unwrap()
        } else {
            "stale-epoch".into()
        };
        let stale = worker.prepare_recovery(&epoch).unwrap();
        if accepted {
            cache.recover_worker(&grant.node_id, &stale).unwrap();
            grant.epoch = cache.rotate_data_epoch().unwrap();
        }
        assert_eq!(
            cache
                .recover_worker(&grant.node_id, &stale)
                .unwrap_err()
                .to_string(),
            "HUB_EPOCH_CHANGED"
        );
        drop(worker);
        let mut worker = WorkerStore::open(&path).unwrap();
        let recovery = worker.prepare_recovery(&grant.epoch).unwrap();
        assert_ne!(recovery.new_stream, stale.new_stream);
        assert_eq!(worker.queue_status().unwrap().batches, 2);
        cache.recover_worker(&grant.node_id, &recovery).unwrap();
        cache.recover_worker(&grant.node_id, &recovery).unwrap();
        worker
            .finish_recovery("https://hub.example/", &grant)
            .unwrap();
        transfer(&mut cache, &mut worker, &grant);
        assert_eq!(cache.snapshot().unwrap().len(), 1);
        assert_eq!(worker.queue_status().unwrap().batches, 0);
        assert_eq!(
            cache
                .rescan_tasks()
                .unwrap()
                .iter()
                .filter(|task| task.status == "waiting")
                .count(),
            1
        );
    }
}

#[test]
fn recovery_retains_orphaned_metadata_until_a_snapshot_repairs_it() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let mut grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    worker.bind("https://hub.example/", &grant).unwrap();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![super::super::tests::source(dir.path(), "shared")],
        removed: vec![],
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    let reference = cache.snapshot().unwrap()[0].reference.clone();
    cache.remove(&[reference]).unwrap();
    batch.sessions[0].head.title = "New title".into();
    worker.save_batch("codex", &mut batch).unwrap();
    let pending = worker.next_upload().unwrap().unwrap();
    let upload = Upload {
        epoch: grant.epoch.clone(),
        stream_id: worker.stream_id().unwrap(),
        sequence: pending.sequence,
        payload_version: pending.payload_version,
        digest: pending.digest,
        operation: pending.operation,
    };
    assert_eq!(
        cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .unwrap_err()
            .to_string(),
        "SNAPSHOT_REQUIRED"
    );
    grant.epoch = cache.rotate_data_epoch().unwrap();
    let recovery = worker.prepare_recovery(&grant.epoch).unwrap();
    cache.recover_worker(&grant.node_id, &recovery).unwrap();
    worker
        .finish_recovery("https://hub.example/", &grant)
        .unwrap();
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(cache.nodes().unwrap()[0].incomplete_sessions, 1);
    let task = cache.rescan_tasks().unwrap()[0].request.clone();
    worker.begin_rescan(&task, &["codex".into()]).unwrap();
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(cache.nodes().unwrap()[0].incomplete_sessions, 0);
    assert_eq!(cache.snapshot().unwrap()[0].title, "New title");
}

#[test]
fn cloned_worker_instances_cannot_share_an_active_node() {
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "node", "1.1.1", &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let first = uuid::Uuid::new_v4().to_string();
    let second = uuid::Uuid::new_v4().to_string();
    cache.claim_worker_instance(&grant.node_id, &first).unwrap();
    cache.claim_worker_instance(&grant.node_id, &first).unwrap();
    assert!(
        cache
            .claim_worker_instance(&grant.node_id, &second)
            .unwrap_err()
            .to_string()
            .contains("WORKER_INSTANCE_CONFLICT")
    );
    cache
        .release_worker_instance(&grant.node_id, &second)
        .unwrap();
    assert!(
        cache
            .claim_worker_instance(&grant.node_id, &second)
            .is_err()
    );
    cache
        .release_worker_instance(&grant.node_id, &first)
        .unwrap();
    cache
        .claim_worker_instance(&grant.node_id, &second)
        .unwrap();
    cache
        .release_worker_instance(&grant.node_id, &first)
        .unwrap();
    assert!(cache.claim_worker_instance(&grant.node_id, &first).is_err());
    cache
        .release_worker_instance(&grant.node_id, &second)
        .unwrap();
    cache.claim_worker_instance(&grant.node_id, &first).unwrap();
    cache
        .connection
        .execute("UPDATE hub_nodes SET lease_until=0", [])
        .unwrap();
    cache
        .claim_worker_instance(&grant.node_id, &second)
        .unwrap();
    assert!(cache.claim_worker_instance(&grant.node_id, &first).is_err());
}

#[test]
fn local_worker_resume_drains_pending_content_without_changing_source_identity() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Local", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    worker.bind("https://hub.example/", &grant).unwrap();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![super::super::tests::source(dir.path(), "shared")],
        removed: vec![],
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    assert!(worker.queue_status().unwrap().batches > 0);
    assert!(
        cache
            .resume_local_worker(&mut worker, "other-hub", &Pricing::bundled())
            .unwrap()
            .is_none()
    );
    assert!(worker.queue_status().unwrap().batches > 0);
    assert_eq!(
        cache
            .resume_local_worker(&mut worker, "hub", &Pricing::bundled())
            .unwrap(),
        Some(grant.node_id.clone())
    );
    assert_eq!(worker.queue_status().unwrap().batches, 0);
    let snapshot = cache.snapshot().unwrap();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].reference.source_node_id, grant.node_id);
    cache
        .resume_local_worker(&mut worker, "hub", &Pricing::bundled())
        .unwrap();
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn local_pairing_requires_bound_proof_and_preserves_existing_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = Cache::open(None).unwrap();
    let mut original = super::super::tests::source(dir.path(), "existing");
    let reference = original.head.reference.clone();
    let project = original.head.project_identity.clone();
    cache.publish(std::slice::from_mut(&mut original)).unwrap();
    cache.initialize_hub("hub").unwrap();
    cache.configure_local_worker("private-local-key").unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let stream = worker.stream_id().unwrap();
    let token = cache.create_pairing_token().unwrap();
    let proof = crate::sync::local_worker_proof("private-local-key", "hub", &token, &stream);
    assert!(
        cache
            .pair_worker_with_origin(
                &token,
                "Local",
                "1.1.1",
                &stream,
                Some(("hub", "wrong-proof"))
            )
            .is_err()
    );
    let other_stream = uuid::Uuid::new_v4().to_string();
    assert!(
        cache
            .pair_worker_with_origin(
                &token,
                "Local",
                "1.1.1",
                &other_stream,
                Some(("hub", &proof))
            )
            .is_err()
    );
    let grant = cache
        .pair_worker_with_origin(&token, "Local", "1.1.1", &stream, Some(("hub", &proof)))
        .unwrap();
    assert_eq!(grant.node_id, "local");
    worker.bind("http://127.0.0.1/", &grant).unwrap();
    assert_eq!(worker.adopt_local_history(&cache, &grant).unwrap(), Some(1));
    assert_eq!(worker.queue_status().unwrap().batches, 0);
    assert_eq!(
        worker.baseline("codex").unwrap().sessions[0].head.reference,
        reference
    );
    original.head.title = "Updated locally".into();
    original.detail.head = original.head.clone();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![original],
        removed: vec![],
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(cache.snapshot().unwrap().len(), 1);
    let head = cache.head(&reference).unwrap().unwrap();
    assert_eq!(head.title, "Updated locally");
    assert_eq!(head.project_identity, project);
    drop(worker);
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    assert_eq!(worker.adopt_local_history(&cache, &grant).unwrap(), None);
    worker.save_batch("codex", &mut batch).unwrap();
    assert_eq!(worker.queue_status().unwrap().batches, 0);
    batch.sessions[0].head.title = "Changed after restart".into();
    worker.save_batch("codex", &mut batch).unwrap();
    let pending = worker.queue_status().unwrap().batches;
    assert!(pending > 0);
    assert_eq!(worker.adopt_local_history(&cache, &grant).unwrap(), None);
    assert_eq!(worker.queue_status().unwrap().batches, pending);
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(cache.snapshot().unwrap().len(), 1);
    assert_eq!(
        cache.head(&reference).unwrap().unwrap().title,
        "Changed after restart"
    );
    let token = cache.create_pairing_token().unwrap();
    let remote = cache
        .pair_worker(&token, "Remote", "1.1.1", &other_stream)
        .unwrap();
    assert_ne!(remote.node_id, "local");
    let mut stale = grant.clone();
    stale.epoch = "old-epoch".into();
    assert!(
        worker
            .adopt_local_history(&cache, &stale)
            .unwrap()
            .is_none()
    );
    cache.revoke_worker("local").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let proof = crate::sync::local_worker_proof("private-local-key", "hub", &token, &other_stream);
    let repaired = cache
        .pair_worker_with_origin(
            &token,
            "Restored local",
            "1.1.1",
            &other_stream,
            Some(("hub", &proof)),
        )
        .unwrap();
    assert_eq!(repaired.node_id, "local");
    assert!(cache.authenticate_worker(&grant.credential).is_err());
    assert_eq!(
        cache.authenticate_worker(&repaired.credential).unwrap(),
        "local"
    );
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn rescans_deduplicate_cancel_before_dispatch_and_keep_terminal_states() {
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let stream = uuid::Uuid::new_v4().to_string();
    let grant = cache
        .pair_worker(&token, "Worker", "1.1.1", &stream)
        .unwrap();
    let nodes = vec![grant.node_id.clone()];
    let first = cache
        .request_rescan(&nodes, &["codex".into(), "claudecode".into()], "manual")
        .unwrap()
        .remove(0);
    let duplicate = cache
        .request_rescan(
            &nodes,
            &["claudecode".into(), "codex".into(), "codex".into()],
            "manual",
        )
        .unwrap()
        .remove(0);
    assert_eq!(first.id, duplicate.id);
    assert!(!cache.cancel_rescan("another-node", &first.id).unwrap());
    assert!(cache.cancel_rescan(&grant.node_id, &first.id).unwrap());
    let next = cache
        .request_rescan(&nodes, &[], "manual")
        .unwrap()
        .remove(0);
    let mut hello = crate::sync::WorkerHello {
        collection_status: None,
        collection_complete: false,
        collection_error: None,
        epoch: Some(grant.epoch.clone()),
        confirmed_sequence: 0,
        version: "1.1.1".into(),
        protocol_version: 1,
        payload_version: 1,
        stream_id: stream,
        queue: crate::sync::QueueStatus {
            batches: 0,
            bytes: 0,
            oldest_at: None,
        },
        rescan: None,
        host: None,
    };
    let offered = cache
        .worker_hello(&grant.node_id, &hello, "1.1.1")
        .unwrap()
        .rescan
        .unwrap();
    assert_eq!(offered.id, next.id);
    assert!(!cache.cancel_rescan(&grant.node_id, &next.id).unwrap());
    assert_eq!(
        cache
            .worker_hello(&grant.node_id, &hello, "1.1.1")
            .unwrap()
            .rescan
            .unwrap()
            .id,
        next.id
    );
    hello.rescan = Some(crate::sync::RescanProgress {
        id: first.id.clone(),
        pending_agents: vec![],
        target_sequence: Some(0),
        error: None,
    });
    cache.worker_hello(&grant.node_id, &hello, "1.1.1").unwrap();
    let tasks = cache.rescan_tasks().unwrap();
    assert_eq!(
        tasks
            .iter()
            .find(|task| task.request.id == first.id)
            .unwrap()
            .status,
        "cancelled"
    );
    assert_eq!(
        tasks
            .iter()
            .find(|task| task.request.id == next.id)
            .unwrap()
            .status,
        "dispatched"
    );
}

#[test]
fn rescan_history_is_bounded_and_paginates_without_duplicates() {
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Worker", "1.1.1", &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let mut ids = Vec::new();
    for _ in 0..25 {
        let task = cache
            .request_rescan(std::slice::from_ref(&grant.node_id), &[], "manual")
            .unwrap()
            .remove(0);
        cache.cancel_rescan(&grant.node_id, &task.id).unwrap();
        ids.push(task.id);
    }
    assert_eq!(cache.rescan_tasks().unwrap().len(), 1);
    let first = cache.rescan_history(&grant.node_id, None).unwrap();
    assert_eq!(first.tasks.len(), 20);
    let next = cache
        .rescan_history(
            &grant.node_id,
            Some(first.next_cursor.unwrap().parse().unwrap()),
        )
        .unwrap();
    assert_eq!(next.tasks.len(), 5);
    assert!(next.next_cursor.is_none());
    let actual: Vec<_> = first
        .tasks
        .into_iter()
        .chain(next.tasks)
        .map(|task| task.request.id)
        .collect();
    ids.reverse();
    assert_eq!(actual, ids);
}

#[test]
fn replacement_preserves_identity_history_and_name_and_revokes_old_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let stream = worker.stream_id().unwrap();
    let token = cache.create_pairing_token().unwrap();
    let old = cache
        .pair_worker(&token, "Original", "1.1.1", &stream)
        .unwrap();
    worker
        .save_batch(
            "codex",
            &mut ScanBatch {
                source_presence: None,
                sessions: vec![super::super::tests::source(dir.path(), "retained")],
                removed: vec![],
                checkpoint: None,
                complete: true,
                on_reject: None,
                pricing: None,
            },
        )
        .unwrap();
    transfer(&mut cache, &mut worker, &old);
    let reference = cache.snapshot().unwrap()[0].reference.clone();
    cache.rename_worker(&old.node_id, "Office").unwrap();
    let task = cache
        .request_rescan(std::slice::from_ref(&old.node_id), &[], "manual")
        .unwrap()
        .remove(0);
    cache
        .claim_worker_instance(&old.node_id, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let replaced_token = cache.create_replacement_token(&old.node_id).unwrap();
    let replacement = cache.create_replacement_token(&old.node_id).unwrap();
    assert!(
        cache
            .pair_worker(&replaced_token, "New", "1.1.1", &stream)
            .is_err()
    );
    assert!(cache.authenticate_worker(&old.credential).is_ok());
    let new = cache
        .pair_worker(&replacement, "New", "1.1.1", &stream)
        .unwrap();
    assert_eq!(new.node_id, old.node_id);
    assert_ne!(new.credential, old.credential);
    assert!(cache.authenticate_worker(&old.credential).is_err());
    assert_eq!(
        cache.authenticate_worker(&new.credential).unwrap(),
        old.node_id
    );
    assert_eq!(cache.nodes().unwrap().len(), 1);
    assert_eq!(cache.nodes().unwrap()[0].name, "Office");
    assert_eq!(cache.snapshot().unwrap()[0].reference, reference);
    assert!(
        cache
            .detail(cache.snapshot().unwrap()[0].clone())
            .unwrap()
            .is_some()
    );
    cache
        .claim_worker_instance(&new.node_id, &uuid::Uuid::new_v4().to_string())
        .unwrap();
    let tasks = cache.rescan_tasks().unwrap();
    assert!(
        tasks
            .iter()
            .any(|item| item.request.reason == "worker-replacement" && item.status == "waiting")
    );
    assert!(
        tasks
            .iter()
            .any(|item| item.request.id == task.id && item.status == "superseded")
    );
    let revoked_token = cache.create_replacement_token(&new.node_id).unwrap();
    cache.revoke_worker(&new.node_id).unwrap();
    assert!(
        cache
            .pair_worker(&revoked_token, "New", "1.1.1", &stream)
            .is_err()
    );
    let restore = cache.create_replacement_token(&new.node_id).unwrap();
    assert_eq!(
        cache
            .pair_worker(&restore, "New", "1.1.1", &stream)
            .unwrap()
            .node_id,
        old.node_id
    );
    let ordinary = cache.create_pairing_token().unwrap();
    assert_ne!(
        cache
            .pair_worker(&ordinary, "Other", "1.1.1", &stream)
            .unwrap()
            .node_id,
        old.node_id
    );
}

#[test]
fn local_replacement_requires_installation_proof() {
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    cache.configure_local_worker("local-key").unwrap();
    let stream = uuid::Uuid::new_v4().to_string();
    let token = cache.create_pairing_token().unwrap();
    let proof = crate::sync::local_worker_proof("local-key", "hub", &token, &stream);
    cache
        .pair_worker_with_origin(&token, "Local", "1.1.1", &stream, Some(("hub", &proof)))
        .unwrap();
    let token = cache.create_replacement_token("local").unwrap();
    assert!(
        cache
            .pair_worker(&token, "Impostor", "1.1.1", &stream)
            .is_err()
    );
    let proof = crate::sync::local_worker_proof("local-key", "hub", &token, &stream);
    assert_eq!(
        cache
            .pair_worker_with_origin(&token, "Local", "1.1.1", &stream, Some(("hub", &proof)))
            .unwrap()
            .node_id,
        "local"
    );
}

#[test]
fn ignored_missing_source_clears_when_worker_finds_it_again() {
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let stream = uuid::Uuid::new_v4().to_string();
    let grant = cache
        .pair_worker(&token, "studio", "1.1.1", &stream)
        .unwrap();
    let hello = |presence| crate::sync::WorkerHello {
        collection_status: Some(crate::sync::CollectionStatus {
            sources: Some(
                [(
                    "zcode".into(),
                    crate::discovery::AgentCollectionStatus {
                        presence,
                        complete: true,
                        error: None,
                    },
                )]
                .into(),
            ),
            rescan: None,
            active_agent: None,
            last_success_at: None,
            errors: Default::default(),
        }),
        collection_complete: true,
        collection_error: None,
        epoch: Some(grant.epoch.clone()),
        confirmed_sequence: 0,
        version: "1.1.1".into(),
        protocol_version: 1,
        payload_version: 1,
        stream_id: stream.clone(),
        queue: crate::sync::QueueStatus {
            batches: 0,
            bytes: 0,
            oldest_at: None,
        },
        rescan: None,
        host: Some(crate::sync::HostInfo {
            hostname: "studio".into(),
            os: "linux".into(),
            arch: "x86_64".into(),
        }),
    };
    let ignored = |cache: &Cache| cache.nodes().unwrap()[0].ignored_sources.clone();

    cache
        .worker_hello(
            &grant.node_id,
            &hello(crate::discovery::SourcePresence::Missing),
            "1.1.1",
        )
        .unwrap();
    cache
        .set_source_ignored(&grant.node_id, "zcode", true)
        .unwrap();
    cache
        .worker_hello(
            &grant.node_id,
            &hello(crate::discovery::SourcePresence::Missing),
            "1.1.1",
        )
        .unwrap();
    assert_eq!(ignored(&cache), ["zcode"]);
    assert_eq!(
        cache.nodes().unwrap()[0]
            .health
            .as_ref()
            .unwrap()
            .host
            .as_ref()
            .unwrap()
            .os,
        "linux"
    );

    cache
        .worker_hello(
            &grant.node_id,
            &hello(crate::discovery::SourcePresence::Available),
            "1.1.1",
        )
        .unwrap();
    assert!(ignored(&cache).is_empty());
    assert!(cache.set_source_ignored("unknown", "zcode", true).is_err());
}
