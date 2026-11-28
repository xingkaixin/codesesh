use super::*;

#[test]
fn incomplete_kimi_sources_keep_both_cached_messages() {
    for (agent, wire_name, message) in [
        (
            "kimi",
            "wire.jsonl",
            r#"{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":[{"text":"hello"}]}}}"#,
        ),
        (
            "kimi-code",
            "agents/main/wire.jsonl",
            r#"{"type":"context.append_message","message":{"role":"user","content":"hello"}}"#,
        ),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let source = environment(temp.path()).source(agent).unwrap();
        let dir = source.scan_path.join("bucket/session");
        let wire = dir.join(wire_name);
        let state = dir.join("state.json");
        std::fs::create_dir_all(wire.parent().unwrap()).unwrap();
        let transcript = format!("{message}\n{message}\n");
        std::fs::write(&wire, &transcript).unwrap();
        std::fs::write(&state, "{}").unwrap();
        let db = temp.path().join("cache.db");
        let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
        let mut scanner = AgentScanner::new(source, db, std::sync::Arc::new(Pricing::bundled()));
        let mut initial = scanner.refresh(None).unwrap();
        assert_eq!(initial.sessions[0].detail.messages.len(), 2);
        let head = initial.sessions[0].head.clone();
        cache
            .apply_checkpoint(
                &mut initial.sessions,
                &initial.removed,
                agent,
                &initial.checkpoint,
                initial.complete,
            )
            .unwrap();
        initial.on_reject.take();
        for companion in [&state, &wire] {
            let backup = temp.path().join("backup");
            std::fs::rename(companion, &backup).unwrap();
            assert!(
                scanner.refresh(None).is_err(),
                "{agent}: {}",
                companion.display()
            );
            std::fs::rename(backup, companion).unwrap();
        }
        std::fs::write(&wire, format!("{message}\n{{broken\n")).unwrap();
        assert!(scanner.refresh(None).is_err());
        assert_eq!(cache.detail(head).unwrap().unwrap().messages.len(), 2);
    }
}

#[test]
fn pi_parent_changes_refresh_cached_children() {
    for restart in [false, true] {
        let temporary = tempfile::tempdir().unwrap();
        let source = pi_source(temporary.path());
        std::fs::create_dir_all(&source.scan_path).unwrap();
        let parent = source.scan_path.join("2026-11-01_parent.jsonl");
        let child = source.scan_path.join("2026-11-02_fork.jsonl");
        let write = |path: &Path, id: &str, parent: Option<&Path>| {
            let header = serde_json::json!({"type":"session","id":id,"cwd":temporary.path(),"timestamp":1000,"parentSession":parent});
            let message = serde_json::json!({"type":"message","id":"u","timestamp":1001,"message":{"role":"user","content":"Review parser"}});
            std::fs::write(path, format!("{header}\n{message}\n")).unwrap();
        };
        write(&child, "fork", Some(&parent));
        let db = temporary.path().join("cache.db");
        let pricing = std::sync::Arc::new(Pricing::bundled());
        let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
        let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
        let mut initial = scanner.refresh(None).unwrap();
        assert_eq!(initial.sessions.len(), 1);
        assert!(initial.sessions[0].head.parent_reference.is_none());
        commit_page(&mut cache, &mut initial);

        for (header_id, expected) in [
            (Some("parent"), Some("parent")),
            (Some("other"), None),
            (Some("parent"), Some("parent")),
            (None, None),
        ] {
            if let Some(id) = header_id {
                write(&parent, id, None);
            } else {
                std::fs::rename(&parent, parent.with_file_name("2026-11-01_renamed.jsonl"))
                    .unwrap();
            }
            if restart {
                scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
            }
            let mut changed = scanner
                .refresh(Some(std::slice::from_ref(&parent)))
                .unwrap();
            let fork = changed
                .sessions
                .iter()
                .find(|session| session.head.reference.session_id == "fork")
                .expect("a parent change must refresh the unchanged child source");
            assert_eq!(
                fork.head
                    .parent_reference
                    .as_ref()
                    .map(|parent| parent.session_id.as_str()),
                expected
            );
            commit_page(&mut cache, &mut changed);
            let fork = cache
                .snapshot()
                .unwrap()
                .into_iter()
                .find(|head| head.reference.session_id == "fork")
                .unwrap();
            assert_eq!(
                fork.parent_reference
                    .as_ref()
                    .map(|parent| parent.session_id.as_str()),
                expected
            );
            let mut unchanged = scanner.refresh(None).unwrap();
            assert!(unchanged.sessions.is_empty());
            commit_page(&mut cache, &mut unchanged);
        }
    }
}

#[test]
fn missing_sources_are_empty_but_corrupt_databases_report_failures() {
    let temporary = tempfile::tempdir().unwrap();
    let pi = pi_source(temporary.path());
    write_pi(&pi, "Survives another agent failure");
    let deep = AgentSource {
        antigravity_profiles: None,
        agent: "deepchat".into(),
        data_root: temporary.path().join("deep"),
        scan_path: temporary.path().join("deep"),
    };
    let missing = scan_source(&deep, &Pricing::bundled()).unwrap();
    assert!(!missing.available);
    std::fs::create_dir_all(deep.scan_path.join("app_db")).unwrap();
    std::fs::write(
        deep.scan_path.join("app_db/agent.db"),
        "not a sqlite database",
    )
    .unwrap();
    let result = scan_sources(&[deep, pi], &ScanOptions::default(), &Pricing::bundled());
    assert_eq!(result.failures.len(), 1);
    assert_eq!(result.failures[0].agent_name, "deepchat");
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.sessions[0].head.reference.agent_name, "pi");
}

#[test]
fn head_only_durable_sessions_are_retained_when_source_disappears() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    let file = write_pi(&source, "Durable head");
    let db = temporary.path().join("cache.db");
    let mut sessions = scan_source(&source, &Pricing::bundled()).unwrap().sessions;
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    cache.publish(&mut sessions).unwrap();
    cache
        .connection()
        .execute("DELETE FROM messages", [])
        .unwrap();
    std::fs::remove_file(file).unwrap();
    let mut scanner = AgentScanner::new(source, db, std::sync::Arc::new(Pricing::bundled()));
    let mut absent = scanner.refresh(None).unwrap();
    assert!(absent.complete);
    assert!(absent.sessions.is_empty());
    assert!(absent.removed.is_empty());
    commit_page(&mut cache, &mut absent);
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn persisted_file_state_skips_bodies_and_rechecks_changes_after_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    let file = write_pi(&source, "Initial");
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut first = scanner.refresh(None).unwrap();
    commit_page(&mut cache, &mut first);
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    assert!(warm.removed.is_empty());
    commit_page(&mut cache, &mut warm);
    for _ in 0..3 {
        let mut unchanged = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
        assert!(unchanged.sessions.is_empty());
        assert!(unchanged.removed.is_empty());
        commit_page(&mut cache, &mut unchanged);
    }
    cache.connection().execute("UPDATE cache_meta SET value=json_set(value,'$.parserVersion','old-parser') WHERE key='rust_source_state:pi'", []).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut revised = scanner.refresh(None).unwrap();
    assert_eq!(revised.sessions.len(), 1);
    commit_page(&mut cache, &mut revised);
    write_pi(&source, "Changed");
    let rejected = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert_eq!(rejected.sessions.len(), 1);
    drop(rejected);
    let mut retry = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert_eq!(retry.sessions[0].head.title, "Changed");
    commit_page(&mut cache, &mut retry);
    let mut scanner = AgentScanner::new(source, db, pricing);
    let mut restart = scanner.refresh(None).unwrap();
    assert!(restart.sessions.is_empty());
    commit_page(&mut cache, &mut restart);
    std::fs::remove_file(&file).unwrap();
    let mut removed = scanner.refresh(Some(&[file])).unwrap();
    assert_eq!(removed.removed.len(), 1);
    commit_page(&mut cache, &mut removed);
    assert!(cache.snapshot().unwrap().is_empty());
}

#[test]
fn targeted_live_refresh_matches_inventory_fingerprints_and_falls_back_on_companions_and_deletions()
{
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("claude");
    let project = root.join("projects/-work-demo");
    std::fs::create_dir_all(&project).unwrap();
    let first = project.join("11111111-1111-4111-8111-000000000001.jsonl");
    let second = project.join("11111111-1111-4111-8111-000000000002.jsonl");
    let index = project.join("sessions-index.json");
    let write_claude = |path: &Path, id: &str, text: &str| {
        std::fs::write(
            path,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "user",
                    "uuid": "u1",
                    "timestamp": "2026-10-01T00:00:00.000Z",
                    "cwd": "/work/demo",
                    "sessionId": id,
                    "message": { "role": "user", "content": text }
                })
            ),
        )
        .unwrap();
    };
    write_claude(&first, "11111111-1111-4111-8111-000000000001", "First");
    write_claude(&second, "11111111-1111-4111-8111-000000000002", "Second");
    std::fs::write(
        &index,
        r#"{"entries":[{"sessionId":"11111111-1111-4111-8111-000000000002","summary":"Second summary"}]}"#,
    )
    .unwrap();
    let source = AgentSource {
        antigravity_profiles: None,
        agent: "claudecode".into(),
        data_root: root.clone(),
        scan_path: root.join("projects"),
    };

    // Targeted items produce the exact same fingerprint as full inventory.
    let full: std::collections::HashMap<_, _> = super::super::backfill::inventory(&source)
        .unwrap()
        .into_iter()
        .map(|item| (item.key, item.fingerprint))
        .collect();
    let targeted = super::super::backfill::targeted_items(
        &source,
        std::slice::from_ref(&first),
        &std::collections::HashSet::new(),
    )
    .unwrap()
    .expect("regular Claude transcript should take targeted fast path");
    assert_eq!(targeted.len(), 1);
    assert_eq!(targeted[0].fingerprint, full[&targeted[0].key]);

    // Companion files, directories, and missing paths fall back to full inventory.
    assert!(
        super::super::backfill::targeted_items(
            &source,
            std::slice::from_ref(&index),
            &std::collections::HashSet::new(),
        )
        .unwrap()
        .is_none()
    );
    assert!(
        super::super::backfill::targeted_items(
            &source,
            std::slice::from_ref(&project),
            &std::collections::HashSet::new(),
        )
        .unwrap()
        .is_none()
    );

    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 2);
    cache
        .apply_checkpoint(
            &mut initial.sessions,
            &initial.removed,
            "claudecode",
            &initial.checkpoint,
            initial.complete,
        )
        .unwrap();
    initial.on_reject.take();

    // Targeted live update refreshes only the modified file and retains untouched siblings.
    write_claude(
        &first,
        "11111111-1111-4111-8111-000000000001",
        "First updated",
    );
    let mut updated = scanner.refresh(Some(std::slice::from_ref(&first))).unwrap();
    assert_eq!(updated.sessions.len(), 1);
    assert_eq!(updated.sessions[0].head.title, "First updated");
    assert!(updated.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut updated.sessions,
            &updated.removed,
            "claudecode",
            &updated.checkpoint,
            updated.complete,
        )
        .unwrap();
    updated.on_reject.take();

    // Warm restart sees matching fingerprints for both sessions and parses nothing.
    let mut warm_scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut warm = warm_scanner.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    assert!(warm.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut warm.sessions,
            &warm.removed,
            "claudecode",
            &warm.checkpoint,
            warm.complete,
        )
        .unwrap();
    warm.on_reject.take();

    // Deleting the file falls back to full inventory and removes only the deleted session.
    std::fs::remove_file(&first).unwrap();
    let mut deleted = warm_scanner.refresh(Some(&[first])).unwrap();
    assert!(deleted.sessions.is_empty());
    assert_eq!(deleted.removed.len(), 1);
    assert_eq!(
        deleted.removed[0].session_id,
        "11111111-1111-4111-8111-000000000001"
    );
    cache
        .apply_checkpoint(
            &mut deleted.sessions,
            &deleted.removed,
            "claudecode",
            &deleted.checkpoint,
            deleted.complete,
        )
        .unwrap();
    deleted.on_reject.take();
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn unchanged_live_refresh_omits_source_state_until_files_change() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("codex");
    let sessions = root.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let path =
        sessions.join("rollout-2026-09-01T00-00-00-019f0000-0000-0000-0000-000000000001.jsonl");
    let write_rollout = |text: &str| {
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "timestamp": "2026-09-01T00:00:00Z",
                    "payload": {"id": "019f0000-0000-0000-0000-000000000001", "cwd": "/work/demo"}
                }),
                serde_json::json!({
                    "type": "response_item",
                    "timestamp": "2026-09-01T00:00:01Z",
                    "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}
                }),
            ),
        )
        .unwrap();
    };
    write_rollout("Initial");
    let source = AgentSource {
        antigravity_profiles: None,
        agent: "codex".into(),
        data_root: root,
        scan_path: sessions,
    };
    let db = temporary.path().join("worker.db");
    let mut store = crate::sync::WorkerStore::open(&db).unwrap();
    let mut scanner = AgentScanner::for_worker(source.clone(), db.clone());

    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 1);
    assert!(
        initial
            .checkpoint
            .as_ref()
            .and_then(|v| v.get("sourceState"))
            .is_some()
    );
    store.save_batch("codex", &mut initial).unwrap();

    // Unchanged live refresh skips rebuilding sourceState while preserving stored state.
    let mut unchanged = scanner.refresh(Some(std::slice::from_ref(&path))).unwrap();
    assert!(unchanged.sessions.is_empty());
    assert!(unchanged.complete);
    assert!(
        unchanged
            .checkpoint
            .as_ref()
            .and_then(|v| v.get("sourceState"))
            .is_none()
    );
    store.save_batch("codex", &mut unchanged).unwrap();
    assert!(store.baseline("codex").unwrap().state.is_some());

    // A real file change marks sourceState dirty and emits the updated fingerprint.
    write_rollout("Updated prompt content");
    let mut updated = scanner.refresh(Some(std::slice::from_ref(&path))).unwrap();
    assert_eq!(updated.sessions.len(), 1);
    assert!(
        updated
            .checkpoint
            .as_ref()
            .and_then(|v| v.get("sourceState"))
            .is_some()
    );
    store.save_batch("codex", &mut updated).unwrap();

    // Restarted scanner sees the persisted updated fingerprint and parses nothing.
    let mut restarted = AgentScanner::for_worker(source, db);
    let mut warm = restarted.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    warm.on_reject.take();
}

#[test]
fn claude_sessions_index_summary_change_only_refreshes_affected_session() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("claude");
    let project = root.join("projects/-work-demo");
    std::fs::create_dir_all(&project).unwrap();
    let first_id = "11111111-1111-4111-8111-000000000001";
    let second_id = "11111111-1111-4111-8111-000000000002";
    let subagent_id = "custom-subagent-id";
    let subagents = project.join(first_id).join("subagents");
    std::fs::create_dir_all(&subagents).unwrap();
    let first = project.join(format!("{first_id}.jsonl"));
    let second = project.join(format!("{second_id}.jsonl"));
    let subagent = subagents.join("agent-worker.jsonl");
    let subagent_meta = subagent.with_extension("meta.json");
    let index = project.join("sessions-index.json");
    let write_claude = |path: &Path, id: &str, text: &str| {
        std::fs::write(
            path,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "user",
                    "uuid": "u1",
                    "timestamp": "2026-10-01T00:00:00.000Z",
                    "cwd": "/work/demo",
                    "sessionId": id,
                    "message": { "role": "user", "content": text }
                })
            ),
        )
        .unwrap();
    };
    write_claude(&first, first_id, "First prompt");
    write_claude(&second, second_id, "Second prompt");
    write_claude(&subagent, subagent_id, "Subagent prompt");
    std::fs::write(&subagent_meta, format!(r#"{{"agentId":"{subagent_id}"}}"#)).unwrap();
    std::fs::write(
        &index,
        serde_json::json!({
            "entries": [
                { "sessionId": first_id, "summary": "Initial summary" },
                { "sessionId": second_id, "summary": "Sibling summary" },
                { "sessionId": subagent_id, "summary": "Initial subagent summary" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    let source = AgentSource {
        antigravity_profiles: None,
        agent: "claudecode".into(),
        data_root: root.clone(),
        scan_path: root.join("projects"),
    };
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source, db, pricing);

    let commit = |cache: &mut crate::storage::Cache, batch: &mut crate::runtime::ScanBatch| {
        cache
            .apply_checkpoint(
                &mut batch.sessions,
                &batch.removed,
                "claudecode",
                &batch.checkpoint,
                batch.complete,
            )
            .unwrap();
        batch.on_reject.take();
    };

    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 3);
    commit(&mut cache, &mut initial);

    // Updating one summary in sessions-index.json refreshes only that session.
    std::fs::write(
        &index,
        serde_json::json!({
            "entries": [
                { "sessionId": first_id, "summary": "Updated summary" },
                { "sessionId": second_id, "summary": "Sibling summary" },
                { "sessionId": subagent_id, "summary": "Initial subagent summary" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    let mut updated = scanner.refresh(Some(std::slice::from_ref(&index))).unwrap();
    assert_eq!(updated.sessions.len(), 1);
    assert_eq!(updated.sessions[0].head.reference.session_id, first_id);
    assert_eq!(updated.sessions[0].head.title, "Updated summary");
    assert!(updated.removed.is_empty());
    commit(&mut cache, &mut updated);

    // Updating a subagent summary whose meta.json `agentId` differs from its filename refreshes it.
    std::fs::write(
        &index,
        serde_json::json!({
            "entries": [
                { "sessionId": first_id, "summary": "Updated summary" },
                { "sessionId": second_id, "summary": "Sibling summary" },
                { "sessionId": subagent_id, "summary": "Updated subagent summary" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    let mut subagent_updated = scanner.refresh(Some(std::slice::from_ref(&index))).unwrap();
    let subagent_session = subagent_updated
        .sessions
        .iter()
        .find(|session| session.head.reference.session_id == subagent_id)
        .expect("subagent session should refresh when its agentId summary changes");
    assert_eq!(subagent_session.head.title, "Updated subagent summary");
    assert!(
        !subagent_updated
            .sessions
            .iter()
            .any(|session| session.head.reference.session_id == second_id)
    );
    commit(&mut cache, &mut subagent_updated);

    // Unrelated edits and trailing duplicate entries do not re-parse any existing session.
    std::fs::write(
        &index,
        serde_json::json!({
            "entries": [
                { "sessionId": first_id, "summary": "Updated summary" },
                { "sessionId": first_id, "summary": "Ignored duplicate" },
                { "sessionId": second_id, "summary": "Sibling summary" },
                { "sessionId": subagent_id, "summary": "Updated subagent summary" },
                { "sessionId": "other-session", "summary": "Other summary" }
            ]
        })
        .to_string(),
    )
    .unwrap();
    let mut unchanged = scanner.refresh(Some(std::slice::from_ref(&index))).unwrap();
    assert!(unchanged.sessions.is_empty());
    assert!(unchanged.removed.is_empty());
    commit(&mut cache, &mut unchanged);
}

#[cfg(unix)]
#[test]
fn unix_file_stamp_ignores_permission_changes_and_tracks_content_mtime_and_inode() {
    use std::os::unix::fs::PermissionsExt;

    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("session.jsonl");
    std::fs::write(&path, "initial").unwrap();
    let original = crate::hash::file_stamp(&std::fs::metadata(&path).unwrap())
        .unwrap()
        .1;

    // Permission-only chmod updates ctime without changing content, mtime, or inode.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let after_chmod = crate::hash::file_stamp(&std::fs::metadata(&path).unwrap())
        .unwrap()
        .1;
    assert_eq!(after_chmod, original);

    // Changing file content updates the stamp.
    std::fs::write(&path, "updated content").unwrap();
    let after_content = crate::hash::file_stamp(&std::fs::metadata(&path).unwrap())
        .unwrap()
        .1;
    assert_ne!(after_content, original);

    // Changing mtime alone updates the stamp.
    let earlier = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(earlier)
        .unwrap();
    let after_mtime = crate::hash::file_stamp(&std::fs::metadata(&path).unwrap())
        .unwrap()
        .1;
    assert_ne!(after_mtime, after_content);

    // Replacing with a new file of identical size and mtime still changes the stamp via inode.
    let replacement = temporary.path().join("replacement.jsonl");
    std::fs::write(&replacement, "updated content").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_modified(earlier)
        .unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    let after_inode = crate::hash::file_stamp(&std::fs::metadata(&path).unwrap())
        .unwrap()
        .1;
    assert_ne!(after_inode, after_mtime);
}
