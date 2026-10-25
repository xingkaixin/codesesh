use super::*;

fn many_pi(source: &AgentSource, count: usize) -> Vec<std::path::PathBuf> {
    let original = write_pi(source, "History");
    let bytes = std::fs::read(&original).unwrap();
    std::fs::remove_file(original).unwrap();
    (0..count)
        .map(|index| {
            let path = source.scan_path.join(format!("history-{index:04}.jsonl"));
            std::fs::write(&path, &bytes).unwrap();
            let time = std::time::UNIX_EPOCH
                + std::time::Duration::from_secs(1_700_000_000 - index as u64);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(time))
                .unwrap();
            path
        })
        .collect()
}

#[test]
fn backfill_resumes_durable_checkpoint_without_reparsing_previous_pages() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    many_pi(&source, 65);
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut first = scanner.refresh(None).unwrap();
    assert_eq!(first.sessions.len(), 32);
    assert!(!first.complete);
    let first_refs: std::collections::HashSet<_> = first
        .sessions
        .iter()
        .map(|session| session.head.reference.clone())
        .collect();
    commit_page(&mut cache, &mut first);
    assert_eq!(cache.snapshot().unwrap().len(), 32);
    drop(scanner);
    let mut scanner = AgentScanner::new(source, db, pricing);
    let mut second = scanner
        .refresh_with_checkpoint(None, first.checkpoint.as_ref())
        .unwrap();
    assert_eq!(second.sessions.len(), 32);
    assert!(!second.complete);
    assert!(
        second
            .sessions
            .iter()
            .all(|session| !first_refs.contains(&session.head.reference))
    );
    commit_page(&mut cache, &mut second);
    let mut final_page = scanner
        .refresh_with_checkpoint(None, second.checkpoint.as_ref())
        .unwrap();
    assert_eq!(final_page.sessions.len(), 1);
    assert!(final_page.complete);
    assert!(
        final_page
            .checkpoint
            .as_ref()
            .unwrap()
            .get("offset")
            .is_none()
    );
    commit_page(&mut cache, &mut final_page);
    assert_eq!(cache.snapshot().unwrap().len(), 65);
    let source = pi_source(temporary.path());
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut warm = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut checked = warm.refresh(None).unwrap();
    assert!(checked.complete);
    assert_eq!(checked.checkpoint.as_ref().unwrap()["incremental"], true);
    assert!(checked.sessions.is_empty());
    assert!(checked.removed.is_empty());
    commit_page(&mut cache, &mut checked);
    let changed = source.scan_path.join("history-0000.jsonl");
    let contents = std::fs::read_to_string(&changed)
        .unwrap()
        .replace("History", "Updated history");
    std::fs::write(changed, contents).unwrap();
    std::fs::remove_file(source.scan_path.join("history-0001.jsonl")).unwrap();
    let mut warm = AgentScanner::new(source, db, pricing);
    let updated = warm.refresh(None).unwrap();
    assert!(updated.complete);
    assert_eq!(updated.sessions.len(), 1);
    assert_eq!(updated.removed.len(), 1);
}

#[test]
fn cold_invalid_transcript_does_not_block_first_backfill_page() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    let paths = many_pi(&source, 33);
    let cold = &paths[32];
    std::fs::write(cold, "invalid historical transcript").unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(cold)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
        .unwrap();
    let db = temporary.path().join("cache.db");
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source, db, std::sync::Arc::new(Pricing::bundled()));
    let mut first = scanner.refresh(None).unwrap();
    assert_eq!(first.sessions.len(), 32);
    assert!(!first.complete);
    commit_page(&mut cache, &mut first);
    let mut second = scanner
        .refresh_with_checkpoint(None, first.checkpoint.as_ref())
        .unwrap();
    assert!(second.sessions.is_empty());
    assert!(second.complete);
    commit_page(&mut cache, &mut second);
    assert_eq!(cache.snapshot().unwrap().len(), 32);
}

#[test]
fn cursor_database_pages_preserve_prior_pages_and_seed_incremental_state() {
    let temporary = tempfile::tempdir().unwrap();
    let source = AgentSource {
        agent: "cursor".into(),
        data_root: temporary.path().join("cursor"),
        scan_path: temporary.path().join("cursor"),
    };
    std::fs::create_dir_all(source.scan_path.join("globalStorage")).unwrap();
    let db =
        rusqlite::Connection::open(source.scan_path.join("globalStorage/state.vscdb")).unwrap();
    db.execute_batch("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        .unwrap();
    for index in 0..33 {
        let id = format!("c-{index:03}");
        db.execute(
            "INSERT INTO cursorDiskKV VALUES(?1,?2)",
            rusqlite::params![
                format!("composerData:{id}"),
                serde_json::json!({"composerId":id,"createdAt":1000,"lastSendTime":2000-index})
                    .to_string()
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO cursorDiskKV VALUES(?1,?2)",
            rusqlite::params![
                format!("bubbleId:{id}:u"),
                serde_json::json!({"type":1,"text":"Hello"}).to_string()
            ],
        )
        .unwrap();
    }
    let cache_path = temporary.path().join("cache.db");
    let mut cache = crate::storage::Cache::open(Some(&cache_path)).unwrap();
    let mut scanner = AgentScanner::new(
        source.clone(),
        cache_path,
        std::sync::Arc::new(Pricing::bundled()),
    );
    let mut first = scanner.refresh(None).unwrap();
    assert_eq!(first.sessions.len(), 32);
    assert!(!first.complete);
    cache
        .apply_checkpoint(
            &mut first.sessions,
            &first.removed,
            "cursor",
            &first.checkpoint,
            first.complete,
        )
        .unwrap();
    first.on_reject.take();
    db.execute(
        "UPDATE cursorDiskKV SET value=?1 WHERE key='bubbleId:c-000:u'",
        [serde_json::json!({"type":1,"text":"Live change"}).to_string()],
    )
    .unwrap();
    let mut refreshed = scanner
        .refresh_with_checkpoint(
            Some(&[source.scan_path.join("globalStorage/state.vscdb")]),
            first.checkpoint.as_ref(),
        )
        .unwrap();
    assert_eq!(refreshed.sessions.len(), 1);
    assert!(!refreshed.complete);
    assert_eq!(refreshed.sessions[0].head.reference.session_id, "c-000");
    cache
        .apply_checkpoint(
            &mut refreshed.sessions,
            &refreshed.removed,
            "cursor",
            &refreshed.checkpoint,
            refreshed.complete,
        )
        .unwrap();
    refreshed.on_reject.take();
    let mut last = scanner
        .refresh_with_checkpoint(None, refreshed.checkpoint.as_ref())
        .unwrap();
    assert_eq!(last.sessions.len(), 1);
    assert!(last.complete);
    assert!(last.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut last.sessions,
            &last.removed,
            "cursor",
            &last.checkpoint,
            last.complete,
        )
        .unwrap();
    last.on_reject.take();
    assert_eq!(cache.snapshot().unwrap().len(), 33);
    let delta = scanner
        .refresh(Some(&[source.scan_path.join("globalStorage/state.vscdb")]))
        .unwrap();
    assert!(delta.sessions.is_empty());
    assert!(delta.removed.is_empty());
}

#[test]
fn target_session_is_parsed_in_first_page_even_outside_startup_window() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    let paths = many_pi(&source, 65);
    let mut scanner = AgentScanner::new(
        source,
        temporary.path().join("cache.db"),
        std::sync::Arc::new(Pricing::bundled()),
    )
    .with_startup_window(Some(1_700_000_000_000.0), None)
    .with_target_session(Some(crate::model::SessionReference {
        source_node_id: crate::model::local_source_node_id(),
        agent_name: "pi".into(),
        session_id: "history-0064".into(),
    }));
    let page = scanner.refresh(None).unwrap();
    assert_eq!(page.sessions.len(), 32);
    assert!(
        page.sessions
            .iter()
            .any(|session| session.source == paths[64])
    );
}

#[test]
fn active_source_updates_do_not_restart_historical_frontier() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    let paths = many_pi(&source, 65);
    let db = temporary.path().join("cache.db");
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source, db, std::sync::Arc::new(Pricing::bundled()));
    let mut first = scanner.refresh(None).unwrap();
    commit_page(&mut cache, &mut first);
    let text = std::fs::read_to_string(&paths[0])
        .unwrap()
        .replace("History", "Live update");
    std::fs::write(&paths[0], text).unwrap();
    let mut refreshed = scanner
        .refresh_with_checkpoint(Some(&paths[..1]), first.checkpoint.as_ref())
        .unwrap();
    assert!(!refreshed.complete);
    assert_eq!(refreshed.sessions.len(), 1);
    assert_eq!(refreshed.sessions[0].head.title, "Live update");
    commit_page(&mut cache, &mut refreshed);
    let mut second = scanner
        .refresh_with_checkpoint(Some(&paths[..1]), refreshed.checkpoint.as_ref())
        .unwrap();
    assert_eq!(second.sessions.len(), 32);
    assert!(
        second
            .sessions
            .iter()
            .all(|session| session.source != paths[0])
    );
    commit_page(&mut cache, &mut second);
    let mut refreshed = scanner
        .refresh_with_checkpoint(None, second.checkpoint.as_ref())
        .unwrap();
    assert!(!refreshed.complete);
    assert!(refreshed.sessions.is_empty());
    commit_page(&mut cache, &mut refreshed);
    let mut third = scanner
        .refresh_with_checkpoint(None, refreshed.checkpoint.as_ref())
        .unwrap();
    assert_eq!(third.sessions.len(), 1);
    assert!(third.complete);
    commit_page(&mut cache, &mut third);
    assert_eq!(cache.snapshot().unwrap().len(), 65);
}
