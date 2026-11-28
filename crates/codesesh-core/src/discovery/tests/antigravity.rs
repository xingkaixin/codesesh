use super::*;
use crate::runtime::ScanBatch;
use rusqlite::Connection;
use std::{fs, path::PathBuf, sync::Arc};

fn write_session(directory: &Path, id: &str) -> PathBuf {
    fs::create_dir_all(directory).unwrap();
    let path = directory.join(format!("{id}.db"));
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("../../agents/antigravity/fixture.sql"))
        .unwrap();
    db.execute("DELETE FROM steps WHERE step_type=23", [])
        .unwrap();
    path
}

fn write_summary(directory: &Path, id: &str, title: &str) {
    let db = Connection::open(
        directory
            .parent()
            .unwrap()
            .join("conversation_summaries.db"),
    )
    .unwrap();
    db.execute_batch("CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, agent_name TEXT);").unwrap();
    db.execute(
        "INSERT OR REPLACE INTO conversation_summaries (conversation_id,title,workspace_uris,last_modified_time,parent_conversation_id) VALUES (?1,?2,'[]','','')",
        [id, title],
    )
    .unwrap();
}

fn commit(cache: &mut crate::storage::Cache, batch: &mut ScanBatch, agent: &str) {
    cache
        .apply_checkpoint(
            &mut batch.sessions,
            &batch.removed,
            agent,
            &batch.checkpoint,
            batch.complete,
        )
        .unwrap();
    batch.on_reject.take();
}

#[test]
fn isolated_profiles_refresh_with_cli_and_retain_history_when_a_profile_disappears() {
    let temp = tempfile::tempdir().unwrap();
    let env = environment(temp.path());
    let source = env.source("antigravity-cli").unwrap();
    write_session(&source.scan_path, "native");
    write_summary(&source.scan_path, "native", "CLI title");
    let path = temp.path().join("cache.db");
    let pricing = Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&path)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), path.clone(), pricing.clone());
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 1);
    assert_eq!(initial.sessions[0].head.title, "CLI title");
    commit(&mut cache, &mut initial, "antigravity-cli");

    let profiles = source.antigravity_profiles.as_ref().unwrap();
    let first = profiles.join("account-a/antigravity-acp/conversations");
    let second = profiles.join("account-b/antigravity-acp/conversations");
    let first_db = write_session(&first, "acp-a");
    let second_db = write_session(&second, "acp-b");
    write_summary(&first, "acp-a", "ACP title");
    let mut added = scanner
        .refresh(Some(std::slice::from_ref(profiles)))
        .unwrap();
    assert_eq!(added.sessions.len(), 2);
    assert!(added.removed.is_empty());
    let reference = added
        .sessions
        .iter()
        .find(|session| session.head.reference.session_id == "acp-a")
        .unwrap()
        .head
        .reference
        .clone();
    assert_eq!(
        added
            .sessions
            .iter()
            .find(|session| session.head.reference == reference)
            .unwrap()
            .head
            .title,
        "ACP title"
    );
    commit(&mut cache, &mut added, "antigravity-cli");

    let db = Connection::open(&first_db).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; UPDATE steps SET step_payload=X'a201090a0755706461746564' WHERE idx=2;").unwrap();
    let wal = PathBuf::from(format!("{}-wal", first_db.display()));
    let mut changed = scanner.refresh(Some(&[wal])).unwrap();
    assert_eq!(changed.sessions.len(), 1);
    assert_eq!(changed.sessions[0].head.reference, reference);
    let crate::model::MessagePart::Text { text, .. } =
        &changed.sessions[0].detail.messages[1].parts[0]
    else {
        panic!("missing assistant text");
    };
    assert_eq!(text, "Updated");
    commit(&mut cache, &mut changed, "antigravity-cli");

    write_summary(&first, "acp-a", "Renamed ACP");
    let mut renamed = scanner.refresh(Some(std::slice::from_ref(&first))).unwrap();
    assert_eq!(renamed.sessions.len(), 1);
    assert_eq!(renamed.sessions[0].head.title, "Renamed ACP");
    commit(&mut cache, &mut renamed, "antigravity-cli");

    scanner = AgentScanner::new(source, path, pricing);
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    assert!(warm.removed.is_empty());
    commit(&mut cache, &mut warm, "antigravity-cli");

    drop(db);
    fs::remove_dir_all(first.parent().unwrap().parent().unwrap()).unwrap();
    let mut missing = scanner.refresh(Some(std::slice::from_ref(&first))).unwrap();
    assert!(missing.removed.is_empty());
    commit(&mut cache, &mut missing, "antigravity-cli");
    assert_eq!(cache.snapshot().unwrap().len(), 3);

    fs::remove_file(second_db).unwrap();
    let mut deleted = scanner.refresh(Some(&[second])).unwrap();
    assert_eq!(deleted.removed.len(), 1);
    assert_eq!(deleted.removed[0].session_id, "acp-b");
    commit(&mut cache, &mut deleted, "antigravity-cli");
    assert_eq!(cache.snapshot().unwrap().len(), 2);

    write_session(&first, "acp-a");
    let mut returned = scanner.refresh(Some(&[first])).unwrap();
    assert_eq!(returned.sessions.len(), 1);
    assert_eq!(returned.sessions[0].head.reference, reference);
    assert!(returned.removed.is_empty());
    commit(&mut cache, &mut returned, "antigravity-cli");
    assert_eq!(cache.snapshot().unwrap().len(), 2);
}

#[test]
fn json_reads_custom_profiles_and_preserves_missing_stores_with_explicit_override() {
    let temp = tempfile::tempdir().unwrap();
    let mut env = environment(temp.path());
    env.variables
        .insert("T3CODE_HOME".into(), "~/custom-t3".into());
    let source = env.source("antigravity-cli").unwrap();
    let profiles = env.home.join("custom-t3/userdata/providers/antigravity");
    let acp = profiles.join("account/antigravity-acp/conversations");
    write_session(&acp, "acp");
    write_session(
        &env.home
            .join(".t3/userdata/providers/antigravity/ignored/antigravity-acp/conversations"),
        "ignored",
    );
    let path = temp.path().join("json.db");
    let pricing = Pricing::bundled();
    let run = |source: &AgentSource| {
        json_scan::run(
            std::slice::from_ref(source),
            &ScanOptions::default(),
            &pricing,
            &path,
            "local",
            |_, _| {},
        )
        .unwrap()
    };
    let first = run(&source);
    assert_eq!(first.sessions.len(), 1);
    assert_eq!(first.sessions[0].reference.session_id, "acp");
    let native = write_session(&source.scan_path, "native");
    assert_eq!(run(&source).sessions.len(), 2);
    fs::remove_dir_all(&profiles).unwrap();
    assert_eq!(run(&source).sessions.len(), 2);
    fs::remove_file(native).unwrap();
    let retained = run(&source);
    assert_eq!(retained.sessions.len(), 1);
    assert_eq!(retained.sessions[0].reference, first.sessions[0].reference);

    env.variables
        .insert("AGY_CONVERSATIONS_DIR".into(), "isolated/convos".into());
    let source = env.source("antigravity-cli").unwrap();
    write_session(&source.scan_path, "override");
    write_session(&acp, "unselected");
    let selected = scan_source(&source, &pricing).unwrap();
    assert_eq!(selected.sessions.len(), 1);
    assert_eq!(selected.sessions[0].head.reference.session_id, "override");
}

#[test]
fn desktop_sqlite_refreshes_independently_of_cli_and_ignores_legacy_files() {
    let temp = tempfile::tempdir().unwrap();
    let env = environment(temp.path());
    let source = env.source("antigravity").unwrap();
    let desktop = env.home.join(".gemini/antigravity/conversations");
    let native = write_session(&desktop, "shared-id");
    write_summary(&desktop, "shared-id", "Desktop title");
    write_summary(&desktop, "cli-only", "Foreign summary");
    fs::write(desktop.join("legacy.pb"), b"unsupported encrypted history").unwrap();
    let cli = env.source("antigravity-cli").unwrap();
    write_session(&cli.scan_path, "shared-id");
    write_summary(&cli.scan_path, "shared-id", "CLI title");
    let path = temp.path().join("cache.db");
    let pricing = Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&path)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), path.clone(), pricing.clone());
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 1);
    let session = &initial.sessions[0];
    assert_eq!(session.head.reference.agent_name, "antigravity");
    assert_eq!(session.head.title, "Desktop title");
    assert!(
        session
            .detail
            .messages
            .iter()
            .filter_map(|m| m.agent.as_deref())
            .all(|agent| agent == "antigravity")
    );
    commit(&mut cache, &mut initial, "antigravity");
    let mut cli_scanner = AgentScanner::new(cli, path.clone(), pricing.clone());
    let mut cli_batch = cli_scanner.refresh(None).unwrap();
    commit(&mut cache, &mut cli_batch, "antigravity-cli");
    assert_eq!(cache.snapshot().unwrap().len(), 2);

    let db = Connection::open(&native).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; UPDATE steps SET step_payload=X'a201090a0755706461746564' WHERE idx=2;").unwrap();
    let wal = PathBuf::from(format!("{}-wal", native.display()));
    let mut changed = scanner.refresh(Some(&[wal])).unwrap();
    assert_eq!(changed.sessions.len(), 1);
    let crate::model::MessagePart::Text { text, .. } =
        &changed.sessions[0].detail.messages[1].parts[0]
    else {
        panic!("missing assistant text");
    };
    assert_eq!(text, "Updated");
    commit(&mut cache, &mut changed, "antigravity");

    write_summary(&desktop, "shared-id", "Renamed Desktop");
    let summary = source.data_root.join("conversation_summaries.db");
    let mut renamed = scanner.refresh(Some(&[summary])).unwrap();
    assert_eq!(renamed.sessions.len(), 1);
    assert_eq!(renamed.sessions[0].head.title, "Renamed Desktop");
    commit(&mut cache, &mut renamed, "antigravity");

    scanner = AgentScanner::new(source, path, pricing);
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    assert!(warm.removed.is_empty());
    commit(&mut cache, &mut warm, "antigravity");
    drop(db);
    fs::remove_file(&native).unwrap();
    let mut deleted = scanner.refresh(Some(&[native])).unwrap();
    assert_eq!(deleted.removed.len(), 1);
    assert_eq!(deleted.removed[0].agent_name, "antigravity");
    commit(&mut cache, &mut deleted, "antigravity");
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn desktop_override_reads_its_own_metadata_and_retains_failed_refreshes() {
    let temp = tempfile::tempdir().unwrap();
    let mut env = environment(temp.path());
    write_session(
        &env.home.join(".gemini/antigravity/conversations"),
        "default",
    );
    env.variables.insert(
        "ANTIGRAVITY_CONVERSATIONS_DIR".into(),
        "~/custom-desktop/conversations".into(),
    );
    let source = env.source("antigravity").unwrap();
    let directory = env.home.join("custom-desktop/conversations");
    let native = write_session(&directory, "custom");
    write_summary(&directory, "custom", "Custom Desktop");
    let path = temp.path().join("json.db");
    let pricing = Pricing::bundled();
    let run = || {
        json_scan::run(
            std::slice::from_ref(&source),
            &ScanOptions::default(),
            &pricing,
            &path,
            "local",
            |_, _| {},
        )
    };
    let first = run().unwrap();
    assert_eq!(first.sessions.len(), 1);
    assert_eq!(first.sessions[0].title, "Custom Desktop");
    assert_eq!(first.sessions[0].reference.agent_name, "antigravity");
    let db = Connection::open(&native).unwrap();
    db.execute("UPDATE steps SET step_payload=X'ff' WHERE idx=2", [])
        .unwrap();
    drop(db);
    assert!(run().is_err());
    let cache = crate::storage::Cache::open(Some(&path)).unwrap();
    assert_eq!(cache.snapshot().unwrap()[0].title, "Custom Desktop");
    fs::remove_dir_all(&directory).unwrap();
    assert!(run().is_err());
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn updating_one_conversation_summary_does_not_invalidate_other_conversations() {
    let temp = tempfile::tempdir().unwrap();
    let env = environment(temp.path());
    let source = env.source("antigravity").unwrap();
    let desktop = source.scan_path.clone();
    let first = write_session(&desktop, "conv-a");
    let second = write_session(&desktop, "conv-b");
    write_summary(&desktop, "conv-a", "Title A");
    write_summary(&desktop, "conv-b", "Title B");
    fs::write(
        source.data_root.join("history.jsonl"),
        format!(
            "{}\n{}\n",
            serde_json::json!({"conversationId":"conv-a","workspace":"/work/a"}),
            serde_json::json!({"conversationId":"conv-b","workspace":"/work/b"}),
        ),
    )
    .unwrap();

    let before: std::collections::HashMap<_, _> = super::super::backfill::inventory(&source)
        .unwrap()
        .into_iter()
        .map(|item| (item.key, item.fingerprint))
        .collect();
    let first_key = first.to_string_lossy().into_owned();
    let second_key = second.to_string_lossy().into_owned();

    let path = temp.path().join("cache.db");
    let pricing = Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&path)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), path, pricing);
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 2);
    commit(&mut cache, &mut initial, "antigravity");

    // Update conversation B's summary row and history entry, leaving conversation A untouched.
    write_summary(&desktop, "conv-b", "Title B Updated");
    fs::write(
        source.data_root.join("history.jsonl"),
        format!(
            "{}\n{}\n",
            serde_json::json!({"conversationId":"conv-a","workspace":"/work/a"}),
            serde_json::json!({"conversationId":"conv-b","workspace":"/work/b2"}),
        ),
    )
    .unwrap();

    let after: std::collections::HashMap<_, _> = super::super::backfill::inventory(&source)
        .unwrap()
        .into_iter()
        .map(|item| (item.key, item.fingerprint))
        .collect();
    assert_eq!(after[&first_key], before[&first_key]);
    assert_ne!(after[&second_key], before[&second_key]);

    let summary_db = source.data_root.join("conversation_summaries.db");
    let mut refreshed = scanner.refresh(Some(&[summary_db])).unwrap();
    assert_eq!(refreshed.sessions.len(), 1);
    assert_eq!(refreshed.sessions[0].head.reference.session_id, "conv-b");
    assert_eq!(refreshed.sessions[0].head.title, "Title B Updated");
    commit(&mut cache, &mut refreshed, "antigravity");
}

#[test]
fn antigravity_cli_watch_roots_scope_profiles_and_targeted_items_skip_non_db_files() {
    let temp = tempfile::tempdir().unwrap();
    let env = environment(temp.path());
    let source = env.source("antigravity-cli").unwrap();
    let profiles = source.antigravity_profiles.as_ref().unwrap();
    let acp = profiles.join("account-a/antigravity-acp");
    let conversations = acp.join("conversations");
    let db = write_session(&conversations, "acp-a");
    let meta = conversations.join("acp-a.meta");
    let pb = conversations.join("legacy.pb");
    fs::write(&meta, "meta").unwrap();
    fs::write(&pb, "pb").unwrap();
    fs::create_dir_all(acp.join("brain/acp-a")).unwrap();
    fs::create_dir_all(acp.join("log")).unwrap();

    let roots = source.watch_roots();
    assert!(roots.contains(&crate::runtime::WatchRoot::shallow(profiles.clone())));
    assert!(!roots.contains(&crate::runtime::WatchRoot::recursive(profiles.clone())));
    assert!(roots.contains(&crate::runtime::WatchRoot::recursive(conversations.clone())));
    assert!(roots.contains(&crate::runtime::WatchRoot::recursive(
        acp.join("conversation_summaries.db")
    )));
    assert!(roots.contains(&crate::runtime::WatchRoot::recursive(
        acp.join("history.jsonl")
    )));
    assert!(!roots.iter().any(|r| r.path.starts_with(acp.join("brain"))));
    assert!(!roots.iter().any(|r| r.path.starts_with(acp.join("log"))));

    // Ignored non-.db regular files (including nested paths and batches > BATCH_SIZE) stay targeted.
    let nested_meta = conversations.join("nested/ignored.meta");
    fs::create_dir_all(nested_meta.parent().unwrap()).unwrap();
    fs::write(&nested_meta, "nested").unwrap();
    let mut many_meta = vec![meta, pb, nested_meta];
    for i in 0..33 {
        let extra = conversations.join(format!("extra-{i}.meta"));
        fs::write(&extra, "m").unwrap();
        many_meta.push(extra);
    }
    let known = std::collections::HashSet::new();
    let ignored = super::super::backfill::targeted_items(&source, &many_meta, &known).unwrap();
    assert_eq!(ignored.as_ref().map(Vec::len), Some(0));

    // A regular .db alongside a non-.db file still targets only the .db.
    let other_meta = conversations.join("other.meta");
    fs::write(&other_meta, "m").unwrap();
    let targeted =
        super::super::backfill::targeted_items(&source, &[db.clone(), other_meta], &known)
            .unwrap()
            .expect("session db should remain targeted");
    assert_eq!(targeted.len(), 1);
    assert_eq!(targeted[0].path.as_deref(), Some(db.as_path()));

    // Companion DB and deleted .db files still fall back to full inventory.
    assert!(
        super::super::backfill::targeted_items(
            &source,
            &[acp.join("conversation_summaries.db")],
            &known,
        )
        .unwrap()
        .is_none()
    );
    fs::remove_file(&db).unwrap();
    assert!(
        super::super::backfill::targeted_items(&source, &[db], &known)
            .unwrap()
            .is_none()
    );

    // An ignored .meta file in an empty profile must not flip source presence from NotFound to Available.
    let empty_temp = tempfile::tempdir().unwrap();
    let empty_env = environment(empty_temp.path());
    let empty_source = empty_env.source("antigravity-cli").unwrap();
    let empty_convo = empty_source
        .antigravity_profiles
        .as_ref()
        .unwrap()
        .join("empty-account/antigravity-acp/conversations");
    fs::create_dir_all(&empty_convo).unwrap();
    let cache_path = empty_temp.path().join("cache.db");
    let mut cache = crate::storage::Cache::open(Some(&cache_path)).unwrap();
    let mut scanner = AgentScanner::new(empty_source, cache_path, Arc::new(Pricing::bundled()));
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.source_presence, Some(SourcePresence::NotFound));
    commit(&mut cache, &mut initial, "antigravity-cli");

    let empty_meta = empty_convo.join("only.meta");
    fs::write(&empty_meta, "meta").unwrap();
    let mut after_meta = scanner.refresh(Some(&[empty_meta])).unwrap();
    assert_eq!(after_meta.source_presence, Some(SourcePresence::NotFound));
    assert!(after_meta.sessions.is_empty());
    after_meta.on_reject.take();
}

#[test]
fn targeted_items_batch_matches_inventory_and_falls_back_for_parents() {
    let temp = tempfile::tempdir().unwrap();
    let env = environment(temp.path());
    let source = env.source("antigravity").unwrap();
    let conversations = source.scan_path.clone();
    let parent_db = write_session(&conversations, "parent");
    let child_a_db = write_session(&conversations, "child-a");
    let child_b_db = write_session(&conversations, "child-b");

    let summary_db = Connection::open(source.data_root.join("conversation_summaries.db")).unwrap();
    summary_db
        .execute_batch(
            "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, agent_name TEXT);",
        )
        .unwrap();
    for (id, title, parent) in [
        ("parent", "Parent", ""),
        ("child-a", "Child A", "parent"),
        ("child-b", "Child B", "parent"),
    ] {
        summary_db
            .execute(
                "INSERT INTO conversation_summaries (conversation_id,title,workspace_uris,last_modified_time,parent_conversation_id) VALUES (?1,?2,'[]','',?3)",
                [id, title, parent],
            )
            .unwrap();
    }
    fs::write(
        source.data_root.join("history.jsonl"),
        format!(
            "{}\nnot-json\n{}\n{}\n",
            serde_json::json!({"conversationId": "parent", "workspace": "/work/root", "extra": {"nested": [1, 2, 3]}}),
            serde_json::json!({"conversationId": "child-a", "workspace": "/work/a", "ignored": true}),
            serde_json::json!({"conversationId": "", "workspace": "/work/empty"}),
        ),
    )
    .unwrap();

    let inventory_fps: std::collections::HashMap<_, _> = super::super::backfill::inventory(&source)
        .unwrap()
        .into_iter()
        .map(|item| (item.key, item.fingerprint))
        .collect();
    let known = std::collections::HashSet::new();
    let child_a_wal = PathBuf::from(format!("{}-wal", child_a_db.display()));
    let batch = super::super::backfill::targeted_items(
        &source,
        &[child_a_db.clone(), child_a_wal, child_b_db.clone()],
        &known,
    )
    .unwrap()
    .expect("leaf conversations should stay targeted");
    assert_eq!(batch.len(), 2);
    for item in &batch {
        assert_eq!(inventory_fps.get(&item.key), Some(&item.fingerprint));
    }

    assert!(
        super::super::backfill::targeted_items(&source, &[parent_db], &known)
            .unwrap()
            .is_none()
    );
}

#[test]
fn summary_wal_diff_refreshes_only_changed_conversation_and_falls_back_when_needed() {
    let temp = tempfile::tempdir().unwrap();
    let env = environment(temp.path());
    let source = env.source("antigravity").unwrap();
    let conversations = source.scan_path.clone();
    write_session(&conversations, "conv-a");
    let conv_b = write_session(&conversations, "conv-b");

    let summary_path = source.data_root.join("conversation_summaries.db");
    let summary_wal = PathBuf::from(format!("{}-wal", summary_path.display()));
    let summary_db = Connection::open(&summary_path).unwrap();
    summary_db
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT, last_modified_time TEXT, parent_conversation_id TEXT, agent_name TEXT);",
        )
        .unwrap();
    let upsert_summary = |id: &str, title: &str| {
        summary_db
            .execute(
                "INSERT OR REPLACE INTO conversation_summaries (conversation_id,title,workspace_uris,last_modified_time,parent_conversation_id,agent_name) VALUES (?1,?2,'[]','','','')",
                [id, title],
            )
            .unwrap();
    };
    upsert_summary("conv-a", "Title A");
    upsert_summary("conv-b", "Title B");

    let cache_path = temp.path().join("cache.db");
    let pricing = Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&cache_path)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), cache_path, pricing);
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 2);
    commit(&mut cache, &mut initial, "antigravity");

    // Add a sibling .db without notifying the scanner; any fallback to full inventory would surface it.
    write_session(&conversations, "unnotified-sibling");

    // 1. No-op summary WAL write does 0 work and does not walk conversations/.
    upsert_summary("conv-a", "Title A");
    let mut noop = scanner
        .refresh(Some(std::slice::from_ref(&summary_wal)))
        .unwrap();
    assert!(noop.sessions.is_empty());
    assert!(noop.removed.is_empty());
    commit(&mut cache, &mut noop, "antigravity");

    // 2. Orphan summary (no .db on disk) also does 0 work and does not walk conversations/.
    upsert_summary("orphan-only", "Orphan title");
    let mut orphan = scanner
        .refresh(Some(std::slice::from_ref(&summary_wal)))
        .unwrap();
    assert!(orphan.sessions.is_empty());
    assert!(orphan.removed.is_empty());
    commit(&mut cache, &mut orphan, "antigravity");

    // 3. Updating conv-b's summary alongside conv-b.db-wal refreshes ONLY conv-b (not conv-a or sibling).
    upsert_summary("conv-b", "Title B v2");
    let conv_b_wal = PathBuf::from(format!("{}-wal", conv_b.display()));
    let mut targeted = scanner
        .refresh(Some(&[summary_wal.clone(), conv_b_wal]))
        .unwrap();
    assert_eq!(targeted.sessions.len(), 1);
    assert_eq!(targeted.sessions[0].head.reference.session_id, "conv-b");
    assert_eq!(targeted.sessions[0].head.title, "Title B v2");
    commit(&mut cache, &mut targeted, "antigravity");

    // 4. Updating > BATCH_SIZE summaries falls back to full inventory (and surfaces unnotified-sibling).
    for i in 0..=super::super::backfill::BATCH_SIZE {
        upsert_summary(&format!("bulk-{i}"), &format!("Bulk {i}"));
    }
    let mut bulk = scanner
        .refresh(Some(std::slice::from_ref(&summary_wal)))
        .unwrap();
    assert!(
        bulk.sessions
            .iter()
            .any(|session| session.head.reference.session_id == "unnotified-sibling"),
        "more than BATCH_SIZE summary changes must fall back to full inventory"
    );
    commit(&mut cache, &mut bulk, "antigravity");
}

#[test]
fn summary_wal_falls_back_when_summary_cache_is_unprimed_then_stays_targeted() {
    let temp = tempfile::tempdir().unwrap();
    let env = environment(temp.path());
    let source = env.source("antigravity").unwrap();
    let conversations = source.scan_path.clone();
    write_session(&conversations, "conv-a");

    let cache_path = temp.path().join("cache.db");
    let pricing = Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&cache_path)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), cache_path, pricing);
    // Initial inventory runs before conversation_summaries.db exists, leaving the summary cache unprimed.
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 1);
    commit(&mut cache, &mut initial, "antigravity");

    write_session(&conversations, "unnotified-before-prime");
    write_summary(&conversations, "conv-a", "Primed Title");
    let summary_wal = PathBuf::from(format!(
        "{}-wal",
        source.data_root.join("conversation_summaries.db").display()
    ));

    // Unprimed store falls back cleanly to full inventory (finding both conv-a update and sibling) and primes cache.
    let mut primed = scanner
        .refresh(Some(std::slice::from_ref(&summary_wal)))
        .unwrap();
    let ids: std::collections::HashSet<_> = primed
        .sessions
        .iter()
        .map(|session| session.head.reference.session_id.as_str())
        .collect();
    assert!(ids.contains("conv-a"));
    assert!(ids.contains("unnotified-before-prime"));
    commit(&mut cache, &mut primed, "antigravity");

    // Subsequent summary update uses the primed cache and avoids walking conversations/.
    write_session(&conversations, "unnotified-after-prime");
    write_summary(&conversations, "conv-a", "Targeted Title");
    let mut targeted = scanner.refresh(Some(&[summary_wal])).unwrap();
    assert_eq!(targeted.sessions.len(), 1);
    assert_eq!(targeted.sessions[0].head.reference.session_id, "conv-a");
    assert_eq!(targeted.sessions[0].head.title, "Targeted Title");
    commit(&mut cache, &mut targeted, "antigravity");
}
