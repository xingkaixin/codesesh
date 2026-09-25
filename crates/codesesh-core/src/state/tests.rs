use super::*;
fn reference(id: &str) -> SessionReference {
    SessionReference {
        agent_name: " CoDeX ".into(),
        session_id: id.into(),
    }
}

#[test]
fn facts_survive_restart_and_import_is_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let mut state = StateStore::open(&path).unwrap();
    let original = state.upsert_bookmark(&reference("one")).unwrap();
    assert_eq!(state.upsert_bookmark(&reference("one")).unwrap(), original);
    state
        .import_bookmarks(&[
            BookmarkRecord {
                reference: reference("one"),
                bookmarked_at: 10.0,
            },
            BookmarkRecord {
                reference: reference("two"),
                bookmarked_at: 20.5,
            },
            BookmarkRecord {
                reference: reference("two"),
                bookmarked_at: 30.0,
            },
        ])
        .unwrap();
    state.upsert_alias(&reference("one"), "  会话  ").unwrap();
    drop(state);
    let mut state = StateStore::open(&path).unwrap();
    assert_eq!(state.list_bookmarks().unwrap()[0], original);
    assert_eq!(state.list_bookmarks().unwrap()[1].bookmarked_at, 20.5);
    assert_eq!(state.list_aliases().unwrap()[0].alias, "会话");
    state.db.execute_batch("CREATE TRIGGER reject_bookmark BEFORE INSERT ON bookmarks WHEN NEW.session_id='bad' BEGIN SELECT RAISE(ABORT,'reject'); END;").unwrap();
    assert!(
        state
            .import_bookmarks(&[
                BookmarkRecord {
                    reference: reference("good"),
                    bookmarked_at: 1.0
                },
                BookmarkRecord {
                    reference: reference("bad"),
                    bookmarked_at: 1.0
                }
            ])
            .is_err()
    );
    assert_eq!(state.list_bookmarks().unwrap().len(), 2);
    state.delete_bookmark(&reference("one")).unwrap();
    state.delete_alias(&reference("one")).unwrap();
    assert_eq!(state.list_bookmarks().unwrap().len(), 1);
    assert!(state.list_aliases().unwrap().is_empty());
}

#[test]
fn legacy_snapshot_migration_backs_up_and_newer_schema_is_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE state_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO state_meta VALUES('version','1'); CREATE TABLE bookmarks(agent_name TEXT,session_id TEXT,bookmarked_at INTEGER,snapshot TEXT,PRIMARY KEY(agent_name,session_id)); INSERT INTO bookmarks VALUES('codex','old',12,'snapshot');").unwrap();
    drop(db);
    let state = StateStore::open(&path).unwrap();
    assert_eq!(state.list_bookmarks().unwrap()[0].bookmarked_at, 12.0);
    let backups: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|v| v == "bak"))
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = Connection::open(backups[0].path()).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT snapshot FROM bookmarks", [], |r| r
                .get::<_, String>(0))
            .unwrap(),
        "snapshot"
    );
    state.db.pragma_update(None, "user_version", 4).unwrap();
    drop(state);
    let state = StateStore::open(&path).unwrap();
    assert_eq!(
        state
            .db
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
}

#[test]
fn invalid_state_is_not_silently_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    std::fs::write(&path, b"corrupt database").unwrap();
    assert!(StateStore::open(&path).is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"corrupt database");
}

#[test]
fn payloads_preserve_legacy_and_utf16_alias_limits() {
    assert!(normalize_session_alias(&"🦀".repeat(80)).is_some());
    assert!(normalize_session_alias(&"🦀".repeat(81)).is_none());
    assert_eq!(
        normalize_session_alias("\u{feff}Alias\u{feff}"),
        Some("Alias".into())
    );
    let value =
        serde_json::json!({"agentKey":" Codex ","sessionId":" / opaque ","bookmarked_at":-1.5});
    assert_eq!(
        parse_bookmark_import(&value, 100).unwrap().bookmarked_at,
        -1.5
    );
    assert!(parse_bookmark_import(&serde_json::json!({"reference":{"agentName":"codex","sessionId":"x"},"bookmarkedAt":"12"}),100).is_none());
}

#[test]
fn paths_match_platform_and_environment_precedence() {
    let home = Path::new("/home/user");
    assert_eq!(
        state_directory(home, "darwin", |_| None),
        home.join("Library/Application Support/codesesh")
    );
    assert_eq!(
        state_directory(home, "linux", |k| (k == "XDG_DATA_HOME")
            .then(|| "/data".into())),
        Path::new("/data/codesesh")
    );
    assert_eq!(
        state_directory(home, "windows", |k| match k {
            "APPDATA" => Some("/roaming".into()),
            "LOCALAPPDATA" => Some("/local".into()),
            _ => None,
        }),
        Path::new("/roaming/codesesh")
    );
}

#[test]
fn memory_aliases_retain_map_insertion_order_after_updates() {
    let state = StateStore::memory().unwrap();
    state.upsert_alias(&reference("first"), "First").unwrap();
    state.upsert_alias(&reference("second"), "Second").unwrap();
    state.upsert_alias(&reference("first"), "Updated").unwrap();
    let aliases = state.list_aliases().unwrap();
    assert_eq!(aliases[0].reference.session_id, "first");
    assert_eq!(aliases[0].alias, "Updated");
    state.delete_alias(&reference("first")).unwrap();
    state
        .upsert_alias(&reference("first"), "Added again")
        .unwrap();
    assert_eq!(
        state.list_aliases().unwrap()[0].reference.session_id,
        "second"
    );
}
