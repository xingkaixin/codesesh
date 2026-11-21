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
        completion: None,
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
        completion: None,
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
            data: None,
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
    let mut session = crate::storage::tests::source(dir.path(), "shared");
    session.detail.messages[0].parts = vec![crate::model::MessagePart::Text {
        text: "x".repeat(300_000),
        time_created: None,
    }];
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![session],
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        completion: None,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    let stream = worker.stream_id().unwrap();
    let mut staged_chunks = 0;
    let commit = loop {
        let pending = worker.next_upload().unwrap().unwrap();
        if matches!(pending.operation, Operation::SnapshotCommit { .. }) {
            break pending;
        }
        let upload = Upload {
            epoch: grant.epoch.clone(),
            stream_id: stream.clone(),
            sequence: pending.sequence,
            payload_version: pending.payload_version,
            digest: pending.digest,
            operation: pending.operation,
        };
        cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .unwrap();
        worker
            .acknowledge(&upload.stream_id, upload.sequence, &upload.digest)
            .unwrap();
        staged_chunks += 1;
    };
    assert!(staged_chunks > 1);
    cache.connection.execute_batch("CREATE TRIGGER reject_receipt BEFORE UPDATE OF confirmed_sequence ON hub_nodes BEGIN SELECT RAISE(ABORT,'disk failure'); END;").unwrap();
    let upload = Upload {
        epoch: grant.epoch.clone(),
        stream_id: stream,
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
        staged_chunks
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
        completion: None,
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
            completion: None,
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

#[test]
fn identity_recovery_moves_file_activity_and_stats_and_metadata_preserves_recorded_remotes() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(Some(&dir.path().join("hub.db"))).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.1.1", &worker.stream_id().unwrap())
        .unwrap();

    let mut session = crate::storage::tests::source(dir.path(), "recovery");
    session.detail.messages.push(crate::model::Message {
        cost_inputs: Vec::new(),
        id: "tool-1".into(),
        role: crate::model::Role::Assistant,
        time_created: 2000.0,
        time_completed: Some(2100.0),
        agent: None,
        mode: None,
        model: Some("gpt-5".into()),
        provider: Some("openai".into()),
        tokens: None,
        cost: Some(0.25),
        cost_source: Some(crate::model::CostSource::Recorded),
        cost_breakdown: None,
        parts: vec![crate::model::MessagePart::Tool {
            tool: "read".into(),
            call_id: Some("call-read".into()),
            time_created: Some(2000.0),
            state: Box::new(crate::model::ToolState {
                status: crate::model::ToolPartStatus::Completed,
                input: Some(serde_json::json!({"file_path": "/fixture/src/main.rs"})),
                output: None,
                error: None,
                metadata: None,
            }),
            title: None,
        }],
        subagent_id: None,
        nickname: None,
        automated: None,
    });
    session.head.stats.message_count = session.detail.messages.len();
    session.head.stats.total_cost = 0.25;
    session.head.stats.cost_source = Some(crate::model::CostSource::Recorded);
    session.detail.head = session.head.clone();
    crate::agents::complete_projections(&mut session);
    assert_eq!(session.detail.file_activity.len(), 1);

    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![session.clone()],
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        completion: None,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);

    let mut recovered = session;
    recovered.head.recorded_git_remotes = vec!["git@github.com:acme/app.git".into()];
    crate::agents::complete_projections(&mut recovered);
    batch.sessions = vec![recovered];
    worker.save_batch("codex", &mut batch).unwrap();
    transfer(&mut cache, &mut worker, &grant);

    let snapshot = cache.snapshot().unwrap();
    assert_eq!(snapshot.len(), 1);
    let hub_head = &snapshot[0];
    assert_eq!(hub_head.project_identity.kind, "git_remote");
    assert_eq!(
        hub_head.project_identity.key,
        format!("@{}/github.com/acme/app", grant.node_id)
    );
    assert_eq!(hub_head.recorded_git_remotes, vec!["github.com/acme/app"]);

    let activity_key: String = cache
        .connection
        .query_row(
            "SELECT project_identity_key FROM session_file_activity",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(activity_key, hub_head.project_identity.key);

    let facts = crate::analytics::CostFactsIndex::from(
        crate::analytics::load_cost_facts(cache.connection(), None, None, true).unwrap(),
    );
    let scope = crate::analytics::DashboardScope::default();
    let time_zone = "UTC".parse().unwrap();
    let dashboard = crate::analytics::build_dashboard(
        &snapshot,
        &crate::analytics::DashboardOptions {
            from: None,
            to: 9_999_999_999_999.0,
            compare: None,
            scope: &scope,
            time_zone: &time_zone,
            cost_facts: Some(&facts),
            by_agent_names: &[],
            agent_info: None,
        },
    )
    .unwrap();
    assert_eq!(dashboard.totals.sessions, 1);
    assert!((dashboard.totals.cost - 0.25).abs() < 1e-9);
    assert_eq!(dashboard.per_project.len(), 1);
    assert_eq!(
        dashboard.per_project[0].identity_kind,
        crate::model::ProjectIdentityKind::GitRemote
    );
    assert_eq!(
        dashboard.per_project[0].identity_key,
        hub_head.project_identity.key
    );

    batch.sessions[0].head.title = "Metadata Only".into();
    batch.sessions[0].detail.head = batch.sessions[0].head.clone();
    worker.save_batch("codex", &mut batch).unwrap();
    assert!(matches!(
        worker.next_upload().unwrap().unwrap().operation,
        Operation::Metadata { .. }
    ));
    transfer(&mut cache, &mut worker, &grant);
    let updated = cache.head(&hub_head.reference).unwrap().unwrap();
    assert_eq!(updated.title, "Metadata Only");
    assert_eq!(updated.recorded_git_remotes, vec!["github.com/acme/app"]);
}

#[test]
fn inline_single_chunk_commit_round_trips_without_hub_chunks_and_respects_boundary() {
    let dir = tempfile::tempdir().unwrap();
    let mut worker = WorkerStore::open(&dir.path().join("worker.db")).unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(&token, "Laptop", "1.5.0", &worker.stream_id().unwrap())
        .unwrap();
    cache
        .connection
        .execute_batch(
            "CREATE TRIGGER forbid_hub_chunks BEFORE INSERT ON hub_chunks BEGIN SELECT RAISE(ABORT,'unexpected chunk'); END;",
        )
        .unwrap();

    let session = crate::storage::tests::source(dir.path(), "inline");
    let mut batch = ScanBatch {
        source_presence: None,
        sessions: vec![session.clone()],
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        completion: None,
        on_reject: None,
        pricing: None,
    };
    worker.save_batch("codex", &mut batch).unwrap();
    assert_eq!(worker.queue_status().unwrap().batches, 1);
    let pending = worker.next_upload().unwrap().unwrap();
    assert!(matches!(
        pending.operation,
        Operation::SnapshotCommit {
            chunks: 0,
            data: Some(_),
            ..
        }
    ));
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(worker.queue_status().unwrap().batches, 0);
    let head = cache.snapshot().unwrap().remove(0);
    assert_eq!(
        cache.detail(head).unwrap().unwrap().messages,
        session.detail.messages
    );

    // Exact 256 KiB serialized payload stays inline; 256 KiB + 1 spills into SnapshotChunk.
    let mut exact = session;
    let base_len = serde_json::to_vec(&CapturedSession::from_parsed(exact.clone()))
        .unwrap()
        .len();
    let crate::model::MessagePart::Text { text, .. } = &mut exact.detail.messages[0].parts[0]
    else {
        panic!("expected text part");
    };
    let chunk_bytes = 256 * 1024;
    text.push_str(&"a".repeat(chunk_bytes - base_len));
    assert_eq!(
        serde_json::to_vec(&CapturedSession::from_parsed(exact.clone()))
            .unwrap()
            .len(),
        chunk_bytes
    );
    batch.sessions = vec![exact.clone()];
    worker.save_batch("codex", &mut batch).unwrap();
    assert_eq!(worker.queue_status().unwrap().batches, 1);
    assert!(matches!(
        worker.next_upload().unwrap().unwrap().operation,
        Operation::SnapshotCommit {
            chunks: 0,
            bytes,
            data: Some(_),
            ..
        } if bytes == chunk_bytes as u64
    ));
    transfer(&mut cache, &mut worker, &grant);

    cache
        .connection
        .execute_batch("DROP TRIGGER forbid_hub_chunks")
        .unwrap();
    let crate::model::MessagePart::Text { text, .. } = &mut exact.detail.messages[0].parts[0]
    else {
        panic!("expected text part");
    };
    text.push('b');
    assert_eq!(
        serde_json::to_vec(&CapturedSession::from_parsed(exact.clone()))
            .unwrap()
            .len(),
        chunk_bytes + 1
    );
    batch.sessions = vec![exact];
    worker.save_batch("codex", &mut batch).unwrap();
    assert_eq!(worker.queue_status().unwrap().batches, 3);
    assert!(matches!(
        worker.next_upload().unwrap().unwrap().operation,
        Operation::SnapshotChunk { index: 0, .. }
    ));
    transfer(&mut cache, &mut worker, &grant);
    assert_eq!(
        cache
            .connection
            .query_row("SELECT COUNT(*) FROM hub_chunks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn hub_accepts_legacy_chunked_single_snapshot_and_validates_inline_integrity() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = Cache::open(None).unwrap();
    cache.initialize_hub("hub-fixture").unwrap();
    let token = cache.create_pairing_token().unwrap();
    let stream = uuid::Uuid::new_v4().to_string();
    let grant = cache
        .pair_worker(&token, "Legacy", "1.1.1", &stream)
        .unwrap();

    let session = crate::storage::tests::source(dir.path(), "legacy");
    let payload = serde_json::to_vec(&CapturedSession::from_parsed(session.clone())).unwrap();
    let encoded = STANDARD.encode(&payload);
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let make_upload = |sequence: i64, operation: Operation| Upload {
        epoch: grant.epoch.clone(),
        stream_id: stream.clone(),
        sequence,
        payload_version: PAYLOAD_VERSION,
        digest: digest(&serde_json::to_vec(&operation).unwrap()),
        operation,
    };

    // Legacy Worker (v1.1.1-v1.5.0) sends SnapshotChunk + SnapshotCommit without `data`.
    let chunk_op = Operation::SnapshotChunk {
        transfer_id: transfer_id.clone(),
        index: 0,
        data: encoded.clone(),
    };
    cache
        .receive_upload(
            &grant.node_id,
            &make_upload(1, chunk_op),
            &Pricing::bundled(),
        )
        .unwrap();

    // Mixing inline `data` with already-staged `hub_chunks` must fail and preserve the staged chunk.
    let mixed = Operation::SnapshotCommit {
        transfer_id: transfer_id.clone(),
        chunks: 0,
        bytes: payload.len() as u64,
        digest: digest(&payload),
        data: Some(encoded.clone()),
        base: None,
        messages: None,
    };
    assert_eq!(
        cache
            .receive_upload(&grant.node_id, &make_upload(2, mixed), &Pricing::bundled())
            .unwrap_err()
            .to_string(),
        "SNAPSHOT_INCOMPLETE"
    );
    assert_eq!(
        cache
            .connection
            .query_row("SELECT COUNT(*) FROM hub_chunks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );

    // Valid legacy commit deserialized without the optional `data` field succeeds.
    let legacy_commit: Operation = serde_json::from_value(serde_json::json!({
        "type": "snapshot-commit",
        "transfer_id": transfer_id,
        "chunks": 1,
        "bytes": payload.len(),
        "digest": digest(&payload),
    }))
    .unwrap();
    cache
        .receive_upload(
            &grant.node_id,
            &make_upload(2, legacy_commit),
            &Pricing::bundled(),
        )
        .unwrap();
    assert_eq!(cache.snapshot().unwrap().len(), 1);
    assert_eq!(
        cache
            .connection
            .query_row("SELECT COUNT(*) FROM hub_chunks", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );

    // Inline SnapshotCommit integrity rejections.
    let fresh_id = uuid::Uuid::new_v4().to_string();
    for (op, expected_error) in [
        (
            Operation::SnapshotCommit {
                transfer_id: fresh_id.clone(),
                chunks: 1,
                bytes: payload.len() as u64,
                digest: digest(&payload),
                data: Some(encoded.clone()),
                base: None,
                messages: None,
            },
            "SNAPSHOT_INCOMPLETE",
        ),
        (
            Operation::SnapshotCommit {
                transfer_id: fresh_id.clone(),
                chunks: 0,
                bytes: 0,
                digest: digest(b""),
                data: Some(String::new()),
                base: None,
                messages: None,
            },
            "SNAPSHOT_INCOMPLETE",
        ),
        (
            Operation::SnapshotCommit {
                transfer_id: fresh_id.clone(),
                chunks: 0,
                bytes: payload.len() as u64 + 1,
                digest: digest(&payload),
                data: Some(encoded.clone()),
                base: None,
                messages: None,
            },
            "SNAPSHOT_CHECKSUM_MISMATCH",
        ),
        (
            Operation::SnapshotCommit {
                transfer_id: fresh_id.clone(),
                chunks: 0,
                bytes: payload.len() as u64,
                digest: "0".repeat(64),
                data: Some(encoded),
                base: None,
                messages: None,
            },
            "SNAPSHOT_CHECKSUM_MISMATCH",
        ),
        (
            Operation::SnapshotCommit {
                transfer_id: fresh_id,
                chunks: 0,
                bytes: 350_001,
                digest: "0".repeat(64),
                data: Some("A".repeat(350_001)),
                base: None,
                messages: None,
            },
            "Snapshot chunk exceeds transport limit",
        ),
    ] {
        assert_eq!(
            cache
                .receive_upload(&grant.node_id, &make_upload(3, op), &Pricing::bundled())
                .unwrap_err()
                .to_string(),
            expected_error
        );
    }
}
