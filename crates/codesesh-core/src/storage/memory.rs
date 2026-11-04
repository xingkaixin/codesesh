use super::{CACHE_SCHEMA_VERSION, Cache};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{cell::Cell, time::Duration};

// Large documents can grow the retained FTS5 token table beyond the page cache.
const LARGE_INDEX_DOCUMENT_BYTES: i64 = 16 * 1024 * 1024;

pub(super) fn note_document_size(bytes: i64, reclaim: &Cell<bool>) {
    if bytes >= LARGE_INDEX_DOCUMENT_BYTES {
        reclaim.set(true);
    }
}

impl Cache {
    pub(crate) fn release_index_memory(&mut self) -> Result<bool> {
        if !self.reclaim_connection.get() || !self.connection.is_autocommit() {
            return Ok(false);
        }
        let Some(path) = self.connection.path().filter(|path| !path.is_empty()) else {
            self.reclaim_connection.set(false);
            return Ok(false);
        };
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        ensure!(
            version == CACHE_SCHEMA_VERSION,
            "Cache schema changed during connection replacement"
        );
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE; PRAGMA journal_mode=WAL; PRAGMA cache_size=-16384")?;
        let registry: Option<String> = self
            .connection
            .query_row(
                "SELECT file FROM pragma_database_list WHERE name='hub_control'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(registry) = registry {
            connection.execute("ATTACH DATABASE ? AS hub_control", [registry])?;
            connection.execute_batch("PRAGMA hub_control.synchronous=FULL")?;
        }
        // FTS5 retains its largest hash table until the owning connection closes.
        self.connection = connection;
        self.snapshot_data_version.set(None);
        self.reclaim_connection.set(false);
        Ok(true)
    }
}
