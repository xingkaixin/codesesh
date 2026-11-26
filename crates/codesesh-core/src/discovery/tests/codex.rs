use super::*;

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
        antigravity_profiles: None,
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
        antigravity_profiles: None,
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
        antigravity_profiles: None,
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
    assert!(scanner.into_runtime_source().roots.resolve().contains(
        &crate::runtime::WatchRoot::recursive(root.join("archived_sessions"))
    ));
}

#[test]
fn codex_compression_during_backfill_does_not_remove_prior_batches() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path();
    for id in 0..40 {
        write_codex_rollout(&root.join("sessions"), id);
    }
    let source = AgentSource {
        antigravity_profiles: None,
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

#[test]
fn parser_version_upgrade_restarts_nonzero_checkpoint_and_recovers_deleted_worktree_sessions() {
    assert_eq!(
        crate::agents::parser_version("codex"),
        crate::agents::parser_version("grok")
    );
    assert_eq!(
        crate::agents::parser_version("antigravity-cli"),
        "rust-parser-v12"
    );
    assert_eq!(
        crate::agents::parser_version("claudecode"),
        "rust-parser-v6"
    );

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("codex");
    let sessions = root.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let deleted_dir = temporary.path().join("deleted/.t3/worktrees/codesesh/t3-1");
    for id in 0..33 {
        let uuid = format!("00000000-0000-0000-0000-{id:012}");
        let path = sessions.join(format!("rollout-2026-09-01T00-00-00-{uuid}.jsonl"));
        let records = [
            serde_json::json!({
                "type": "session_meta",
                "timestamp": "2026-09-01T00:00:00Z",
                "payload": {
                    "id": uuid,
                    "cwd": deleted_dir,
                    "git": {"repository_url": "git@github.com:xingkaixin/codesesh.git"}
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "timestamp": "2026-09-01T00:00:01Z",
                "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": format!("Work {id}")}]}
            }),
        ];
        std::fs::write(
            &path,
            records
                .iter()
                .map(|r| format!("{r}\n"))
                .collect::<Vec<_>>()
                .join(""),
        )
        .unwrap();
    }

    let source = AgentSource {
        antigravity_profiles: None,
        agent: "codex".into(),
        data_root: root.clone(),
        scan_path: sessions,
    };
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut page1 = scanner.refresh(None).unwrap();
    assert_eq!(page1.sessions.len(), 32);
    assert!(!page1.complete);
    let mut stale_checkpoint = page1.checkpoint.clone().unwrap();
    cache
        .apply_checkpoint(
            &mut page1.sessions,
            &page1.removed,
            "codex",
            &page1.checkpoint,
            page1.complete,
        )
        .unwrap();
    page1.on_reject.take();
    let mut page2 = scanner
        .refresh_with_checkpoint(None, Some(&stale_checkpoint))
        .unwrap();
    assert_eq!(page2.sessions.len(), 1);
    assert!(page2.complete);
    cache
        .apply_checkpoint(
            &mut page2.sessions,
            &page2.removed,
            "codex",
            &page2.checkpoint,
            page2.complete,
        )
        .unwrap();
    page2.on_reject.take();

    // Simulate pre-fix cache: path identity, old parserVersion, and a mid-backfill non-zero offset.
    cache
        .connection()
        .execute(
            "UPDATE sessions SET project_identity_kind='path',project_identity_key=?1,project_display_name='t3-1',head_meta_json='{}'",
            [deleted_dir.to_string_lossy().as_ref()],
        )
        .unwrap();
    cache
        .connection()
        .execute(
            "UPDATE cache_meta SET value=json_set(value,'$.parserVersion','rust-parser-v10') WHERE key='rust_source_state:codex'",
            [],
        )
        .unwrap();
    stale_checkpoint["sourceState"]["parserVersion"] = serde_json::json!("rust-parser-v10");
    assert_eq!(stale_checkpoint["offset"], 32);

    let mut upgraded = AgentScanner::new(source, db, pricing);
    let mut checkpoint = Some(stale_checkpoint);
    let mut repaired = 0;
    loop {
        let mut batch = upgraded
            .refresh_with_checkpoint(None, checkpoint.as_ref())
            .unwrap();
        repaired += batch.sessions.len();
        checkpoint = batch.checkpoint.clone();
        cache
            .apply_checkpoint(
                &mut batch.sessions,
                &batch.removed,
                "codex",
                &batch.checkpoint,
                batch.complete,
            )
            .unwrap();
        batch.on_reject.take();
        if batch.complete {
            break;
        }
    }
    assert_eq!(repaired, 33);
    let snapshot = cache.snapshot().unwrap();
    assert_eq!(snapshot.len(), 33);
    assert!(snapshot.iter().all(|head| {
        head.project_identity.kind == "git_remote"
            && head.project_identity.key == "github.com/xingkaixin/codesesh"
            && head.recorded_git_remotes == ["github.com/xingkaixin/codesesh"]
    }));
}

#[test]
fn worktree_lifecycle_keeps_identity_and_display_name_after_deletion_without_cache_illusion() {
    let temporary = tempfile::tempdir().unwrap();
    let canonical = temporary.path().canonicalize().unwrap();
    #[cfg(windows)]
    let canonical = {
        let path = canonical.to_str().unwrap();
        if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{path}"))
        } else {
            std::path::PathBuf::from(path.strip_prefix(r"\\?\").unwrap_or(path))
        }
    };
    let repo = canonical.join("repo");
    let worktree = canonical.join("worktree");
    std::fs::create_dir(&repo).unwrap();
    let run_git = |args: &[&str]| {
        assert!(
            std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    run_git(&["init"]);
    run_git(&[
        "remote",
        "add",
        "origin",
        "git@github.com:xingkaixin/codesesh.git",
    ]);
    run_git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
    ]);
    run_git(&["worktree", "add", "-b", "wt", worktree.to_str().unwrap()]);
    std::fs::write(
        worktree.join("package.json"),
        r#"{"name":"codesesh-monorepo"}"#,
    )
    .unwrap();

    let codex_root = canonical.join("codex");
    let codex_sessions = codex_root.join("sessions");
    std::fs::create_dir_all(&codex_sessions).unwrap();
    let codex_file =
        codex_sessions.join("rollout-2026-09-01-00000000-0000-0000-0000-000000000055.jsonl");
    std::fs::write(
        &codex_file,
        format!(
            "{}\n{}\n",
            serde_json::json!({
                "type": "session_meta",
                "timestamp": "2026-09-01T00:00:00Z",
                "payload": {
                    "id": "00000000-0000-0000-0000-000000000055",
                    "cwd": worktree,
                    "git": {"repository_url": "git@github.com:xingkaixin/codesesh.git"}
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "timestamp": "2026-09-01T00:00:01Z",
                "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Codex initial"}]}
            }),
        ),
    )
    .unwrap();

    let pi_source = pi_source(&canonical.join("pi"));
    std::fs::create_dir_all(&pi_source.scan_path).unwrap();
    let pi_file = pi_source.scan_path.join("session.jsonl");
    std::fs::write(
        &pi_file,
        format!(
            "{}\n{}\n",
            serde_json::json!({"type": "session", "cwd": worktree, "timestamp": 1000}),
            serde_json::json!({"type": "message", "id": "u1", "parentId": null, "message": {"role": "user", "content": "Pi initial"}}),
        ),
    )
    .unwrap();

    let codex_source = AgentSource {
        antigravity_profiles: None,
        agent: "codex".into(),
        data_root: codex_root,
        scan_path: codex_sessions,
    };
    let db = canonical.join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();

    crate::projects::clear_identity_cache();
    for (agent_name, source) in [("codex", &codex_source), ("pi", &pi_source)] {
        let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
        let mut batch = scanner.refresh(None).unwrap();
        assert_eq!(batch.sessions.len(), 1);
        assert_eq!(batch.sessions[0].head.project_identity.kind, "git_remote");
        assert_eq!(
            batch.sessions[0].head.project_identity.key,
            "github.com/xingkaixin/codesesh"
        );
        assert_eq!(
            batch.sessions[0].head.project_identity.display_name,
            "codesesh-monorepo"
        );
        cache
            .apply_checkpoint(
                &mut batch.sessions,
                &batch.removed,
                agent_name,
                &batch.checkpoint,
                batch.complete,
            )
            .unwrap();
        batch.on_reject.take();
    }

    let json_db = canonical.join("json-cache.db");
    let initial_json = crate::discovery::json_scan::run(
        &[codex_source.clone(), pi_source.clone()],
        &ScanOptions::default(),
        &pricing,
        &json_db,
        "local",
        |_, _| {},
    )
    .unwrap();
    assert_eq!(initial_json.sessions.len(), 2);
    assert!(initial_json.sessions.iter().all(|head| {
        head.project_identity.display_name == "codesesh-monorepo"
            && head.recorded_git_remotes.is_empty()
    }));

    // Delete the worktree and clear the in-process directory cache to rule out stale cache hits.
    std::fs::remove_dir_all(&worktree).unwrap();
    crate::projects::clear_identity_cache();

    for source in [&codex_source, &pi_source] {
        let mut cold_scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
        let mut cold = cold_scanner.refresh(None).unwrap();
        assert!(cold.sessions.is_empty());
        assert!(cold.removed.is_empty());
        cold.on_reject.take();
    }

    let warm_json_db = crate::storage::Cache::open(Some(&json_db)).unwrap();
    warm_json_db.connection().execute_batch("CREATE TRIGGER reject_json_reparse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'deleted worktree invalidated json scan'); END").unwrap();
    drop(warm_json_db);
    crate::projects::clear_identity_cache();
    let warm_json = crate::discovery::json_scan::run(
        &[codex_source.clone(), pi_source.clone()],
        &ScanOptions::default(),
        &pricing,
        &json_db,
        "local",
        |_, _| {},
    )
    .unwrap();
    assert!(warm_json.sessions.iter().all(|head| {
        head.project_identity.kind == "git_remote"
            && head.project_identity.key == "github.com/xingkaixin/codesesh"
            && head.project_identity.display_name == "codesesh-monorepo"
    }));

    // Appending after worktree deletion triggers incremental re-parse without losing identity or name.
    use std::io::Write;
    writeln!(
        std::fs::OpenOptions::new().append(true).open(&codex_file).unwrap(),
        "{}",
        serde_json::json!({
            "type": "response_item",
            "timestamp": "2026-09-01T00:00:02Z",
            "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Codex reply"}]}
        })
    )
    .unwrap();
    writeln!(
        std::fs::OpenOptions::new().append(true).open(&pi_file).unwrap(),
        "{}",
        serde_json::json!({"type": "message", "id": "a1", "parentId": "u1", "message": {"role": "assistant", "content": "Pi reply"}})
    )
    .unwrap();
    crate::projects::clear_identity_cache();

    for (agent_name, source, changed_path) in [
        ("codex", &codex_source, &codex_file),
        ("pi", &pi_source, &pi_file),
    ] {
        let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
        let mut updated = scanner
            .refresh(Some(std::slice::from_ref(changed_path)))
            .unwrap();
        assert_eq!(updated.sessions.len(), 1);
        assert_eq!(updated.sessions[0].head.project_identity.kind, "git_remote");
        assert_eq!(
            updated.sessions[0].head.project_identity.key,
            "github.com/xingkaixin/codesesh"
        );
        assert_eq!(
            updated.sessions[0].head.project_identity.display_name,
            "codesesh-monorepo"
        );
        cache
            .apply_checkpoint(
                &mut updated.sessions,
                &updated.removed,
                agent_name,
                &updated.checkpoint,
                updated.complete,
            )
            .unwrap();
        updated.on_reject.take();
    }
}
