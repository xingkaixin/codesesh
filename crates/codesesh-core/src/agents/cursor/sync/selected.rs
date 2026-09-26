use super::super::{composer_id, pagination, parse_composer, string, workspace_paths};
use super::{CursorSync, child_owners, fingerprint};
use crate::{agents::codex::ParsedSession, pricing::Pricing};
use anyhow::Result;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Arc,
};

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
        let mut db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let tx = db.transaction()?;
        let mut composers = Vec::new();
        {
            let mut query=tx.prepare("SELECT key,value,rowid FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid")?;
            let mut rows = query.query([])?;
            while let Some(row) = rows.next()? {
                let raw: String = row.get(1)?;
                if let Some(composer) = pagination::selected_composer(&raw, selected) {
                    composers.push((
                        row.get::<_, String>(0)?,
                        fingerprint(row.get(2)?, &raw),
                        Arc::new(composer),
                    ));
                }
            }
        }
        let directories = workspace_paths(root);
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
