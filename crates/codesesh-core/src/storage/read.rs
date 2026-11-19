use super::cursor;
use crate::model::*;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

#[cfg(test)]
mod tests;

pub fn cursor_message_count(encoded: &str) -> Option<usize> {
    parse_cursor(encoded).map(|(count, _)| count)
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
    emit: impl FnMut(Message) -> Result<()>,
) -> Result<Option<SessionDetail>> {
    Ok(visit_detail_message_page(connection, head, encoded, None, emit)?.map(|(detail, _)| detail))
}

pub fn visit_detail_message_page(
    connection: &Connection,
    head: SessionHead,
    encoded: Option<&str>,
    limit: Option<usize>,
    mut emit: impl FnMut(Message) -> Result<()>,
) -> Result<Option<(SessionDetail, usize)>> {
    const PAGE_PARTS_BYTES: usize = 512 * 1024;
    anyhow::ensure!(limit != Some(0), "message limit must be positive");
    let reference = &head.reference;
    let count = connection
        .query_row(
            "SELECT indexed_message_count FROM session_documents WHERE source_node_id=? AND agent_name=? AND session_id=?",
            params![reference.source_node_id,reference.agent_name,reference.session_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let Some(count) = count else { return Ok(None) };
    let stored_tail = if count == 0 {
        Some(cursor::initial(reference))
    } else {
        connection.query_row("SELECT content_chain_digest FROM messages WHERE source_node_id=? AND agent_name=? AND session_id=? AND message_index=?",params![reference.source_node_id,reference.agent_name,reference.session_id,count-1],|row|row.get::<_,Option<String>>(0)).optional()?.flatten()
    };
    let cost_revision = connection.query_row(
        "SELECT COALESCE(json_extract(meta_json,'$.rustPricingRevision'),0) FROM sessions WHERE source_node_id=? AND agent_name=? AND session_id=?",
        params![reference.source_node_id,reference.agent_name,reference.session_id], |row| row.get::<_, i64>(0))? as u64;
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
            connection.query_row("SELECT content_chain_digest FROM messages WHERE source_node_id=? AND agent_name=? AND session_id=? AND message_index=?",params![reference.source_node_id,reference.agent_name,reference.session_id,previous_count as i64-1],|row|row.get::<_,Option<String>>(0)).optional()?.flatten()
        };
        if actual
            .as_ref()
            .is_some_and(|actual| cursor::with_cost_revision(actual, cost_revision) == expected)
        {
            start = previous_count;
            prefix = actual.unwrap();
            append = true;
        }
    }

    // Legacy rows lack a verifiable continuation prefix until background reindexing.
    let limit = limit.filter(|_| stored_tail.is_some());
    let end = start
        .saturating_add(limit.unwrap_or(count as usize))
        .min(count as usize);
    let mut statement = connection.prepare_cached(
        "SELECT message_index,message_id,role,time_created,time_completed,agent,mode,model,provider,tokens_json,cost,cost_source,parts_json,parts_format_version,content_chain_digest,subagent_id,nickname,automated \
         FROM messages \
         WHERE source_node_id=? AND agent_name=? AND session_id=? AND message_index>=? AND message_index<? \
         ORDER BY message_index",
    )?;
    let rows = statement.query_map(
        params![
            reference.source_node_id,
            reference.agent_name,
            reference.session_id,
            start as i64,
            end as i64
        ],
        |row| {
            let message_index: i64 = row.get(0)?;
            let role: String = row.get(2)?;
            let tokens_json: Option<String> = row.get(9)?;
            let tokens = tokens_json
                .as_deref()
                .map(|text| {
                    serde_json::from_str(text).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            9,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .transpose()?;
            let cost_source: Option<String> = row.get(11)?;
            let raw_parts = super::body::unpack(row.get_ref(12)?)?.into_owned();
            let parts_format_version: i64 = row.get(13)?;
            let message = Message {
                cost_inputs: Vec::new(),
                cost_breakdown: None,
                id: row.get(1)?,
                role: match role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    "tool" => Role::Tool,
                    _ => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            2,
                            "role".into(),
                            rusqlite::types::Type::Text,
                        ));
                    }
                },
                agent: row.get(5)?,
                time_created: row.get(3)?,
                time_completed: row.get(4)?,
                mode: row.get(6)?,
                model: row.get(7)?,
                provider: row.get(8)?,
                tokens,
                cost: row.get(10)?,
                cost_source: match cost_source.as_deref() {
                    Some("recorded") => Some(CostSource::Recorded),
                    Some("estimated") => Some(CostSource::Estimated),
                    _ => None,
                },
                parts: super::body::decode_parts(&raw_parts, parts_format_version)?,
                subagent_id: row.get(15)?,
                nickname: row.get(16)?,
                automated: row.get::<_, bool>(17)?.then_some(true),
            };
            Ok((
                message,
                row.get::<_, Option<String>>(14)?,
                raw_parts,
                parts_format_version,
                tokens_json,
                message_index,
            ))
        },
    )?;
    let mut emitted = 0;
    let mut digest = prefix;
    let mut parts_bytes = 0;
    for row in rows {
        let (message, next, raw_parts, format, raw_tokens, index) = row?;
        anyhow::ensure!(
            index == (start + emitted) as i64,
            "materialized message index is inconsistent"
        );
        parts_bytes += raw_parts.len();
        digest = match next {
            Some(next) => next,
            None => cursor::advance(&digest, &message, &raw_parts, raw_tokens.as_deref(), format)?,
        };
        emit(message)?;
        emitted += 1;
        if limit.is_some() && parts_bytes >= PAGE_PARTS_BYTES {
            break;
        }
    }
    anyhow::ensure!(
        emitted + start == end || (limit.is_some() && parts_bytes >= PAGE_PARTS_BYTES),
        "materialized message count is inconsistent"
    );
    let mut query = connection.prepare("SELECT project_identity_key,path,kind,count,latest_time FROM session_file_activity WHERE source_node_id=? AND agent_name=? AND session_id=? ORDER BY latest_time DESC,path")?;
    let file_activity = query
        .query_map(
            params![
                reference.source_node_id,
                reference.agent_name,
                reference.session_id
            ],
            |row| {
                Ok(SessionFileActivity {
                    reference: reference.clone(),
                    project_identity_key: row.get(0)?,
                    path: row.get(1)?,
                    kind: row.get(2)?,
                    count: row.get::<_, i64>(3)? as usize,
                    latest_time: row.get(4)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let pending = connection
        .query_row(
            "SELECT 1 FROM pending_reindex WHERE source_node_id=? AND agent_name=? AND session_id=?",
            params![reference.source_node_id,reference.agent_name,reference.session_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(Some((
        SessionDetail {
            message_cursor: Some(cursor::encode(
                start + emitted,
                &cursor::with_cost_revision(&digest, cost_revision),
            )?),
            message_update: Some(if append {
                crate::model::MessageUpdate::Append
            } else {
                crate::model::MessageUpdate::Reset
            }),
            head: SessionHead {
                version: None,
                summary_files: None,
                recorded_git_remotes: Vec::new(),
                ..head
            },
            messages: Vec::new(),
            detail_freshness: if pending {
                crate::model::DetailFreshness::Stale
            } else {
                crate::model::DetailFreshness::Fresh
            },
            file_activity,
        },
        count as usize,
    )))
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
