use super::*;

fn options(home: &Path) -> Options {
    Options {
        home: home.into(),
        environment: BTreeMap::new(),
        state: false,
        cache: true,
        clear_cache: false,
    }
}

#[test]
fn wal_database_is_verified_and_old_files_are_removed() {
    let home = tempfile::tempdir().unwrap();
    let old = home.path().join(".cache/codesesh");
    fs::create_dir_all(&old).unwrap();
    let db = rusqlite::Connection::open(old.join("codesesh.db")).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE messages(id INTEGER PRIMARY KEY, text TEXT); INSERT INTO messages VALUES(1,'from WAL');").unwrap();
    let mut phases = BTreeSet::new();
    let candidate = Candidate {
        source: old.join("codesesh.db"),
        target: home.path().join(".codesesh/codesesh.db"),
        database: true,
    };
    migrate(&candidate, &mut |p| {
        phases.insert(p.phase);
    })
    .unwrap();
    let migrated = rusqlite::Connection::open(&candidate.target).unwrap();
    assert_eq!(
        migrated
            .query_row("SELECT text FROM messages", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "from WAL"
    );
    assert!(phases.contains("Migrating"));
    assert!(phases.contains("Verifying rows"));
    drop(db);
}

#[test]
fn completed_migration_does_not_restore_deleted_target() {
    let home = tempfile::tempdir().unwrap();
    let old = home.path().join(".cache/codesesh");
    fs::create_dir_all(&old).unwrap();
    let db = rusqlite::Connection::open(old.join("codesesh.db")).unwrap();
    db.execute_batch("CREATE TABLE data(value); INSERT INTO data VALUES(42)")
        .unwrap();
    drop(db);
    let mut confirmations = 0;
    run(
        options(home.path()),
        |_| {
            confirmations += 1;
            Ok(())
        },
        |_| {},
    )
    .unwrap();
    assert_eq!(confirmations, 1);
    assert!(!old.exists());
    let target = home.path().join(".codesesh/codesesh.db");
    fs::remove_file(&target).unwrap();
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("codesesh.db"), b"stale").unwrap();
    run(
        options(home.path()),
        |_| panic!("must not confirm again"),
        |_| {},
    )
    .unwrap();
    assert!(!target.exists());
}

#[test]
fn missing_record_never_overwrites_existing_destination() {
    let home = tempfile::tempdir().unwrap();
    let old = home.path().join(".cache/codesesh");
    let new = home.path().join(".codesesh");
    fs::create_dir_all(&old).unwrap();
    fs::create_dir_all(&new).unwrap();
    fs::write(old.join("codesesh.db"), b"old").unwrap();
    fs::write(new.join("codesesh.db"), b"new").unwrap();
    let warnings = run(
        options(home.path()),
        |_| panic!("no migration needed"),
        |_| {},
    )
    .unwrap();
    assert!(warnings.iter().any(|s| s.contains("already exists")));
    assert_eq!(fs::read(new.join("codesesh.db")).unwrap(), b"new");
    assert!(
        run(options(home.path()), |_| panic!(), |_| {})
            .unwrap()
            .is_empty()
    );
}

#[test]
fn changed_residue_is_retained_without_reimport() {
    let home = tempfile::tempdir().unwrap();
    let old = home.path().join("old.log");
    fs::write(&old, b"original").unwrap();
    let mut item = Item {
        source: old.clone(),
        cleanup: Cleanup::Pending,
        fingerprints: files::fingerprints(&old, false, &mut |_| {}).unwrap(),
    };
    fs::write(&old, b"changed").unwrap();
    assert!(cleanup(&mut item, &mut |_| {}).is_err());
    assert!(item.cleanup == Cleanup::Retained);
    assert_eq!(fs::read(old).unwrap(), b"changed");
}

#[test]
fn rejected_confirmation_preserves_source_and_destination() {
    let home = tempfile::tempdir().unwrap();
    let old = home.path().join(".cache/codesesh");
    fs::create_dir_all(&old).unwrap();
    fs::write(old.join("codesesh.db"), b"old").unwrap();
    assert!(run(options(home.path()), |_| anyhow::bail!("cancel"), |_| {}).is_err());
    assert_eq!(fs::read(old.join("codesesh.db")).unwrap(), b"old");
    assert!(!home.path().join(".codesesh/codesesh.db").exists());
}

#[test]
fn corrupted_record_is_not_treated_as_first_start() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".codesesh")).unwrap();
    fs::write(home.path().join(".codesesh/migration-v1.json"), "{").unwrap();
    assert!(
        run(options(home.path()), |_| panic!(), |_| {})
            .unwrap_err()
            .to_string()
            .contains("Invalid migration record")
    );
}

#[test]
fn real_cache_and_state_schemas_survive_backup() {
    let home = tempfile::tempdir().unwrap();
    let old_cache = home.path().join(".cache/codesesh/codesesh.db");
    let mut configuration = options(home.path());
    configuration.state = true;
    configuration.environment.insert(
        "APPDATA".into(),
        home.path().join("configured-roaming").into_os_string(),
    );
    configuration.environment.insert(
        "XDG_DATA_HOME".into(),
        home.path().join("configured-data").into_os_string(),
    );
    let old_state = crate::app_paths::legacy_state(home.path(), std::env::consts::OS, |key| {
        configuration.environment.get(key).cloned()
    })
    .join("state.db");
    drop(crate::storage::Cache::open(Some(&old_cache)).unwrap());
    let state = crate::state::StateStore::open(&old_state).unwrap();
    state
        .upsert_bookmark(&crate::contract::SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
            agent_name: "codex".into(),
            session_id: "kept".into(),
        })
        .unwrap();
    drop(state);
    run(configuration, |_| Ok(()), |_| {}).unwrap();
    let target = crate::state::StateStore::open(&home.path().join(".codesesh/state.db")).unwrap();
    assert_eq!(target.list_bookmarks().unwrap().len(), 1);
    assert!(!old_state.exists());
    assert!(!old_cache.exists());
}

#[test]
fn cleanup_resumes_after_partial_deletion() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("old.db");
    let wal = home.path().join("old.db-wal");
    fs::write(&source, b"database").unwrap();
    fs::write(&wal, b"wal").unwrap();
    let mut item = Item {
        source: source.clone(),
        cleanup: Cleanup::Pending,
        fingerprints: files::fingerprints(&source, true, &mut |_| {}).unwrap(),
    };
    fs::remove_file(wal).unwrap();
    cleanup(&mut item, &mut |_| {}).unwrap();
    assert!(!source.exists());
}

#[test]
fn default_paths_and_legacy_paths_are_separate() {
    let home = Path::new("/user");
    assert_eq!(crate::app_paths::root(home), home.join(".codesesh"));
    assert_eq!(
        crate::app_paths::legacy_state(home, "macos", |_| None),
        home.join("Library/Application Support/codesesh")
    );
    assert_eq!(
        crate::app_paths::legacy_state(home, "linux", |_| None),
        home.join(".local/share/codesesh")
    );
    assert_eq!(
        crate::app_paths::legacy_state(home, "windows", |key| (key == "APPDATA")
            .then(|| "/roaming".into())),
        Path::new("/roaming/codesesh")
    );
}

#[test]
fn unknown_files_are_reported_and_never_deleted() {
    let home = tempfile::tempdir().unwrap();
    let logs = home.path().join(".cache/codesesh/logs");
    fs::create_dir_all(&logs).unwrap();
    fs::write(logs.join("codesesh.log"), b"log").unwrap();
    fs::write(logs.join("personal.txt"), b"keep").unwrap();
    let warnings = run(options(home.path()), |_| Ok(()), |_| {}).unwrap();
    assert_eq!(
        fs::read(home.path().join(".codesesh/logs/codesesh.log")).unwrap(),
        b"log"
    );
    assert!(!logs.join("codesesh.log").exists());
    assert_eq!(fs::read(logs.join("personal.txt")).unwrap(), b"keep");
    assert!(warnings.iter().any(|w| w.contains("personal.txt")));
}

#[cfg(unix)]
#[test]
fn failed_deletion_is_reported_and_retried_without_confirmation() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    let directory = home.path().join(".cache/codesesh");
    fs::create_dir_all(&directory).unwrap();
    let source = directory.join("models-dev-pricing.json");
    fs::write(&source, r#"{"timestamp":1,"data":{}}"#).unwrap();
    let warnings = run(
        options(home.path()),
        |_| Ok(()),
        |progress| {
            if progress.phase == "Cleaning files" {
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o500)).unwrap();
            }
        },
    )
    .unwrap();
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w.contains(source.to_str().unwrap()))
    );
    assert!(source.exists());
    let warnings = run(
        options(home.path()),
        |_| panic!("migration already completed"),
        |_| {},
    )
    .unwrap();
    assert!(warnings.is_empty(), "{warnings:?}");
    assert!(!directory.exists());
}

#[test]
fn target_created_during_copy_is_never_overwritten() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("source.log");
    let target = home.path().join("target.log");
    fs::write(&source, b"source").unwrap();
    let candidate = Candidate {
        source: source.clone(),
        target: target.clone(),
        database: false,
    };
    let result = migrate(&candidate, &mut |p| {
        if p.phase == "Migrating" {
            fs::write(&target, b"existing").unwrap();
        }
    });
    assert!(result.is_err());
    assert_eq!(fs::read(target).unwrap(), b"existing");
    assert_eq!(fs::read(source).unwrap(), b"source");
}

#[test]
fn corrupt_cache_can_be_rebuilt_but_corrupt_user_state_stops_startup() {
    let home = tempfile::tempdir().unwrap();
    let cache = home.path().join(".cache/codesesh/codesesh.db");
    fs::create_dir_all(cache.parent().unwrap()).unwrap();
    fs::write(&cache, b"corrupt").unwrap();
    let warnings = run(options(home.path()), |_| Ok(()), |_| {}).unwrap();
    assert!(warnings.iter().any(|w| w.contains("Migration failed")));
    assert!(cache.exists());
    let state = crate::app_paths::legacy_state(home.path(), std::env::consts::OS, |_| None)
        .join("state.db");
    fs::create_dir_all(state.parent().unwrap()).unwrap();
    fs::write(&state, b"corrupt").unwrap();
    let mut configuration = options(home.path());
    configuration.state = true;
    assert!(run(configuration, |_| Ok(()), |_| {}).is_err());
    assert_eq!(fs::read(state).unwrap(), b"corrupt");
    assert!(!home.path().join(".codesesh/state.db").exists());
}

#[test]
fn interrupted_copy_is_discarded_before_retry() {
    let home = tempfile::tempdir().unwrap();
    let source = home.path().join("source.log");
    let target = home.path().join("target.log");
    fs::write(&source, b"complete").unwrap();
    fs::write(home.path().join(".migration-target.log.tmp"), b"partial").unwrap();
    fs::write(
        home.path().join(".migration-target.log.tmp-wal"),
        b"partial",
    )
    .unwrap();
    migrate(
        &Candidate {
            source,
            target: target.clone(),
            database: false,
        },
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(fs::read(target).unwrap(), b"complete");
    assert!(!home.path().join(".migration-target.log.tmp").exists());
    assert!(!home.path().join(".migration-target.log.tmp-wal").exists());
}
