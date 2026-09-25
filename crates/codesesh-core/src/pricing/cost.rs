use std::cell::RefCell;

use super::{Pricing, round_cost};
use crate::contract::{CostSource, Message, MessageTokens, SessionStats};

pub const PRICING_CAPTURE_EPOCH: &str = "pricing-capture-v1";

thread_local! {
    static MISSES: RefCell<Vec<Vec<String>>> = const { RefCell::new(Vec::new()) };
}

struct Capture;
impl Drop for Capture {
    fn drop(&mut self) {
        MISSES.with(|misses| {
            misses.borrow_mut().pop();
        });
    }
}

pub fn capture_misses<T>(run: impl FnOnce() -> T) -> (T, Vec<String>) {
    MISSES.with(|misses| misses.borrow_mut().push(Vec::new()));
    let guard = Capture;
    let result = run();
    let misses = MISSES.with(|misses| std::mem::take(misses.borrow_mut().last_mut().unwrap()));
    drop(guard);
    (result, misses)
}

pub(super) fn record_miss(model: &str) {
    MISSES.with(|misses| {
        if let Some(capture) = misses.borrow_mut().last_mut()
            && !capture.iter().any(|existing| existing == model)
        {
            capture.push(model.to_owned());
        }
    });
}

impl Pricing {
    pub fn apply_message_cost(&self, message: &mut Message) {
        if message.cost.unwrap_or(0.0) > 0.0 {
            message.cost_source = Some(CostSource::Recorded);
            return;
        }
        if let Some(tokens) = &message.tokens
            && let Some(cost) = self.estimate(message.model.as_deref(), tokens, 0.0)
        {
            message.cost = Some(cost);
            message.cost_source = Some(CostSource::Estimated);
        }
    }

    pub fn apply_message_costs(&self, messages: &mut [Message]) -> (f64, Option<CostSource>) {
        let mut total = 0.0;
        let mut source = None;
        for message in messages {
            self.apply_message_cost(message);
            if message.cost.unwrap_or(0.0) <= 0.0 {
                continue;
            }
            total += message.cost.unwrap_or(0.0);
            if message.cost_source == Some(CostSource::Estimated) {
                source = Some(CostSource::Estimated);
            } else if source.is_none() {
                source = Some(CostSource::Recorded);
            }
        }
        (round_cost(total), source)
    }

    pub fn apply_session_cost(&self, stats: &mut SessionStats, model: Option<&str>) {
        if stats.total_cost > 0.0 {
            stats.cost_source.get_or_insert(CostSource::Recorded);
            return;
        }
        let tokens = MessageTokens {
            input: Some(stats.total_input_tokens),
            output: Some(stats.total_output_tokens),
            reasoning: None,
            cache_read: stats.total_cache_read_tokens,
            cache_create: stats.total_cache_create_tokens,
        };
        if let Some(cost) = self.estimate(model, &tokens, 0.0) {
            stats.total_cost = cost;
            stats.cost_source = Some(CostSource::Estimated);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recorded_costs_win_and_estimated_costs_set_aggregate_source() {
        let pricing = Pricing::bundled();
        let mut messages: Vec<Message> = serde_json::from_value(json!([
            {"id":"recorded","role":"assistant","time_created":0,"model":"claude-sonnet-4-6",
                "cost":3,"tokens":{"input":1_000_000},"parts":[]},
            {"id":"estimated","role":"assistant","time_created":0,"model":"claude-sonnet-4-6",
                "tokens":{"input":1_000_000},"parts":[]}
        ]))
        .unwrap();
        let expected = pricing
            .estimate(
                Some("claude-sonnet-4-6"),
                messages[1].tokens.as_ref().unwrap(),
                0.0,
            )
            .unwrap();
        let (total, source) = pricing.apply_message_costs(&mut messages);
        assert_eq!(messages[0].cost, Some(3.0));
        assert_eq!(messages[0].cost_source, Some(CostSource::Recorded));
        assert_eq!(messages[1].cost, Some(expected));
        assert_eq!(messages[1].cost_source, Some(CostSource::Estimated));
        assert_eq!(total, round_cost(3.0 + expected));
        assert_eq!(source, Some(CostSource::Estimated));
    }

    #[test]
    fn capture_is_nested_and_cleans_up_after_panics() {
        let pricing = Pricing::bundled();
        let tokens: MessageTokens = serde_json::from_value(json!({"input":1})).unwrap();
        let (_, outer) = capture_misses(|| {
            pricing.estimate(Some("absent-outer"), &tokens, 0.0);
            let (_, inner) = capture_misses(|| {
                pricing.estimate(Some("absent-inner"), &tokens, 0.0);
            });
            assert_eq!(inner, ["absent-inner"]);
            pricing.estimate(Some("absent-outer"), &tokens, 0.0);
        });
        assert_eq!(outer, ["absent-outer"]);
        let _ = std::panic::catch_unwind(|| capture_misses(|| panic!("test capture cleanup")));
        assert!(MISSES.with(|misses| misses.borrow().is_empty()));
    }
}
