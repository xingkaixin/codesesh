use super::StorageProgress;
use crate::contract::{Message, MessagePart, SessionReference};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

const REVISION_KEY: &str = "search_text_v2";
const CURSOR_KEY: &str = "search_text_v2_cursor";
const TOOL_TEXT_EDGE_BYTES: usize = 64 * 1024;
const BLOB_MIN_BYTES: usize = 256;
const INDEX_KEY: &str = "message_fts_v1";
const INDEX_CURSOR_KEY: &str = "message_fts_v1_cursor";
const BATCH: usize = 500;
const INDEX_SCHEMA: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(content_text, content='', contentless_delete=1);
    CREATE VIRTUAL TABLE IF NOT EXISTS session_title_fts USING fts5(title, content='sessions', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS session_title_ai AFTER INSERT ON sessions BEGIN
      INSERT INTO session_title_fts(rowid, title) VALUES (new.rowid, new.title);
    END;
    CREATE TRIGGER IF NOT EXISTS session_title_ad AFTER DELETE ON sessions BEGIN
      INSERT INTO session_title_fts(session_title_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
    END;
    CREATE TRIGGER IF NOT EXISTS session_title_au AFTER UPDATE OF title ON sessions BEGIN
      INSERT INTO session_title_fts(session_title_fts, rowid, title) VALUES ('delete', old.rowid, old.title);
      INSERT INTO session_title_fts(rowid, title) VALUES (new.rowid, new.title);
    END;";

pub(super) fn message_text(message: &Message) -> String {
    text(
        super::role_name(&message.role),
        message.agent.as_deref(),
        message.model.as_deref(),
        &message.parts,
    )
}

fn text(role: &str, agent: Option<&str>, model: Option<&str>, parts: &[MessagePart]) -> String {
    let mut fields = vec![role.to_owned()];
    for value in [agent, model].into_iter().flatten() {
        push(value, &mut fields);
    }
    for part in parts {
        match part {
            MessagePart::Text { text, .. } => {
                fields.push("text".into());
                push(text, &mut fields);
            }
            MessagePart::Reasoning { text, .. } => {
                fields.push("reasoning".into());
                push(text, &mut fields);
            }
            MessagePart::Plan { text, .. } => {
                fields.push("plan".into());
                push(text, &mut fields);
            }
            MessagePart::Image { .. } => fields.push("image".into()),
            MessagePart::Tool {
                tool, state, title, ..
            } => {
                fields.push("tool".into());
                if let Some(title) = title {
                    push(title, &mut fields);
                }
                push(tool, &mut fields);
                let mut state_fields = Vec::new();
                push(&state.status, &mut state_fields);
                for value in [&state.input, &state.output, &state.error, &state.metadata]
                    .into_iter()
                    .flatten()
                {
                    append(value, &mut state_fields);
                }
                if !state_fields.is_empty() {
                    fields.push(edges(state_fields.join("\n")));
                }
            }
        }
    }
    fields.join("\n")
}

fn append(value: &Value, fields: &mut Vec<String>) {
    match value {
        Value::Null => (),
        Value::String(value) => push(value, fields),
        Value::Array(values) => values.iter().for_each(|value| append(value, fields)),
        Value::Object(values) => values.values().for_each(|value| append(value, fields)),
        value => fields.push(value.to_string()),
    }
}

fn push(value: &str, fields: &mut Vec<String>) {
    let value = value.trim();
    if !value.is_empty() && !is_blob(value) {
        fields.push(value.to_owned());
    }
}

// Inline images and attachments arrive as base64; their tokens are unique noise for FTS.
fn is_blob(value: &str) -> bool {
    let payload = value
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .map_or(value, |(_, payload)| payload);
    payload.len() >= BLOB_MIN_BYTES
        && payload.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

fn edges(text: String) -> String {
    if text.len() <= TOOL_TEXT_EDGE_BYTES * 2 {
        return text;
    }
    let mut head = TOOL_TEXT_EDGE_BYTES;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - TOOL_TEXT_EDGE_BYTES;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n{}", &text[..head], &text[tail..])
}

pub(super) fn rebuild(
    db: &Connection,
    progress: &mut dyn FnMut(StorageProgress) -> Result<()>,
) -> Result<()> {
    if meta(db, REVISION_KEY)?.is_some() {
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
            phase: "Rebuilding message search text".into(),
            done: cursor as u64,
            total: Some(total as u64),
        })?;
        cursor = batch(db, |db| {
            let mut query = db.prepare_cached(
                "SELECT rowid,role,agent,model,parts_json,content_text FROM messages WHERE rowid>? AND parts_format_version>=1 ORDER BY rowid LIMIT ?",
            )?;
            let rows = query
                .query_map(params![cursor, BATCH as i64], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        super::body::unpack(row.get_ref(4)?)?.into_owned(),
                        row.get::<_, String>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut last = total;
            for (rowid, role, agent, model, raw, stored) in rows {
                let parts: Vec<MessagePart> = serde_json::from_str(&raw)?;
                let next = text(&role, agent.as_deref(), model.as_deref(), &parts);
                if next != stored {
                    db.prepare_cached("UPDATE messages SET content_text=? WHERE rowid=?")?
                        .execute(params![next, rowid])?;
                    db.execute("DELETE FROM cache_meta WHERE key=?", [INDEX_KEY])?;
                }
                last = rowid;
            }
            set_meta(db, CURSOR_KEY, &last.to_string())?;
            Ok(last)
        })?;
    }
    db.execute("DELETE FROM cache_meta WHERE key=?", [CURSOR_KEY])?;
    set_meta(db, REVISION_KEY, "1")
}

pub(super) fn ensure_index(
    db: &Connection,
    progress: &mut dyn FnMut(StorageProgress) -> Result<()>,
) -> Result<()> {
    let legacy = db
        .prepare("SELECT 1 FROM pragma_table_info('session_documents') WHERE name='content_text'")?
        .exists([])?;
    let missing = !db
        .prepare("SELECT 1 FROM sqlite_master WHERE name IN ('message_fts','session_title_fts')")?
        .query_map([], |_| Ok(()))?
        .count()
        == 2;
    if legacy || missing {
        progress(StorageProgress {
            phase: "Preparing message search index".into(),
            done: 0,
            total: None,
        })?;
        batch(db, |db| {
            db.execute_batch(
                "DROP TRIGGER IF EXISTS session_documents_ai;
                 DROP TRIGGER IF EXISTS session_documents_ad;
                 DROP TRIGGER IF EXISTS session_documents_au;
                 DROP TABLE IF EXISTS session_documents_fts;",
            )?;
            if legacy {
                db.execute_batch("ALTER TABLE session_documents DROP COLUMN content_text")?;
            }
            db.execute_batch(INDEX_SCHEMA)?;
            db.execute("DELETE FROM cache_meta WHERE key=?", [INDEX_KEY])?;
            Ok(())
        })?;
    }
    if meta(db, INDEX_KEY)?.is_some() {
        return Ok(());
    }
    let total: i64 = db.query_row("SELECT COALESCE(MAX(rowid),0) FROM messages", [], |row| {
        row.get(0)
    })?;
    let mut cursor = match meta(db, INDEX_CURSOR_KEY)?.and_then(|value| value.parse().ok()) {
        Some(cursor) => cursor,
        None => {
            db.execute(
                "INSERT INTO message_fts(message_fts) VALUES('delete-all')",
                [],
            )?;
            0
        }
    };
    while cursor < total {
        progress(StorageProgress {
            phase: "Indexing messages for search".into(),
            done: cursor as u64,
            total: Some(total as u64),
        })?;
        cursor = batch(db, |db| {
            let mut query = db.prepare_cached(
                "SELECT rowid,content_text FROM messages WHERE rowid>? ORDER BY rowid LIMIT ?",
            )?;
            let mut rows = query.query(params![cursor, BATCH as i64])?;
            let mut last = total;
            while let Some(row) = rows.next()? {
                last = row.get(0)?;
                index(db, last, row.get_ref(1)?.as_str()?)?;
            }
            set_meta(db, INDEX_CURSOR_KEY, &last.to_string())?;
            Ok(last)
        })?;
    }
    batch(db, |db| {
        db.execute(
            "INSERT INTO session_title_fts(session_title_fts) VALUES('rebuild')",
            [],
        )?;
        db.execute("DELETE FROM cache_meta WHERE key=?", [INDEX_CURSOR_KEY])?;
        set_meta(db, INDEX_KEY, "1")
    })
}

pub(super) fn reset_index(db: &Connection) -> Result<()> {
    db.execute(
        "DELETE FROM cache_meta WHERE key IN (?,?)",
        [INDEX_KEY, INDEX_CURSOR_KEY],
    )?;
    Ok(())
}

pub(super) fn index(db: &Connection, rowid: i64, text: &str) -> Result<()> {
    db.prepare_cached("INSERT INTO message_fts(rowid,content_text) VALUES(?,?)")?
        .execute(params![rowid, crate::search::index_text(text)])?;
    Ok(())
}

pub(super) fn forget(
    db: &Connection,
    reference: &SessionReference,
    indexes: std::ops::Range<i64>,
) -> Result<()> {
    db.prepare_cached(
        "DELETE FROM message_fts WHERE rowid IN (SELECT rowid FROM messages WHERE source_node_id=? AND agent_name=? AND session_id=? AND message_index>=? AND message_index<?)",
    )?
    .execute(params![
        reference.source_node_id,
        reference.agent_name,
        reference.session_id,
        indexes.start,
        indexes.end
    ])?;
    Ok(())
}

fn batch<T>(db: &Connection, work: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    match work(db) {
        Ok(value) => {
            db.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn set_meta(db: &Connection, key: &str, value: &str) -> Result<()> {
    db.execute(
        "INSERT INTO cache_meta VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn meta(db: &Connection, key: &str) -> Result<Option<String>> {
    Ok(db
        .query_row("SELECT value FROM cache_meta WHERE key=?", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::ToolState;
    use serde_json::json;

    fn tool(output: Value) -> String {
        text(
            "assistant",
            None,
            None,
            &[MessagePart::Tool {
                tool: "view_image".into(),
                call_id: None,
                state: Box::new(ToolState {
                    status: "completed".into(),
                    input: Some(json!({"path": "/tmp/shot.png"})),
                    output: Some(output),
                    error: None,
                    metadata: None,
                }),
                time_created: None,
                title: None,
            }],
        )
    }

    #[test]
    fn skips_inline_binary_and_keeps_tool_edges() {
        let image = "iVBORw0KGgo".repeat(64);
        let text = tool(json!([
            {"type": "text", "text": "rendered ok"},
            {"type": "image", "mime_type": "image/png", "data": image},
            {"type": "text", "text": format!("data:image/png;base64,{image}")},
        ]));
        assert!(text.contains("/tmp/shot.png") && text.contains("rendered ok"));
        assert!(!text.contains("iVBORw0KGgo"));

        let log = format!("start {} finish", "line of build output\n".repeat(10_000));
        let text = tool(json!(log));
        assert!(text.contains("start") && text.contains("finish"));
        assert!(text.len() < 3 * TOOL_TEXT_EDGE_BYTES);
    }

    #[test]
    fn rebuild_rewrites_stored_text_and_index() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("cache.db");
        let mut session = super::super::tests::source(root.path(), "blob");
        let mut cache = super::super::Cache::open(Some(&path)).unwrap();
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        let blob = "QUJD".repeat(100);
        cache
            .connection()
            .execute_batch(&format!(
                "UPDATE messages SET content_text=content_text||' {blob}';
                 DELETE FROM message_fts;
                 INSERT INTO message_fts(rowid,content_text) SELECT rowid,content_text FROM messages;
                 DELETE FROM cache_meta WHERE key='{REVISION_KEY}';"
            ))
            .unwrap();
        drop(cache);
        let cache = super::super::Cache::open(Some(&path)).unwrap();
        let stored: String = cache
            .connection()
            .query_row("SELECT content_text FROM messages", [], |row| row.get(0))
            .unwrap();
        assert!(stored.contains("Fixture") && !stored.contains("QUJD"));
        let search = |query: &str| {
            crate::search::search_sessions(cache.connection(), query, &Default::default())
                .unwrap()
                .len()
        };
        assert_eq!((search("Fixture"), search(&blob)), (1, 0));
    }

    #[test]
    fn legacy_session_documents_move_to_message_index() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("cache.db");
        let mut session = super::super::tests::source(root.path(), "legacy");
        let mut cache = super::super::Cache::open(Some(&path)).unwrap();
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        cache
            .connection()
            .execute_batch(&format!(
                "DROP TABLE message_fts;
                 ALTER TABLE session_documents ADD COLUMN content_text TEXT NOT NULL DEFAULT 'legacy';
                 CREATE VIRTUAL TABLE session_documents_fts USING fts5(title, content_text, content='session_documents', content_rowid='id');
                 DELETE FROM cache_meta WHERE key='{INDEX_KEY}';"
            ))
            .unwrap();
        drop(cache);
        let cache = super::super::Cache::open(Some(&path)).unwrap();
        let legacy: i64 = cache
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='session_documents_fts' OR sql LIKE '%content_text TEXT NOT NULL DEFAULT ''legacy''%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0);
        let search = |query: &str| {
            crate::search::search_sessions(cache.connection(), query, &Default::default())
                .unwrap()
                .len()
        };
        assert_eq!(
            (search("Fixture"), search("中文"), search("legacy")),
            (1, 1, 0)
        );
    }
}
