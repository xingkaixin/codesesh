mod bookmarks;
mod database;
use crate::model::SessionReference;
pub use crate::wire::{BookmarkRecord, PricingOverrideKind, PricingRatePerMillion};
use anyhow::{Result, bail};
pub use bookmarks::materialize_bookmarks;
pub(crate) use database::state_directory;
use rusqlite::{Connection, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionAlias {
    pub reference: SessionReference,
    pub alias: String,
    #[ts(type = "number")]
    pub updated_at: i64,
}

const MAX_RATE_PER_MILLION: f64 = 1_000_000.0;

pub type PricingOverrideRuleKind = PricingOverrideKind;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelPriceOverrideRecord {
    pub model_key: String,
    pub display_model: String,
    pub kind: PricingOverrideRuleKind,
    pub target_model: Option<String>,
    pub rates: Option<PricingRatePerMillion>,
    pub acknowledged_official_hash: Option<String>,
    pub acknowledged_official_json: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UpsertModelPriceOverride {
    pub model_key: String,
    pub display_model: String,
    pub kind: PricingOverrideRuleKind,
    pub target_model: Option<String>,
    pub rates: Option<PricingRatePerMillion>,
}

pub struct StateStore {
    db: Connection,
    memory: bool,
}

pub(crate) fn normalize_reference(reference: &SessionReference) -> SessionReference {
    SessionReference {
        source_node_id: reference.source_node_id.clone(),
        agent_name: js_trim(&reference.agent_name).to_lowercase(),
        session_id: reference.session_id.clone(),
    }
}

pub(crate) fn reference_key(reference: &SessionReference) -> String {
    let r = normalize_reference(reference);
    if r.source_node_id == crate::model::LOCAL_SOURCE_NODE_ID {
        format!("{}/{}", r.agent_name, r.session_id)
    } else {
        format!("@{}/{}/{}", r.source_node_id, r.agent_name, r.session_id)
    }
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

pub fn normalize_session_alias(value: &str) -> Option<String> {
    let alias = js_trim(value);
    (!alias.is_empty() && alias.encode_utf16().count() <= 160).then(|| alias.to_owned())
}

pub fn parse_bookmark_reference(value: &Value) -> Option<SessionReference> {
    let parse = |agent: &Value, session: &Value, node: &Value| {
        let agent = agent.as_str()?;
        let session = session.as_str()?;
        if js_trim(agent).is_empty() || session.is_empty() {
            return None;
        }
        Some(normalize_reference(&SessionReference {
            source_node_id: match node {
                Value::Null => crate::model::local_source_node_id(),
                Value::String(node) if !node.is_empty() => node.clone(),
                _ => return None,
            },
            agent_name: agent.into(),
            session_id: session.into(),
        }))
    };
    parse(
        &value["reference"]["agentName"],
        &value["reference"]["sessionId"],
        &value["reference"]["sourceNodeId"],
    )
    .or_else(|| parse(&value["agentKey"], &value["sessionId"], &Value::Null))
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
    pub(crate) fn open(path: &Path) -> Result<Self> {
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
            "SELECT agent_name,session_id,bookmarked_at,source_node_id FROM bookmarks ORDER BY rowid"
        } else {
            "SELECT agent_name,session_id,bookmarked_at,source_node_id FROM bookmarks ORDER BY bookmarked_at DESC,agent_name ASC,session_id ASC"
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
                        serde_json::to_string(&[&r.source_node_id, &r.agent_name, &r.session_id])
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
        Ok(self.db.query_row("INSERT INTO bookmarks(source_node_id,agent_name,session_id,bookmarked_at) VALUES (?,?,?,?) ON CONFLICT(source_node_id,agent_name,session_id) DO UPDATE SET bookmarked_at=bookmarks.bookmarked_at RETURNING agent_name,session_id,bookmarked_at,source_node_id", params![r.source_node_id,r.agent_name,r.session_id,chrono::Utc::now().timestamp_millis()], bookmark_row)?)
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
            tx.execute("INSERT INTO bookmarks(source_node_id,agent_name,session_id,bookmarked_at) VALUES (?,?,?,?) ON CONFLICT(source_node_id,agent_name,session_id) DO NOTHING", params![r.source_node_id,r.agent_name,r.session_id,b.bookmarked_at])?;
        }
        tx.commit()?;
        self.list_bookmarks()
    }
    pub fn delete_bookmark(&self, reference: &SessionReference) -> Result<()> {
        let r = normalize_reference(reference);
        self.db.execute(
            "DELETE FROM bookmarks WHERE source_node_id=? AND agent_name=? AND session_id=?",
            params![r.source_node_id, r.agent_name, r.session_id],
        )?;
        Ok(())
    }
    pub fn list_aliases(&self) -> Result<Vec<SessionAlias>> {
        let sql = if self.memory {
            "SELECT agent_name,session_id,alias,updated_at,source_node_id FROM session_aliases ORDER BY rowid"
        } else {
            "SELECT agent_name,session_id,alias,updated_at,source_node_id FROM session_aliases ORDER BY updated_at DESC"
        };
        Ok(self
            .db
            .prepare(sql)?
            .query_map([], |r| {
                Ok(SessionAlias {
                    reference: normalize_reference(&SessionReference {
                        source_node_id: r.get(4)?,
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
        self.db.execute("INSERT INTO session_aliases(source_node_id,agent_name,session_id,alias,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(source_node_id,agent_name,session_id) DO UPDATE SET alias=excluded.alias,updated_at=excluded.updated_at", params![saved.reference.source_node_id,saved.reference.agent_name,saved.reference.session_id,saved.alias,saved.updated_at])?;
        Ok(saved)
    }
    pub fn delete_alias(&self, reference: &SessionReference) -> Result<()> {
        let r = normalize_reference(reference);
        self.db.execute(
            "DELETE FROM session_aliases WHERE source_node_id=? AND agent_name=? AND session_id=?",
            params![r.source_node_id, r.agent_name, r.session_id],
        )?;
        Ok(())
    }

    pub fn list_model_price_overrides(&self) -> Result<Vec<ModelPriceOverrideRecord>> {
        Ok(self
            .db
            .prepare(
                "SELECT model_key,display_model,rule_kind,target_model,input_per_1m,output_per_1m,cache_read_per_1m,cache_write_per_1m,acknowledged_official_hash,acknowledged_official_json,created_at,updated_at FROM model_price_overrides ORDER BY updated_at DESC, model_key ASC",
            )?
            .query_map([], model_price_override_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn upsert_model_price_override(
        &self,
        input: UpsertModelPriceOverride,
    ) -> Result<ModelPriceOverrideRecord> {
        let Some(model_key) = crate::pricing::normalize_override_model_key(&input.model_key) else {
            bail!("Invalid override model key");
        };
        let display_trimmed = js_trim(&input.display_model);
        let display_model = if display_trimmed.is_empty() {
            model_key.clone()
        } else {
            display_trimmed.to_owned()
        };
        let (rule_kind_str, target_model, rates) = match input.kind {
            PricingOverrideRuleKind::Remap => {
                let Some(target) = input
                    .target_model
                    .as_deref()
                    .and_then(crate::pricing::normalize_override_model_key)
                else {
                    bail!("Remap pricing override requires a valid target model");
                };
                ("remap", Some(target), None)
            }
            PricingOverrideRuleKind::Manual => {
                let Some(rates) = input.rates else {
                    bail!("Manual pricing override requires rates");
                };
                validate_rates(&rates)?;
                ("manual", None, Some(rates))
            }
        };
        let now = chrono::Utc::now().timestamp_millis();
        Ok(self.db.query_row(
            "INSERT INTO model_price_overrides(model_key,display_model,rule_kind,target_model,input_per_1m,output_per_1m,cache_read_per_1m,cache_write_per_1m,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(model_key) DO UPDATE SET display_model=excluded.display_model,rule_kind=excluded.rule_kind,target_model=excluded.target_model,input_per_1m=excluded.input_per_1m,output_per_1m=excluded.output_per_1m,cache_read_per_1m=excluded.cache_read_per_1m,cache_write_per_1m=excluded.cache_write_per_1m,updated_at=excluded.updated_at RETURNING model_key,display_model,rule_kind,target_model,input_per_1m,output_per_1m,cache_read_per_1m,cache_write_per_1m,acknowledged_official_hash,acknowledged_official_json,created_at,updated_at",
            params![
                model_key,
                display_model,
                rule_kind_str,
                target_model,
                rates.as_ref().map(|r| r.input),
                rates.as_ref().map(|r| r.output),
                rates.as_ref().map(|r| r.cache_read),
                rates.as_ref().map(|r| r.cache_write),
                now,
                now,
            ],
            model_price_override_row,
        )?)
    }

    pub fn acknowledge_official_price(
        &self,
        model_key: &str,
        official_hash: &str,
        official_json: &str,
        now: i64,
    ) -> Result<bool> {
        let Some(model_key) = crate::pricing::normalize_override_model_key(model_key) else {
            return Ok(false);
        };
        if official_hash.is_empty() {
            bail!("Missing official pricing hash");
        }
        let updated = self.db.execute(
            "UPDATE model_price_overrides SET acknowledged_official_hash=?, acknowledged_official_json=?, updated_at=? WHERE model_key=?",
            params![official_hash, official_json, now, model_key],
        )?;
        Ok(updated > 0)
    }

    pub fn delete_model_price_override(&self, model_key: &str) -> Result<bool> {
        let Some(model_key) = crate::pricing::normalize_override_model_key(model_key) else {
            return Ok(false);
        };
        let deleted = self.db.execute(
            "DELETE FROM model_price_overrides WHERE model_key=?",
            params![model_key],
        )?;
        Ok(deleted > 0)
    }
}

fn validate_rates(rates: &PricingRatePerMillion) -> Result<()> {
    for value in [
        rates.input,
        rates.output,
        rates.cache_read,
        rates.cache_write,
    ] {
        if !value.is_finite() || !(0.0..=MAX_RATE_PER_MILLION).contains(&value) {
            bail!("Pricing rate must be finite, non-negative, and at most {MAX_RATE_PER_MILLION}");
        }
    }
    Ok(())
}

fn model_price_override_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelPriceOverrideRecord> {
    let kind_str: String = row.get(2)?;
    let kind = match kind_str.as_str() {
        "remap" => PricingOverrideRuleKind::Remap,
        "manual" => PricingOverrideRuleKind::Manual,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                format!("Unknown override rule kind: {other}").into(),
            ));
        }
    };
    let rates = match kind {
        PricingOverrideRuleKind::Manual => Some(PricingRatePerMillion {
            input: row.get(4)?,
            output: row.get(5)?,
            cache_read: row.get(6)?,
            cache_write: row.get(7)?,
        }),
        PricingOverrideRuleKind::Remap => None,
    };
    Ok(ModelPriceOverrideRecord {
        model_key: row.get(0)?,
        display_model: row.get(1)?,
        kind,
        target_model: row.get(3)?,
        rates,
        acknowledged_official_hash: row.get(8)?,
        acknowledged_official_json: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}
fn bookmark_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookmarkRecord> {
    Ok(BookmarkRecord {
        reference: normalize_reference(&SessionReference {
            source_node_id: row.get(3)?,
            agent_name: row.get(0)?,
            session_id: row.get(1)?,
        }),
        bookmarked_at: row.get(2)?,
    })
}

#[cfg(test)]
mod tests;
