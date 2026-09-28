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
    let stream = uuid::Uuid::new_v4().to_string();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &stream)
        .unwrap();
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
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    let session = super::super::tests::source(dir.path(), "shared");
    let mut batch = ScanBatch {
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
    batch.sessions[0].head.title = "Renamed".into();
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    let renamed = cache.head(&head.reference).unwrap().unwrap();
    assert_eq!(renamed.title, "Renamed");
    assert_eq!(
        cache.detail(renamed).unwrap().unwrap().messages,
        detail.messages
    );
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
                grant.node_id.clone(),
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
    worker.save_batch("codex", &mut batch).unwrap();
    let hello = crate::sync::WorkerHello {
        collection_complete: true,
        collection_error: None,
        epoch: Some(grant.epoch.clone()),
        confirmed_sequence: worker.confirmed_sequence().unwrap(),
        version: "1.1.1".into(),
        protocol_version: 1,
        payload_version: 1,
        stream_id: worker.stream_id().unwrap(),
        queue: worker.queue_status().unwrap(),
        rescan: worker.rescan_progress().unwrap(),
    };
    assert!(hello.rescan.as_ref().unwrap().target_sequence.is_some());
    cache.worker_hello(&grant.node_id, &hello, "1.1.1").unwrap();
    assert_eq!(cache.rescan_tasks().unwrap()[0].status, "uploading");
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
