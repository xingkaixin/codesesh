mod database;
use crate::contract::SessionReference;
use anyhow::{Result, bail};
pub use database::state_directory;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkRecord {
    pub reference: SessionReference,
    pub bookmarked_at: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionAlias {
    pub reference: SessionReference,
    pub alias: String,
    #[ts(type = "number")]
    pub updated_at: i64,
}

pub struct StateStore {
    db: Connection,
    memory: bool,
}

pub fn normalize_reference(reference: &SessionReference) -> SessionReference {
    SessionReference {
        agent_name: js_trim(&reference.agent_name).to_lowercase(),
        session_id: reference.session_id.clone(),
    }
}

pub fn reference_key(reference: &SessionReference) -> String {
    let r = normalize_reference(reference);
    format!("{}/{}", r.agent_name, r.session_id)
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

pub fn normalize_session_alias(value: &str) -> Option<String> {
    let alias = js_trim(value);
    (!alias.is_empty() && alias.encode_utf16().count() <= 160).then(|| alias.to_owned())
}

pub fn parse_bookmark_reference(value: &Value) -> Option<SessionReference> {
    let parse = |agent: &Value, session: &Value| {
        let agent = agent.as_str()?;
        let session = session.as_str()?;
        if js_trim(agent).is_empty() || session.is_empty() {
            return None;
        }
        Some(normalize_reference(&SessionReference {
            agent_name: agent.into(),
            session_id: session.into(),
        }))
    };
    parse(
        &value["reference"]["agentName"],
        &value["reference"]["sessionId"],
    )
    .or_else(|| parse(&value["agentKey"], &value["sessionId"]))
}

pub fn parse_bookmark_import(value: &Value, now: i64) -> Option<BookmarkRecord> {
    let reference = parse_bookmark_reference(value)?;
    let timestamp = value
        .get("bookmarkedAt")
        .filter(|v| !v.is_null())
        .or_else(|| value.get("bookmarked_at").filter(|v| !v.is_null()));
    let bookmarked_at = match timestamp {
        Some(v) => v.as_f64()?,
        None => now as f64,
    };
    bookmarked_at.is_finite().then_some(BookmarkRecord {
        reference,
        bookmarked_at,
    })
}

impl StateStore {
    pub fn open(path: &Path) -> Result<Self> {
        Ok(Self {
            db: database::open(Some(path))?,
            memory: false,
        })
    }
    pub fn memory() -> Result<Self> {
        Ok(Self {
            db: database::open(None)?,
            memory: true,
        })
    }
    pub fn from_environment(home: &Path) -> Result<Self> {
        if std::env::var("CODESESH_STATE_STORE").as_deref() == Ok("memory") {
            return Self::memory();
        }
        Self::open(
            &state_directory(home, std::env::consts::OS, |key| std::env::var(key).ok())
                .join("state.db"),
        )
    }
    pub fn list_bookmarks(&self) -> Result<Vec<BookmarkRecord>> {
        let sql = if self.memory {
            "SELECT agent_name,session_id,bookmarked_at FROM bookmarks ORDER BY rowid"
        } else {
            "SELECT agent_name,session_id,bookmarked_at FROM bookmarks ORDER BY bookmarked_at DESC,agent_name ASC,session_id ASC"
        };
        let mut bookmarks: Vec<BookmarkRecord> = self
            .db
            .prepare(sql)?
            .query_map([], bookmark_row)?
            .collect::<rusqlite::Result<_>>()?;
        if self.memory {
            bookmarks.sort_by(|a, b| {
                b.bookmarked_at.total_cmp(&a.bookmarked_at).then_with(|| {
                    let key = |r: &SessionReference| {
                        serde_json::to_string(&[&r.agent_name, &r.session_id])
                            .expect("string array serialization")
                    };
                    crate::locale::compare(&key(&a.reference), &key(&b.reference))
                })
            });
        }
        Ok(bookmarks)
    }
    pub fn upsert_bookmark(&self, reference: &SessionReference) -> Result<BookmarkRecord> {
        let r = normalize_reference(reference);
        Ok(self.db.query_row("INSERT INTO bookmarks(agent_name,session_id,bookmarked_at) VALUES (?,?,?) ON CONFLICT(agent_name,session_id) DO UPDATE SET bookmarked_at=bookmarks.bookmarked_at RETURNING agent_name,session_id,bookmarked_at", params![r.agent_name,r.session_id,chrono::Utc::now().timestamp_millis()], bookmark_row)?)
    }
    pub fn import_bookmarks(
        &mut self,
        bookmarks: &[BookmarkRecord],
    ) -> Result<Vec<BookmarkRecord>> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for b in bookmarks {
            let r = normalize_reference(&b.reference);
            tx.execute("INSERT INTO bookmarks(agent_name,session_id,bookmarked_at) VALUES (?,?,?) ON CONFLICT(agent_name,session_id) DO NOTHING", params![r.agent_name,r.session_id,b.bookmarked_at])?;
        }
        tx.commit()?;
        self.list_bookmarks()
    }
    pub fn delete_bookmark(&self, reference: &SessionReference) -> Result<()> {
        let r = normalize_reference(reference);
        self.db.execute(
            "DELETE FROM bookmarks WHERE agent_name=? AND session_id=?",
            params![r.agent_name, r.session_id],
        )?;
        Ok(())
    }
    pub fn list_aliases(&self) -> Result<Vec<SessionAlias>> {
        let sql = if self.memory {
            "SELECT agent_name,session_id,alias,updated_at FROM session_aliases ORDER BY rowid"
        } else {
            "SELECT agent_name,session_id,alias,updated_at FROM session_aliases ORDER BY updated_at DESC"
        };
        Ok(self
            .db
            .prepare(sql)?
            .query_map([], |r| {
                Ok(SessionAlias {
                    reference: normalize_reference(&SessionReference {
                        agent_name: r.get(0)?,
                        session_id: r.get(1)?,
                    }),
                    alias: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn upsert_alias(&self, reference: &SessionReference, alias: &str) -> Result<SessionAlias> {
        let Some(alias) = normalize_session_alias(alias) else {
            bail!("Invalid session alias");
        };
        let saved = SessionAlias {
            reference: normalize_reference(reference),
            alias,
            updated_at: chrono::Utc::now().timestamp_millis(),
        };
        self.db.execute("INSERT INTO session_aliases(agent_name,session_id,alias,updated_at) VALUES (?,?,?,?) ON CONFLICT(agent_name,session_id) DO UPDATE SET alias=excluded.alias,updated_at=excluded.updated_at", params![saved.reference.agent_name,saved.reference.session_id,saved.alias,saved.updated_at])?;
        Ok(saved)
    }
    pub fn delete_alias(&self, reference: &SessionReference) -> Result<()> {
        let r = normalize_reference(reference);
        self.db.execute(
            "DELETE FROM session_aliases WHERE agent_name=? AND session_id=?",
            params![r.agent_name, r.session_id],
        )?;
        Ok(())
    }
}
fn bookmark_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookmarkRecord> {
    Ok(BookmarkRecord {
        reference: normalize_reference(&SessionReference {
            agent_name: row.get(0)?,
            session_id: row.get(1)?,
        }),
        bookmarked_at: row.get(2)?,
    })
}

#[cfg(test)]
mod tests;
