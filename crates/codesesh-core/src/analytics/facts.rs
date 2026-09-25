use crate::contract::{CostSource, SessionReference};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageCostFact {
    pub reference: SessionReference,
    pub time: f64,
    pub model: Option<String>,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub reasoning_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub cost: f64,
    pub cost_source: Option<CostSource>,
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
