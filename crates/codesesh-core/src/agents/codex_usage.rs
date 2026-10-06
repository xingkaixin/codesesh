use crate::{
    contract::{CostSource, Message, MessageTokens, Role, SessionStats},
    pricing::Pricing,
};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Default)]
pub struct Usage {
    previous_total: f64,
    previous: [f64; 4],
    input: f64,
    output: f64,
    cache_read: f64,
    cost: f64,
    models: BTreeMap<String, f64>,
    cost_inputs: Vec<crate::pricing::CostInput>,
    assigned_prefix: usize,
}

fn count(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
        .filter(|value| value.is_finite())
        .unwrap_or(0.0)
}
fn counts(value: &Value) -> [f64; 4] {
    [
        count(&value["input_tokens"]),
        count(&value["output_tokens"]),
        count(&value["reasoning_output_tokens"]),
        count(
            value
                .get("cached_input_tokens")
                .unwrap_or(&value["cache_read_input_tokens"]),
        ),
    ]
}

impl Usage {
    pub fn consume(
        &mut self,
        payload: &Value,
        model: Option<&str>,
        pricing: &Pricing,
        messages: &mut [Message],
    ) {
        let total = &payload["info"]["total_token_usage"];
        let last = &payload["info"]["last_token_usage"];
        let cumulative = count(&total["total_tokens"]);
        if cumulative > 0.0 && cumulative == self.previous_total {
            return;
        }
        let mut delta = if last.is_object() {
            counts(last)
        } else if total.is_object() && cumulative > 0.0 {
            let next = counts(total);
            std::array::from_fn(|i| next[i] - self.previous[i])
        } else {
            return;
        };
        if total.is_object() {
            self.previous = counts(total);
        }
        if cumulative > 0.0 {
            self.previous_total = cumulative;
        }
        for count in &mut delta {
            *count = count.max(0.0);
        }
        let [input, output, reasoning, cache_read] = delta;
        if delta.iter().all(|count| *count == 0.0) {
            return;
        }
        let tokens = MessageTokens {
            input: Some(input),
            output: Some(output),
            reasoning: (reasoning > 0.0).then_some(reasoning),
            cache_read: (cache_read > 0.0).then_some(cache_read),
            cache_create: None,
        };
        let cost = pricing.estimate_tracked(model, &tokens, 0.0, &mut self.cost_inputs);
        let model_tokens = input + output + reasoning;
        if model_tokens > 0.0
            && let Some(model) = model
        {
            *self.models.entry(model.into()).or_default() += model_tokens;
        }
        self.input += input;
        self.output += output + reasoning;
        self.cache_read += cache_read;
        self.cost += cost.unwrap_or(0.0);
        let mut merge_target = None;
        for index in (0..messages.len()).rev() {
            // Parsing only appends messages and this accumulator only adds tokens.
            if index < self.assigned_prefix && merge_target.is_some() {
                break;
            }
            let message = &mut messages[index];
            if message.role != Role::Assistant {
                continue;
            }
            if message.tokens.is_none() {
                message
                    .cost_inputs
                    .push(self.cost_inputs.last().unwrap().clone());
                message.tokens = Some(tokens);
                if message.model.is_none() {
                    message.model = model.map(str::to_owned);
                }
                if let Some(cost) = cost {
                    message.cost = Some(cost);
                    message.cost_source = Some(CostSource::Estimated);
                }
                return;
            }
            if merge_target.is_none() && message.model.as_deref() == model {
                merge_target = Some(index);
            }
        }
        self.assigned_prefix = messages.len();
        if let Some(index) = merge_target {
            let message = &mut messages[index];
            message
                .cost_inputs
                .push(self.cost_inputs.last().unwrap().clone());
            let base = message.tokens.as_mut().unwrap();
            for (target, extra) in [
                (&mut base.input, tokens.input),
                (&mut base.output, tokens.output),
                (&mut base.reasoning, tokens.reasoning),
                (&mut base.cache_read, tokens.cache_read),
            ] {
                if let Some(extra) = extra {
                    *target = Some(target.unwrap_or(0.0) + extra);
                }
            }
            if let Some(cost) = cost {
                message.cost = Some(message.cost.unwrap_or(0.0) + cost);
                message.cost_source.get_or_insert(CostSource::Estimated);
            }
        }
    }

    pub fn stats(&self, count: usize) -> SessionStats {
        SessionStats {
            message_count: count,
            total_input_tokens: self.input,
            total_output_tokens: self.output,
            total_cost: self.cost,
            cost_inputs: self.cost_inputs.clone(),
            cost_source: (self.cost > 0.0).then_some(CostSource::Estimated),
            total_cache_read_tokens: (self.cache_read > 0.0).then_some(self.cache_read),
            ..Default::default()
        }
    }
    pub fn models(self) -> Option<BTreeMap<String, f64>> {
        (!self.models.is_empty()).then_some(self.models)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(role: Role, model: Option<&str>) -> Message {
        serde_json::from_value(json!({
            "id":"", "role":role, "model":model, "parts":[], "time_created":0
        }))
        .unwrap()
    }

    fn consume(usage: &mut Usage, messages: &mut [Message], step: usize, model: Option<&str>) {
        usage.consume(
            &json!({"info":{
                "total_token_usage":{"total_tokens":step * 10},
                "last_token_usage":{"input_tokens":7,"output_tokens":3}
            }}),
            model,
            &Pricing::capture_only(),
            messages,
        );
    }

    #[test]
    fn unassigned_messages_take_priority_over_merging_by_model() {
        let mut usage = Usage::default();
        let mut messages = vec![
            message(Role::Assistant, Some("old")),
            message(Role::Assistant, Some("new")),
        ];
        for (index, model) in [
            "new", "new", "new", "other", "new", "missing", "new", "new", "new",
        ]
        .into_iter()
        .enumerate()
        {
            let step = index + 1;
            if step == 4 {
                messages.push(message(Role::User, None));
                messages.push(message(Role::Assistant, Some("other")));
            }
            if step == 7 {
                messages.push(message(Role::Assistant, Some("pending")));
                messages.push(message(Role::Assistant, Some("new")));
            }
            consume(&mut usage, &mut messages, step, Some(model));
        }
        assert_eq!(
            messages
                .iter()
                .map(|m| m.cost_inputs.len())
                .collect::<Vec<_>>(),
            [1, 3, 0, 1, 1, 2]
        );
        assert_eq!(messages[0].model.as_deref(), Some("old"));
        assert_eq!(messages[1].tokens.as_ref().unwrap().input, Some(21.0));
        assert_eq!(usage.stats(0).total_input_tokens, 63.0);
        messages.push(message(Role::Assistant, None));
        consume(&mut usage, &mut messages, 9, Some("new"));
        assert!(messages.last().unwrap().tokens.is_none());
        consume(&mut usage, &mut messages, 10, Some("new"));
        assert_eq!(messages.last().unwrap().cost_inputs.len(), 1);
        assert_eq!(usage.stats(0).total_input_tokens, 70.0);
    }

    #[test]
    fn late_model_assignment_is_visible_for_usage_merges() {
        let mut usage = Usage::default();
        let mut messages = vec![message(Role::Assistant, None)];
        consume(&mut usage, &mut messages, 1, None);
        consume(&mut usage, &mut messages, 2, None);
        messages[0].model = Some("late".into());
        messages.push(message(Role::User, None));
        consume(&mut usage, &mut messages, 3, None);
        assert_eq!(messages[0].cost_inputs.len(), 2);
        consume(&mut usage, &mut messages, 4, Some("late"));
        assert_eq!(messages[0].cost_inputs.len(), 3);
        assert_eq!(messages[0].tokens.as_ref().unwrap().input, Some(21.0));
        assert_eq!(usage.stats(0).total_input_tokens, 28.0);
    }
}
