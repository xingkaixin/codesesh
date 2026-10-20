use super::*;

#[test]
fn rejected_publication_rescans_before_advancing_source_state() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    write_pi(&source, "Initial");
    let mut scanner = AgentScanner::new(
        source.clone(),
        temporary.path().join("cache.db"),
        std::sync::Arc::new(Pricing::bundled()),
    );
    let first = scanner.refresh(None).unwrap();
    assert_eq!(first.sessions.len(), 1);
    drop(first);
    let retried = scanner
        .refresh(Some(&[source.scan_path.join("unrelated.txt")]))
        .unwrap();
    assert_eq!(retried.sessions.len(), 1);
}

#[test]
fn committed_incremental_refresh_ignores_unrelated_sources_and_reports_delete() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    let file = write_pi(&source, "Initial");
    let db = temporary.path().join("cache.db");
    let mut scanner = AgentScanner::new(
        source.clone(),
        db.clone(),
        std::sync::Arc::new(Pricing::bundled()),
    );
    let mut batch = scanner.refresh(None).unwrap();
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    cache.publish(&mut batch.sessions).unwrap();
    batch.on_reject.take();
    write_pi(&source, "Changed");
    std::fs::create_dir(source.scan_path.join("unrelated.jsonl")).unwrap();
    let mut updated = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert_eq!(updated.sessions.len(), 1);
    assert_eq!(updated.sessions[0].head.title, "Changed");
    cache.publish(&mut updated.sessions).unwrap();
    updated.on_reject.take();
    std::fs::remove_file(&file).unwrap();
    let removed = scanner.refresh(Some(&[file])).unwrap();
    assert!(removed.sessions.is_empty());
    assert_eq!(removed.removed.len(), 1);
}

#[test]
fn missing_sources_are_empty_but_corrupt_databases_report_failures() {
    let temporary = tempfile::tempdir().unwrap();
    let pi = pi_source(temporary.path());
    write_pi(&pi, "Survives another agent failure");
    let deep = AgentSource {
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
