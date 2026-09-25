use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::normalize;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input_cost_per_token: f64,
    pub output_cost_per_token: f64,
    pub cache_create_cost_per_token: f64,
    pub cache_read_cost_per_token: f64,
    pub reasoning_cost_per_token: f64,
    pub web_search_cost_per_request: f64,
}

impl Price {
    pub fn billable(&self) -> bool {
        self.input_cost_per_token > 0.0
            || self.output_cost_per_token > 0.0
            || self.cache_create_cost_per_token > 0.0
            || self.cache_read_cost_per_token > 0.0
    }

    pub(super) fn from_cache(value: &Value) -> Option<Self> {
        let input = nonnegative(value.get("inputCostPerToken"))?;
        let output = nonnegative(value.get("outputCostPerToken"))?;
        Some(Self {
            input_cost_per_token: input,
            output_cost_per_token: output,
            cache_create_cost_per_token: nonnegative(value.get("cacheCreateCostPerToken"))
                .unwrap_or(input * 1.25),
            cache_read_cost_per_token: nonnegative(value.get("cacheReadCostPerToken"))
                .unwrap_or(input * 0.1),
            reasoning_cost_per_token: nonnegative(value.get("reasoningCostPerToken"))
                .unwrap_or(output),
            web_search_cost_per_request: nonnegative(value.get("webSearchCostPerRequest"))
                .unwrap_or(0.01),
        })
    }

    pub(super) fn json(&self) -> String {
        let mut buffer = ryu_js::Buffer::new();
        let mut output = String::from("{");
        for (index, (name, value)) in [
            ("inputCostPerToken", self.input_cost_per_token),
            ("outputCostPerToken", self.output_cost_per_token),
            ("cacheCreateCostPerToken", self.cache_create_cost_per_token),
            ("cacheReadCostPerToken", self.cache_read_cost_per_token),
            ("reasoningCostPerToken", self.reasoning_cost_per_token),
            ("webSearchCostPerRequest", self.web_search_cost_per_request),
        ]
        .into_iter()
        .enumerate()
        {
            if index > 0 {
                output.push(',');
            }
            output.push('"');
            output.push_str(name);
            output.push_str("\":");
            output.push_str(if value.is_finite() {
                buffer.format(value)
            } else {
                "null"
            });
        }
        output.push('}');
        output
    }
}

fn nonnegative(value: Option<&Value>) -> Option<f64> {
    value?
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

pub(super) fn snapshot() -> HashMap<String, Price> {
    let snapshot: serde_json::Map<String, Value> =
        serde_json::from_str(include_str!("data/snapshot.json")).expect("bundled pricing snapshot");
    let mut prices = HashMap::new();
    for (model, values) in snapshot {
        let input = values[0].as_f64().unwrap_or(0.0);
        let output = values[1].as_f64().unwrap_or(0.0);
        let price = Price {
            input_cost_per_token: input,
            output_cost_per_token: output,
            cache_create_cost_per_token: nonnegative(values.get(2)).unwrap_or(input * 1.25),
            cache_read_cost_per_token: nonnegative(values.get(3)).unwrap_or(input * 0.1),
            reasoning_cost_per_token: nonnegative(values.get(4)).unwrap_or(output),
            web_search_cost_per_request: nonnegative(values.get(5)).unwrap_or(0.01),
        };
        let model = normalize(&model);
        prices.insert(model.clone(), price.clone());
        if let Some((_, stripped)) = model.split_once('/') {
            prices.entry(stripped.to_owned()).or_insert(price);
        }
    }
    prices
}

pub(super) fn generation(prices: &HashMap<String, Price>) -> u64 {
    let mut entries: Vec<_> = prices.iter().collect();
    entries.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
    let mut hash = Sha256::new();
    for (name, price) in entries {
        hash.update(name);
        hash.update(b"\0");
        hash.update(price.json());
        hash.update(b"\n");
    }
    let digest = hash.finalize();
    let mut head = [0; 8];
    head[..7].copy_from_slice(&digest[..7]);
    (u64::from_be_bytes(head) >> 12).max(1)
}

pub fn parse_models_dev(data: &Value) -> HashMap<String, Price> {
    const ORIGINAL: &[&str] = &[
        "anthropic",
        "openai",
        "google",
        "deepseek",
        "moonshotai",
        "minimax",
        "mistral",
        "xai",
        "cohere",
        "zai",
        "zhipuai",
        "alibaba",
        "meta",
        "stepfun",
    ];
    let Some(providers) = data.as_object() else {
        return HashMap::new();
    };
    let mut providers: Vec<_> = providers.iter().collect();
    providers.sort_by(|(left, _), (right, _)| {
        ORIGINAL
            .contains(&right.as_str())
            .cmp(&ORIGINAL.contains(&left.as_str()))
            .then_with(|| crate::locale::compare(left, right))
    });
    let mut qualified = HashMap::new();
    let mut aliases = HashMap::new();
    for (provider, value) in providers {
        let Some(models) = value.get("models").and_then(Value::as_object) else {
            continue;
        };
        for (model, value) in models {
            let Some(cost) = value.get("cost").and_then(Value::as_object) else {
                continue;
            };
            let Some(input) = nonnegative(cost.get("input")).map(|value| value / 1_000_000.0)
            else {
                continue;
            };
            let Some(output) = nonnegative(cost.get("output")).map(|value| value / 1_000_000.0)
            else {
                continue;
            };
            let price = Price {
                input_cost_per_token: input,
                output_cost_per_token: output,
                cache_create_cost_per_token: nonnegative(cost.get("cache_write"))
                    .map(|value| value / 1_000_000.0)
                    .unwrap_or(input),
                cache_read_cost_per_token: nonnegative(cost.get("cache_read"))
                    .map(|value| value / 1_000_000.0)
                    .unwrap_or(input),
                reasoning_cost_per_token: output,
                web_search_cost_per_request: 0.01,
            };
            qualified.insert(normalize(&format!("{provider}/{model}")), price.clone());
            aliases.entry(normalize(model)).or_insert(price);
        }
    }
    aliases.extend(qualified);
    aliases
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn generation_matches_node_snapshot_hash() {
        assert_eq!(generation(&snapshot()), 3_454_732_389_400_122);
    }

    #[test]
    fn original_providers_win_aliases_and_qualified_prices_remain_distinct() {
        let prices = parse_models_dev(&json!({
            "gateway":{"models":{"model":{"cost":{"input":1,"output":2}}}},
            "openai":{"models":{"model":{"cost":{"input":4,"output":8}},
                "free":{"cost":{"input":0,"output":0}},
                "invalid":{"cost":{"input":-1,"output":3}},
                "partial":{"cost":{"input":1}}}}
        }));
        assert_eq!(prices["model"].input_cost_per_token, 4e-6);
        assert_eq!(prices["gateway/model"].input_cost_per_token, 1e-6);
        assert_eq!(prices["model"].cache_read_cost_per_token, 4e-6);
        assert!(prices.contains_key("free"));
        assert!(!prices["free"].billable());
        assert!(!prices.contains_key("invalid"));
        assert!(!prices.contains_key("partial"));
        assert!(parse_models_dev(&json!([])).is_empty());
        assert!(
            !Price {
                input_cost_per_token: 0.0,
                output_cost_per_token: 0.0,
                cache_create_cost_per_token: 0.0,
                cache_read_cost_per_token: 0.0,
                reasoning_cost_per_token: 1.0,
                web_search_cost_per_request: 1.0
            }
            .billable()
        );
    }
}
