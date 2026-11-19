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
        antigravity_profiles: None,
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
        antigravity_profiles: None,
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
fn child_session_changes_refresh_their_database_root() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("zcode");
    let file = root.join("cli/db/db.sqlite");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,directory TEXT,version TEXT,summary_files TEXT,slug TEXT); INSERT INTO session(id,parent_id,title,time_created,time_updated,directory) VALUES('root',NULL,'Root',1000,2000,'/project'),('child','root','Child',1000,2000,'/project');").unwrap();
    let source = AgentSource {
        antigravity_profiles: None,
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

#[test]
fn cursor_warm_restart_reuses_unchanged_sessions_and_tracks_updates_and_deletions() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("cursor");
    std::fs::create_dir_all(root.join("globalStorage")).unwrap();
    let file = root.join("globalStorage/state.vscdb");
    let database = rusqlite::Connection::open(&file).unwrap();
    database
        .execute_batch("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .unwrap();
    for (key, value) in [
        (
            "composerData:a",
            serde_json::json!({"composerId":"a","createdAt":1000,"lastSendTime":3000,"subagentInfos":[{"id":"child"}]}),
        ),
        (
            "composerData:b",
            serde_json::json!({"composerId":"b","createdAt":1000,"lastSendTime":2000}),
        ),
        (
            "composerData:c",
            serde_json::json!({"composerId":"c","createdAt":1000,"lastSendTime":1500}),
        ),
        (
            "composerData:empty",
            serde_json::json!({"composerId":"empty","createdAt":1000}),
        ),
        ("bubbleId:a:1", serde_json::json!({"type":1,"text":"Alpha"})),
        ("bubbleId:b:1", serde_json::json!({"type":1,"text":"Beta"})),
        ("bubbleId:c:1", serde_json::json!({"type":1,"text":"Gamma"})),
        (
            "bubble:child",
            serde_json::json!({"chatMessages":[{"role":"assistant","text":"Child v1"}]}),
        ),
    ] {
        database
            .execute(
                "INSERT INTO cursorDiskKV VALUES(?1,?2)",
                rusqlite::params![key, value.to_string()],
            )
            .unwrap();
    }
    let source = AgentSource {
        antigravity_profiles: None,
        agent: "cursor".into(),
        data_root: root.clone(),
        scan_path: root,
    };
    let db = temporary.path().join("cache.db");
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let mut scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    assert_eq!(refreshed_ids(&mut scanner, &mut cache, "cursor").len(), 3);

    // Warm restart with unchanged DB reuses all sessions and empty composers.
    scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.complete);
    assert!(warm.sessions.is_empty());
    assert!(warm.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut warm.sessions,
            &warm.removed,
            "cursor",
            &warm.checkpoint,
            warm.complete,
        )
        .unwrap();
    warm.on_reject.take();

    // Live update right after warm restart only parses the single modified session.
    database
        .execute(
            "UPDATE cursorDiskKV SET value=?1 WHERE key='bubbleId:a:1'",
            [serde_json::json!({"type":1,"text":"Alpha v2"}).to_string()],
        )
        .unwrap();
    let mut live = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert_eq!(live.sessions.len(), 1);
    assert_eq!(live.sessions[0].head.reference.session_id, "a");
    assert!(live.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut live.sessions,
            &live.removed,
            "cursor",
            &live.checkpoint,
            live.complete,
        )
        .unwrap();
    live.on_reject.take();

    // Subsequent warm restart still reuses everything, including the live-updated session.
    scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    assert!(refreshed_ids(&mut scanner, &mut cache, "cursor").is_empty());

    // Subagent update invalidates only its owner; composer deletion removes only that session.
    database
        .execute(
            "UPDATE cursorDiskKV SET value=?1 WHERE key='bubble:child'",
            [
                serde_json::json!({"chatMessages":[{"role":"assistant","text":"Child v2"}]})
                    .to_string(),
            ],
        )
        .unwrap();
    database
        .execute("DELETE FROM cursorDiskKV WHERE key='composerData:b'", [])
        .unwrap();
    scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut restarted = scanner.refresh(None).unwrap();
    assert!(restarted.complete);
    assert_eq!(restarted.sessions.len(), 1);
    assert_eq!(restarted.sessions[0].head.reference.session_id, "a");
    assert_eq!(restarted.removed.len(), 1);
    assert_eq!(restarted.removed[0].session_id, "b");
    cache
        .apply_checkpoint(
            &mut restarted.sessions,
            &restarted.removed,
            "cursor",
            &restarted.checkpoint,
            restarted.complete,
        )
        .unwrap();
    restarted.on_reject.take();

    // Emptying a session removes it live and stays quiet across restart.
    database
        .execute("DELETE FROM cursorDiskKV WHERE key='bubbleId:c:1'", [])
        .unwrap();
    let mut emptied = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert!(emptied.sessions.is_empty());
    assert_eq!(emptied.removed.len(), 1);
    assert_eq!(emptied.removed[0].session_id, "c");
    cache
        .apply_checkpoint(
            &mut emptied.sessions,
            &emptied.removed,
            "cursor",
            &emptied.checkpoint,
            emptied.complete,
        )
        .unwrap();
    emptied.on_reject.take();

    scanner = AgentScanner::new(source, db, pricing);
    let mut quiet = scanner.refresh(None).unwrap();
    assert!(quiet.sessions.is_empty());
    assert!(quiet.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut quiet.sessions,
            &quiet.removed,
            "cursor",
            &quiet.checkpoint,
            quiet.complete,
        )
        .unwrap();
    quiet.on_reject.take();
    assert_eq!(cache.snapshot().unwrap().len(), 1);
}

#[test]
fn paged_cursor_backfill_uses_the_refreshed_storage_key() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("cursor");
    std::fs::create_dir_all(root.join("globalStorage")).unwrap();
    let path = root.join("globalStorage/state.vscdb");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        .unwrap();
    for index in 0..34 {
        let id = format!("session-{index:02}");
        for (key, value) in [
            (
                format!("composerData:{id}"),
                serde_json::json!({"composerId":id, "lastSendTime":2000-index}),
            ),
            (
                format!("bubbleId:{id}:1"),
                serde_json::json!({"type":1,"text":id}),
            ),
        ] {
            db.execute(
                "INSERT INTO cursorDiskKV VALUES(?,?)",
                [key, value.to_string()],
            )
            .unwrap();
        }
    }
    db.execute(
        "INSERT INTO cursorDiskKV VALUES('composerData:legacy',?)",
        [serde_json::json!({"composerId":"session-32","lastSendTime":1968}).to_string()],
    )
    .unwrap();
    let source = AgentSource {
        agent: "cursor".into(),
        data_root: root.clone(),
        scan_path: root,
        antigravity_profiles: None,
    };
    let (mut warm, mut cache) = database_scanner(temp.path(), source.clone());
    assert_eq!(refreshed_ids(&mut warm, &mut cache, "cursor").len(), 32);
    assert_eq!(refreshed_ids(&mut warm, &mut cache, "cursor").len(), 2);
    drop(cache);
    db.execute("UPDATE cursorDiskKV SET value=? WHERE key LIKE 'bubbleId:%' AND key <> 'bubbleId:session-33:1'",
        [serde_json::json!({"type":1,"text":"Updated"}).to_string()]).unwrap();
    let (mut scanner, mut cache) = database_scanner(temp.path(), source);
    assert_eq!(refreshed_ids(&mut scanner, &mut cache, "cursor").len(), 32);
    db.execute(
        "DELETE FROM cursorDiskKV WHERE key IN ('composerData:legacy','composerData:session-33')",
        [],
    )
    .unwrap();
    let mut dirty = scanner.refresh(Some(&[path])).unwrap();
    assert!(!dirty.complete);
    assert_eq!(dirty.removed.len(), 1);
    assert_eq!(dirty.removed[0].session_id, "session-33");
    cache
        .apply_checkpoint(
            &mut dirty.sessions,
            &dirty.removed,
            "cursor",
            &dirty.checkpoint,
            dirty.complete,
        )
        .unwrap();
    dirty.on_reject.take();
    let final_page = scanner.refresh(None).unwrap();
    assert!(final_page.complete);
    assert_eq!(final_page.sessions.len(), 1);
    assert_eq!(
        final_page.sessions[0].head.reference.session_id,
        "session-32"
    );
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
