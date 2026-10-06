use super::StorageProgress;
use crate::contract::{Message, MessagePart};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

const REVISION_KEY: &str = "search_text_v2";
const CURSOR_KEY: &str = "search_text_v2_cursor";
const TOOL_TEXT_EDGE_BYTES: usize = 64 * 1024;
const BLOB_MIN_BYTES: usize = 256;
const REWRITE_BATCH: usize = 500;

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
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS search_text_pending(source_node_id TEXT NOT NULL,agent_name TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(source_node_id,agent_name,session_id)) WITHOUT ROWID",
    )?;
    let mut cursor: i64 = meta(db, CURSOR_KEY)?
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    while cursor < total {
        progress(StorageProgress {
            phase: "Rebuilding message search text".into(),
            done: cursor as u64,
            total: Some(total as u64),
        })?;
        db.execute_batch("BEGIN IMMEDIATE")?;
        let batch = (|| -> Result<i64> {
            let mut query = db.prepare_cached(
                "SELECT rowid,role,agent,model,parts_json,content_text,source_node_id,agent_name,session_id FROM messages WHERE rowid>? AND parts_format_version>=1 ORDER BY rowid LIMIT ?",
            )?;
            let rows = query
                .query_map(params![cursor, REWRITE_BATCH as i64], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        [
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                        ],
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut last = total;
            for (rowid, role, agent, model, raw, stored, session) in rows {
                let parts: Vec<MessagePart> = serde_json::from_str(&raw)?;
                let next = text(&role, agent.as_deref(), model.as_deref(), &parts);
                if next != stored {
                    db.prepare_cached("UPDATE messages SET content_text=? WHERE rowid=?")?
                        .execute(params![next, rowid])?;
                    db.prepare_cached("INSERT OR IGNORE INTO search_text_pending VALUES(?,?,?)")?
                        .execute(session)?;
                }
                last = rowid;
            }
            db.execute(
                "INSERT INTO cache_meta VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![CURSOR_KEY, last.to_string()],
            )?;
            Ok(last)
        })();
        match batch {
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
    progress(StorageProgress {
        phase: "Rebuilding session search index".into(),
        done: 0,
        total: None,
    })?;
    db.execute_batch("BEGIN IMMEDIATE")?;
    let documents = (|| -> Result<()> {
        db.execute_batch("DROP TRIGGER IF EXISTS session_documents_au")?;
        let mut query = db.prepare(
            "SELECT d.id,d.source_node_id,d.agent_name,d.session_id,d.title,d.indexed_message_count FROM session_documents d JOIN search_text_pending p USING(source_node_id,agent_name,session_id)",
        )?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(query);
        let changed = !rows.is_empty();
        let mut messages = db.prepare(
            "SELECT content_text FROM messages WHERE source_node_id=? AND agent_name=? AND session_id=? AND message_index<? ORDER BY message_index",
        )?;
        let mut update = db.prepare("UPDATE session_documents SET content_text=? WHERE id=?")?;
        for (id, node, agent, session, title, count) in rows {
            let mut document = title.trim().to_owned();
            let mut contents = messages.query(params![node, agent, session, count])?;
            while let Some(row) = contents.next()? {
                document.push('\n');
                document.push_str(row.get_ref(0)?.as_str()?);
            }
            update.execute(params![document, id])?;
        }
        if changed {
            db.execute(
                "INSERT INTO session_documents_fts(session_documents_fts) VALUES('rebuild')",
                [],
            )?;
        }
        db.execute_batch(super::schema::DOCUMENT_UPDATE_TRIGGER)?;
        db.execute_batch("DROP TABLE search_text_pending")?;
        db.execute("DELETE FROM cache_meta WHERE key=?", [CURSOR_KEY])?;
        db.execute("INSERT INTO cache_meta VALUES(?,'1')", [REVISION_KEY])?;
        Ok(())
    })();
    match documents {
        Ok(()) => db.execute_batch("COMMIT")?,
        Err(error) => {
            let _ = db.execute_batch("ROLLBACK");
            return Err(error);
        }
    }
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
                 UPDATE session_documents SET content_text=content_text||' {blob}';
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
}
