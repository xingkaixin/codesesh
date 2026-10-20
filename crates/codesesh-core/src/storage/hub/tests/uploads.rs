use super::*;

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
    let session = crate::storage::tests::source(dir.path(), "shared");
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
fn receiver_accepts_metadata_that_does_not_survive_a_json_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(Some(&dir.path().join("hub.db"))).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![crate::storage::tests::source(dir.path(), "shared")],
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);
    batch.sessions[0].head.summary_files = Some(serde_json::Value::Null);
    batch.sessions[0].head.title = "Renamed".into();
    worker.save_batch("codex", &mut batch).unwrap();
    assert!(matches!(
        worker.next_upload().unwrap().unwrap().operation,
        Operation::Metadata { .. }
    ));
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(worker.queue_status().unwrap().batches, 0);
    assert_eq!(cache.snapshot().unwrap()[0].title, "Renamed");
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
    let mut session = crate::storage::tests::source(dir.path(), "chunked");
    session.detail.messages[0].parts = vec![crate::model::MessagePart::Text {
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
        .push(crate::storage::tests::source(dir.path(), "shared"));
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
        sessions: vec![crate::storage::tests::source(dir.path(), "shared")],
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
        sessions: vec![crate::storage::tests::source(dir.path(), "shared")],
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
fn deltas_rebuild_the_full_session_and_fall_back_to_a_rescan() {
    let dir = tempfile::tempdir().unwrap();
    let save = |worker: &mut WorkerStore, session: &crate::agents::ParsedSession| {
        let mut batch = ScanBatch {
            source_presence: None,
            sessions: vec![session.clone()],
            removed: Vec::new(),
            checkpoint: None,
            complete: true,
            on_reject: None,
            pricing: None,
        };
        worker.save_batch("codex", &mut batch).unwrap();
    };
    let connect = |name: &str| {
        let worker = WorkerStore::open(&dir.path().join(format!("{name}-worker.db"))).unwrap();
        let mut hub = Cache::open(Some(&dir.path().join(format!("{name}-hub.db")))).unwrap();
        hub.initialize_hub("hub-fixture").unwrap();
        let token = hub.create_pairing_token().unwrap();
        let grant = hub
            .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
            .unwrap();
        (worker, hub, grant)
    };
    let append = |session: &crate::agents::ParsedSession, id: &str| {
        let mut next = session.clone();
        let mut message = next.detail.messages[0].clone();
        message.id = id.into();
        next.detail.messages.push(message);
        next.head.stats.message_count = next.detail.messages.len();
        next.detail.head = next.head.clone();
        next
    };
    let messages = |hub: &Cache, grant: &PairingGrant| {
        let mut reference = hub.snapshot().unwrap()[0].reference.clone();
        reference.source_node_id = grant.node_id.clone();
        let head = hub.head(&reference).unwrap().unwrap();
        serde_json::to_value(hub.detail(head).unwrap().unwrap().messages).unwrap()
    };
    let first = crate::storage::tests::source(dir.path(), "shared");
    let second = append(&first, "second");

    let (mut worker, mut delta_hub, delta_grant) = connect("delta");
    save(&mut worker, &first);
    transfer(&mut delta_hub, &mut worker, &delta_grant);
    save(&mut worker, &second);
    let mut commits = Vec::new();
    while let Some(pending) = worker.next_upload().unwrap() {
        if let Operation::SnapshotCommit { base, .. } = &pending.operation {
            commits.push(base.clone());
        }
        let upload = Upload {
            epoch: delta_grant.epoch.clone(),
            stream_id: worker.stream_id().unwrap(),
            sequence: pending.sequence,
            payload_version: pending.payload_version,
            digest: pending.digest,
            operation: pending.operation,
        };
        let receipt = delta_hub
            .receive_upload(&delta_grant.node_id, &upload, &Pricing::bundled())
            .unwrap();
        worker
            .acknowledge(&receipt.stream_id, receipt.sequence, &receipt.digest)
            .unwrap();
    }
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].as_ref().map(|base| base.keep), Some(1));

    let (mut full_worker, mut full_hub, full_grant) = connect("full");
    save(&mut full_worker, &second);
    transfer(&mut full_hub, &mut full_worker, &full_grant);
    assert_eq!(
        messages(&delta_hub, &delta_grant),
        messages(&full_hub, &full_grant)
    );

    delta_hub
        .connection()
        .execute("UPDATE hub_message_bases SET digest='stale'", [])
        .unwrap();
    save(&mut worker, &append(&second, "third"));
    transfer(&mut delta_hub, &mut worker, &delta_grant);
    assert_eq!(
        messages(&delta_hub, &delta_grant).as_array().unwrap().len(),
        2
    );
    let rescans = delta_hub.rescan_tasks().unwrap();
    assert_eq!(rescans.len(), 1);
    assert_eq!(rescans[0].request.agents, ["codex"]);
    assert_eq!(delta_hub.nodes().unwrap()[0].incomplete_sessions, 1);
    worker
        .begin_rescan(&rescans[0].request, &["codex".into()])
        .unwrap();
    save(&mut worker, &append(&second, "third"));
    transfer(&mut delta_hub, &mut worker, &delta_grant);
    assert_eq!(delta_hub.nodes().unwrap()[0].incomplete_sessions, 0);
}
