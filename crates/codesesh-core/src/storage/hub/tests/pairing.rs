use super::*;

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
fn local_pairing_requires_bound_proof_and_preserves_existing_history() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = Cache::open(None).unwrap();
    let mut original = crate::storage::tests::source(dir.path(), "existing");
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
                sessions: vec![crate::storage::tests::source(dir.path(), "retained")],
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
