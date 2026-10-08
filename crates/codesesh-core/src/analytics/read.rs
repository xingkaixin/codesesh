use super::{
    CostFactsIndex, DashboardCostFacts, DashboardScope, MessageCostFact, SessionCostSummary,
    SessionModelCostFact,
};
use crate::{
    contract::{CostSource, SessionHead, SessionReference},
    query::SessionTree,
};
use rusqlite::{Connection, Row, types::Value};
use std::{collections::HashMap, sync::Arc};

fn nonnegative(row: &Row<'_>, name: &str) -> rusqlite::Result<f64> {
    Ok(row.get::<_, Option<f64>>(name)?.unwrap_or(0.0).max(0.0))
}
fn reference(row: &Row<'_>) -> rusqlite::Result<SessionReference> {
    Ok(SessionReference {
        source_node_id: row.get("source_node_id")?,
        agent_name: row.get("agent_name")?,
        session_id: row.get("session_id")?,
    })
}

// Past this many changed sessions, one full read is cheaper than reading each session.
const FULL_RELOAD_SESSIONS: usize = 256;

/// Cost facts for every visible session, kept between requests. Each refresh compares
/// `session_cost_summary.revision` and re-reads only the sessions whose facts were rewritten.
#[derive(Default)]
pub struct CostFactsCache {
    index: Arc<CostFactsIndex>,
    revisions: HashMap<SessionReference, i64>,
}

impl CostFactsCache {
    pub fn refresh(&mut self, connection: &Connection) -> rusqlite::Result<Arc<CostFactsIndex>> {
        let transaction = if connection.is_autocommit() {
            Some(connection.unchecked_transaction()?)
        } else {
            None
        };
        let current = connection
            .prepare("SELECT c.source_node_id,c.agent_name,c.session_id,c.revision FROM session_cost_summary c JOIN sessions s ON s.source_node_id=c.source_node_id AND s.agent_name=c.agent_name AND s.session_id=c.session_id AND s.publication_id IS NULL")?
            .query_map([], |row| Ok((reference(row)?, row.get::<_, i64>("revision")?)))?
            .collect::<rusqlite::Result<HashMap<_, _>>>()?;
        let changed: Vec<_> = current
            .iter()
            .filter(|(reference, revision)| self.revisions.get(*reference) != Some(*revision))
            .map(|(reference, _)| reference)
            .collect();
        let removed = self
            .revisions
            .keys()
            .any(|reference| !current.contains_key(reference));
        if !changed.is_empty() || removed {
            let index = if self.revisions.is_empty() || changed.len() > FULL_RELOAD_SESSIONS {
                CostFactsIndex::from(read_cost_facts(connection, None, None, true, None)?)
            } else {
                let mut sessions = self.index.sessions.clone();
                sessions.retain(|reference, _| current.contains_key(reference));
                for reference in &changed {
                    sessions.remove(*reference);
                }
                let references = encode_references(changed.iter().copied());
                sessions.extend(
                    CostFactsIndex::from(read_cost_facts(
                        connection,
                        None,
                        None,
                        true,
                        Some(references),
                    )?)
                    .sessions,
                );
                CostFactsIndex { sessions }
            };
            self.index = Arc::new(index);
            self.revisions = current;
        }
        if let Some(transaction) = transaction {
            transaction.commit()?;
        }
        Ok(self.index.clone())
    }
}

pub fn load_cost_facts(
    connection: &Connection,
    from: Option<f64>,
    to: Option<f64>,
    include_model_costs: bool,
) -> rusqlite::Result<DashboardCostFacts> {
    read_cost_facts(connection, from, to, include_model_costs, None)
}

pub fn load_scoped_cost_facts(
    connection: &Connection,
    sessions: &[SessionHead],
    scope: &DashboardScope,
    from: Option<f64>,
    to: Option<f64>,
    include_model_costs: bool,
) -> rusqlite::Result<DashboardCostFacts> {
    let tree = SessionTree::new(sessions);
    let references = encode_references(
        tree.entries
            .iter()
            .filter(|&&entry| scope.matches(tree.sessions[entry]))
            .flat_map(|&entry| tree.descendants(entry))
            .map(|index| &tree.sessions[index].reference),
    );
    read_cost_facts(connection, from, to, include_model_costs, Some(references))
}

pub(super) fn encode_references<'a>(
    references: impl Iterator<Item = &'a SessionReference>,
) -> String {
    let references: Vec<_> = references
        .map(|r| (&r.source_node_id, &r.agent_name, &r.session_id))
        .collect();
    serde_json::to_string(&references).expect("serializable session references")
}

pub(super) fn reference_condition(alias: &str) -> String {
    format!(
        "({alias}.source_node_id,{alias}.agent_name,{alias}.session_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?))"
    )
}

fn read_cost_facts(
    connection: &Connection,
    from: Option<f64>,
    to: Option<f64>,
    include_model_costs: bool,
    references: Option<String>,
) -> rusqlite::Result<DashboardCostFacts> {
    let transaction = if connection.is_autocommit() {
        Some(connection.unchecked_transaction()?)
    } else {
        None
    };
    let references = if let Some(references) = references {
        let covers_all = connection.query_row(
            &format!("SELECT NOT EXISTS(SELECT 1 FROM sessions s WHERE s.publication_id IS NULL AND NOT ({}))", reference_condition("s")),
            [&references],
            |row| row.get::<_, bool>(0),
        )?;
        // Complete scopes keep the covering time index instead of sorting session-index reads.
        (!covers_all).then_some(references)
    } else {
        None
    };
    let scope = references
        .as_ref()
        .map(|_| format!("WHERE {}", reference_condition("c")))
        .unwrap_or_default();
    let mut summaries=connection.prepare(&format!("SELECT c.* FROM session_cost_summary c JOIN sessions s ON s.source_node_id=c.source_node_id AND s.agent_name=c.agent_name AND s.session_id=c.session_id AND s.publication_id IS NULL {scope} ORDER BY c.agent_name,c.session_id"))?;
    let mut sessions = summaries
        .query_map(rusqlite::params_from_iter(references.iter()), |r| {
            Ok(SessionCostSummary {
                reference: reference(r)?,
                message_count: nonnegative(r, "message_count")? as usize,
                untimed_message_count: nonnegative(r, "untimed_message_count")? as usize,
                input_tokens: nonnegative(r, "input_tokens")?,
                output_tokens: nonnegative(r, "output_tokens")?,
                reasoning_tokens: nonnegative(r, "reasoning_tokens")?,
                cache_read_tokens: nonnegative(r, "cache_read_tokens")?,
                cache_create_tokens: nonnegative(r, "cache_create_tokens")?,
                untimed_input_tokens: nonnegative(r, "untimed_input_tokens")?,
                untimed_output_tokens: nonnegative(r, "untimed_output_tokens")?,
                untimed_reasoning_tokens: nonnegative(r, "untimed_reasoning_tokens")?,
                untimed_cache_read_tokens: nonnegative(r, "untimed_cache_read_tokens")?,
                untimed_cache_create_tokens: nonnegative(r, "untimed_cache_create_tokens")?,
                message_cost: r.get("message_cost")?,
                untimed_message_cost: r.get("untimed_message_cost")?,
                model_costs: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(summaries);
    if include_model_costs {
        let by_reference: HashMap<_, _> = sessions
            .iter()
            .enumerate()
            .map(|(i, s)| (s.reference.clone(), i))
            .collect();
        let scope = references
            .as_ref()
            .map(|_| format!("WHERE {}", reference_condition("m")))
            .unwrap_or_default();
        let mut models=connection.prepare(&format!("SELECT m.* FROM session_model_cost m JOIN sessions s ON s.source_node_id=m.source_node_id AND s.agent_name=m.agent_name AND s.session_id=m.session_id AND s.publication_id IS NULL {scope} ORDER BY m.agent_name,m.session_id,m.model"))?;
        for row in models.query_map(rusqlite::params_from_iter(references.iter()), |r| {
            Ok((
                reference(r)?,
                SessionModelCostFact {
                    model: r.get("model")?,
                    cost: r.get("cost")?,
                    cost_recorded: r.get("cost_recorded")?,
                },
            ))
        })? {
            let (reference, model) = row?;
            if let Some(&index) = by_reference.get(&reference) {
                sessions[index].model_costs.push(model);
            }
        }
    }
    let effective = "CASE WHEN m.time_completed > 0 THEN m.time_completed WHEN m.time_created > 0 THEN m.time_created END";
    let mut conditions = vec![format!("{effective} IS NOT NULL")];
    let mut values = Vec::new();
    let index = if let Some(references) = references {
        conditions.push(reference_condition("m"));
        values.push(Value::Text(references));
        ""
    } else {
        "INDEXED BY idx_messages_usage_time"
    };
    if let Some(from) = from {
        conditions.push(format!("{effective} >= ?"));
        values.push(Value::Real(from));
    }
    if let Some(to) = to {
        conditions.push(format!("{effective} <= ?"));
        values.push(Value::Real(to));
    }
    let mut query=connection.prepare(&format!("SELECT m.source_node_id,m.agent_name,m.session_id,{effective} AS cost_time,m.model,CAST(COALESCE(json_extract(m.tokens_json,'$.input'),0) AS INTEGER) AS input_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.output'),0) AS INTEGER) AS output_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.reasoning'),0) AS INTEGER) AS reasoning_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.cache_read'),0) AS INTEGER) AS cache_read_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.cache_create'),0) AS INTEGER) AS cache_create_tokens,m.cost,m.cost_source FROM messages m {index} JOIN sessions s ON s.source_node_id=m.source_node_id AND s.agent_name=m.agent_name AND s.session_id=m.session_id AND s.publication_id IS NULL WHERE {} ORDER BY cost_time,m.agent_name,m.session_id,m.message_index",conditions.join(" AND ")))?;
    let messages = query
        .query_map(rusqlite::params_from_iter(values), |r| {
            let model: Option<String> = r.get("model")?;
            let source: Option<String> = r.get("cost_source")?;
            Ok(MessageCostFact {
                reference: reference(r)?,
                time: r.get("cost_time")?,
                model: model.filter(|m| !m.is_empty()),
                input_tokens: nonnegative(r, "input_tokens")?,
                output_tokens: nonnegative(r, "output_tokens")?,
                reasoning_tokens: nonnegative(r, "reasoning_tokens")?,
                cache_read_tokens: nonnegative(r, "cache_read_tokens")?,
                cache_create_tokens: nonnegative(r, "cache_create_tokens")?,
                cost: r.get::<_, Option<f64>>("cost")?.unwrap_or(0.0),
                cost_source: match source.as_deref() {
                    Some("recorded") => Some(CostSource::Recorded),
                    Some("estimated") => Some(CostSource::Estimated),
                    _ => None,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    if let Some(transaction) = transaction {
        transaction.commit()?;
    }
    Ok(DashboardCostFacts { messages, sessions })
}
