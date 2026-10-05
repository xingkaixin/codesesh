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
fn counts_and_registry_cover_all_fourteen_agents() {
    let catalog = agents::catalog_counts(&HashMap::from([("kimi".into(), 2), ("codex".into(), 3)]));
    assert_eq!(catalog.len(), 14);
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
fn unrelated_pricing_changes_preserve_scans_and_replace_commit_ticket() {
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
    assert!(refreshed.sessions.is_empty());
    assert!(refreshed.complete);
    assert_eq!(
        refreshed.pricing.as_ref().unwrap().generation(),
        controller.generation()
    );
}

#[test]
fn durable_pricing_dependencies_reuse_unrelated_changes_and_refresh_used_prices() {
    for model in ["discovery-missing-model", "gpt-4o-2024-08-06"] {
        let temporary = tempfile::tempdir().unwrap();
        let source = pi_source(temporary.path());
        let file = write_pi(&source, "Priced session");
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap(),
            "\n{}",
            serde_json::json!({"type":"message","id":"a","parentId":"u","message":{
                "role":"assistant","model":model,"usage":{"input":1000000,"output":0},
                "content":[{"type":"text","text":"Answer"}]}})
        )
        .unwrap();
        let db = temporary.path().join("cache.db");
        let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
        let controller = crate::pricing::PricingController::load(temporary.path());
        let mut scanner =
            AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
                .unwrap();
        let mut initial = scanner.refresh(None).unwrap();
        let old_cost = initial.sessions[0].head.stats.total_cost;
        assert!(
            initial.checkpoint.as_ref().unwrap()["sourceState"]["priceDependencies"]
                .get(model)
                .is_some()
        );
        commit_page(&mut cache, &mut initial);
        controller.stage_remote(&serde_json::json!({"openai":{"models":{"unrelated-model":{"cost":{"input":2,"output":8}}}}})).unwrap();
        controller.publish_pending().unwrap();
        let mut warm = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
        assert!(warm.complete);
        assert!(warm.sessions.is_empty());
        // Leave the old generation on disk to exercise restart across a pricing change.
        warm.on_reject.take();
        let mut scanner =
            AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
                .unwrap();
        let mut restarted = scanner.refresh(None).unwrap();
        assert!(restarted.complete);
        assert!(restarted.sessions.is_empty());
        assert_eq!(restarted.checkpoint.as_ref().unwrap()["incremental"], true);
        commit_page(&mut cache, &mut restarted);
        controller
            .stage_remote(
                &serde_json::json!({"openai":{"models":{model:{"cost":{"input":123,"output":8}}}}}),
            )
            .unwrap();
        controller.publish_pending().unwrap();
        let mut repriced = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
        assert!(repriced.sessions.is_empty());
        assert!(repriced.complete);
        commit_page(&mut cache, &mut repriced);
        let updated = cache
            .reprice("pi", &controller.snapshot().unwrap().pricing)
            .unwrap();
        assert_eq!(updated.len(), 1);
        let head = cache.head(&updated[0]).unwrap().unwrap();
        assert_ne!(head.stats.total_cost, old_cost);
        assert_eq!(head.stats.total_cost, 123.0);
        let mut scanner = AgentScanner::with_pricing_controller(source, db, controller).unwrap();
        let mut stable = scanner.refresh(None).unwrap();
        assert!(stable.sessions.is_empty());
        commit_page(&mut cache, &mut stable);
    }
}

#[test]
fn legacy_pricing_state_stays_unknown_until_reparsed() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    write_pi(&source, "Legacy session");
    let db = temporary.path().join("cache.db");
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let controller = crate::pricing::PricingController::load(temporary.path());
    let mut scanner =
        AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
            .unwrap();
    let mut initial = scanner.refresh(None).unwrap();
    commit_page(&mut cache, &mut initial);
    cache.connection().execute("UPDATE cache_meta SET value=json_remove(value,'$.priceDependencies') WHERE key='rust_source_state:pi'", []).unwrap();
    cache
        .connection()
        .execute(
            "UPDATE sessions SET meta_json=json_remove(meta_json,'$.rustPricing')",
            [],
        )
        .unwrap();
    let mut scanner =
        AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
            .unwrap();
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    assert!(warm.checkpoint.as_ref().unwrap()["sourceState"]["priceDependencies"].is_null());
    commit_page(&mut cache, &mut warm);
    controller.stage_remote(&serde_json::json!({"openai":{"models":{"unrelated-model":{"cost":{"input":2,"output":8}}}}})).unwrap();
    controller.publish_pending().unwrap();
    let mut scanner = AgentScanner::with_pricing_controller(source, db, controller).unwrap();
    let mut refreshed = scanner.refresh(None).unwrap();
    assert_eq!(refreshed.sessions.len(), 1);
    commit_page(&mut cache, &mut refreshed);
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
fn removed_zcode_database_retains_sessions_and_resumes_after_restore() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("zcode");
    let file = root.join("cli/db/db.sqlite");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,directory TEXT,version TEXT,summary_files TEXT,slug TEXT); INSERT INTO session(id,title,time_created,time_updated,directory) VALUES('retained','Before removal',1000,2000,'/project');").unwrap();
    drop(database);
    let source = AgentSource {
        agent: "zcode".into(),
        data_root: root.clone(),
        scan_path: root,
    };
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut first = scanner.refresh(None).unwrap();
    assert_eq!(first.sessions.len(), 1);
    cache
        .apply_checkpoint(
            &mut first.sessions,
            &first.removed,
            "zcode",
            &first.checkpoint,
            first.complete,
        )
        .unwrap();
    first.on_reject.take();
    scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.complete);
    assert!(warm.sessions.is_empty());
    assert!(warm.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut warm.sessions,
            &warm.removed,
            "zcode",
            &warm.checkpoint,
            warm.complete,
        )
        .unwrap();
    warm.on_reject.take();
    let backup = temporary.path().join("backup.sqlite");
    std::fs::rename(&file, &backup).unwrap();
    for paths in [Some(vec![file.clone()]), None] {
        let mut absent = scanner.refresh(paths.as_deref()).unwrap();
        assert!(absent.complete);
        assert!(absent.sessions.is_empty());
        assert!(absent.removed.is_empty());
        cache
            .apply_checkpoint(
                &mut absent.sessions,
                &absent.removed,
                "zcode",
                &absent.checkpoint,
                absent.complete,
            )
            .unwrap();
        absent.on_reject.take();
        assert_eq!(cache.snapshot().unwrap().len(), 1);
        scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    }
    std::fs::rename(backup, &file).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database
        .execute("UPDATE session SET title='Restored',time_updated=3000", [])
        .unwrap();
    drop(database);
    let restored = scanner.refresh(None).unwrap();
    assert_eq!(restored.sessions[0].head.title, "Restored");
    assert!(restored.removed.is_empty());
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
        source_node_id: crate::contract::local_source_node_id(),
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
