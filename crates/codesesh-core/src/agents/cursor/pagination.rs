use super::{CursorSync, composer_id};
use crate::{agents::codex::ParsedSession, pricing::Pricing};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use serde_json::Value;
use std::{collections::HashSet, path::Path};

#[derive(Clone, Debug)]
pub struct SessionKey {
    pub id: String,
    pub activity: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexFields {
    id: Option<Value>,
    composer_id: Option<Value>,
    updated_at: Option<Value>,
    last_updated_at: Option<Value>,
    last_send_time: Option<Value>,
    created_at: Option<Value>,
}

pub(super) fn key(raw: &str) -> Option<SessionKey> {
    let fields: IndexFields = serde_json::from_str(raw).ok()?;
    let id = fields
        .id
        .as_ref()
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .or_else(|| fields.composer_id.as_ref().and_then(Value::as_str))
        .filter(|v| !v.is_empty())?
        .to_owned();
    let activity = [
        fields.updated_at,
        fields.last_updated_at,
        fields.last_send_time,
        fields.created_at,
    ]
    .iter()
    .flatten()
    .find_map(Value::as_f64)
    .unwrap_or(0.0);
    Some(SessionKey { id, activity })
}

pub fn enumerate_session_keys(root: &Path) -> Result<Vec<SessionKey>> {
    let path = root.join("globalStorage/state.vscdb");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = db
        .prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid")?;
    let mut rows = query.query([])?;
    let mut keys = Vec::new();
    while let Some(row) = rows.next()? {
        let raw: String = row.get(0)?;
        if let Some(key) = key(&raw) {
            keys.push(key);
        }
    }
    Ok(keys)
}

pub fn scan_selected(
    root: &Path,
    pricing: &Pricing,
    selected: &HashSet<String>,
) -> Result<Vec<ParsedSession>> {
    CursorSync::default().scan_selected(root, pricing, selected)
}

pub(super) fn selected_composer(raw: &str, selected: &HashSet<String>) -> Option<Value> {
    let index = key(raw)?;
    if !selected.contains(&index.id) {
        return None;
    }
    let value = serde_json::from_str::<Value>(raw).ok()?;
    composer_id(&value)?;
    Some(value)
}
