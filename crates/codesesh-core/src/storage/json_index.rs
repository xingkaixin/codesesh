use super::{Cache, snapshot};
use crate::{
    agents::ParsedSession,
    contract::{SessionHead, SessionReference},
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;

pub struct JsonBaseline {
    pub revision: String,
    pub fingerprints: HashMap<String, String>,
    pub heads: Vec<SessionHead>,
    pub source_paths: HashMap<SessionReference, String>,
}
#[derive(Debug)]
struct Changed;
impl std::fmt::Display for Changed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("cache changed while scanning JSON index")
    }
}
impl std::error::Error for Changed {}
pub(super) struct Publication<'a> {
    pub revision: &'a str,
    pub fingerprints: &'a [(String, String)],
}
fn revision(connection: &Connection) -> Result<String> {
    Ok(connection
        .query_row(
            "SELECT value FROM cache_meta WHERE key='analytics_revision'",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or_else(|| "0".into()))
}
impl Publication<'_> {
    pub(super) fn validate(&self, connection: &Connection) -> Result<()> {
        if revision(connection)? != self.revision {
            return Err(Changed.into());
        }
        Ok(())
    }
    pub(super) fn publish(&self, connection: &Connection) -> Result<()> {
        let revision = revision(connection)?;
        for (agent, fingerprint) in self.fingerprints {
            let value = serde_json::json!({"revision":revision,"fingerprint":fingerprint});
            connection.execute("INSERT INTO cache_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![format!("rust_json_inventory:{agent}"),serde_json::to_string(&value)?])?;
        }
        Ok(())
    }
}
impl Cache {
    pub fn json_baseline(&mut self) -> Result<JsonBaseline> {
        let transaction = self.connection.transaction()?;
        let revision = revision(&transaction)?;
        let mut query = transaction
            .prepare("SELECT key,value FROM cache_meta WHERE key LIKE 'rust_json_inventory:%'")?;
        let mut fingerprints = HashMap::new();
        for row in query.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (key, value) = row?;
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&value)
                && value["revision"] == revision
                && let Some(fingerprint) = value["fingerprint"].as_str()
            {
                fingerprints.insert(
                    key.trim_start_matches("rust_json_inventory:").to_owned(),
                    fingerprint.to_owned(),
                );
            }
        }
        drop(query);
        let mut query = transaction.prepare("SELECT DISTINCT agent_name FROM pending_reindex")?;
        for agent in query.query_map([], |row| row.get::<_, String>(0))? {
            fingerprints.remove(&agent?);
        }
        drop(query);
        let mut query=transaction.prepare("SELECT * FROM sessions WHERE publication_id IS NULL ORDER BY agent_name,sort_index,rowid")?;
        let heads = query
            .query_map([], snapshot::head)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(query);
        let mut query = transaction.prepare(
            "SELECT agent_name,session_id,source_path FROM sessions WHERE publication_id IS NULL",
        )?;
        let source_paths = query
            .query_map([], |row| {
                Ok((
                    SessionReference {
                        agent_name: row.get(0)?,
                        session_id: row.get(1)?,
                    },
                    row.get(2)?,
                ))
            })?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        drop(query);
        transaction.commit()?;
        Ok(JsonBaseline {
            revision,
            fingerprints,
            heads,
            source_paths,
        })
    }
    pub fn apply_json_index(
        &mut self,
        sessions: &mut [ParsedSession],
        removed: &[SessionReference],
        fingerprints: &[(String, String)],
        revision: &str,
    ) -> Result<bool> {
        let publication = Publication {
            revision,
            fingerprints,
        };
        match self.apply_with_recovery(sessions, removed, None, Some(&publication)) {
            Ok(()) => Ok(true),
            Err(error) if error.downcast_ref::<Changed>().is_some() => Ok(false),
            Err(error) => Err(error),
        }
    }
}
