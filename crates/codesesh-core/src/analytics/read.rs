use super::{
    CostFactsIndex, DashboardCostFacts, DashboardScope, MessageCostFact, SessionCostSummary,
    SessionModelCostFact, attribution,
};
use crate::{
    model::{CostSource, SessionHead, SessionReference},
    session_list::SessionTree,
};
use rusqlite::{Connection, Row, types::Value};
use std::collections::{HashMap, HashSet};

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

#[cfg(test)]
pub fn load_cost_facts(
    connection: &Connection,
    from: Option<f64>,
    to: Option<f64>,
    include_model_costs: bool,
) -> rusqlite::Result<DashboardCostFacts> {
    let transaction = if connection.is_autocommit() {
        Some(connection.unchecked_transaction()?)
    } else {
        None
    };
    let facts = query_cost_facts(connection, from, to, include_model_costs, None)?;
    if let Some(transaction) = transaction {
        transaction.commit()?;
    }
    Ok(facts)
}

pub fn load_scoped_cost_facts(
    connection: &Connection,
    sessions: &[SessionHead],
    scope: &DashboardScope,
    from: Option<f64>,
    to: Option<f64>,
    include_model_costs: bool,
) -> rusqlite::Result<DashboardCostFacts> {
    if sessions.is_empty() {
        return Ok(DashboardCostFacts {
            messages: Vec::new(),
            sessions: Vec::new(),
        });
    }
    let transaction = if connection.is_autocommit() {
        Some(connection.unchecked_transaction()?)
    } else {
        None
    };
    let total_published = connection.query_row(
        "SELECT COUNT(*) FROM sessions WHERE publication_id IS NULL",
        [],
        |row| row.get::<_, i64>(0),
    )? as usize;
    let references = if scope.is_unfiltered() {
        let mut unique = Vec::with_capacity(sessions.len());
        let mut seen = HashSet::with_capacity(sessions.len());
        for session in sessions {
            if seen.insert(&session.reference) {
                unique.push(&session.reference);
            }
        }
        // Complete scopes read the bucket window in key order without serializing every reference.
        (unique.len() != total_published).then(|| encode_references(unique.into_iter()))
    } else {
        let tree = SessionTree::new(sessions);
        let selected: Vec<_> = tree
            .entries
            .iter()
            .filter(|&&entry| scope.matches(tree.sessions[entry]))
            .flat_map(|&entry| tree.descendants(entry))
            .map(|index| &tree.sessions[index].reference)
            .collect();
        if selected.is_empty() {
            if let Some(transaction) = transaction {
                transaction.commit()?;
            }
            return Ok(DashboardCostFacts {
                messages: Vec::new(),
                sessions: Vec::new(),
            });
        }
        (selected.len() != total_published).then(|| encode_references(selected.into_iter()))
    };
    let facts = query_cost_facts(connection, from, to, include_model_costs, references)?;
    if let Some(transaction) = transaction {
        transaction.commit()?;
    }
    Ok(facts)
}

pub(crate) fn model_entry_refs(
    connection: &Connection,
    sessions: &[SessionHead],
    scope: &DashboardScope,
    model: &str,
    from: Option<f64>,
    to: Option<f64>,
) -> rusqlite::Result<String> {
    let to = to.unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as f64);
    let facts = CostFactsIndex::from(load_scoped_cost_facts(
        connection,
        sessions,
        scope,
        from,
        Some(to),
        false,
    )?);
    let tree = SessionTree::new(sessions);
    let entries: HashSet<_> = attribution::contributions(&tree, scope, from, to, Some(&facts))
        .into_iter()
        .filter(|contribution| {
            contribution
                .usage
                .models
                .get(model)
                .is_some_and(|tokens| *tokens > 0.0)
        })
        .map(|contribution| contribution.entry)
        .collect();
    Ok(encode_references(
        entries
            .into_iter()
            .map(|entry| &tree.sessions[entry].reference),
    ))
}

pub(super) fn encode_references<'a>(
    references: impl Iterator<Item = &'a SessionReference>,
) -> String {
    let references: Vec<_> = references
        .map(|r| (&r.source_node_id, &r.agent_name, &r.session_id))
        .collect();
    serde_json::to_string(&references).expect("serializable session references")
}

pub(crate) fn reference_condition(alias: &str) -> String {
    format!(
        "({alias}.source_node_id,{alias}.agent_name,{alias}.session_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?))"
    )
}

fn query_cost_facts(
    connection: &Connection,
    from: Option<f64>,
    to: Option<f64>,
    include_model_costs: bool,
    references: Option<String>,
) -> rusqlite::Result<DashboardCostFacts> {
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
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    if let Some(references) = references {
        conditions.push(reference_condition("b"));
        values.push(Value::Text(references));
    }
    if let Some(from) = from {
        conditions.push("b.bucket_start >= ?".to_owned());
        values.push(Value::Real(from));
    }
    if let Some(to) = to {
        conditions.push("b.bucket_start <= ?".to_owned());
        values.push(Value::Real(to));
    }
    let filter = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };
    let mut query=connection.prepare(&format!("SELECT b.* FROM session_usage_bucket b JOIN sessions s ON s.source_node_id=b.source_node_id AND s.agent_name=b.agent_name AND s.session_id=b.session_id AND s.publication_id IS NULL {filter} ORDER BY b.bucket_start,b.source_node_id,b.agent_name,b.session_id,b.model,b.cost_source"))?;
    let messages = query
        .query_map(rusqlite::params_from_iter(values), |r| {
            let model: String = r.get("model")?;
            let source: String = r.get("cost_source")?;
            Ok(MessageCostFact {
                reference: reference(r)?,
                time: r.get("bucket_start")?,
                message_count: r.get::<_, i64>("message_count")? as usize,
                model: (!model.is_empty()).then_some(model),
                input_tokens: r.get("input_tokens")?,
                output_tokens: r.get("output_tokens")?,
                reasoning_tokens: r.get("reasoning_tokens")?,
                cache_read_tokens: r.get("cache_read_tokens")?,
                cache_create_tokens: r.get("cache_create_tokens")?,
                cost: r.get("cost")?,
                cost_source: match source.as_str() {
                    "recorded" => Some(CostSource::Recorded),
                    "estimated" => Some(CostSource::Estimated),
                    _ => None,
                },
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(query);
    Ok(DashboardCostFacts { messages, sessions })
}
