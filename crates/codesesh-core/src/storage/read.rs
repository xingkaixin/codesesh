use super::cursor;
use crate::contract::*;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, params};

fn json_column<T: serde::de::DeserializeOwned>(row: &Row<'_>, column: &str) -> rusqlite::Result<T> {
    let text: String = row.get(column)?;
    serde_json::from_str(&text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            row.as_ref().column_index(column).unwrap_or(0),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

pub fn detail(connection: &Connection, head: SessionHead) -> Result<Option<SessionDetail>> {
    detail_with_cursor(connection, head, None)
}

pub fn detail_with_cursor(
    connection: &Connection,
    head: SessionHead,
    encoded: Option<&str>,
) -> Result<Option<SessionDetail>> {
    let mut messages = Vec::new();
    let detail = visit_detail_messages(connection, head, encoded, |message| {
        messages.push(message);
        Ok(())
    })?;
    Ok(detail.map(|mut detail| {
        detail.messages = messages;
        detail
    }))
}

pub fn visit_detail_messages(
    connection: &Connection,
    head: SessionHead,
    encoded: Option<&str>,
    mut emit: impl FnMut(Message) -> Result<()>,
) -> Result<Option<SessionDetail>> {
    let reference = &head.reference;
    let count = connection
        .query_row(
            "SELECT indexed_message_count FROM session_documents WHERE agent_name=? AND session_id=?",
            params![reference.agent_name, reference.session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(count) = count else { return Ok(None) };
    let stored_tail = if count == 0 {
        Some(cursor::initial(reference))
    } else {
        connection.query_row("SELECT content_chain_digest FROM messages WHERE agent_name=? AND session_id=? AND message_index=?",params![reference.agent_name,reference.session_id,count-1],|row|row.get::<_,Option<String>>(0)).optional()?.flatten()
    };
    let parsed = encoded.and_then(parse_cursor);
    let mut start = 0;
    let mut append = false;
    let mut prefix = cursor::initial(reference);
    if let Some((previous_count, expected)) = parsed
        && stored_tail.is_some()
        && previous_count <= count as usize
    {
        let actual = if previous_count == 0 {
            Some(prefix.clone())
        } else {
            connection.query_row("SELECT content_chain_digest FROM messages WHERE agent_name=? AND session_id=? AND message_index=?",params![reference.agent_name,reference.session_id,previous_count as i64-1],|row|row.get::<_,Option<String>>(0)).optional()?.flatten()
        };
        if actual.as_deref() == Some(expected.as_str()) {
            start = previous_count;
            prefix = expected;
            append = true;
        }
    }

    let mut statement = connection.prepare(
        "SELECT * FROM messages WHERE agent_name=? AND session_id=? AND message_index>=? ORDER BY message_index",
    )?;
    let rows = statement.query_map(
        params![reference.agent_name, reference.session_id, start as i64],
        |row| {
            let role: String = row.get("role")?;
            let tokens: Option<String> = row.get("tokens_json")?;
            let cost_source: Option<String> = row.get("cost_source")?;
            let message = Message {
                id: row.get("message_id")?,
                role: match role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    "tool" => Role::Tool,
                    _ => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            row.as_ref().column_index("role")?,
                            "role".into(),
                            rusqlite::types::Type::Text,
                        ));
                    }
                },
                agent: row.get("agent")?,
                time_created: row.get("time_created")?,
                time_completed: row.get("time_completed")?,
                mode: row.get("mode")?,
                model: row.get("model")?,
                provider: row.get("provider")?,
                tokens: tokens
                    .as_ref()
                    .map(|_| json_column(row, "tokens_json"))
                    .transpose()?,
                cost: row.get("cost")?,
                cost_source: match cost_source.as_deref() {
                    Some("recorded") => Some(CostSource::Recorded),
                    Some("estimated") => Some(CostSource::Estimated),
                    _ => None,
                },
                parts: if row.get::<_, i64>("parts_format_version")? >= 1 {
                    json_column(row, "parts_json")?
                } else {
                    super::legacy_parts::normalize(&row.get::<_, String>("parts_json")?)
                },
                subagent_id: row.get("subagent_id")?,
                nickname: row.get("nickname")?,
                automated: row.get::<_, bool>("automated")?.then_some(true),
            };
            Ok((
                message,
                row.get::<_, Option<String>>("content_chain_digest")?,
                row.get::<_, String>("parts_json")?,
                row.get::<_, i64>("parts_format_version")?,
                tokens,
            ))
        },
    )?;
    let mut emitted = 0;
    let mut digest = prefix;
    for row in rows {
        let (message, next, raw_parts, format, raw_tokens) = row?;
        digest = match next {
            Some(next) => next,
            None => cursor::advance(&digest, &message, &raw_parts, raw_tokens.as_deref(), format)?,
        };
        emit(message)?;
        emitted += 1;
    }
    anyhow::ensure!(
        emitted + start as i64 == count,
        "materialized message count is inconsistent"
    );
    let mut query = connection.prepare("SELECT project_identity_key,path,kind,count,latest_time FROM session_file_activity WHERE agent_name=? AND session_id=? ORDER BY latest_time DESC,path")?;
    let file_activity = query
        .query_map(params![reference.agent_name, reference.session_id], |row| {
            Ok(SessionFileActivity {
                reference: reference.clone(),
                project_identity_key: row.get(0)?,
                path: row.get(1)?,
                kind: row.get(2)?,
                count: row.get::<_, i64>(3)? as usize,
                latest_time: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let pending = connection
        .query_row(
            "SELECT 1 FROM pending_reindex WHERE agent_name=? AND session_id=?",
            params![reference.agent_name, reference.session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(Some(SessionDetail {
        message_cursor: Some(cursor::encode(count as usize, &digest)?),
        message_update: Some(if append { "append" } else { "reset" }.into()),
        head: SessionHead {
            version: None,
            summary_files: None,
            ..head
        },
        messages: Vec::new(),
        detail_freshness: if pending { "stale" } else { "fresh" }.into(),
        file_activity,
    }))
}

fn parse_cursor(encoded: &str) -> Option<(usize, String)> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    if encoded.is_empty() || encoded.len() > 512 {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('=')).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    if value["version"].as_u64() != Some(2) {
        return None;
    }
    let count = value["count"].as_f64()?;
    if count < 0.0 || count.fract() != 0.0 || count > 9_007_199_254_740_991.0 {
        return None;
    }
    let digest = value["digest"].as_str()?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return None;
    }
    Some((count as usize, digest.to_owned()))
}
