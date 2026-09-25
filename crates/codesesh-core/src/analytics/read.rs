use super::{DashboardCostFacts, MessageCostFact, SessionCostSummary, SessionModelCostFact};
use crate::contract::{CostSource, SessionReference};
use rusqlite::{Connection, Row};
use std::collections::HashMap;

fn nonnegative(row: &Row<'_>, name: &str) -> rusqlite::Result<f64> {
    Ok(row.get::<_, Option<f64>>(name)?.unwrap_or(0.0).max(0.0))
}
fn reference(row: &Row<'_>) -> rusqlite::Result<SessionReference> {
    Ok(SessionReference {
        agent_name: row.get("agent_name")?,
        session_id: row.get("session_id")?,
    })
}

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
    let mut summaries=connection.prepare("SELECT c.* FROM session_cost_summary c JOIN sessions s ON s.agent_name=c.agent_name AND s.session_id=c.session_id AND s.publication_id IS NULL ORDER BY c.agent_name,c.session_id")?;
    let mut sessions = summaries
        .query_map([], |r| {
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
        let mut models=connection.prepare("SELECT m.* FROM session_model_cost m JOIN sessions s ON s.agent_name=m.agent_name AND s.session_id=m.session_id AND s.publication_id IS NULL ORDER BY m.agent_name,m.session_id,m.model")?;
        for row in models.query_map([], |r| {
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
    if let Some(from) = from {
        conditions.push(format!("{effective} >= ?"));
        values.push(from);
    }
    if let Some(to) = to {
        conditions.push(format!("{effective} <= ?"));
        values.push(to);
    }
    let mut query=connection.prepare(&format!("SELECT m.agent_name,m.session_id,{effective} AS cost_time,m.model,CAST(COALESCE(json_extract(m.tokens_json,'$.input'),0) AS INTEGER) AS input_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.output'),0) AS INTEGER) AS output_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.reasoning'),0) AS INTEGER) AS reasoning_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.cache_read'),0) AS INTEGER) AS cache_read_tokens,CAST(COALESCE(json_extract(m.tokens_json,'$.cache_create'),0) AS INTEGER) AS cache_create_tokens,m.cost,m.cost_source FROM messages m INDEXED BY idx_messages_usage_time JOIN sessions s ON s.agent_name=m.agent_name AND s.session_id=m.session_id AND s.publication_id IS NULL WHERE {} ORDER BY cost_time,m.agent_name,m.session_id,m.message_index",conditions.join(" AND ")))?;
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
