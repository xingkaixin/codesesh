use super::*;

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
        sessions: vec![crate::storage::tests::source(dir.path(), "shared")],
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
