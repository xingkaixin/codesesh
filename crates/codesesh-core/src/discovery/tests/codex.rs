use super::*;

#[test]
fn codex_parser_upgrade_corrects_cached_activity_without_source_changes() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("codex");
    let sessions = root.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let path = sessions.join("rollout-2026-01-01-00000000-0000-0000-0000-000000000001.jsonl");
    let records = [
        serde_json::json!({"type":"session_meta","timestamp":1000,"payload":{"cwd":"/project"}}),
        serde_json::json!({"type":"response_item","timestamp":2000,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Hello"}]}}),
        serde_json::json!({"type":"event_msg","timestamp":3000,"payload":{"type":"task_complete"}}),
        serde_json::json!({"type":"event_msg","timestamp":4000,"payload":{"type":"thread_settings_applied"}}),
    ];
    std::fs::write(
        &path,
        records
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    let source = AgentSource {
        agent: "codex".into(),
        data_root: root,
        scan_path: sessions,
    };
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut initial = scanner.refresh(None).unwrap();
    cache
        .apply_checkpoint(
            &mut initial.sessions,
            &initial.removed,
            "codex",
            &initial.checkpoint,
            initial.complete,
        )
        .unwrap();
    initial.on_reject.take();
    cache
        .connection()
        .execute(
            "UPDATE sessions SET time_updated=4000,activity_time=4000 WHERE agent_name='codex'",
            [],
        )
        .unwrap();
    cache.connection().execute("UPDATE cache_meta SET value=json_set(value,'$.parserVersion','rust-parser-v3') WHERE key='rust_source_state:codex'", []).unwrap();
    assert_eq!(cache.snapshot().unwrap()[0].time_updated, 4000.0);
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut revised = scanner.refresh(None).unwrap();
    assert_eq!(revised.sessions.len(), 1);
    assert_eq!(revised.sessions[0].head.time_updated, 3000.0);
    cache
        .apply_checkpoint(
            &mut revised.sessions,
            &revised.removed,
            "codex",
            &revised.checkpoint,
            revised.complete,
        )
        .unwrap();
    revised.on_reject.take();
    assert_eq!(cache.snapshot().unwrap()[0].time_updated, 3000.0);
    let mut scanner = AgentScanner::new(source, db, pricing);
    assert!(scanner.refresh(None).unwrap().sessions.is_empty());
}

#[test]
fn codex_title_index_refresh_only_parses_the_renamed_session() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("codex");
    let sessions = root.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let ids = [
        "019f0000-0000-0000-0000-000000000001",
        "019f0000-0000-0000-0000-000000000002",
    ];
    for id in ids {
        std::fs::write(sessions.join(format!("rollout-2026-09-01T00-00-00-{id}.jsonl")), format!("{}\n{}\n", serde_json::json!({"type":"session_meta","timestamp":"2026-09-01T00:00:00Z","payload":{"id":id,"cwd":"/tmp/codex-index-fixture"}}),serde_json::json!({"type":"response_item","timestamp":"2026-09-01T00:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Initial"}]}}))).unwrap();
    }
    let source = AgentSource {
        agent: "codex".into(),
        data_root: root.clone(),
        scan_path: sessions,
    };
    let db = temporary.path().join("cache.db");
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source, db, std::sync::Arc::new(Pricing::bundled()));
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 2);
    cache
        .apply_checkpoint(
            &mut initial.sessions,
            &initial.removed,
            "codex",
            &initial.checkpoint,
            initial.complete,
        )
        .unwrap();
    initial.on_reject.take();
    let index = root.join("session_index.jsonl");
    std::fs::write(
        &index,
        serde_json::json!({"id":ids[0],"thread_name":"Renamed"}).to_string(),
    )
    .unwrap();
    let mut renamed = scanner.refresh(Some(std::slice::from_ref(&index))).unwrap();
    assert_eq!(renamed.sessions.len(), 1);
    assert_eq!(renamed.sessions[0].head.title, "Renamed");
    cache
        .apply_checkpoint(
            &mut renamed.sessions,
            &renamed.removed,
            "codex",
            &renamed.checkpoint,
            renamed.complete,
        )
        .unwrap();
    renamed.on_reject.take();
    let unchanged = scanner.refresh(Some(&[index])).unwrap();
    assert!(unchanged.sessions.is_empty());
}

fn write_codex_rollout(directory: &Path, id: usize) -> std::path::PathBuf {
    std::fs::create_dir_all(directory).unwrap();
    let path = directory.join(format!(
        "rollout-2026-01-01-00000000-0000-0000-0000-{id:012}.jsonl"
    ));
    let records = [
        serde_json::json!({"type":"session_meta","timestamp":1000,"payload":{"cwd":"/tmp/codex-compression-fixture"}}),
        serde_json::json!({"type":"response_item","timestamp":2000,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("Question {id}")}]}}),
    ];
    std::fs::write(
        &path,
        records
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    path
}

fn compress_codex_rollout(path: &Path) -> std::path::PathBuf {
    let compressed = path.with_extension("jsonl.zst");
    let bytes = zstd::stream::encode_all(std::fs::File::open(path).unwrap(), 3).unwrap();
    std::fs::write(&compressed, bytes).unwrap();
    std::fs::remove_file(path).unwrap();
    compressed
}

#[test]
fn codex_compression_resume_and_archive_keep_cached_identity() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("codex");
    let path = write_codex_rollout(&root.join("sessions"), 1);
    let original = std::fs::read(&path).unwrap();
    let source = AgentSource {
        agent: "codex".into(),
        scan_path: root.join("sessions"),
        data_root: root.clone(),
    };
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut initial = scanner.refresh(None).unwrap();
    let reference = initial.sessions[0].head.reference.clone();
    let messages = initial.sessions[0].detail.messages.clone();
    cache
        .apply_checkpoint(
            &mut initial.sessions,
            &initial.removed,
            "codex",
            &initial.checkpoint,
            initial.complete,
        )
        .unwrap();
    initial.on_reject.take();
    let compressed = compress_codex_rollout(&path);
    let mut updated = scanner
        .refresh(Some(&[path.clone(), compressed.clone()]))
        .unwrap();
    assert!(updated.removed.is_empty());
    assert_eq!(updated.sessions.len(), 1);
    assert_eq!(updated.sessions[0].head.reference, reference);
    assert_eq!(updated.sessions[0].source, path);
    assert_eq!(updated.sessions[0].detail.messages, messages);
    cache
        .apply_checkpoint(
            &mut updated.sessions,
            &updated.removed,
            "codex",
            &updated.checkpoint,
            updated.complete,
        )
        .unwrap();
    updated.on_reject.take();
    let mut scanner = AgentScanner::new(source, db, pricing);
    let mut restarted = scanner.refresh(None).unwrap();
    assert!(restarted.sessions.is_empty());
    assert!(restarted.removed.is_empty());
    restarted.on_reject.take();
    std::fs::write(&path, &original).unwrap();
    let mut resumed = scanner.refresh(Some(std::slice::from_ref(&path))).unwrap();
    assert_eq!(resumed.sessions.len(), 1);
    assert_eq!(resumed.sessions[0].detail.messages, messages);
    assert!(resumed.removed.is_empty());
    resumed.on_reject.take();
    std::fs::remove_file(&compressed).unwrap();
    let mut unchanged = scanner
        .refresh(Some(std::slice::from_ref(&compressed)))
        .unwrap();
    assert!(unchanged.sessions.is_empty());
    assert!(unchanged.removed.is_empty());
    unchanged.on_reject.take();
    let archived_dir = root.join("archived_sessions");
    std::fs::create_dir_all(&archived_dir).unwrap();
    let archived = archived_dir.join(path.file_name().unwrap());
    std::fs::rename(&path, &archived).unwrap();
    let compressed = compress_codex_rollout(&archived);
    let mut moved = scanner.refresh(Some(&[path, compressed.clone()])).unwrap();
    assert!(moved.removed.is_empty());
    assert_eq!(moved.sessions.len(), 1);
    assert_eq!(moved.sessions[0].head.reference, reference);
    assert_eq!(moved.sessions[0].detail.messages, messages);
    moved.on_reject.take();
    std::fs::write(&compressed, b"invalid zstd").unwrap();
    assert!(
        scanner
            .refresh(Some(std::slice::from_ref(&compressed)))
            .is_err()
    );
    std::fs::remove_file(&compressed).unwrap();
    let deleted = scanner.refresh(Some(&[compressed])).unwrap();
    assert_eq!(deleted.removed, [reference]);
}

#[test]
fn codex_archived_only_store_is_discovered_and_watched() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    let path = write_codex_rollout(&root.join("archived_sessions"), 1);
    compress_codex_rollout(&path);
    let source = AgentSource {
        agent: "codex".into(),
        scan_path: root.join("sessions"),
        data_root: root.to_owned(),
    };
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let full = scan_source(&source, &pricing).unwrap();
    assert!(full.available);
    assert_eq!(full.sessions.len(), 1);
    let mut scanner = AgentScanner::new(source, root.join("cache.db"), pricing);
    let mut batch = scanner.refresh(None).unwrap();
    assert_eq!(batch.sessions.len(), 1);
    assert_eq!(
        batch.sessions[0].detail.messages,
        full.sessions[0].detail.messages
    );
    batch.on_reject.take();
    assert!(
        scanner
            .into_runtime_source()
            .roots
            .contains(&root.join("archived_sessions"))
    );
}

#[test]
fn codex_compression_during_backfill_does_not_remove_prior_batches() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    for id in 0..40 {
        write_codex_rollout(&root.join("sessions"), id);
    }
    let source = AgentSource {
        agent: "codex".into(),
        scan_path: root.join("sessions"),
        data_root: root.to_owned(),
    };
    let mut scanner = AgentScanner::new(
        source,
        root.join("cache.db"),
        std::sync::Arc::new(Pricing::bundled()),
    );
    let mut first = scanner.refresh(None).unwrap();
    assert!(!first.complete);
    let mut references: std::collections::HashSet<_> = first
        .sessions
        .iter()
        .map(|session| session.head.reference.clone())
        .collect();
    let mut changed = Vec::new();
    for entry in std::fs::read_dir(root.join("sessions")).unwrap() {
        changed.push(compress_codex_rollout(&entry.unwrap().path()));
    }
    first.on_reject.take();
    let mut checkpoint = first.checkpoint.take();
    for pass in 0..10 {
        let mut batch = scanner
            .refresh_with_checkpoint(
                (pass == 0).then_some(changed.as_slice()),
                checkpoint.as_ref(),
            )
            .unwrap();
        assert!(batch.removed.is_empty());
        references.extend(
            batch
                .sessions
                .iter()
                .map(|session| session.head.reference.clone()),
        );
        batch.on_reject.take();
        checkpoint = batch.checkpoint.take();
        if batch.complete {
            assert_eq!(references.len(), 40);
            return;
        }
    }
    panic!("Codex backfill did not complete");
}
