use super::Pricing;
use crate::contract::MessageTokens;
use serde::{Deserialize, Serialize};

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
