use anyhow::Result;
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
};

pub(crate) const KIND_FILE: &str = "file";
pub(crate) const KIND_DATABASE: &str = "database";
pub(crate) const KIND_EMPTY: &str = "empty";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct SourceFingerprints {
    pub files: HashMap<String, String>,
    pub database_sessions: HashMap<String, String>,
    pub empty_sources: HashSet<String>,
}

impl SourceFingerprints {
    pub(crate) fn is_empty(&self) -> bool {
        self.files.is_empty() && self.database_sessions.is_empty() && self.empty_sources.is_empty()
    }

    pub(crate) fn merge_from(&mut self, other: Self) {
        self.files.extend(other.files);
        self.database_sessions.extend(other.database_sessions);
        self.empty_sources.extend(other.empty_sources);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceStateDelta {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reset: bool,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub file_upserts: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    pub file_removes: HashSet<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub database_upserts: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    pub database_removes: HashSet<String>,
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    pub empty_adds: HashSet<String>,
    #[serde(default, skip_serializing_if = "HashSet::is_empty")]
    pub empty_removes: HashSet<String>,
}

impl SourceStateDelta {
    pub(crate) fn is_empty(&self) -> bool {
        !self.reset
            && self.file_upserts.is_empty()
            && self.file_removes.is_empty()
            && self.database_upserts.is_empty()
            && self.database_removes.is_empty()
            && self.empty_adds.is_empty()
            && self.empty_removes.is_empty()
    }

    pub(crate) fn from_fingerprints(fingerprints: SourceFingerprints, reset: bool) -> Self {
        Self {
            reset,
            file_upserts: fingerprints.files,
            file_removes: HashSet::new(),
            database_upserts: fingerprints.database_sessions,
            database_removes: HashSet::new(),
            empty_adds: fingerprints.empty_sources,
            empty_removes: HashSet::new(),
        }
    }
}

pub(crate) fn parse_inline_fields(state: &Value) -> SourceFingerprints {
    SourceFingerprints {
        files: state
            .get("files")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        database_sessions: state
            .get("databaseSessions")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        empty_sources: state
            .get("emptySources")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
    }
}

/// Removes legacy inline fingerprint collections from a `sourceState` JSON object and returns them
/// when any of the three keys were present.
pub(crate) fn extract_inline_fields(state: &mut Value) -> Option<SourceFingerprints> {
    let object = state.as_object_mut()?;
    let files = object.remove("files");
    let database_sessions = object.remove("databaseSessions");
    let empty_sources = object.remove("emptySources");
    if files.is_none() && database_sessions.is_none() && empty_sources.is_none() {
        return None;
    }
    Some(SourceFingerprints {
        files: files
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        database_sessions: database_sessions
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
        empty_sources: empty_sources
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or_default(),
    })
}

pub(crate) fn strip_metadata_state(state: &Value) -> Cow<'_, Value> {
    let has_inline = state.as_object().is_some_and(|object| {
        object.contains_key("files")
            || object.contains_key("databaseSessions")
            || object.contains_key("emptySources")
    });
    if !has_inline {
        return Cow::Borrowed(state);
    }
    let mut cleaned = state.clone();
    extract_inline_fields(&mut cleaned);
    Cow::Owned(cleaned)
}

pub(crate) fn strip_checkpoint_delta(checkpoint: &Value) -> Cow<'_, Value> {
    let needs_strip = checkpoint.as_object().is_some_and(|object| {
        object.contains_key("sourceStateDelta")
            || object
                .get("sourceState")
                .and_then(Value::as_object)
                .is_some_and(|state| {
                    state.contains_key("files")
                        || state.contains_key("databaseSessions")
                        || state.contains_key("emptySources")
                })
    });
    if !needs_strip {
        return Cow::Borrowed(checkpoint);
    }
    let mut cleaned = checkpoint.clone();
    if let Some(object) = cleaned.as_object_mut() {
        object.remove("sourceStateDelta");
        if let Some(state) = object.get_mut("sourceState") {
            extract_inline_fields(state);
        }
    }
    Cow::Owned(cleaned)
}

pub(crate) fn load(
    connection: &Connection,
    table: &str,
    agent_col: &str,
    agent: &str,
) -> Result<SourceFingerprints> {
    let mut query = connection.prepare_cached(&format!(
        "SELECT kind,entry_key,fingerprint FROM {table} WHERE {agent_col}=?1"
    ))?;
    let mut rows = query.query([agent])?;
    let mut loaded = SourceFingerprints::default();
    while let Some(row) = rows.next()? {
        let kind: String = row.get(0)?;
        let key: String = row.get(1)?;
        let fingerprint: String = row.get(2)?;
        match kind.as_str() {
            KIND_FILE => {
                loaded.files.insert(key, fingerprint);
            }
            KIND_DATABASE => {
                loaded.database_sessions.insert(key, fingerprint);
            }
            KIND_EMPTY => {
                loaded.empty_sources.insert(key);
            }
            _ => {}
        }
    }
    Ok(loaded)
}

pub(crate) fn insert_all(
    connection: &Connection,
    table: &str,
    agent_col: &str,
    agent: &str,
    fingerprints: &SourceFingerprints,
) -> Result<()> {
    if fingerprints.is_empty() {
        return Ok(());
    }
    let mut upsert = connection.prepare_cached(&format!(
        "INSERT INTO {table}({agent_col},kind,entry_key,fingerprint) VALUES(?1,?2,?3,?4) \
         ON CONFLICT({agent_col},kind,entry_key) DO UPDATE SET fingerprint=excluded.fingerprint \
         WHERE fingerprint<>excluded.fingerprint"
    ))?;
    for (key, fingerprint) in &fingerprints.files {
        upsert.execute(params![agent, KIND_FILE, key, fingerprint])?;
    }
    for (key, fingerprint) in &fingerprints.database_sessions {
        upsert.execute(params![agent, KIND_DATABASE, key, fingerprint])?;
    }
    for key in &fingerprints.empty_sources {
        upsert.execute(params![agent, KIND_EMPTY, key, ""])?;
    }
    Ok(())
}

pub(crate) fn apply(
    tx: &Transaction<'_>,
    table: &str,
    agent_col: &str,
    agent: &str,
    delta: &SourceStateDelta,
) -> Result<()> {
    if delta.reset {
        tx.execute(
            &format!("DELETE FROM {table} WHERE {agent_col}=?1"),
            [agent],
        )?;
    } else if !delta.file_removes.is_empty()
        || !delta.database_removes.is_empty()
        || !delta.empty_removes.is_empty()
    {
        let mut delete = tx.prepare_cached(&format!(
            "DELETE FROM {table} WHERE {agent_col}=?1 AND kind=?2 AND entry_key=?3"
        ))?;
        for key in &delta.file_removes {
            delete.execute(params![agent, KIND_FILE, key])?;
        }
        for key in &delta.database_removes {
            delete.execute(params![agent, KIND_DATABASE, key])?;
        }
        for key in &delta.empty_removes {
            delete.execute(params![agent, KIND_EMPTY, key])?;
        }
    }
    if !delta.file_upserts.is_empty()
        || !delta.database_upserts.is_empty()
        || !delta.empty_adds.is_empty()
    {
        let mut upsert = tx.prepare_cached(&format!(
            "INSERT INTO {table}({agent_col},kind,entry_key,fingerprint) VALUES(?1,?2,?3,?4) \
             ON CONFLICT({agent_col},kind,entry_key) DO UPDATE SET fingerprint=excluded.fingerprint \
             WHERE fingerprint<>excluded.fingerprint"
        ))?;
        for (key, fingerprint) in &delta.file_upserts {
            upsert.execute(params![agent, KIND_FILE, key, fingerprint])?;
        }
        for (key, fingerprint) in &delta.database_upserts {
            upsert.execute(params![agent, KIND_DATABASE, key, fingerprint])?;
        }
        for key in &delta.empty_adds {
            upsert.execute(params![agent, KIND_EMPTY, key, ""])?;
        }
    }
    Ok(())
}
