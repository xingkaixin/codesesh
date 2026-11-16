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
