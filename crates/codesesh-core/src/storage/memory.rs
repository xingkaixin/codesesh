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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_failure_keeps_connection_and_retry_refreshes_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("cache.db");
        let mut cache = Cache::open(Some(&path)).unwrap();
        let mut session = super::super::tests::source(root.path(), "memory");
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        let before = cache.snapshot().unwrap();
        cache.connection.execute_batch("CREATE TEMP TABLE connection_marker(value); INSERT INTO connection_marker VALUES('live'); PRAGMA user_version=0").unwrap();
        assert!(cache.release_index_memory().is_err());
        assert_eq!(
            cache
                .connection
                .query_row("SELECT value FROM connection_marker", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "live"
        );
        cache
            .connection
            .pragma_update(None, "user_version", CACHE_SCHEMA_VERSION)
            .unwrap();
        let other = Connection::open(&path).unwrap();
        other
            .execute("UPDATE sessions SET title='External title'", [])
            .unwrap();
        assert!(cache.release_index_memory().unwrap());
        assert!(!cache.release_index_memory().unwrap());
        assert_eq!(
            cache.refresh_snapshot(&before, &[]).unwrap()[0].title,
            "External title"
        );
        assert_eq!(
            cache
                .connection
                .pragma_query_value(None, "foreign_keys", |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            cache
                .connection
                .pragma_query_value(None, "cache_size", |row| row.get::<_, i64>(0))
                .unwrap(),
            -16384
        );
    }

    #[test]
    fn only_large_index_writes_release_the_connection() {
        let root = tempfile::tempdir().unwrap();
        let mut cache = Cache::open(Some(&root.path().join("cache.db"))).unwrap();
        assert!(cache.release_index_memory().unwrap());
        let mut session = super::super::tests::source(root.path(), "large");
        let reference = session.head.reference.clone();
        for remove in [false, true] {
            session.detail.messages[0].parts = vec![crate::contract::MessagePart::Text {
                text: "x ".repeat(LARGE_INDEX_DOCUMENT_BYTES as usize / 2 + 1),
                time_created: None,
            }];
            cache.publish(std::slice::from_mut(&mut session)).unwrap();
            assert!(cache.release_index_memory().unwrap());
            assert!(!cache.release_index_memory().unwrap());
            // Contentless deletes record tombstones without re-tokenizing the old text.
            if remove {
                cache
                    .apply(&mut [], std::slice::from_ref(&reference))
                    .unwrap();
            } else {
                session.detail.messages[0].parts.clear();
                cache.publish(std::slice::from_mut(&mut session)).unwrap();
            }
            assert!(!cache.release_index_memory().unwrap());
        }
        session.detail.messages[0].parts.clear();
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        assert!(!cache.release_index_memory().unwrap());
        assert!(cache.head(&reference).unwrap().is_some());
    }
}
