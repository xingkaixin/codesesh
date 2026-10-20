use super::*;

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
        sessions: vec![crate::storage::tests::source(dir.path(), "shared")],
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
            sessions: vec![crate::storage::tests::source(dir.path(), "queued")],
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
        sessions: vec![crate::storage::tests::source(dir.path(), "shared")],
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
