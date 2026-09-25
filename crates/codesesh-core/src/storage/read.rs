use super::cursor;
use crate::contract::*;
use anyhow::{Context, Result};
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
    let reference = &head.reference;
    let count = connection
        .query_row(
            "SELECT message_count FROM sessions WHERE agent_name=? AND session_id=?",
            params![reference.agent_name, reference.session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(count) = count else { return Ok(None) };
    let mut statement = connection.prepare(
        "SELECT * FROM messages WHERE agent_name=? AND session_id=? ORDER BY message_index",
    )?;
    let rows = statement.query_map(params![reference.agent_name, reference.session_id], |row| {
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
            cost: row.get::<_, Option<f64>>("cost")?.unwrap_or(0.0),
            cost_source: match cost_source.as_deref() {
                Some("recorded") => Some(CostSource::Recorded),
                Some("estimated") => Some(CostSource::Estimated),
                _ => None,
            },
            parts: json_column(row, "parts_json")?,
            subagent_id: row.get("subagent_id")?,
            nickname: row.get("nickname")?,
            automated: row.get::<_, bool>("automated")?.then_some(true),
        };
        Ok((
            message,
            row.get::<_, Option<String>>("content_chain_digest")?,
        ))
    })?;
    let mut messages = Vec::new();
    let mut digest = cursor::initial(reference);
    for row in rows {
        let (message, next) = row?;
        digest = next.context("missing materialized message digest")?;
        messages.push(message);
    }
    anyhow::ensure!(
        messages.len() as i64 == count,
        "materialized message count is inconsistent"
    );
    Ok(Some(SessionDetail {
        message_cursor: Some(cursor::encode(messages.len(), &digest)?),
        message_update: Some("reset".into()),
        head,
        messages,
        detail_freshness: "fresh".into(),
        file_activity: Vec::new(),
    }))
}
