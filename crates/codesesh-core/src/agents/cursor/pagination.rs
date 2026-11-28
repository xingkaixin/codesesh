use super::{string, workspace_paths};
use crate::agents::open_readonly_sqlite;
use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};

#[derive(Clone, Debug)]
pub struct SessionKey {
    pub id: String,
    pub composer_key: String,
    pub activity: f64,
    pub fingerprint: String,
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
    subagent_infos: Option<Value>,
}

struct ComposerIndex {
    id: String,
    activity: f64,
    children: Vec<String>,
    has_subagents: bool,
}

pub(super) fn subagent_ids(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|child| {
            string(child, "id")
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        })
        .collect()
}

fn index_entry(raw: &str) -> Option<ComposerIndex> {
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
    let children = subagent_ids(fields.subagent_infos.as_ref());
    Some(ComposerIndex {
        id,
        activity,
        children,
        has_subagents: fields
            .subagent_infos
            .as_ref()
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(Value::is_object)),
    })
}

pub(super) fn hash_bubble_row(hasher: &mut Sha256, key: &str, hash: &[u8; 32]) {
    hasher.update((key.len() as u64).to_le_bytes());
    hasher.update(key.as_bytes());
    hasher.update(hash);
}

pub(super) fn session_fingerprint(
    composer_key: &str,
    composer_hash: &[u8; 32],
    bubbles_digest: &[u8; 32],
    children: &[String],
    child_hash: impl Fn(&str) -> Option<[u8; 32]>,
    directory: Option<&str>,
) -> String {
    let mut hash = Sha256::new();
    hash.update((composer_key.len() as u64).to_le_bytes());
    hash.update(composer_key.as_bytes());
    hash.update(composer_hash);
    hash.update(bubbles_digest);
    hash.update((children.len() as u64).to_le_bytes());
    for child in children {
        hash.update((child.len() as u64).to_le_bytes());
        hash.update(child.as_bytes());
        match child_hash(child) {
            Some(digest) => {
                hash.update([1]);
                hash.update(digest);
            }
            None => hash.update([0]),
        }
    }
    let directory = directory.unwrap_or("");
    hash.update((directory.len() as u64).to_le_bytes());
    hash.update(directory.as_bytes());
    crate::hash::hex(&hash.finalize())
}

fn has_own_messages(db: &rusqlite::Connection, id: &str) -> Result<bool> {
    let mut query =
        db.prepare_cached("SELECT value FROM cursorDiskKV WHERE key >= ?1 AND key < ?2")?;
    let mut rows = query.query([format!("bubbleId:{id}:"), format!("bubbleId:{id};")])?;
    while let Some(row) = rows.next()? {
        let raw = row.get_ref(0)?.as_str()?;
        if let Ok(bubble) = serde_json::from_str::<Value>(raw)
            && super::messages::bubble_parts(&bubble, 0.0).is_some_and(|parts| !parts.is_empty())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn enumerate_session_keys(root: &Path) -> Result<Vec<SessionKey>> {
    let path = root.join("globalStorage/state.vscdb");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = open_readonly_sqlite(path)?;
    db.execute_batch("BEGIN")?;
    let mut query = db.prepare(
        "SELECT key, value, rowid FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%' OR key LIKE 'bubble:%' ORDER BY rowid",
    )?;
    let mut rows = query.query([])?;
    let mut composers: HashMap<String, (String, [u8; 32], ComposerIndex)> = HashMap::new();
    let mut duplicate_has_messages = HashMap::new();
    let mut bubble_hashers: HashMap<String, Sha256> = HashMap::new();
    let mut child_hashes: HashMap<String, [u8; 32]> = HashMap::new();
    while let Some(row) = rows.next()? {
        let key = row.get_ref(0)?.as_str()?;
        let raw = row.get_ref(1)?.as_str()?;
        let hash = super::sync::fingerprint(row.get(2)?, raw);
        if key.starts_with("composerData:") {
            if let Some(entry) = index_entry(raw) {
                if !entry.has_subagents
                    && composers
                        .get(&entry.id)
                        .is_some_and(|(_, _, previous)| previous.has_subagents)
                {
                    let has_messages = match duplicate_has_messages.entry(entry.id.clone()) {
                        std::collections::hash_map::Entry::Occupied(previous) => *previous.get(),
                        std::collections::hash_map::Entry::Vacant(slot) => {
                            *slot.insert(has_own_messages(&db, &entry.id)?)
                        }
                    };
                    if !has_messages {
                        continue;
                    }
                }
                composers.insert(entry.id.clone(), (key.to_owned(), hash, entry));
            }
        } else if key.starts_with("bubbleId:") {
            if let Some(id) = key.split(':').nth(1) {
                let hasher = if let Some(hasher) = bubble_hashers.get_mut(id) {
                    hasher
                } else {
                    bubble_hashers.entry(id.to_owned()).or_default()
                };
                hash_bubble_row(hasher, key, &hash);
            }
        } else if let Some(child_id) = key.strip_prefix("bubble:") {
            child_hashes.insert(child_id.to_owned(), hash);
        }
    }
    drop(rows);
    drop(query);
    db.execute_batch("COMMIT")?;
    let directories = workspace_paths(root)?;
    let empty_bubbles: [u8; 32] = Sha256::new().finalize().into();
    let mut keys = Vec::with_capacity(composers.len());
    for (composer_key, composer_hash, entry) in composers.into_values() {
        let bubbles_digest: [u8; 32] = bubble_hashers
            .remove(&entry.id)
            .map(|hasher| hasher.finalize().into())
            .unwrap_or(empty_bubbles);
        let fingerprint = session_fingerprint(
            &composer_key,
            &composer_hash,
            &bubbles_digest,
            &entry.children,
            |child| child_hashes.get(child).copied(),
            directories.get(&entry.id).map(String::as_str),
        );
        keys.push(SessionKey {
            composer_key,
            id: entry.id,
            activity: entry.activity,
            fingerprint,
        });
    }
    Ok(keys)
}
