use super::{DashboardCostFacts, DashboardScope, SessionModelCostFact};
use crate::{
    contract::CostSource,
    query::{SessionTree, in_window},
};
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
pub struct Usage {
    pub messages: usize,
    pub tokens: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create: f64,
    pub models: BTreeMap<String, f64>,
}

pub struct Contribution {
    pub entry: usize,
    pub time: f64,
    pub usage: Usage,
    pub has_usage: bool,
    pub cost: f64,
    pub source: CostSource,
    pub model_costs: Vec<SessionModelCostFact>,
}

fn reconcile(left: f64, right: f64) -> bool {
    (left - right).abs() <= 1e-8_f64.max(left.abs().max(right.abs()) * 1e-6)
}

pub fn contributions(
    tree: &SessionTree<'_>,
    scope: &DashboardScope,
    from: Option<f64>,
    to: f64,
    facts: Option<&DashboardCostFacts>,
) -> Vec<Contribution> {
    let summaries: HashMap<_, _> = facts
        .into_iter()
        .flat_map(|f| &f.sessions)
        .map(|s| (&s.reference, s))
        .collect();
    let mut messages = HashMap::<_, Vec<_>>::new();
    for message in facts.into_iter().flat_map(|f| &f.messages) {
        messages
            .entry(&message.reference)
            .or_default()
            .push(message);
    }
    let mut output = Vec::new();
    for &entry in &tree.entries {
        if !scope.matches(tree.sessions[entry]) {
            continue;
        }
        let fallback = tree.sessions[entry].time_updated;
        for index in tree.descendants(entry) {
            let session = tree.sessions[index];
            let stats = &session.stats;
            let summary = summaries.get(&session.reference).copied();
            let source = stats.cost_source.clone().unwrap_or(CostSource::Recorded);
            let total = stats.total_cost.max(0.0);
            let detailed_cost = total > 0.0
                && summary.is_some_and(|s| {
                    s.untimed_message_cost <= 1e-8 && reconcile(s.message_cost, total)
                });
            let detailed_messages = summary.is_some_and(|s| {
                s.untimed_message_count == 0 && s.message_count == stats.message_count
            });
            let input = stats.total_input_tokens.max(0.0);
            let out = stats.total_output_tokens.max(0.0);
            let tokens = stats.total_tokens.unwrap_or(input + out).max(0.0);
            let cache_read = stats.total_cache_read_tokens.unwrap_or(0.0).max(0.0);
            let cache_create = stats.total_cache_create_tokens.unwrap_or(0.0).max(0.0);
            let reasoning = summary.and_then(|s| {
                let matches = s.output_tokens == out;
                let with_reasoning = s.output_tokens + s.reasoning_tokens == out;
                if !(matches || with_reasoning)
                    || s.input_tokens != input
                    || s.cache_read_tokens != cache_read
                    || s.cache_create_tokens != cache_create
                    || s.input_tokens + out != tokens
                    || s.untimed_input_tokens > 0.0
                    || s.untimed_output_tokens > 0.0
                    || s.untimed_reasoning_tokens > 0.0
                    || s.untimed_cache_read_tokens > 0.0
                    || s.untimed_cache_create_tokens > 0.0
                {
                    None
                } else {
                    Some(!matches && with_reasoning)
                }
            });
            for message in messages.get(&session.reference).into_iter().flatten() {
                if !in_window(message.time, from, Some(to)) {
                    continue;
                }
                let message_source = message
                    .cost_source
                    .clone()
                    .unwrap_or_else(|| source.clone());
                let mut usage = Usage::default();
                if detailed_messages {
                    usage.messages = 1;
                }
                if let Some(includes_reasoning) = reasoning {
                    usage.input = message.input_tokens;
                    usage.output = message.output_tokens
                        + if includes_reasoning {
                            message.reasoning_tokens
                        } else {
                            0.0
                        };
                    usage.tokens = usage.input + usage.output;
                    usage.cache_read = message.cache_read_tokens;
                    usage.cache_create = message.cache_create_tokens;
                    if let Some(model) = &message.model {
                        usage.models.insert(model.clone(), usage.tokens);
                    }
                }
                let cost = if detailed_cost {
                    message.cost.max(0.0)
                } else {
                    0.0
                };
                let model_costs = message
                    .model
                    .as_ref()
                    .filter(|_| cost > 0.0)
                    .map(|model| {
                        vec![SessionModelCostFact {
                            model: model.clone(),
                            cost,
                            cost_recorded: if message_source == CostSource::Recorded {
                                cost
                            } else {
                                0.0
                            },
                        }]
                    })
                    .unwrap_or_default();
                output.push(Contribution {
                    entry,
                    time: message.time,
                    has_usage: detailed_messages || reasoning.is_some(),
                    usage,
                    cost,
                    source: message_source,
                    model_costs,
                });
            }
            if !in_window(fallback, from, Some(to)) {
                continue;
            }
            let mut usage = Usage::default();
            if !detailed_messages {
                usage.messages = stats.message_count;
            }
            if reasoning.is_none() {
                usage.input = input;
                usage.output = out;
                usage.tokens = tokens;
                usage.cache_read = cache_read;
                usage.cache_create = cache_create;
                if let Some(models) = &session.model_usage
                    && models.values().sum::<f64>() <= tokens
                {
                    usage.models = models.clone();
                }
            }
            let cost = if detailed_cost { 0.0 } else { total };
            let model_costs = if cost > 0.0 {
                summary
                    .filter(|s| {
                        let sum = s.model_costs.iter().map(|m| m.cost).sum::<f64>();
                        sum <= total || reconcile(sum, total)
                    })
                    .map(|s| s.model_costs.clone())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            output.push(Contribution {
                entry,
                time: fallback,
                has_usage: !detailed_messages || reasoning.is_none(),
                usage,
                cost,
                source,
                model_costs,
            });
        }
    }
    output
}
