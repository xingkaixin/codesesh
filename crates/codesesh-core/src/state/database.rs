use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const BOOKMARKS: &str = "CREATE TABLE IF NOT EXISTS bookmarks(agent_name TEXT NOT NULL, session_id TEXT NOT NULL, bookmarked_at INTEGER NOT NULL, PRIMARY KEY(agent_name, session_id));";
const ALIASES: &str = "CREATE TABLE IF NOT EXISTS session_aliases(agent_name TEXT NOT NULL, session_id TEXT NOT NULL, alias TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agent_name, session_id));";

pub fn state_directory(
    home: &Path,
    platform: &str,
    env: impl Fn(&str) -> Option<String>,
) -> PathBuf {
    if let Some(value) = env("CODESESH_STATE_DIR").filter(|v| !v.is_empty()) {
        return value.into();
    }
    match platform {
        "darwin" | "macos" => home.join("Library/Application Support/codesesh"),
        "win32" | "windows" => env("APPDATA")
            .or_else(|| env("LOCALAPPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("codesesh"),
        _ => env("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("codesesh"),
    }
}

pub(super) fn open(path: Option<&Path>) -> Result<Connection> {
    if let Some(parent) = path.and_then(Path::parent) {
        std::fs::create_dir_all(parent)?;
        private(parent, 0o700);
    }
    let mut db = match path {
        Some(path) => Connection::open(path),
        None => Connection::open_in_memory(),
    }
    .context("SQLite state database is unavailable")?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE;")?;
    if let Some(path) = path {
        private(path, 0o600);
        for suffix in ["-wal", "-shm", "-journal"] {
            private(Path::new(&format!("{}{suffix}", path.display())), 0o600);
        }
        if let Some(parent) = path.parent() {
            let prefix = format!(
                "{}.",
                path.file_name().unwrap_or_default().to_string_lossy()
            );
            for entry in std::fs::read_dir(parent)?.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with(&prefix) && name.ends_with(".bak") {
                    private(&entry.path(), 0o600);
                }
            }
        }
    }
    ensure_schema(&mut db, path)?;
    Ok(db)
}

fn exists(db: &Connection, name: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn ensure_schema(db: &mut Connection, path: Option<&Path>) -> Result<()> {
    let mut version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let meta = exists(db, "state_meta")?;
    let bookmarks = exists(db, "bookmarks")?;
    if version == 0 && meta {
        let columns = db
            .prepare("PRAGMA table_info(state_meta)")?
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if columns.iter().any(|v| v == "key") && columns.iter().any(|v| v == "value") {
            version = db
                .query_row(
                    "SELECT value FROM state_meta WHERE key='version'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
        }
    }
    if version == 0 && bookmarks {
        version = 1;
    }
    if version >= 3 {
        return Ok(());
    }
    if version < 0 {
        bail!("state-migration current version must be a non-negative safe integer");
    }
    if version == 0 && !meta && !bookmarks {
        return set_schema(db);
    }
    for next in version + 1..=3 {
        if next == 3 {
            backup_populated(db, path)?;
        }
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        match next {
            1 => tx.execute_batch(BOOKMARKS)?,
            2 => tx.execute_batch(ALIASES)?,
            3 => {
                tx.execute_batch("ALTER TABLE bookmarks RENAME TO bookmarks_with_snapshots;")?;
                tx.execute_batch(BOOKMARKS)?;
                tx.execute_batch("INSERT INTO bookmarks(agent_name,session_id,bookmarked_at) SELECT agent_name,session_id,bookmarked_at FROM bookmarks_with_snapshots; DROP TABLE bookmarks_with_snapshots;")?;
            }
            _ => unreachable!(),
        }
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
    }
    set_schema(db)
}

fn set_schema(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS state_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    )?;
    db.execute_batch(BOOKMARKS)?;
    db.execute_batch(ALIASES)?;
    db.execute("INSERT INTO state_meta(key,value) VALUES ('version','3') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [])?;
    db.pragma_update(None, "user_version", 3)?;
    Ok(())
}

fn backup_populated(db: &Connection, path: Option<&Path>) -> Result<()> {
    let Some(path) = path else {
        return Ok(());
    };
    let mut populated = false;
    for table in ["bookmarks", "session_aliases"] {
        if exists(db, table)?
            && db
                .query_row(&format!("SELECT 1 FROM {table} LIMIT 1"), [], |_| Ok(()))
                .optional()?
                .is_some()
        {
            populated = true;
        }
    }
    if !populated {
        return Ok(());
    }
    let stamp = chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(':', "")
        .replace('.', "-");
    let base = format!("{}.{stamp}.state-migration", path.display());
    let mut backup = PathBuf::from(format!("{base}.bak"));
    let mut counter = 1;
    while backup.exists() {
        backup = PathBuf::from(format!("{base}.{counter}.bak"));
        counter += 1;
    }
    db.execute("VACUUM INTO ?", [backup.to_string_lossy().as_ref()])?;
    private(&backup, 0o600);
    Ok(())
}

fn private(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        }
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}
