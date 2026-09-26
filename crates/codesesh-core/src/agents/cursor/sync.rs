use super::{composer_id, parse_composer, string, workspace_paths};
use crate::{agents::codex::ParsedSession, contract::SessionReference, pricing::Pricing};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Default)]
pub struct CursorSync {
    root: Option<PathBuf>,
    fingerprints: HashMap<String, [u8; 32]>,
    composers: HashMap<String, Arc<Value>>,
    directories: HashMap<String, String>,
    active: HashSet<String>,
    dirty: HashSet<String>,
}
pub struct CursorDelta {
    pub upserts: Vec<ParsedSession>,
    pub removed: Vec<SessionReference>,
}
impl CursorSync {
    pub fn refresh(&mut self, root: &Path, pricing: &Pricing) -> Result<CursorDelta> {
        self.refresh_inner(root, pricing, None)
    }

    pub fn refresh_selected(
        &mut self,
        root: &Path,
        pricing: &Pricing,
        eligible: &HashSet<String>,
    ) -> Result<CursorDelta> {
        self.refresh_inner(root, pricing, Some(eligible))
    }

    fn refresh_inner(
        &mut self,
        root: &Path,
        pricing: &Pricing,
        eligible: Option<&HashSet<String>>,
    ) -> Result<CursorDelta> {
        anyhow::ensure!(
            self.root.as_deref().is_none_or(|previous| previous == root),
            "CursorSync cannot change source root"
        );
        let path = root.join("globalStorage/state.vscdb");
        if !path.exists() {
            let removed = references(self.active.iter().cloned());
            *self = Self::default();
            return Ok(CursorDelta {
                upserts: Vec::new(),
                removed,
            });
        }
        let mut db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let transaction = db.transaction()?;
        let mut fingerprints = HashMap::new();
        let mut composers = self.composers.clone();
        {
            let mut query = transaction.prepare("SELECT key, value, rowid FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%' OR key LIKE 'bubble:%' ORDER BY rowid")?;
            let mut rows = query.query([])?;
            while let Some(row) = rows.next()? {
                let key: String = row.get(0)?;
                let raw: String = row.get(1)?;
                let hash = fingerprint(row.get(2)?, &raw);
                if key.starts_with("composerData:") && self.fingerprints.get(&key) != Some(&hash) {
                    composers.remove(&key);
                    if let Ok(value) = serde_json::from_str::<Value>(&raw)
                        && composer_id(&value).is_some()
                    {
                        composers.insert(key.clone(), metadata(&value));
                    }
                }
                fingerprints.insert(key, hash);
            }
        }
        composers.retain(|key, _| fingerprints.contains_key(key));
        let changed: HashSet<&str> = fingerprints
            .keys()
            .chain(self.fingerprints.keys())
            .filter(|key| fingerprints.get(*key) != self.fingerprints.get(*key))
            .map(String::as_str)
            .collect();
        let mut affected = self.dirty.clone();
        let old_children = child_owners(&self.composers);
        let children = child_owners(&composers);
        for key in changed {
            if key.starts_with("composerData:") {
                for value in [self.composers.get(key), composers.get(key)]
                    .into_iter()
                    .flatten()
                {
                    if let Some(id) = composer_id(value) {
                        affected.insert(id.into());
                    }
                }
            } else if key.starts_with("bubbleId:") {
                if let Some(id) = key.split(':').nth(1) {
                    affected.insert(id.into());
                }
            } else if let Some(id) = key.strip_prefix("bubble:") {
                for owners in [old_children.get(id), children.get(id)]
                    .into_iter()
                    .flatten()
                {
                    affected.extend(owners.iter().cloned());
                }
            }
        }
        let directories = workspace_paths(root);
        for id in directories.keys().chain(self.directories.keys()) {
            if directories.get(id) != self.directories.get(id) {
                affected.insert(id.clone());
            }
        }
        let mut deferred = HashSet::new();
        if let Some(eligible) = eligible {
            affected.retain(|id| {
                if eligible.contains(id) {
                    true
                } else {
                    deferred.insert(id.clone());
                    false
                }
            });
        }
        let mut active = self.active.clone();
        active.retain(|id| !affected.contains(id));
        let mut upserts = Vec::new();
        {
            let mut query = transaction.prepare(
                "SELECT key,value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid",
            )?;
            let mut rows = query.query([])?;
            let mut bubble_query = transaction.prepare(
                "SELECT key,value FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 ORDER BY rowid",
            )?;
            while let Some(row) = rows.next()? {
                let key: String = row.get(0)?;
                let Some(id) = composers
                    .get(&key)
                    .and_then(|c| composer_id(c))
                    .filter(|id| affected.contains(*id))
                else {
                    continue;
                };
                let raw: String = row.get(1)?;
                let composer: Value = serde_json::from_str(&raw)?;
                let mut bubble_rows =
                    bubble_query.query([format!("bubbleId:{id}:"), format!("bubbleId:{id};")])?;
                let mut messages = Vec::new();
                while let Some(row) = bubble_rows.next()? {
                    let raw: String = row.get(1)?;
                    if let Ok(value) = serde_json::from_str::<Value>(&raw)
                        && value.is_object()
                    {
                        messages.push((row.get::<_, String>(0)?, value));
                    }
                }
                if let Some(session) = parse_composer(
                    &transaction,
                    &path,
                    &composer,
                    &messages,
                    directories.get(id).cloned().unwrap_or_default(),
                    pricing,
                )? {
                    active.insert(id.into());
                    upserts.push(session);
                }
            }
        }
        let removed = references(self.active.difference(&active).cloned());
        transaction.commit()?;
        self.root = Some(root.into());
        self.fingerprints = fingerprints;
        self.composers = composers;
        self.directories = directories;
        self.active = active;
        self.dirty = deferred;
        Ok(CursorDelta { upserts, removed })
    }
}
fn references(ids: impl Iterator<Item = String>) -> Vec<SessionReference> {
    let mut ids = ids.collect::<Vec<_>>();
    ids.sort();
    ids.into_iter()
        .map(|session_id| SessionReference {
            agent_name: "cursor".into(),
            session_id,
        })
        .collect()
}
fn metadata(composer: &Value) -> Arc<Value> {
    Arc::new(serde_json::json!({
        "composerId": composer_id(composer),
        "subagentInfos": composer["subagentInfos"].as_array().into_iter().flatten()
            .filter_map(|child| string(child, "id"))
            .map(|id| serde_json::json!({"id":id})).collect::<Vec<_>>()
    }))
}

fn child_owners(composers: &HashMap<String, Arc<Value>>) -> HashMap<String, HashSet<String>> {
    let mut owners: HashMap<String, HashSet<String>> = HashMap::new();
    for composer in composers.values() {
        let Some(id) = composer_id(composer) else {
            continue;
        };
        if let Some(children) = composer["subagentInfos"].as_array() {
            for child in children {
                if let Some(child) = string(child, "id").filter(|s| !s.is_empty()) {
                    owners.entry(child.into()).or_default().insert(id.into());
                }
            }
        }
    }
    owners
}

mod selected;

fn fingerprint(row_id: i64, raw: &str) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(row_id.to_le_bytes());
    hash.update(raw.as_bytes());
    hash.finalize().into()
}
