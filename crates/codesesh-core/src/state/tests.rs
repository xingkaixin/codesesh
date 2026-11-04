use super::*;
fn reference(id: &str) -> SessionReference {
    SessionReference {
        source_node_id: crate::model::local_source_node_id(),
        agent_name: " CoDeX ".into(),
        session_id: id.into(),
    }
}

#[test]
fn source_nodes_keep_bookmarks_and_aliases_separate_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.db");
    let local = reference("same");
    let mut remote = local.clone();
    remote.source_node_id = "worker-a".into();
    let state = StateStore::open(&path).unwrap();
    state.upsert_bookmark(&local).unwrap();
    state.upsert_bookmark(&remote).unwrap();
    state.upsert_alias(&local, "Local").unwrap();
    state.upsert_alias(&remote, "Remote").unwrap();
    drop(state);
    let state = StateStore::open(&path).unwrap();
    assert_eq!(state.list_bookmarks().unwrap().len(), 2);
    assert_eq!(state.list_aliases().unwrap().len(), 2);
    state.delete_bookmark(&remote).unwrap();
    state.delete_alias(&remote).unwrap();
    assert_eq!(
        state.list_bookmarks().unwrap()[0].reference,
        normalize_reference(&local)
    );
    assert_eq!(state.list_aliases().unwrap()[0].alias, "Local");
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
