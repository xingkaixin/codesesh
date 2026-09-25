use super::codex::ParsedSession;
use crate::{
    contract::{
        CostSource, Message, MessagePart, Role, SessionDetail, SessionHead, SessionReference,
        SessionStats,
    },
    pricing::Pricing,
    projects::path_identity,
};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{collections::HashMap, path::Path};

mod text;
use text::{clean, title};
mod messages;
use messages::{append_subagents, detail_stats, messages, model_usage};

mod pagination;
pub use pagination::{SessionKey, enumerate_session_keys, scan_selected};
mod sync;
pub use sync::{CursorDelta, CursorSync};

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    Ok(CursorSync::default().refresh(root, pricing)?.upserts)
}

fn parse_composer(
    db: &Connection,
    path: &Path,
    composer: &Value,
    bubbles: &[(String, Value)],
    directory: String,
    pricing: &Pricing,
) -> Result<Option<ParsedSession>> {
    let Some(id) = composer_id(composer) else {
        return Ok(None);
    };
    let mut messages = messages(bubbles, model(composer), pricing);
    let subagents = composer["subagentInfos"].as_array();
    if messages.is_empty() && !subagents.is_some_and(|v| v.iter().any(Value::is_object)) {
        return Ok(None);
    }
    let model_usage = model_usage(&messages);
    let scan_cost = messages.iter().map(|m| m.cost.unwrap_or(0.0)).sum::<f64>();
    let scan_stats = SessionStats {
        message_count: messages.len(),
        total_input_tokens: number(composer, "inputTokenCount").unwrap_or(0.0),
        total_output_tokens: number(composer, "outputTokenCount").unwrap_or(0.0),
        total_cost: scan_cost,
        cost_source: (scan_cost > 0.0).then_some(CostSource::Estimated),
        ..Default::default()
    };
    let scan_title = session_title(composer, &messages);
    append_subagents(db, composer, &mut messages)?;
    let (project_identity, signature) = path_identity(&directory);
    let created = number(composer, "createdAt").unwrap_or(0.0);
    let updated = ["updatedAt", "lastUpdatedAt", "lastSendTime", "createdAt"]
        .iter()
        .find_map(|key| number(composer, key))
        .unwrap_or(0.0);
    let session_title = session_title(composer, &messages);
    let stats = detail_stats(&messages, composer, pricing);
    let head = SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            agent_name: "cursor".into(),
            session_id: id.into(),
        },
        title: session_title,
        directory,
        display_title: None,
        parent_reference: None,
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats,
        model_usage,
        smart_tags: super::smart_tags::classify(&messages),
        smart_tags_source_updated_at: Some(updated),
        smart_tags_classifier_revision: Some("smart-tags-v1".into()),
    };
    let file_activity = super::file_activity::summarize(&head, &messages);
    Ok(Some(ParsedSession {
        head: SessionHead {
            stats: scan_stats,
            title: scan_title,
            ..head.clone()
        },
        source: path.to_path_buf(),
        detail: SessionDetail {
            head,
            messages,
            detail_freshness: "fresh".into(),
            message_cursor: None,
            message_update: None,
            file_activity,
        },
    }))
}

fn composer_id(composer: &Value) -> Option<&str> {
    string(composer, "id")
        .filter(|s| !s.is_empty())
        .or_else(|| string(composer, "composerId"))
        .filter(|s| !s.is_empty())
}

pub fn resolve_session_id(root: &Path, request_id: &str) -> Result<Option<String>> {
    let db = Connection::open_with_flags(
        root.join("globalStorage/state.vscdb"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut query = db.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' AND value LIKE ?",
    )?;
    let mut rows = query.query([format!("%\"requestId\":\"{request_id}\"%")])?;
    while let Some(row) = rows.next()? {
        let key: String = row.get(0)?;
        let raw: String = row.get(1)?;
        if let Ok(bubble) = serde_json::from_str::<Value>(&raw)
            && string(&bubble, "requestId") == Some(request_id)
        {
            return Ok(key.split(':').nth(1).map(str::to_owned));
        }
    }
    Ok(None)
}
fn session_title(composer: &Value, messages: &[Message]) -> String {
    let message_title = messages
        .iter()
        .filter(|m| m.role == Role::User)
        .flat_map(|m| &m.parts)
        .find_map(|part| match part {
            MessagePart::Text { text, .. } => title(text),
            _ => None,
        });
    let explicit = string(composer, "name")
        .filter(|s| !s.is_empty())
        .or_else(|| string(composer, "title"));
    explicit
        .and_then(title)
        .or(message_title)
        .or_else(|| string(composer, "text").and_then(title))
        .unwrap_or_else(|| "Untitled Session".into())
}

fn string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}
fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64().filter(|n| n.is_finite())
}
fn model(value: &Value) -> Option<&str> {
    string(&value["modelConfig"], "modelName").or_else(|| string(value, "model"))
}
fn internal(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let mut normalized = String::new();
    let mut separator = false;
    for character in text.trim().to_lowercase().chars() {
        if matches!(character, '_' | '-') {
            if !separator {
                normalized.push(' ');
            }
            separator = true;
        } else {
            normalized.push(character);
            separator = false;
        }
    }
    matches!(
        normalized.as_str(),
        "progress" | "file history snapshot" | "queue operation" | "last prompt"
    )
}
fn workspace_paths(root: &Path) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let Ok(entries) = std::fs::read_dir(root.join("workspaceStorage")) else {
        return result;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let dir = entry.path();
        let Some(value) = std::fs::read(dir.join("workspace.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        else {
            continue;
        };
        let Some(uri) = string(&value, "folder")
            .or_else(|| string(&value, "workspace"))
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let Some(path) = decode_uri(uri.strip_prefix("file://").unwrap_or(uri)) else {
            continue;
        };
        let path = normalize_path(&path);
        let Ok(db) =
            Connection::open_with_flags(dir.join("state.vscdb"), OpenFlags::SQLITE_OPEN_READ_ONLY)
        else {
            continue;
        };
        let Ok(raw) = db.query_row(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerData'",
            [],
            |row| row.get::<_, String>(0),
        ) else {
            continue;
        };
        let Ok(composers) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(composers) = composers["allComposers"]
            .as_array()
            .or_else(|| composers.as_array())
        else {
            continue;
        };
        for composer in composers {
            if let Some(id) = string(composer, "composerId")
                .or_else(|| string(composer, "id"))
                .filter(|s| !s.is_empty())
            {
                result.insert(id.into(), path.clone());
            }
        }
    }
    result
}
fn decode_uri(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut iter = value.bytes();
    while let Some(byte) = iter.next() {
        if byte == b'%' {
            let high = (iter.next()? as char).to_digit(16)?;
            let low = (iter.next()? as char).to_digit(16)?;
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).ok()
}
fn normalize_path(value: &str) -> String {
    use std::path::{Component, PathBuf};
    let mut path = PathBuf::new();
    for part in Path::new(value).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir if path.file_name().is_some_and(|v| v != "..") => {
                path.pop();
            }
            _ => path.push(part.as_os_str()),
        }
    }
    let mut result = path.to_string_lossy().into_owned();
    if result.is_empty() {
        result.push('.');
    }
    if value.ends_with(std::path::MAIN_SEPARATOR) && !result.ends_with(std::path::MAIN_SEPARATOR) {
        result.push(std::path::MAIN_SEPARATOR);
    }
    result
}

#[cfg(test)]
mod tests;
