use super::StorageProgress;
use anyhow::Result;
use rusqlite::{
    Connection, OptionalExtension, params,
    types::{Type, Value, ValueRef},
};
use std::{borrow::Cow, cell::RefCell};

const LEVEL: i32 = 3;
const KEY: &str = "message_parts_zstd_v1";
const CURSOR_KEY: &str = "message_parts_zstd_v1_cursor";
const BATCH: i64 = 500;

thread_local! {
    // One context per thread; creating a zstd context per message showed up in search.
    static COMPRESSOR: RefCell<Option<zstd::bulk::Compressor<'static>>> = const { RefCell::new(None) };
    static DECOMPRESSOR: RefCell<Option<zstd::bulk::Decompressor<'static>>> = const { RefCell::new(None) };
}

/// Message parts are zstd blobs when that is smaller; short ones stay text.
pub(crate) fn pack(text: &str) -> Result<Value> {
    let compressed = COMPRESSOR.with_borrow_mut(|compressor| -> std::io::Result<Vec<u8>> {
        let compressor = match compressor {
            Some(compressor) => compressor,
            None => compressor.insert(zstd::bulk::Compressor::new(LEVEL)?),
        };
        compressor.compress(text.as_bytes())
    })?;
    Ok(if compressed.len() < text.len() {
        Value::Blob(compressed)
    } else {
        Value::Text(text.to_owned())
    })
}

fn decompress(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let Ok(Some(size)) = zstd::zstd_safe::get_frame_content_size(bytes) else {
        return zstd::stream::decode_all(bytes);
    };
    DECOMPRESSOR.with_borrow_mut(|decompressor| {
        let decompressor = match decompressor {
            Some(decompressor) => decompressor,
            None => decompressor.insert(zstd::bulk::Decompressor::new()?),
        };
        decompressor.decompress(bytes, usize::try_from(size).map_err(std::io::Error::other)?)
    })
}

pub(crate) fn unpack(value: ValueRef<'_>) -> rusqlite::Result<Cow<'_, str>> {
    match value {
        ValueRef::Text(bytes) => std::str::from_utf8(bytes)
            .map(Cow::Borrowed)
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(0, Type::Text, error.into())
            }),
        ValueRef::Blob(bytes) => decompress(bytes)
            .map_err(Into::into)
            .and_then(|bytes| String::from_utf8(bytes).map_err(Into::into))
            .map(Cow::Owned)
            .map_err(|error: Box<dyn std::error::Error + Send + Sync>| {
                rusqlite::Error::FromSqlConversionFailure(0, Type::Blob, error)
            }),
        other => Err(rusqlite::Error::InvalidColumnType(
            0,
            "message parts".into(),
            other.data_type(),
        )),
    }
}

/// Compresses parts written before schema 37 in resumable batches.
pub(super) fn compress_existing(
    db: &Connection,
    progress: &mut dyn FnMut(StorageProgress) -> Result<()>,
) -> Result<()> {
    if meta(db, KEY)?.is_some() {
        return Ok(());
    }
    let total: i64 = db.query_row("SELECT COALESCE(MAX(rowid),0) FROM messages", [], |row| {
        row.get(0)
    })?;
    let mut cursor: i64 = meta(db, CURSOR_KEY)?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    while cursor < total {
        progress(StorageProgress {
            phase: "Compressing message parts".into(),
            done: cursor as u64,
            total: Some(total as u64),
        })?;
        db.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> Result<i64> {
            let rows = db
                .prepare_cached(
                    "SELECT rowid,parts_json FROM messages WHERE rowid>? AND typeof(parts_json)='text' ORDER BY rowid LIMIT ?",
                )?
                .query_map(params![cursor, BATCH], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut last = total;
            for (rowid, parts) in rows {
                db.prepare_cached("UPDATE messages SET parts_json=? WHERE rowid=?")?
                    .execute(params![pack(&parts)?, rowid])?;
                last = rowid;
            }
            db.execute(
                "INSERT INTO cache_meta VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![CURSOR_KEY, last.to_string()],
            )?;
            Ok(last)
        })();
        match result {
            Ok(last) => {
                db.execute_batch("COMMIT")?;
                cursor = last;
            }
            Err(error) => {
                let _ = db.execute_batch("ROLLBACK");
                return Err(error);
            }
        }
    }
    db.execute("DELETE FROM cache_meta WHERE key=?", [CURSOR_KEY])?;
    db.execute("INSERT OR REPLACE INTO cache_meta VALUES(?,'1')", [KEY])?;
    Ok(())
}

fn meta(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM cache_meta WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()?)
}
