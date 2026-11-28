use super::{ParsedSession, open_readonly_sqlite};
use crate::{
    model::{
        CostSource, Message, MessagePart, Role, SessionDetail, SessionHead, SessionReference,
        SessionStats,
    },
    pricing::Pricing,
    projects::path_identity,
};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
};

mod text;
use text::{clean, title};
mod messages;
use messages::{append_subagents, detail_stats, messages, model_usage};

mod pagination;
pub use pagination::enumerate_session_keys;
mod sync;
pub use sync::{CursorSync, scan_page};

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
    let scan_estimated = messages
        .iter()
        .any(|m| m.cost_source == Some(CostSource::Estimated));
    let scan_stats = SessionStats {
        message_count: messages.len(),
        total_input_tokens: number(composer, "inputTokenCount").unwrap_or(0.0),
        total_output_tokens: number(composer, "outputTokenCount").unwrap_or(0.0),
        total_cost: scan_cost,
        cost_inputs: messages
            .iter()
            .flat_map(|m| m.cost_inputs.iter().cloned())
            .collect(),
        cost_source: scan_estimated.then_some(CostSource::Estimated),
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
            source_node_id: crate::model::local_source_node_id(),
            agent_name: "cursor".into(),
            session_id: id.into(),
        },
        title: session_title,
        directory,
        display_title: None,
        parent_reference: None,
        project_identity,
        recorded_git_remotes: Vec::new(),
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats,
        model_usage,
        smart_tags: Vec::new(),
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
            detail_freshness: crate::model::DetailFreshness::Fresh,
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
type WorkspaceMapping = (String, Vec<String>);

#[derive(Clone)]
struct CachedWorkspace {
    stamp: String,
    mappings: Option<WorkspaceMapping>,
}

static WORKSPACE_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedWorkspace>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn workspace_dir_stamp(dir: &Path) -> String {
    let mut stamp = String::new();
    for name in [
        "workspace.json",
        "state.vscdb",
        "state.vscdb-wal",
        "state.vscdb-journal",
    ] {
        let path = dir.join(name);
        if let Ok(metadata) = std::fs::metadata(&path)
            && let Ok((_, file_stamp)) = crate::hash::file_stamp(&metadata)
        {
            stamp.push('|');
            stamp.push_str(name);
            stamp.push(':');
            stamp.push_str(&file_stamp);
        }
    }
    stamp
}

fn read_workspace_dir(dir: &Path) -> Option<WorkspaceMapping> {
    let value = std::fs::read(dir.join("workspace.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())?;
    let uri = string(&value, "folder")
        .or_else(|| string(&value, "workspace"))
        .filter(|v| !v.is_empty())?;
    let path = normalize_path(&decode_uri(uri.strip_prefix("file://").unwrap_or(uri))?);
    let db = open_readonly_sqlite(dir.join("state.vscdb")).ok()?;
    let raw = db
        .query_row(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerData'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    let composers = serde_json::from_str::<Value>(&raw).ok()?;
    let composers = composers["allComposers"]
        .as_array()
        .or_else(|| composers.as_array())?;
    let ids = composers
        .iter()
        .filter_map(|composer| {
            string(composer, "composerId")
                .or_else(|| string(composer, "id"))
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        })
        .collect();
    Some((path, ids))
}

fn workspace_paths(root: &Path) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let storage = root.join("workspaceStorage");
    let Ok(entries) = std::fs::read_dir(&storage) else {
        let mut cache = WORKSPACE_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.retain(|path, _| !path.starts_with(&storage));
        return result;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|e| e.file_name());
    let mut dirs = Vec::new();
    let mut live_dirs = HashSet::new();
    for entry in entries {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let dir = entry.path();
        let stamp = workspace_dir_stamp(&dir);
        live_dirs.insert(dir.clone());
        dirs.push((dir, stamp));
    }
    let mut resolved: Vec<Option<Option<WorkspaceMapping>>> = Vec::with_capacity(dirs.len());
    {
        let mut cache = WORKSPACE_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.retain(|path, _| !path.starts_with(&storage) || live_dirs.contains(path));
        for (dir, stamp) in &dirs {
            let hit = cache
                .get(dir)
                .filter(|entry| entry.stamp == *stamp)
                .map(|entry| entry.mappings.clone());
            resolved.push(hit);
        }
    }
    let mut updates = Vec::new();
    for ((dir, stamp), slot) in dirs.into_iter().zip(&mut resolved) {
        if slot.is_none() {
            let mappings = read_workspace_dir(&dir);
            *slot = Some(mappings.clone());
            updates.push((dir, CachedWorkspace { stamp, mappings }));
        }
    }
    if !updates.is_empty() {
        let mut cache = WORKSPACE_CACHE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (dir, entry) in updates {
            cache.insert(dir, entry);
        }
    }
    for mappings in resolved.into_iter().flatten().flatten() {
        let (path, ids) = mappings;
        for id in ids {
            result.insert(id, path.clone());
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
