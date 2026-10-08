use crate::contract::{CostSource, SessionReference};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

/// Usage of a session's timed messages that share a model and cost source; SQLite reads
/// return one fact per 15-minute bucket, with `time` at the bucket start.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCostFact {
    pub reference: SessionReference,
    pub time: f64,
    #[serde(default = "one")]
    pub message_count: usize,
    pub model: Option<String>,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub cost: f64,
    pub cost_source: Option<CostSource>,
}

fn one() -> usize {
    1
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelCostFact {
    pub model: String,
    pub cost: f64,
    pub cost_recorded: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCostSummary {
    pub reference: SessionReference,
    pub message_count: usize,
    pub untimed_message_count: usize,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub untimed_input_tokens: f64,
    pub untimed_output_tokens: f64,
    pub untimed_reasoning_tokens: f64,
    pub untimed_cache_read_tokens: f64,
    pub untimed_cache_create_tokens: f64,
    pub message_cost: f64,
    pub untimed_message_cost: f64,
    pub model_costs: Vec<SessionModelCostFact>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct DashboardCostFacts {
    pub messages: Vec<MessageCostFact>,
    pub sessions: Vec<SessionCostSummary>,
}

/// One session's cost facts, with message facts in time order.
#[derive(Clone, Debug, Default)]
pub struct SessionCostFacts {
    pub summary: Option<SessionCostSummary>,
    pub messages: Vec<MessageCostFact>,
}

impl SessionCostFacts {
    pub fn messages_in(&self, from: Option<f64>, to: f64) -> &[MessageCostFact] {
        let start = from.map_or(0, |from| self.messages.partition_point(|m| m.time < from));
        let end = self.messages.partition_point(|m| m.time <= to);
        &self.messages[start..end.max(start)]
    }
}

/// Cost facts grouped by session, as attribution reads them.
#[derive(Clone, Debug, Default)]
pub struct CostFactsIndex {
    pub sessions: HashMap<SessionReference, Arc<SessionCostFacts>>,
}

impl From<DashboardCostFacts> for CostFactsIndex {
    fn from(facts: DashboardCostFacts) -> Self {
        let mut sessions = HashMap::<SessionReference, SessionCostFacts>::new();
        for summary in facts.sessions {
            let reference = summary.reference.clone();
            sessions.entry(reference).or_default().summary = Some(summary);
        }
        // Loaded in time order; a stable grouping keeps that order within each session.
        for message in facts.messages {
            sessions
                .entry(message.reference.clone())
                .or_default()
                .messages
                .push(message);
        }
        Self {
            sessions: sessions
                .into_iter()
                .map(|(reference, facts)| (reference, Arc::new(facts)))
                .collect(),
        }
    }
}
