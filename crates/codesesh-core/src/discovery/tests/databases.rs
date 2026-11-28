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

#[test]
fn unchanged_database_stamp_skips_opening_sqlite_on_warm_restart_and_live_refresh() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("zcode");
    let file = root.join("cli/db/db.sqlite");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database
        .execute_batch(
            "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,directory TEXT,version TEXT,summary_files TEXT,slug TEXT); \
             INSERT INTO session(id,title,time_created,time_updated,directory) VALUES('s1','Initial',1000,2000,'/project');",
        )
        .unwrap();
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
    let mut initial = scanner.refresh(None).unwrap();
    assert_eq!(initial.sessions.len(), 1);
    let stamp = initial.checkpoint.as_ref().unwrap()["sourceState"]["databaseStamp"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!stamp.is_empty());
    cache
        .apply_checkpoint(
            &mut initial.sessions,
            &initial.removed,
            "zcode",
            &initial.checkpoint,
            initial.complete,
        )
        .unwrap();
    initial.on_reject.take();

    // Hold an exclusive lock without mutating the DB file; any SQLite read would block and fail.
    database.execute_batch("BEGIN EXCLUSIVE").unwrap();
    scanner = AgentScanner::new(source.clone(), db.clone(), pricing.clone());
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.complete);
    assert!(warm.sessions.is_empty());
    assert!(warm.removed.is_empty());
    assert_eq!(warm.source_presence, Some(SourcePresence::Available));
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

    let mut live_unchanged = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert!(live_unchanged.complete);
    assert!(live_unchanged.sessions.is_empty());
    assert!(live_unchanged.removed.is_empty());
    assert_eq!(
        live_unchanged.source_presence,
        Some(SourcePresence::Available)
    );
    cache
        .apply_checkpoint(
            &mut live_unchanged.sessions,
            &live_unchanged.removed,
            "zcode",
            &live_unchanged.checkpoint,
            live_unchanged.complete,
        )
        .unwrap();
    live_unchanged.on_reject.take();

    // Subsequent write invalidates the persisted stamp and refreshes accurately.
    database
        .execute_batch(
            "UPDATE session SET title='Updated', time_updated=3000 WHERE id='s1'; COMMIT;",
        )
        .unwrap();
    let mut live_updated = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert!(live_updated.complete);
    assert_eq!(live_updated.sessions.len(), 1);
    assert_eq!(live_updated.sessions[0].head.title, "Updated");
    assert!(live_updated.removed.is_empty());
    let updated_stamp = live_updated.checkpoint.as_ref().unwrap()["sourceState"]["databaseStamp"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(updated_stamp, stamp);
    cache
        .apply_checkpoint(
            &mut live_updated.sessions,
            &live_updated.removed,
            "zcode",
            &live_updated.checkpoint,
            live_updated.complete,
        )
        .unwrap();
    live_updated.on_reject.take();

    // Subsequent deletion after warm restart removes the deleted session cleanly.
    scanner = AgentScanner::new(source, db, pricing);
    let mut warm_after_update = scanner.refresh(None).unwrap();
    assert!(warm_after_update.sessions.is_empty());
    assert!(warm_after_update.removed.is_empty());
    cache
        .apply_checkpoint(
            &mut warm_after_update.sessions,
            &warm_after_update.removed,
            "zcode",
            &warm_after_update.checkpoint,
            warm_after_update.complete,
        )
        .unwrap();
    warm_after_update.on_reject.take();

    database
        .execute("DELETE FROM session WHERE id='s1'", [])
        .unwrap();
    let mut live_deleted = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert!(live_deleted.sessions.is_empty());
    assert_eq!(live_deleted.removed.len(), 1);
    assert_eq!(live_deleted.removed[0].session_id, "s1");
    cache
        .apply_checkpoint(
            &mut live_deleted.sessions,
            &live_deleted.removed,
            "zcode",
            &live_deleted.checkpoint,
            live_deleted.complete,
        )
        .unwrap();
    live_deleted.on_reject.take();
    assert!(cache.snapshot().unwrap().is_empty());
}

#[test]
fn mid_backfill_database_write_does_not_persist_new_stamp_and_partial_warm_snapshot_detects_deletes()
 {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("zcode");
    let file = root.join("cli/db/db.sqlite");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let database = rusqlite::Connection::open(&file).unwrap();
    database
        .execute_batch(
            "CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER,directory TEXT,version TEXT,summary_files TEXT,slug TEXT);",
        )
        .unwrap();
    for index in 0..33 {
        database
            .execute(
                "INSERT INTO session(id,title,time_created,time_updated,directory) VALUES(?1,?2,?3,?4,'/project')",
                rusqlite::params![
                    format!("s{index:02}"),
                    format!("Title {index:02}"),
                    1000 + index,
                    2000 + index,
                ],
            )
            .unwrap();
    }
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

    // Page 1 reads 32 of 33 sessions.
    let mut page1 = scanner.refresh(None).unwrap();
    assert!(!page1.complete);
    assert_eq!(page1.sessions.len(), 32);
    cache
        .apply_checkpoint(
            &mut page1.sessions,
            &page1.removed,
            "zcode",
            &page1.checkpoint,
            page1.complete,
        )
        .unwrap();
    page1.on_reject.take();

    // Mutate an already-read session before page 2 completes.
    database
        .execute(
            "UPDATE session SET title='Mid-backfill update', time_updated=9999 WHERE id='s32'",
            [],
        )
        .unwrap();
    let mut page2 = scanner.refresh(None).unwrap();
    assert!(page2.complete);
    assert!(
        page2.checkpoint.as_ref().unwrap()["sourceState"]["databaseStamp"].is_null(),
        "mid-backfill write must prevent certifying the changed stamp"
    );
    cache
        .apply_checkpoint(
            &mut page2.sessions,
            &page2.removed,
            "zcode",
            &page2.checkpoint,
            page2.complete,
        )
        .unwrap();
    page2.on_reject.take();

    // Live refresh sees the uncertified write instead of skipping it.
    let mut live = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert_eq!(live.sessions.len(), 1);
    assert_eq!(live.sessions[0].head.reference.session_id, "s32");
    assert_eq!(live.sessions[0].head.title, "Mid-backfill update");
    assert!(
        live.checkpoint.as_ref().unwrap()["sourceState"]["databaseStamp"]
            .as_str()
            .is_some_and(|stamp| !stamp.is_empty())
    );
    cache
        .apply_checkpoint(
            &mut live.sessions,
            &live.removed,
            "zcode",
            &live.checkpoint,
            live.complete,
        )
        .unwrap();
    live.on_reject.take();

    // Warm restart where only s32 changed leaves s00 reused (absent from in-memory opencode snapshot).
    database
        .execute(
            "UPDATE session SET title='Warm change', time_updated=10000 WHERE id='s32'",
            [],
        )
        .unwrap();
    scanner = AgentScanner::new(source, db, pricing);
    for _ in 0..2 {
        let mut batch = scanner.refresh(None).unwrap();
        let complete = batch.complete;
        cache
            .apply_checkpoint(
                &mut batch.sessions,
                &batch.removed,
                "zcode",
                &batch.checkpoint,
                batch.complete,
            )
            .unwrap();
        batch.on_reject.take();
        if complete {
            break;
        }
    }

    // Deleting s00 (reused during warm restart) must be reported by the next live refresh.
    database
        .execute("DELETE FROM session WHERE id='s00'", [])
        .unwrap();
    let mut deleted = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
    assert_eq!(deleted.removed.len(), 1);
    assert_eq!(deleted.removed[0].session_id, "s00");
    cache
        .apply_checkpoint(
            &mut deleted.sessions,
            &deleted.removed,
            "zcode",
            &deleted.checkpoint,
            deleted.complete,
        )
        .unwrap();
    deleted.on_reject.take();
    assert_eq!(cache.snapshot().unwrap().len(), 32);

    // Moving away the ZCode database mid-backfill preserves cached sessions with zero removals.
    database
        .execute(
            "INSERT INTO session(id,title,time_created,time_updated,directory) VALUES('s33','Extra',1033,10001,'/project')",
            [],
        )
        .unwrap();
    database
        .execute("UPDATE session SET title = title || ' v2'", [])
        .unwrap();
    let mut vanish_scanner = AgentScanner::new(
        AgentSource {
            antigravity_profiles: None,
            agent: "zcode".into(),
            data_root: file
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf(),
            scan_path: file
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .parent()
                .unwrap()
                .to_path_buf(),
        },
        temporary.path().join("cache.db"),
        std::sync::Arc::new(Pricing::bundled()),
    );
    let mut p1 = vanish_scanner.refresh(None).unwrap();
    assert!(!p1.complete);
    cache
        .apply_checkpoint(
            &mut p1.sessions,
            &p1.removed,
            "zcode",
            &p1.checkpoint,
            p1.complete,
        )
        .unwrap();
    p1.on_reject.take();
    drop(database);
    std::fs::remove_file(&file).unwrap();
    let p2 = vanish_scanner.refresh(None).unwrap();
    assert!(p2.removed.is_empty());
    assert_eq!(p2.source_presence, Some(SourcePresence::Missing));
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
