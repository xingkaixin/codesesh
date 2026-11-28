use super::super::{composer_id, pagination, parse_composer, workspace_paths};
use super::fingerprint;
#[cfg(test)]
use super::{super::string, CursorSync, child_owners};
use crate::{
    agents::{ParsedSession, open_readonly_sqlite},
    pricing::Pricing,
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::collections::HashSet;
use std::{collections::HashMap, path::Path, sync::Arc};

type SelectedComposer = (String, [u8; 32], Arc<Value>);

fn load_selected_composers(
    tx: &Connection,
    selected: &HashMap<String, String>,
) -> Result<Vec<SelectedComposer>> {
    let mut query = tx.prepare("SELECT key,value,rowid FROM cursorDiskKV WHERE key=?1")?;
    let mut ordered = Vec::with_capacity(selected.len());
    for (id, lookup) in selected {
        if let Some((key, raw, row_id)) = query
            .query_row([lookup], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .optional()?
            && let Ok(composer) = serde_json::from_str::<Value>(&raw)
            && composer_id(&composer) == Some(id.as_str())
        {
            ordered.push((row_id, key, fingerprint(row_id, &raw), Arc::new(composer)));
        }
    }
    ordered.sort_by_key(|(row_id, ..)| *row_id);
    Ok(ordered
        .into_iter()
        .map(|(_, key, hash, composer)| (key, hash, composer))
        .collect())
}

pub fn scan_page(
    root: &Path,
    pricing: &Pricing,
    selected: &HashMap<String, String>,
) -> Result<(Vec<ParsedSession>, HashMap<String, String>)> {
    if selected.is_empty() {
        return Ok((Vec::new(), HashMap::new()));
    }
    let path = root.join("globalStorage/state.vscdb");
    if !path.exists() {
        return Ok((Vec::new(), HashMap::new()));
    }
    let mut db = open_readonly_sqlite(&path)?;
    let tx = db.transaction()?;
    let composers = load_selected_composers(&tx, selected)?;
    let directories = workspace_paths(root)?;
    let mut session_fingerprints = HashMap::with_capacity(composers.len());
    let mut output = Vec::new();
    let mut bubble_query = tx.prepare(
        "SELECT key,value,rowid FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 ORDER BY rowid",
    )?;
    let mut child_query = tx.prepare("SELECT value,rowid FROM cursorDiskKV WHERE key=?1")?;
    for (composer_key, composer_hash, composer) in &composers {
        let id = composer_id(composer).expect("selected composer id");
        let mut rows =
            bubble_query.query([format!("bubbleId:{id}:"), format!("bubbleId:{id};")])?;
        let mut bubbles = Vec::new();
        let mut bubble_hasher = Sha256::new();
        while let Some(row) = rows.next()? {
            let key: String = row.get(0)?;
            let raw: String = row.get(1)?;
            let row_hash = fingerprint(row.get(2)?, &raw);
            pagination::hash_bubble_row(&mut bubble_hasher, &key, &row_hash);
            if let Ok(value) = serde_json::from_str::<Value>(&raw)
                && value.is_object()
            {
                bubbles.push((key, value));
            }
        }
        let bubbles_digest: [u8; 32] = bubble_hasher.finalize().into();
        let children = pagination::subagent_ids(composer.get("subagentInfos"));
        let mut child_hashes: HashMap<&str, Option<[u8; 32]>> = HashMap::new();
        for child in &children {
            if child_hashes.contains_key(child.as_str()) {
                continue;
            }
            let key = format!("bubble:{child}");
            let hash = child_query
                .query_row([&key], |row| {
                    Ok(fingerprint(row.get(1)?, &row.get::<_, String>(0)?))
                })
                .optional()?;
            child_hashes.insert(child.as_str(), hash);
        }
        let directory = directories.get(id).map(String::as_str);
        session_fingerprints.insert(
            id.to_owned(),
            pagination::session_fingerprint(
                composer_key,
                composer_hash,
                &bubbles_digest,
                &children,
                |child| child_hashes.get(child).copied().flatten(),
                directory,
            ),
        );
        if let Some(session) = parse_composer(
            &tx,
            &path,
            composer,
            &bubbles,
            directory.unwrap_or_default().to_owned(),
            pricing,
        )? {
            output.push(session);
        }
    }
    drop(bubble_query);
    drop(child_query);
    tx.commit()?;
    Ok((output, session_fingerprints))
}

#[cfg(test)]
impl CursorSync {
    pub fn scan_selected(
        &mut self,
        root: &Path,
        pricing: &Pricing,
        selected: &HashSet<String>,
    ) -> Result<Vec<ParsedSession>> {
        anyhow::ensure!(
            self.root.as_deref().is_none_or(|previous| previous == root),
            "CursorSync cannot change source root"
        );
        if selected.is_empty() {
            return Ok(Vec::new());
        }
        let path = root.join("globalStorage/state.vscdb");
        if !path.exists() {
            return Ok(Vec::new());
        }
        let mut db = open_readonly_sqlite(&path)?;
        let tx = db.transaction()?;
        let keys = pagination::enumerate_session_keys(root)?
            .into_iter()
            .filter(|key| selected.contains(&key.id))
            .map(|key| (key.id, key.composer_key))
            .collect();
        let composers = load_selected_composers(&tx, &keys)?;
        let directories = workspace_paths(root)?;
        let owners = child_owners(&self.composers);
        let mut fingerprints = HashMap::new();
        let mut dirty = self.dirty.clone();
        let mut output = Vec::new();
        let mut bubble_query = tx.prepare(
            "SELECT key,value,rowid FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 ORDER BY rowid",
        )?;
        let mut child_query = tx.prepare("SELECT value,rowid FROM cursorDiskKV WHERE key=?1")?;
        for (key, hash, composer) in &composers {
            fingerprints.insert(key.clone(), *hash);
            let id = composer_id(composer).expect("selected composer id");
            let mut rows =
                bubble_query.query([format!("bubbleId:{id}:"), format!("bubbleId:{id};")])?;
            let mut bubbles = Vec::new();
            while let Some(row) = rows.next()? {
                let key: String = row.get(0)?;
                let raw: String = row.get(1)?;
                fingerprints.insert(key.clone(), fingerprint(row.get(2)?, &raw));
                if let Ok(value) = serde_json::from_str::<Value>(&raw)
                    && value.is_object()
                {
                    bubbles.push((key, value));
                }
            }
            if let Some(children) = composer["subagentInfos"].as_array() {
                for child in children {
                    let Some(child) = string(child, "id").filter(|id| !id.is_empty()) else {
                        continue;
                    };
                    let key = format!("bubble:{child}");
                    let row = child_query
                        .query_row([&key], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                        })
                        .optional()?;
                    let hash = row.as_ref().map(|(raw, row_id)| fingerprint(*row_id, raw));
                    if self.fingerprints.get(&key).copied() != hash
                        && let Some(parents) = owners.get(child)
                    {
                        dirty.extend(parents.iter().cloned());
                    }
                    if let Some(hash) = hash {
                        fingerprints.insert(key, hash);
                    }
                }
            }
            if let Some(session) = parse_composer(
                &tx,
                &path,
                composer,
                &bubbles,
                directories.get(id).cloned().unwrap_or_default(),
                pricing,
            )? {
                output.push(session);
            }
        }
        drop(bubble_query);
        drop(child_query);
        tx.commit()?;
        let old_composer_keys: HashSet<_> = self
            .composers
            .iter()
            .filter(|(_, value)| composer_id(value).is_some_and(|id| selected.contains(id)))
            .map(|(key, _)| key.clone())
            .collect();
        self.composers
            .retain(|key, _| !old_composer_keys.contains(key));
        self.fingerprints.retain(|key, _| {
            let selected_bubble = key.starts_with("bubbleId:")
                && key
                    .split(':')
                    .nth(1)
                    .is_some_and(|id| selected.contains(id));
            !(old_composer_keys.contains(key) || selected_bubble)
        });
        self.fingerprints.extend(fingerprints);
        for (key, _, composer) in composers {
            self.composers.insert(key, super::metadata(&composer));
        }
        for id in selected {
            self.directories.remove(id);
            if let Some(directory) = directories.get(id) {
                self.directories.insert(id.clone(), directory.clone());
            }
            self.active.remove(id);
            dirty.remove(id);
        }
        self.active.extend(
            output
                .iter()
                .map(|session| session.head.reference.session_id.clone()),
        );
        self.root = Some(root.into());
        self.dirty = dirty;
        Ok(output)
    }
}
