use super::{codex::ParsedSession, deepchat::common};
use crate::{contract::*, pricing::Pricing};
use anyhow::{Context, Result};
use prost::Message as _;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

mod proto;

pub fn scan(root: &Path, data_root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let mut paths = Vec::new();
    if root.try_exists()? {
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            let entry = entry?;
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|ext| ext == "db")
            {
                paths.push(entry.into_path());
            }
        }
    }
    scan_paths(data_root, pricing, &paths)
}

pub fn scan_paths(
    data_root: &Path,
    _pricing: &Pricing,
    paths: &[PathBuf],
) -> Result<Vec<ParsedSession>> {
    let summary_path = data_root.join("conversation_summaries.db");
    let summaries = if summary_path.try_exists()? {
        let db = Connection::open_with_flags(summary_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.execute_batch("BEGIN")?;
        Some(db)
    } else {
        None
    };
    let mut sessions = Vec::new();
    for path in paths.iter().collect::<std::collections::BTreeSet<_>>() {
        if path.try_exists()?
            && let Some(session) = parse(path, summaries.as_ref())?
        {
            sessions.push(session);
        }
    }
    Ok(sessions)
}

#[derive(Default)]
struct Summary {
    title: String,
    workspaces: String,
    modified: String,
    parent: String,
}

fn parse(path: &Path, summaries: Option<&Connection>) -> Result<Option<ParsedSession>> {
    let id = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let summary = summaries.map(|db| {
        db.query_row(
            "SELECT title,workspace_uris,last_modified_time,parent_conversation_id FROM conversation_summaries WHERE conversation_id=?1",
            [&id],
            |row| Ok(Summary { title: row.get(0)?, workspaces: row.get(1)?, modified: row.get(2)?, parent: row.get(3)? }),
        ).optional()
    }).transpose()?.flatten().unwrap_or_default();
    let directory = serde_json::from_str::<Vec<String>>(&summary.workspaces)
        .ok()
        .and_then(|paths| {
            paths
                .into_iter()
                .find_map(|path| url::Url::parse(&path).ok()?.to_file_path().ok())
        })
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let time = chrono::DateTime::parse_from_str(&summary.modified, "%Y-%m-%d %H:%M:%S%.f%:z")
        .ok()
        .map(|time| time.timestamp_millis() as f64)
        .unwrap_or(crate::time::file_mtime_ms(path)?);
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    let mut statement = db
        .prepare("SELECT idx,step_type,status,step_payload FROM steps ORDER BY idx")
        .with_context(|| format!("unsupported Antigravity CLI database {}", path.display()))?;
    let mut rows = statement.query([])?;
    let mut messages = Vec::new();
    let mut title = summary.title;
    let mut unsupported = 0;
    while let Some(row) = rows.next()? {
        let index: i64 = row.get(0)?;
        let kind: i64 = row.get(1)?;
        let status: i64 = row.get(2)?;
        let payload: Option<Vec<u8>> = row.get(3)?;
        let Some(payload) = payload else {
            unsupported += 1;
            continue;
        };
        let step = proto::Step::decode(payload.as_slice()).with_context(|| {
            format!("invalid Antigravity CLI step {index} in {}", path.display())
        })?;
        let part = match kind {
            14 => step
                .user
                .and_then(|user| {
                    user.text
                        .or_else(|| user.content.and_then(|value| value.text))
                })
                .filter(|text| !text.is_empty())
                .map(|text| (Role::User, common::text(text, None))),
            15 => step
                .assistant
                .and_then(|value| value.text)
                .filter(|text| !text.is_empty())
                .map(|text| (Role::Assistant, common::text(text, None))),
            23 => {
                if let Some(value) = step
                    .title
                    .and_then(|title| title.text)
                    .filter(|text| !text.is_empty())
                {
                    title = value;
                }
                continue;
            }
            _ => None,
        };
        let part = part.or_else(|| {
            let call = step.tool?.call?;
            let name = call
                .name
                .filter(|name| !name.is_empty())
                .or(call.secondary_name)?;
            let input = call
                .input
                .map(|input| serde_json::from_str(&input).unwrap_or(Value::String(input)));
            Some((
                Role::Assistant,
                MessagePart::Tool {
                    tool: name,
                    call_id: call.id,
                    title: None,
                    time_created: None,
                    state: Box::new(ToolState {
                        status: "unknown".into(),
                        input,
                        output: None,
                        error: None,
                        metadata: Some(
                            json!({"antigravity_step_type":kind,"antigravity_status":status}),
                        ),
                    }),
                },
            ))
        });
        if let Some((role, part)) = part {
            let mut message = common::message(format!("{id}:{index}"), role, time, vec![part]);
            if message.role == Role::Assistant {
                message.agent = Some("antigravity-cli".into());
            }
            messages.push(message);
        } else {
            unsupported += 1;
        }
    }
    if messages.is_empty() && unsupported == 0 {
        return Ok(None);
    }
    let prompt = messages
        .iter()
        .find(|message| message.role == Role::User)
        .and_then(|message| message.parts.first())
        .and_then(|part| match part {
            MessagePart::Text { text, .. } => Some(text.as_str()),
            _ => None,
        });
    let title = common::title(&[Some(&title), prompt]);
    let stats = SessionStats {
        message_count: messages.len(),
        ..Default::default()
    };
    let mut session = common::finish(
        path,
        "antigravity-cli",
        id.clone(),
        title,
        directory,
        time,
        time,
        (!summary.parent.is_empty() && summary.parent != id).then_some(summary.parent),
        stats,
        None,
        messages,
    );
    let notice = format!(
        "Partial Antigravity CLI import: {unsupported} unsupported steps. Tool outcomes, model and token usage are not decoded. Message times use the session update time."
    );
    session.head.summary_files = Some(Value::String(notice));
    session.detail.head = session.head.clone();
    Ok(Some(session))
}

#[cfg(test)]
mod tests;
