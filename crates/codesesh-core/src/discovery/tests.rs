use super::*;
use std::collections::HashMap;

fn environment(root: &Path) -> PathEnvironment {
    PathEnvironment {
        home: root.join("home"),
        cwd: root.join("cwd"),
        platform: "linux".into(),
        variables: HashMap::new(),
    }
}
#[test]
fn path_overrides_expand_and_fallbacks_preserve_precedence() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    env.variables
        .insert("CODEX_HOME".into(), " ~/custom ".into());
    assert_eq!(env.data_root("codex"), Some(env.home.join("custom")));
    env.variables.insert("CODEX_HOME".into(), "relative".into());
    assert_eq!(env.data_root("codex"), Some(env.cwd.join("relative")));
    env.variables.insert("CODEX_HOME".into(), " \t ".into());
    assert_eq!(env.data_root("codex"), Some(env.home.join(".codex")));
    std::fs::create_dir_all(env.cwd.join("data/pi")).unwrap();
    assert_eq!(env.source("pi").unwrap().scan_path, env.cwd.join("data/pi"));
    std::fs::create_dir_all(env.home.join(".pi/agent/sessions")).unwrap();
    assert_eq!(
        env.source("pi").unwrap().scan_path,
        env.home.join(".pi/agent/sessions")
    );
}
#[test]
fn platform_paths_and_opencode_override_match_existing_rules() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    assert!(env.data_root("zcode").is_none());
    env.platform = "darwin".into();
    assert_eq!(
        env.data_root("deepchat"),
        Some(env.home.join("Library/Application Support/DeepChat"))
    );
    assert_eq!(env.data_root("zcode"), Some(env.home.join(".zcode")));
    env.platform = "win32".into();
    assert_eq!(env.data_home(), env.home.join("AppData/Local"));
    env.variables
        .insert("OPENCODE_DB".into(), ":memory:".into());
    assert!(env.source("opencode").is_none());
    env.variables
        .insert("OPENCODE_DB".into(), "other.sqlite".into());
    assert_eq!(
        env.source("opencode").unwrap().scan_path,
        env.home.join(".local/share/opencode/other.sqlite")
    );
    assert_eq!(selected_sources(&env, &["CODEX".into()]).len(), 1);
}
#[test]
fn counts_and_registry_cover_all_thirteen_agents() {
    let catalog = agents::catalog_counts(&HashMap::from([("kimi".into(), 2), ("codex".into(), 3)]));
    assert_eq!(catalog.len(), 13);
    assert_eq!(catalog.iter().map(|agent| agent.count).sum::<usize>(), 5);
    assert_eq!(catalog.iter().filter(|agent| agent.available).count(), 2);
}

fn pi_source(root: &Path) -> AgentSource {
    AgentSource {
        agent: "pi".into(),
        data_root: root.to_owned(),
        scan_path: root.join("agent/sessions"),
    }
}
fn write_pi(source: &AgentSource, text: &str) -> std::path::PathBuf {
    std::fs::create_dir_all(&source.scan_path).unwrap();
    let file = source.scan_path.join("session.jsonl");
    let records = [
        serde_json::json!({"type":"session","cwd":"/tmp/discovery-fixture","timestamp":1000}),
        serde_json::json!({"type":"message","id":"u","parentId":null,"message":{"role":"user","content":text}}),
    ];
    std::fs::write(
        &file,
        records
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    file
}
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
fn pricing_generation_restarts_scanning_and_carries_commit_ticket() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    write_pi(&source, "Priced session");
    let controller = crate::pricing::PricingController::load(temporary.path());
    let mut scanner = AgentScanner::with_pricing_controller(
        source.clone(),
        temporary.path().join("cache.db"),
        controller.clone(),
    )
    .unwrap();
    let mut initial = scanner.refresh(None).unwrap();
    let old = initial.pricing.clone().unwrap();
    initial.on_reject.take();
    let mut unchanged = scanner
        .refresh(Some(&[source.scan_path.join("unrelated.txt")]))
        .unwrap();
    assert!(unchanged.sessions.is_empty());
    unchanged.on_reject.take();
    controller.stage_remote(&serde_json::json!({"openai":{"models":{"discovery-new-model":{"cost":{"input":2,"output":8}}}}})).unwrap();
    assert!(controller.publish_pending().unwrap());
    assert!(old.check().is_err());
    let refreshed = scanner
        .refresh(Some(&[source.scan_path.join("unrelated.txt")]))
        .unwrap();
    assert_eq!(refreshed.sessions.len(), 1);
    assert_eq!(
        refreshed.pricing.as_ref().unwrap().generation(),
        controller.generation()
    );
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
    assert!(scanner.refresh(None).is_err());
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

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
fn commit_page(cache: &mut crate::storage::Cache, batch: &mut crate::runtime::ScanBatch) {
    cache
        .apply_checkpoint(
            &mut batch.sessions,
            &batch.removed,
            "pi",
            &batch.checkpoint,
            batch.complete,
        )
        .unwrap();
    batch.on_reject.take();
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
    assert!(
        scanner
            .refresh_with_checkpoint(None, first.checkpoint.as_ref())
            .is_err()
    );
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
    .with_target_session(Some(crate::contract::SessionReference {
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

#[test]
fn every_catalog_entry_has_a_source_resolver_and_scanner() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    env.platform = "darwin".into();
    env.variables.insert(
        "CURSOR_DATA_PATH".into(),
        temporary
            .path()
            .join("cursor")
            .to_string_lossy()
            .into_owned(),
    );
    let pricing = Pricing::bundled();
    for agent in agents::catalog(0) {
        let source = env
            .source(&agent.name)
            .unwrap_or_else(|| panic!("missing resolver for {}", agent.name));
        assert!(
            agents::scan_agent(&agent.name, &source.scan_path, &source.data_root, &pricing)
                .unwrap()
                .is_empty()
        );
    }
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
