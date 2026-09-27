use super::Pricing;
use crate::contract::MessageTokens;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, TS)]
pub struct TokenCostBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create: f64,
}

impl TokenCostBreakdown {
    pub fn total(&self) -> f64 {
        self.input + self.output + self.cache_read + self.cache_create
    }
}

impl super::Price {
    pub fn token_costs(&self, tokens: &MessageTokens) -> TokenCostBreakdown {
        let positive =
            |value: Option<f64>| value.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
        let read = positive(tokens.cache_read);
        let create = positive(tokens.cache_create);
        TokenCostBreakdown {
            input: (positive(tokens.input) - read - create).max(0.0) * self.input_cost_per_token,
            output: positive(tokens.output) * self.output_cost_per_token
                + positive(tokens.reasoning) * self.reasoning_cost_per_token,
            cache_read: read * self.cache_read_cost_per_token,
            cache_create: create * self.cache_create_cost_per_token,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct CostInput {
    #[serde(skip)]
    pub generation: u64,
    pub model: Option<String>,
    pub tokens: MessageTokens,
    pub web_search: f64,
    pub cost: Option<f64>,
}

impl Pricing {
    pub fn message_cost_breakdown(
        &self,
        message: &crate::contract::Message,
    ) -> Option<TokenCostBreakdown> {
        if message.cost_source != Some(crate::contract::CostSource::Estimated) {
            return None;
        }
        let price = self.resolve(message.model.as_deref()?)?;
        let breakdown = price.token_costs(message.tokens.as_ref()?);
        // Persisted estimates may predate the current price snapshot; never split a mismatching total.
        ((message.cost? - breakdown.total()).abs() <= 1e-8).then_some(breakdown)
    }

    pub fn estimate_tracked(
        &self,
        model: Option<&str>,
        tokens: &MessageTokens,
        web_search: f64,
        inputs: &mut Vec<CostInput>,
    ) -> Option<f64> {
        let cost = self.estimate(model, tokens, web_search);
        inputs.push(CostInput {
            generation: self.generation(),
            model: model.map(str::to_owned),
            tokens: tokens.clone(),
            web_search,
            cost,
        });
        cost
    }
}

#[cfg(test)]
pub(crate) fn assert_cached_repricing(
    scan: impl Fn(&Pricing) -> Vec<crate::agents::ParsedSession>,
) {
    use super::PricingController;
    use crate::storage::Cache;
    use serde_json::json;
    use std::collections::HashSet;

    let mut sessions = scan(&Pricing::bundled());
    let mut models = serde_json::Map::new();
    for session in &sessions {
        for input in session.head.stats.cost_inputs.iter().chain(
            session
                .detail
                .messages
                .iter()
                .flat_map(|message| &message.cost_inputs),
        ) {
            if let Some(model) = &input.model {
                models.insert(model.clone(), json!({"cost":{"input":7,"output":11,"cache_read":2,"cache_write":9,"reasoning":13}}));
            }
        }
    }
    if models.is_empty() {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let controller = PricingController::load(root.path());
    controller
        .stage_remote(&json!({"openai":{"models":models}}))
        .unwrap();
    controller.publish_pending().unwrap();
    let pricing = controller.snapshot().unwrap().pricing;
    let mut cache = Cache::open(None).unwrap();
    cache.publish(&mut sessions).unwrap();
    for agent in sessions
        .iter()
        .map(|session| session.head.reference.agent_name.as_str())
        .collect::<HashSet<_>>()
    {
        cache.reprice(agent, &pricing).unwrap();
    }
    for expected in scan(&pricing) {
        let head = cache.head(&expected.head.reference).unwrap().unwrap();
        assert!(
            (head.stats.total_cost - expected.head.stats.total_cost).abs() < 1e-8,
            "head {:?}: {} != {}",
            head.reference,
            head.stats.total_cost,
            expected.head.stats.total_cost
        );
        assert_eq!(head.stats.cost_source, expected.head.stats.cost_source);
        let detail = cache.detail(head).unwrap().unwrap();
        for (actual, expected) in detail.messages.iter().zip(&expected.detail.messages) {
            assert!(
                (actual.cost.unwrap_or(0.0) - expected.cost.unwrap_or(0.0)).abs() < 1e-8,
                "message {}: {:?} != {:?}",
                actual.id,
                actual.cost,
                expected.cost
            );
            assert_eq!(actual.cost_source, expected.cost_source);
        }
    }
}

#[cfg(test)]
mod receipt_tests {
    use super::*;
    use crate::contract::{CostSource, Message};
    #[test]
    fn receipt_split_uses_prices_without_checkpoint_and_rejects_mismatched_totals() {
        let pricing = Pricing::bundled();
        let mut message: Message = serde_json::from_value(serde_json::json!({
            "id":"receipt", "role":"assistant", "time_created":0, "parts":[],
            "model":"claude-sonnet-4-6", "tokens":{"input":1000,"output":200,"reasoning":50,"cache_read":400,"cache_create":100}
        })).unwrap();
        pricing.apply_message_cost(&mut message);
        let split = pricing.message_cost_breakdown(&message).unwrap();
        let price = pricing.resolve("claude-sonnet-4-6").unwrap();
        assert_eq!(split.input, 500.0 * price.input_cost_per_token);
        assert_eq!(
            split.output,
            200.0 * price.output_cost_per_token + 50.0 * price.reasoning_cost_per_token
        );
        assert_eq!(split.cache_read, 400.0 * price.cache_read_cost_per_token);
        assert_eq!(
            split.cache_create,
            100.0 * price.cache_create_cost_per_token
        );
        assert!((split.total() - message.cost.unwrap()).abs() < 1e-8);
        message.cost_source = Some(CostSource::Recorded);
        assert!(pricing.message_cost_breakdown(&message).is_none());
        message.cost_source = Some(CostSource::Estimated);
        message.cost = Some(123.0);
        assert!(pricing.message_cost_breakdown(&message).is_none());
    }
}
