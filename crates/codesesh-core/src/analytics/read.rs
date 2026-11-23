use super::{
    CostFactsIndex, DashboardCostFacts, DashboardScope, MessageCostFact, SessionCostFacts,
    SessionCostSummary, SessionModelCostFact, attribution,
};
use crate::{
    model::{CostSource, SessionHead, SessionReference},
    session_list::SessionTree,
};
use rusqlite::{Connection, Row, types::Value};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

fn nonnegative_idx(row: &Row<'_>, index: usize) -> rusqlite::Result<f64> {
    Ok(row.get::<_, Option<f64>>(index)?.unwrap_or(0.0).max(0.0))
}

fn empty_ref() -> SessionReference {
    SessionReference {
        source_node_id: String::new(),
        agent_name: String::new(),
        session_id: String::new(),
    }
}

fn reconcile_cost(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-8_f64.max(left.abs().max(right.abs()) * 1e-6)
}

fn needs_fallback_model_costs(
    summary: Option<&SessionCostSummary>,
    total_cost: f64,
    root_in_window: bool,
) -> bool {
    if !root_in_window || total_cost <= 0.0 {
        return false;
    }
    let Some(s) = summary else {
        return false;
    };
    !(s.untimed_message_cost <= 1e-8 && reconcile_cost(s.message_cost, total_cost))
}

fn read_summary_from(row: &Row<'_>, offset: usize) -> rusqlite::Result<SessionCostSummary> {
    Ok(SessionCostSummary {
        reference: empty_ref(),
        message_count: nonnegative_idx(row, offset)? as usize,
        untimed_message_count: nonnegative_idx(row, offset + 1)? as usize,
        input_tokens: nonnegative_idx(row, offset + 2)?,
        output_tokens: nonnegative_idx(row, offset + 3)?,
        reasoning_tokens: nonnegative_idx(row, offset + 4)?,
        cache_read_tokens: nonnegative_idx(row, offset + 5)?,
        cache_create_tokens: nonnegative_idx(row, offset + 6)?,
        untimed_input_tokens: nonnegative_idx(row, offset + 7)?,
        untimed_output_tokens: nonnegative_idx(row, offset + 8)?,
        untimed_reasoning_tokens: nonnegative_idx(row, offset + 9)?,
        untimed_cache_read_tokens: nonnegative_idx(row, offset + 10)?,
        untimed_cache_create_tokens: nonnegative_idx(row, offset + 11)?,
        message_cost: row.get(offset + 12)?,
        untimed_message_cost: row.get(offset + 13)?,
        model_costs: Vec::new(),
    })
}

fn parse_cost_source(raw: &str) -> Option<CostSource> {
    match raw {
        "recorded" => Some(CostSource::Recorded),
        "estimated" => Some(CostSource::Estimated),
        _ => None,
    }
}

pub fn load_scoped_cost_facts_index_refs(
    connection: &Connection,
    sessions_in: &[&SessionHead],
    scope: &DashboardScope,
    from: Option<f64>,
    to: Option<f64>,
    include_model_costs: bool,
) -> rusqlite::Result<CostFactsIndex> {
    if sessions_in.is_empty() {
        return Ok(CostFactsIndex::default());
    }
    // Maps (source_node_id, agent_name, session_id) -> (total_cost, root_in_window).
    let allowed: HashMap<(&str, &str, &str), (f64, bool)> =
        if scope.is_unfiltered() && from.is_none() && to.is_none() {
            let mut map = HashMap::with_capacity(sessions_in.len());
            for s in sessions_in {
                map.insert(
                    (
                        s.reference.source_node_id.as_str(),
                        s.reference.agent_name.as_str(),
                        s.reference.session_id.as_str(),
                    ),
                    (s.stats.total_cost.max(0.0), true),
                );
            }
            map
        } else {
            let tree = SessionTree::from_refs(sessions_in.iter().copied());
            let mut map = HashMap::with_capacity(if scope.is_unfiltered() {
                sessions_in.len()
            } else {
                sessions_in.len() / 4
            });
            for &entry in &tree.entries {
                if !scope.matches(tree.sessions[entry]) {
                    continue;
                }
                let root_in_window =
                    crate::session_list::in_window(tree.sessions[entry].time_updated, from, to);
                for idx in tree.descendants(entry) {
                    let s = tree.sessions[idx];
                    map.insert(
                        (
                            s.reference.source_node_id.as_str(),
                            s.reference.agent_name.as_str(),
                            s.reference.session_id.as_str(),
                        ),
                        (s.stats.total_cost.max(0.0), root_in_window),
                    );
                }
            }
            map
        };
    if allowed.is_empty() {
        return Ok(CostFactsIndex::default());
    }
    let transaction = if connection.is_autocommit() {
        Some(connection.unchecked_transaction()?)
    } else {
        None
    };
    trait RefParts {
        fn parts(&self) -> (&str, &str, &str);
    }
    impl RefParts for SessionReference {
        fn parts(&self) -> (&str, &str, &str) {
            (&self.source_node_id, &self.agent_name, &self.session_id)
        }
    }
    impl<'a> std::borrow::Borrow<dyn RefParts + 'a> for SessionReference {
        fn borrow(&self) -> &(dyn RefParts + 'a) {
            self
        }
    }
    impl PartialEq for dyn RefParts + '_ {
        fn eq(&self, other: &Self) -> bool {
            self.parts() == other.parts()
        }
    }
    impl Eq for dyn RefParts + '_ {}
    impl std::hash::Hash for dyn RefParts + '_ {
        fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
            self.parts().hash(state);
        }
    }
    #[derive(Clone, Copy)]
    struct BorrowedRef<'a>(&'a str, &'a str, &'a str);
    impl RefParts for BorrowedRef<'_> {
        fn parts(&self) -> (&str, &str, &str) {
            (self.0, self.1, self.2)
        }
    }

    let mut sessions =
        HashMap::<SessionReference, SessionCostFacts>::with_capacity(if from.is_some() {
            allowed.len().min(2048)
        } else {
            allowed.len()
        });
    let narrow_scope = allowed.len() <= 256;

    if narrow_scope {
        let mut summary_stmt = connection.prepare_cached(
            "SELECT message_count,untimed_message_count,\
                    input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_create_tokens,\
                    untimed_input_tokens,untimed_output_tokens,untimed_reasoning_tokens,\
                    untimed_cache_read_tokens,untimed_cache_create_tokens,message_cost,untimed_message_cost \
             FROM session_cost_summary WHERE source_node_id=?1 AND agent_name=?2 AND session_id=?3",
        )?;
        let mut model_stmt = if include_model_costs {
            Some(connection.prepare_cached(
                "SELECT model,cost,cost_recorded FROM session_model_cost \
                 WHERE source_node_id=?1 AND agent_name=?2 AND session_id=?3",
            )?)
        } else {
            None
        };
        let mut bucket_sql = String::from(if include_model_costs {
            "SELECT bucket_start,model,cost_source,message_count,\
                    input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_create_tokens,cost \
             FROM session_usage_bucket WHERE source_node_id=?1 AND agent_name=?2 AND session_id=?3"
        } else {
            "SELECT bucket_start,cost_source,message_count,\
                    input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_create_tokens,cost \
             FROM session_usage_bucket WHERE source_node_id=?1 AND agent_name=?2 AND session_id=?3"
        });
        if from.is_some() {
            bucket_sql.push_str(" AND bucket_start>=?4");
        }
        if to.is_some() {
            bucket_sql.push_str(if from.is_some() {
                " AND bucket_start<=?5"
            } else {
                " AND bucket_start<=?4"
            });
        }
        let mut bucket_stmt = connection.prepare_cached(&bucket_sql)?;

        for (&(node, agent, sid), &(total_cost, root_in_window)) in &allowed {
            let mut summary: Option<SessionCostSummary> = {
                let mut rows = summary_stmt.query(rusqlite::params![node, agent, sid])?;
                rows.next()?.map(|r| read_summary_from(r, 0)).transpose()?
            };
            if let (Some(summary), Some(model_stmt)) = (summary.as_mut(), model_stmt.as_mut())
                && needs_fallback_model_costs(Some(summary), total_cost, root_in_window)
            {
                let mut rows = model_stmt.query(rusqlite::params![node, agent, sid])?;
                while let Some(r) = rows.next()? {
                    summary.model_costs.push(SessionModelCostFact {
                        model: r.get(0)?,
                        cost: r.get(1)?,
                        cost_recorded: r.get(2)?,
                    });
                }
            }
            let mut bparams: Vec<Value> = vec![
                Value::Text(node.to_owned()),
                Value::Text(agent.to_owned()),
                Value::Text(sid.to_owned()),
            ];
            if let Some(f) = from {
                bparams.push(Value::Real(f));
            }
            if let Some(t) = to {
                bparams.push(Value::Real(t));
            }
            let mut messages = Vec::new();
            let mut brows = bucket_stmt.query(rusqlite::params_from_iter(bparams))?;
            while let Some(r) = brows.next()? {
                let (model, col) = if include_model_costs {
                    let model_str: String = r.get(1)?;
                    ((!model_str.is_empty()).then_some(model_str), 2)
                } else {
                    (None, 1)
                };
                messages.push(MessageCostFact {
                    reference: empty_ref(),
                    time: r.get(0)?,
                    message_count: r.get::<_, i64>(col + 1)? as usize,
                    model,
                    input_tokens: r.get(col + 2)?,
                    output_tokens: r.get(col + 3)?,
                    reasoning_tokens: r.get(col + 4)?,
                    cache_read_tokens: r.get(col + 5)?,
                    cache_create_tokens: r.get(col + 6)?,
                    cost: r.get(col + 7)?,
                    cost_source: parse_cost_source(r.get_ref(col)?.as_str().unwrap_or("")),
                });
            }
            if summary.is_some() || !messages.is_empty() {
                sessions.insert(
                    SessionReference {
                        source_node_id: node.to_owned(),
                        agent_name: agent.to_owned(),
                        session_id: sid.to_owned(),
                    },
                    SessionCostFacts { summary, messages },
                );
            }
        }
    } else if from.is_some() {
        // Windowed queries scan only the bounded PK range in session_usage_bucket first,
        // then fetch session_cost_summary only for sessions active in or falling back into the window.
        let mut bucket_sql = String::from(if include_model_costs {
            "SELECT bucket_start,source_node_id,agent_name,session_id,model,cost_source,\
             message_count,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,\
             cache_create_tokens,cost FROM session_usage_bucket WHERE bucket_start>=?"
        } else {
            "SELECT bucket_start,source_node_id,agent_name,session_id,cost_source,\
             message_count,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,\
             cache_create_tokens,cost FROM session_usage_bucket WHERE bucket_start>=?"
        });
        let mut bparams: Vec<Value> = vec![Value::Real(from.unwrap())];
        if let Some(t) = to {
            bucket_sql.push_str(" AND bucket_start<=?");
            bparams.push(Value::Real(t));
        }
        {
            let mut buckets = connection.prepare_cached(&bucket_sql)?;
            let mut rows = buckets.query(rusqlite::params_from_iter(bparams))?;
            while let Some(r) = rows.next()? {
                let node = r.get_ref(1)?.as_str().unwrap_or("");
                let agent = r.get_ref(2)?.as_str().unwrap_or("");
                let sid = r.get_ref(3)?.as_str().unwrap_or("");
                if !allowed.contains_key(&(node, agent, sid)) {
                    continue;
                }
                let (model, col) = if include_model_costs {
                    let model_str: String = r.get(4)?;
                    ((!model_str.is_empty()).then_some(model_str), 5)
                } else {
                    (None, 4)
                };
                let fact = MessageCostFact {
                    reference: empty_ref(),
                    time: r.get(0)?,
                    message_count: r.get::<_, i64>(col + 1)? as usize,
                    model,
                    input_tokens: r.get(col + 2)?,
                    output_tokens: r.get(col + 3)?,
                    reasoning_tokens: r.get(col + 4)?,
                    cache_read_tokens: r.get(col + 5)?,
                    cache_create_tokens: r.get(col + 6)?,
                    cost: r.get(col + 7)?,
                    cost_source: parse_cost_source(r.get_ref(col)?.as_str().unwrap_or("")),
                };
                let key = BorrowedRef(node, agent, sid);
                if let Some(entry) = sessions.get_mut(&key as &dyn RefParts) {
                    entry.messages.push(fact);
                } else {
                    sessions.insert(
                        SessionReference {
                            source_node_id: node.to_owned(),
                            agent_name: agent.to_owned(),
                            session_id: sid.to_owned(),
                        },
                        SessionCostFacts {
                            summary: None,
                            messages: vec![fact],
                        },
                    );
                }
            }
        }
        for (&(node, agent, sid), &(_, root_in_window)) in &allowed {
            if !root_in_window {
                continue;
            }
            let key = BorrowedRef(node, agent, sid);
            if !sessions.contains_key(&key as &dyn RefParts) {
                sessions.insert(
                    SessionReference {
                        source_node_id: node.to_owned(),
                        agent_name: agent.to_owned(),
                        session_id: sid.to_owned(),
                    },
                    SessionCostFacts::default(),
                );
            }
        }
        if sessions.len() <= 2048 {
            let mut summary_stmt = connection.prepare_cached(
                "SELECT message_count,untimed_message_count,\
                        input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_create_tokens,\
                        untimed_input_tokens,untimed_output_tokens,untimed_reasoning_tokens,\
                        untimed_cache_read_tokens,untimed_cache_create_tokens,message_cost,untimed_message_cost \
                 FROM session_cost_summary WHERE source_node_id=?1 AND agent_name=?2 AND session_id=?3",
            )?;
            for (reference, entry) in &mut sessions {
                let mut rows = summary_stmt.query(rusqlite::params![
                    reference.source_node_id.as_str(),
                    reference.agent_name.as_str(),
                    reference.session_id.as_str()
                ])?;
                entry.summary = rows.next()?.map(|r| read_summary_from(r, 0)).transpose()?;
            }
        } else {
            let mut summaries = connection.prepare_cached(
                "SELECT source_node_id,agent_name,session_id,message_count,untimed_message_count,\
                 input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_create_tokens,\
                 untimed_input_tokens,untimed_output_tokens,untimed_reasoning_tokens,\
                 untimed_cache_read_tokens,untimed_cache_create_tokens,message_cost,untimed_message_cost \
                 FROM session_cost_summary",
            )?;
            let mut rows = summaries.query([])?;
            while let Some(r) = rows.next()? {
                let node = r.get_ref(0)?.as_str().unwrap_or("");
                let agent = r.get_ref(1)?.as_str().unwrap_or("");
                let sid = r.get_ref(2)?.as_str().unwrap_or("");
                let key = BorrowedRef(node, agent, sid);
                if let Some(entry) = sessions.get_mut(&key as &dyn RefParts) {
                    entry.summary = Some(read_summary_from(r, 3)?);
                }
            }
        }
        if include_model_costs {
            let mut model_stmt = connection.prepare_cached(
                "SELECT model,cost,cost_recorded FROM session_model_cost \
                 WHERE source_node_id=?1 AND agent_name=?2 AND session_id=?3",
            )?;
            for (reference, entry) in &mut sessions {
                let Some(&(total_cost, root_in_window)) = allowed.get(&(
                    reference.source_node_id.as_str(),
                    reference.agent_name.as_str(),
                    reference.session_id.as_str(),
                )) else {
                    continue;
                };
                if !needs_fallback_model_costs(entry.summary.as_ref(), total_cost, root_in_window) {
                    continue;
                }
                if let Some(summary) = entry.summary.as_mut() {
                    let mut rows = model_stmt.query(rusqlite::params![
                        reference.source_node_id.as_str(),
                        reference.agent_name.as_str(),
                        reference.session_id.as_str()
                    ])?;
                    while let Some(r) = rows.next()? {
                        summary.model_costs.push(SessionModelCostFact {
                            model: r.get(0)?,
                            cost: r.get(1)?,
                            cost_recorded: r.get(2)?,
                        });
                    }
                }
            }
        }
    } else {
        {
            let mut summaries = connection.prepare_cached(
                "SELECT source_node_id,agent_name,session_id,message_count,untimed_message_count,\
                 input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_create_tokens,\
                 untimed_input_tokens,untimed_output_tokens,untimed_reasoning_tokens,\
                 untimed_cache_read_tokens,untimed_cache_create_tokens,message_cost,untimed_message_cost \
                 FROM session_cost_summary",
            )?;
            let mut rows = summaries.query([])?;
            while let Some(r) = rows.next()? {
                let node = r.get_ref(0)?.as_str().unwrap_or("");
                let agent = r.get_ref(1)?.as_str().unwrap_or("");
                let sid = r.get_ref(2)?.as_str().unwrap_or("");
                if !allowed.contains_key(&(node, agent, sid)) {
                    continue;
                }
                sessions.insert(
                    SessionReference {
                        source_node_id: node.to_owned(),
                        agent_name: agent.to_owned(),
                        session_id: sid.to_owned(),
                    },
                    SessionCostFacts {
                        summary: Some(read_summary_from(r, 3)?),
                        messages: Vec::new(),
                    },
                );
            }
        }
        if include_model_costs {
            // Only sessions whose timed bucket sum doesn't reconcile with total_cost read summary.model_costs.
            let mut model_stmt = connection.prepare_cached(
                "SELECT model,cost,cost_recorded FROM session_model_cost \
                 WHERE source_node_id=?1 AND agent_name=?2 AND session_id=?3",
            )?;
            for (reference, entry) in &mut sessions {
                let Some(&(total_cost, root_in_window)) = allowed.get(&(
                    reference.source_node_id.as_str(),
                    reference.agent_name.as_str(),
                    reference.session_id.as_str(),
                )) else {
                    continue;
                };
                if !needs_fallback_model_costs(entry.summary.as_ref(), total_cost, root_in_window) {
                    continue;
                }
                if let Some(summary) = entry.summary.as_mut() {
                    let mut rows = model_stmt.query(rusqlite::params![
                        reference.source_node_id.as_str(),
                        reference.agent_name.as_str(),
                        reference.session_id.as_str()
                    ])?;
                    while let Some(r) = rows.next()? {
                        summary.model_costs.push(SessionModelCostFact {
                            model: r.get(0)?,
                            cost: r.get(1)?,
                            cost_recorded: r.get(2)?,
                        });
                    }
                }
            }
        }
        {
            let mut bucket_sql = String::from(if include_model_costs {
                "SELECT bucket_start,source_node_id,agent_name,session_id,model,cost_source,\
                 message_count,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,\
                 cache_create_tokens,cost FROM session_usage_bucket"
            } else {
                "SELECT bucket_start,source_node_id,agent_name,session_id,cost_source,\
                 message_count,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,\
                 cache_create_tokens,cost FROM session_usage_bucket"
            });
            let mut bparams: Vec<Value> = Vec::new();
            if let Some(t) = to {
                bucket_sql.push_str(" WHERE bucket_start<=?");
                bparams.push(Value::Real(t));
            }
            let mut buckets = connection.prepare_cached(&bucket_sql)?;
            let mut rows = buckets.query(rusqlite::params_from_iter(bparams))?;
            while let Some(r) = rows.next()? {
                let node = r.get_ref(1)?.as_str().unwrap_or("");
                let agent = r.get_ref(2)?.as_str().unwrap_or("");
                let sid = r.get_ref(3)?.as_str().unwrap_or("");
                let key = BorrowedRef(node, agent, sid);
                let (model, col) = if include_model_costs {
                    let model_str: String = r.get(4)?;
                    ((!model_str.is_empty()).then_some(model_str), 5)
                } else {
                    (None, 4)
                };
                if let Some(entry) = sessions.get_mut(&key as &dyn RefParts) {
                    entry.messages.push(MessageCostFact {
                        reference: empty_ref(),
                        time: r.get(0)?,
                        message_count: r.get::<_, i64>(col + 1)? as usize,
                        model,
                        input_tokens: r.get(col + 2)?,
                        output_tokens: r.get(col + 3)?,
                        reasoning_tokens: r.get(col + 4)?,
                        cache_read_tokens: r.get(col + 5)?,
                        cache_create_tokens: r.get(col + 6)?,
                        cost: r.get(col + 7)?,
                        cost_source: parse_cost_source(r.get_ref(col)?.as_str().unwrap_or("")),
                    });
                } else if allowed.contains_key(&(node, agent, sid)) {
                    sessions.insert(
                        SessionReference {
                            source_node_id: node.to_owned(),
                            agent_name: agent.to_owned(),
                            session_id: sid.to_owned(),
                        },
                        SessionCostFacts {
                            summary: None,
                            messages: vec![MessageCostFact {
                                reference: empty_ref(),
                                time: r.get(0)?,
                                message_count: r.get::<_, i64>(col + 1)? as usize,
                                model,
                                input_tokens: r.get(col + 2)?,
                                output_tokens: r.get(col + 3)?,
                                reasoning_tokens: r.get(col + 4)?,
                                cache_read_tokens: r.get(col + 5)?,
                                cache_create_tokens: r.get(col + 6)?,
                                cost: r.get(col + 7)?,
                                cost_source: parse_cost_source(
                                    r.get_ref(col)?.as_str().unwrap_or(""),
                                ),
                            }],
                        },
                    );
                }
            }
        }
    }
    if let Some(transaction) = transaction {
        transaction.commit()?;
    }
    Ok(CostFactsIndex {
        sessions: sessions
            .into_iter()
            .map(|(reference, facts)| (reference, Arc::new(facts)))
            .collect(),
    })
}

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
    let references = if scope.is_unfiltered() {
        encode_references(sessions.iter().map(|session| &session.reference))
    } else {
        let tree = SessionTree::new(sessions);
        encode_references(
            tree.entries
                .iter()
                .filter(|&&entry| scope.matches(tree.sessions[entry]))
                .flat_map(|&entry| tree.descendants(entry))
                .map(|index| &tree.sessions[index].reference),
        )
    };
    read_cost_facts(connection, from, to, include_model_costs, Some(references))
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
    if let Some(transaction) = transaction {
        transaction.commit()?;
    }
    Ok(DashboardCostFacts { messages, sessions })
}
