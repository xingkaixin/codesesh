use super::{Cache, facts, snapshot};
use crate::{
    agents::ParsedSession,
    contract::{CostSource, SessionReference},
    pricing::{CostInput, Pricing},
};
use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize)]
struct CostBasis {
    cost: Option<f64>,
    source: Option<CostSource>,
    inputs: Vec<CostInput>,
    fixed_source: CostSource,
    round_total: bool,
}

impl CostBasis {
    fn reprice(&mut self, pricing: &Pricing) -> bool {
        let mut delta = 0.0;
        let previous_estimate: f64 = self.inputs.iter().filter_map(|input| input.cost).sum();
        for input in &mut self.inputs {
            let cost = pricing.estimate(input.model.as_deref(), &input.tokens, input.web_search);
            delta += cost.unwrap_or(0.0) - input.cost.unwrap_or(0.0);
            input.cost = cost;
            input.generation = pricing.generation();
        }
        if delta == 0.0 {
            return false;
        }
        let fixed = if self.round_total {
            0.0
        } else {
            self.cost.unwrap_or(0.0) - previous_estimate
        };
        let estimated: f64 = self.inputs.iter().filter_map(|input| input.cost).sum();
        let cost = if self.round_total {
            crate::pricing::round_cost(fixed + estimated)
        } else {
            fixed + estimated
        };
        self.cost = Some(cost);
        self.source = if cost <= 0.0 {
            None
        } else if estimated > 0.0 {
            Some(CostSource::Estimated)
        } else if fixed > 0.0 {
            Some(self.fixed_source.clone())
        } else {
            None
        };
        true
    }
}

#[derive(Deserialize, Serialize)]
struct PricingState {
    version: u32,
    generation: Option<u64>,
    head: CostBasis,
    messages: BTreeMap<usize, CostBasis>,
}

pub(super) fn state(session: &ParsedSession) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(PricingState {
        version: 1,
        generation: session
            .head
            .stats
            .cost_inputs
            .first()
            .or_else(|| {
                session
                    .detail
                    .messages
                    .iter()
                    .find_map(|m| m.cost_inputs.first())
            })
            .map(|input| input.generation),
        head: CostBasis {
            cost: Some(session.head.stats.total_cost),
            source: session.head.stats.cost_source.clone(),
            inputs: session.head.stats.cost_inputs.clone(),
            round_total: matches!(
                session.head.reference.agent_name.as_str(),
                "kimi" | "kimi-code"
            ),
            fixed_source: if session.detail.messages.iter().any(|message| {
                message.cost_inputs.is_empty()
                    && message.cost_source == Some(CostSource::Estimated)
                    && message.cost.unwrap_or(0.0) > 0.0
            }) {
                CostSource::Estimated
            } else {
                CostSource::Recorded
            },
        },
        messages: session
            .detail
            .messages
            .iter()
            .enumerate()
            .filter(|(_, message)| !message.cost_inputs.is_empty())
            .map(|(index, message)| {
                (
                    index,
                    CostBasis {
                        cost: message.cost,
                        source: message.cost_source.clone(),
                        inputs: message.cost_inputs.clone(),
                        fixed_source: CostSource::Recorded,
                        round_total: false,
                    },
                )
            })
            .collect(),
    })?)
}

pub(crate) fn reprice_session(session: &mut ParsedSession, pricing: &Pricing) {
    let fixed_source = if session.detail.messages.iter().any(|message| {
        message.cost_inputs.is_empty()
            && message.cost_source == Some(CostSource::Estimated)
            && message.cost.unwrap_or(0.0) > 0.0
    }) {
        CostSource::Estimated
    } else {
        CostSource::Recorded
    };
    for stats in [&mut session.head.stats, &mut session.detail.head.stats] {
        if stats
            .cost_inputs
            .iter()
            .all(|input| input.generation == pricing.generation())
        {
            continue;
        }
        let mut basis = CostBasis {
            cost: Some(stats.total_cost),
            source: stats.cost_source.clone(),
            inputs: std::mem::take(&mut stats.cost_inputs),
            fixed_source: fixed_source.clone(),
            round_total: matches!(
                session.head.reference.agent_name.as_str(),
                "kimi" | "kimi-code"
            ),
        };
        basis.reprice(pricing);
        stats.total_cost = basis.cost.unwrap_or(0.0);
        stats.cost_source = basis.source;
        stats.cost_inputs = basis.inputs;
    }
    for message in &mut session.detail.messages {
        if message
            .cost_inputs
            .iter()
            .all(|input| input.generation == pricing.generation())
        {
            continue;
        }
        let mut basis = CostBasis {
            cost: message.cost,
            source: message.cost_source.clone(),
            inputs: std::mem::take(&mut message.cost_inputs),
            fixed_source: CostSource::Recorded,
            round_total: false,
        };
        basis.reprice(pricing);
        message.cost = basis.cost;
        message.cost_source = basis.source;
        message.cost_inputs = basis.inputs;
    }
}

impl Cache {
    pub fn reprice(&mut self, agent: &str, pricing: &Pricing) -> Result<Vec<SessionReference>> {
        let transaction = self.connection.transaction()?;
        let entries = {
            let mut query = transaction.prepare("SELECT session_id FROM sessions WHERE agent_name=? AND publication_id IS NULL AND json_extract(meta_json,'$.rustPricing.version')=1 AND json_extract(meta_json,'$.rustPricing.generation')<>?")?;
            query
                .query_map(params![agent, pricing.generation() as i64], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut changed = Vec::new();
        for id in entries {
            let raw: String = transaction.query_row(
                "SELECT meta_json FROM sessions WHERE agent_name=? AND session_id=?",
                params![agent, id],
                |row| row.get(0),
            )?;
            let mut metadata: serde_json::Value = serde_json::from_str(&raw)?;
            let mut state: PricingState = serde_json::from_value(metadata["rustPricing"].clone())?;
            let mut updated = state.head.reprice(pricing);
            for (index, basis) in &mut state.messages {
                if basis.reprice(pricing) {
                    transaction.execute("UPDATE messages SET cost=?,cost_source=? WHERE agent_name=? AND session_id=? AND message_index=?", params![basis.cost,basis.source.as_ref().map(CostSource::as_str),agent,id,*index as i64])?;
                    updated = true;
                }
            }
            state.generation = Some(pricing.generation());
            if !updated {
                transaction.execute("UPDATE sessions SET meta_json=json_set(meta_json,'$.rustPricing',json(?)) WHERE agent_name=? AND session_id=?", params![serde_json::to_string(&state)?,agent,id])?;
                continue;
            }
            metadata["rustPricing"] = serde_json::to_value(&state)?;
            metadata["rustPricingRevision"] =
                (metadata["rustPricingRevision"].as_u64().unwrap_or(0) + 1).into();
            transaction.execute("UPDATE sessions SET total_cost=?,cost_source=?,meta_json=? WHERE agent_name=? AND session_id=?", params![state.head.cost.unwrap_or(0.0),state.head.source.as_ref().map(CostSource::as_str),serde_json::to_string(&metadata)?,agent,id])?;
            for table in ["session_model_cost", "session_cost_summary"] {
                transaction.execute(
                    &format!("DELETE FROM {table} WHERE agent_name=? AND session_id=?"),
                    params![agent, id],
                )?;
            }
            let reference = SessionReference {
                agent_name: agent.into(),
                session_id: id,
            };
            facts::write(&transaction, &reference, &[])?;
            let head = transaction.query_row(
                "SELECT * FROM sessions WHERE agent_name=? AND session_id=?",
                params![agent, reference.session_id],
                snapshot::head,
            )?;
            transaction.execute(
                "UPDATE session_documents SET content_hash=? WHERE agent_name=? AND session_id=?",
                params![facts::content_hash(&head)?, agent, reference.session_id],
            )?;
            changed.push(reference);
        }
        if !changed.is_empty() {
            transaction.execute("INSERT INTO cache_meta VALUES('analytics_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1", [])?;
            transaction.execute("UPDATE cache_meta SET value=json_set(value,'$.revision',(SELECT value FROM cache_meta WHERE key='analytics_revision')) WHERE key LIKE 'rust_json_inventory:%' AND json_extract(value,'$.revision')=CAST(CAST((SELECT value FROM cache_meta WHERE key='analytics_revision') AS INTEGER)-1 AS TEXT)", [])?;
        }
        transaction.commit()?;
        Ok(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{contract::MessageTokens, pricing::PricingController};
    use serde_json::json;

    #[test]
    fn repricing_preserves_content_recorded_costs_and_resets_existing_cursors() {
        let root = tempfile::tempdir().unwrap();
        let controller = PricingController::load(root.path());
        controller
            .stage_remote(
                &json!({"openai":{"models":{"reprice-model":{"cost":{"input":1,"output":2}}}}}),
            )
            .unwrap();
        controller.publish_pending().unwrap();
        let pricing = controller.snapshot().unwrap().pricing;
        let mut session = super::super::tests::source(root.path(), "pricing");
        session.detail.messages = serde_json::from_value(json!([
            {"id":"recorded","role":"assistant","time_created":1,"cost":0.75,"cost_source":"recorded","model":"reprice-model","parts":[{"type":"text","text":"Recorded body"}]},
            {"id":"estimated","role":"assistant","time_created":2,"model":"reprice-model","parts":[{"type":"text","text":"Estimated body"}]},
            {"id":"missing","role":"assistant","time_created":3,"model":"new-price-model","parts":[]},
            {"id":"upstream","role":"assistant","time_created":4,"cost":3,"cost_source":"estimated","parts":[]}
        ])).unwrap();
        let tokens = MessageTokens {
            input: Some(1_000_000.0),
            output: Some(0.0),
            reasoning: None,
            cache_read: None,
            cache_create: None,
        };
        for index in [1, 2] {
            let message = &mut session.detail.messages[index];
            message.tokens = Some(tokens.clone());
            message.cost = pricing.estimate_tracked(
                message.model.as_deref(),
                &tokens,
                0.0,
                &mut message.cost_inputs,
            );
            message.cost_source = message.cost.map(|_| CostSource::Estimated);
        }
        session.head.stats.cost_inputs = session
            .detail
            .messages
            .iter()
            .flat_map(|m| m.cost_inputs.iter().cloned())
            .collect();
        let detached = pricing
            .estimate_tracked(
                Some("reprice-model"),
                &tokens,
                0.0,
                &mut session.head.stats.cost_inputs,
            )
            .unwrap();
        session.head.stats.total_cost = 3.75 + 1.0 + detached;
        session.head.stats.cost_source = Some(CostSource::Estimated);
        let reference = session.head.reference.clone();
        let path = root.path().join("cache.db");
        let mut cache = Cache::open(Some(&path)).unwrap();
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        let before = cache
            .detail(cache.head(&reference).unwrap().unwrap())
            .unwrap()
            .unwrap();
        std::fs::remove_file(&session.source).unwrap();
        cache.connection().execute_batch("
            CREATE TRIGGER reject_body_update BEFORE UPDATE OF parts_json,content_text,tokens_json ON messages BEGIN SELECT RAISE(ABORT,'body rewrite'); END;
            CREATE TRIGGER reject_body_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'body insert'); END;
            CREATE TRIGGER reject_body_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'body delete'); END;
            CREATE TRIGGER reject_search_update BEFORE UPDATE OF title,content_text ON session_documents BEGIN SELECT RAISE(ABORT,'search rewrite'); END;
        ").unwrap();
        controller
            .stage_remote(&json!({"openai":{"models":{
                "reprice-model":{"cost":{"input":2,"output":2}},
                "new-price-model":{"cost":{"input":4,"output":2}}
            }}}))
            .unwrap();
        controller.publish_pending().unwrap();
        let pricing = controller.snapshot().unwrap().pricing;
        assert_eq!(
            cache.reprice("codex", &pricing).unwrap(),
            std::slice::from_ref(&reference)
        );
        let head = cache.head(&reference).unwrap().unwrap();
        assert_eq!(head.stats.total_cost, 11.75);
        let after = super::super::detail_with_cursor(
            cache.connection(),
            head.clone(),
            before.message_cursor.as_deref(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(after.message_update.as_deref(), Some("reset"));
        assert_eq!(after.messages[0].cost, Some(0.75));
        assert_eq!(after.messages[0].cost_source, Some(CostSource::Recorded));
        assert_eq!(after.messages[1].cost, Some(2.0));
        assert_eq!(after.messages[2].cost, Some(4.0));
        assert_eq!(after.messages[3].cost, Some(3.0));
        for (old, new) in before.messages.iter().zip(&after.messages) {
            assert_eq!(old.parts, new.parts);
            assert_eq!(old.tokens, new.tokens);
        }
        let summary: f64 = cache
            .connection()
            .query_row(
                "SELECT message_cost FROM session_cost_summary WHERE session_id=?",
                [&reference.session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(summary, 9.75);
        let unchanged = super::super::detail_with_cursor(
            cache.connection(),
            head,
            after.message_cursor.as_deref(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(unchanged.message_update.as_deref(), Some("append"));
        assert!(unchanged.messages.is_empty());
        let revision: String = cache
            .connection()
            .query_row(
                "SELECT value FROM cache_meta WHERE key='analytics_revision'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(cache.reprice("codex", &pricing).unwrap().is_empty());
        assert_eq!(
            revision,
            cache
                .connection()
                .query_row::<String, _, _>(
                    "SELECT value FROM cache_meta WHERE key='analytics_revision'",
                    [],
                    |row| row.get(0)
                )
                .unwrap()
        );
        drop(cache);
        let mut cache = Cache::open(Some(&path)).unwrap();
        controller
            .stage_remote(
                &json!({"openai":{"models":{"irrelevant":{"cost":{"input":9,"output":9}}}}}),
            )
            .unwrap();
        controller.publish_pending().unwrap();
        cache
            .reprice("codex", &controller.snapshot().unwrap().pricing)
            .unwrap();
        let head = cache.head(&reference).unwrap().unwrap();
        assert_eq!(head.stats.total_cost, 3.75);
        assert_eq!(head.stats.cost_source, Some(CostSource::Estimated));
    }

    #[test]
    fn failed_cost_publication_rolls_back_costs_and_revision() {
        let root = tempfile::tempdir().unwrap();
        let mut session = super::super::tests::source(root.path(), "rollback-pricing");
        let pricing = Pricing::bundled();
        let tokens: MessageTokens = serde_json::from_value(json!({"input":1_000_000})).unwrap();
        session.head.stats.total_cost = pricing
            .estimate_tracked(
                Some("gpt-4o"),
                &tokens,
                0.0,
                &mut session.head.stats.cost_inputs,
            )
            .unwrap();
        let mut cache = Cache::open(None).unwrap();
        cache.publish(std::slice::from_mut(&mut session)).unwrap();
        cache.connection().execute_batch("CREATE TRIGGER reject_cost BEFORE UPDATE OF total_cost ON sessions BEGIN SELECT RAISE(ABORT,'cost failure'); END;").unwrap();
        let controller = PricingController::load(root.path());
        controller
            .stage_remote(
                &json!({"openai":{"models":{"gpt-4o":{"cost":{"input":123,"output":8}}}}}),
            )
            .unwrap();
        controller.publish_pending().unwrap();
        assert!(
            cache
                .reprice("codex", &controller.snapshot().unwrap().pricing)
                .is_err()
        );
        assert_eq!(
            cache
                .head(&session.head.reference)
                .unwrap()
                .unwrap()
                .stats
                .total_cost,
            session.head.stats.total_cost
        );
    }
}
