use super::*;

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

#[test]
fn reused_database_inventory_still_lists_new_sessions() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("zcode");
    let file = root.join("cli/db/db.sqlite");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,directory TEXT,version TEXT,summary_files TEXT,slug TEXT); INSERT INTO session(id,title,time_created,time_updated,directory) VALUES('first','First',1000,2000,'/project');").unwrap();
    let source = AgentSource {
        agent: "zcode".into(),
        data_root: root.clone(),
        scan_path: root,
    };
    let (mut scanner, mut cache) = database_scanner(temporary.path(), source);
    assert_eq!(refreshed_ids(&mut scanner, &mut cache, "zcode"), ["first"]);
    assert!(refreshed_ids(&mut scanner, &mut cache, "zcode").is_empty());
    database.execute("INSERT INTO session(id,title,time_created,time_updated,directory) VALUES('second','Second',3000,4000,'/project')", []).unwrap();
    assert_eq!(refreshed_ids(&mut scanner, &mut cache, "zcode"), ["second"]);
}

#[test]
fn unrelated_database_writes_do_not_reparse_desktop_sessions() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("deepchat");
    let file = root.join("app_db/agent.db");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database
        .execute_batch(include_str!("../../agents/deepchat/fixture.sql"))
        .unwrap();
    database.execute_batch("INSERT INTO new_sessions(id,agent_id,title,project_dir) VALUES('s','deepchat','Session','/work'); INSERT INTO deepchat_messages(id,session_id,order_seq,role,content,metadata,created_at,updated_at) VALUES('u','s',1,'user','{\"text\":\"Hello\"}','{}',1000,3000);").unwrap();
    let source = AgentSource {
        agent: "deepchat".into(),
        data_root: root.clone(),
        scan_path: root,
    };
    let stamp = backfill::database_stamp(&source).unwrap();
    let (mut scanner, mut cache) = database_scanner(temporary.path(), source.clone());
    assert_eq!(refreshed_ids(&mut scanner, &mut cache, "deepchat"), ["s"]);
    database
        .execute_batch("CREATE TABLE app_settings(key TEXT,value TEXT); INSERT INTO app_settings VALUES('theme','dark');")
        .unwrap();
    assert_ne!(backfill::database_stamp(&source).unwrap(), stamp);
    assert!(refreshed_ids(&mut scanner, &mut cache, "deepchat").is_empty());
    database
        .execute("UPDATE deepchat_messages SET content='{\"text\":\"Edited\"}',updated_at=4000 WHERE id='u'", [])
        .unwrap();
    assert_eq!(refreshed_ids(&mut scanner, &mut cache, "deepchat"), ["s"]);
}

#[test]
fn child_session_changes_refresh_their_database_root() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("zcode");
    let file = root.join("cli/db/db.sqlite");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,directory TEXT,version TEXT,summary_files TEXT,slug TEXT); INSERT INTO session(id,parent_id,title,time_created,time_updated,directory) VALUES('root',NULL,'Root',1000,2000,'/project'),('child','root','Child',1000,2000,'/project');").unwrap();
    let source = AgentSource {
        agent: "zcode".into(),
        data_root: root.clone(),
        scan_path: root,
    };
    let (mut scanner, mut cache) = database_scanner(temporary.path(), source);
    assert!(!refreshed_ids(&mut scanner, &mut cache, "zcode").is_empty());
    assert!(refreshed_ids(&mut scanner, &mut cache, "zcode").is_empty());
    database
        .execute("UPDATE session SET title='Renamed' WHERE id='child'", [])
        .unwrap();
    assert!(refreshed_ids(&mut scanner, &mut cache, "zcode").contains(&"child".to_owned()));
}

fn database_scanner(
    directory: &Path,
    source: AgentSource,
) -> (AgentScanner, crate::storage::Cache) {
    let db = directory.join("cache.db");
    let cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let scanner = AgentScanner::new(source, db, std::sync::Arc::new(Pricing::bundled()));
    (scanner, cache)
}

fn refreshed_ids(
    scanner: &mut AgentScanner,
    cache: &mut crate::storage::Cache,
    agent: &str,
) -> Vec<String> {
    let mut batch = scanner.refresh(None).unwrap();
    let ids = batch
        .sessions
        .iter()
        .map(|session| session.head.reference.session_id.clone())
        .collect();
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
    ids
}
