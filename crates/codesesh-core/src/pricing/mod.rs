mod controller;
mod cost;
mod dependencies;
mod inputs;
mod manager;
#[cfg(test)]
pub(crate) use inputs::assert_cached_repricing;
pub use inputs::{CostInput, TokenCostBreakdown};
mod registry;
mod tier;

pub use controller::{PricingController, PricingSnapshot};
pub use cost::{PRICING_CAPTURE_EPOCH, capture_misses};
pub(crate) use dependencies::{PriceDependencies, capture_dependencies};
pub use manager::{CACHE_TTL_MS, MODELS_DEV_URL, PricingManager};
pub use registry::{Price, parse_models_dev};
pub use tier::priced_model;

use crate::contract::MessageTokens;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, LazyLock},
};

static ALIASES: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    let aliases: HashMap<String, String> =
        serde_json::from_str(include_str!("data/aliases.json")).expect("bundled pricing aliases");
    aliases
        .into_iter()
        .map(|(key, value)| (normalize(&key), normalize(&value)))
        .collect()
});

#[derive(Clone, Debug)]
pub struct Pricing {
    prices: Arc<HashMap<String, Price>>,
    generation: u64,
}

fn normalize(model: &str) -> String {
    model.trim().to_lowercase().replace('_', "-")
}
fn alias(model: &str) -> &str {
    ALIASES.get(model).map(String::as_str).unwrap_or(model)
}

fn without_date(model: &str) -> &str {
    for pattern in ["-########", "-####-##-##"] {
        if let Some(start) = model.len().checked_sub(pattern.len())
            && model.as_bytes()[start..]
                .iter()
                .zip(pattern.bytes())
                .all(|(byte, expected)| match expected {
                    b'#' => byte.is_ascii_digit(),
                    _ => *byte == expected,
                })
        {
            return &model[..start];
        }
    }
    model
}

fn drops_version(kept: &str, dropped: &str) -> bool {
    let digits = dropped.bytes().take_while(u8::is_ascii_digit).count();
    // An 8-digit date names a snapshot of the kept model, not a newer version.
    let date = digits == 8 && !dropped[8..].starts_with(|c: char| c.is_ascii_alphanumeric());
    digits > 0 && !date && kept.ends_with(|c: char| c.is_ascii_digit())
}

impl Pricing {
    pub fn capture_only() -> Self {
        Self::from_prices(HashMap::new())
    }

    pub fn bundled() -> Self {
        Self::from_prices(registry::snapshot())
    }

    fn from_prices(prices: HashMap<String, Price>) -> Self {
        let generation = registry::generation(&prices);
        Self {
            prices: Arc::new(prices),
            generation,
        }
    }

    pub fn load(home: &Path) -> Self {
        manager::read_cache(
            &crate::app_paths::root(home).join("models-dev-pricing.json"),
            false,
        )
        .unwrap_or_else(Self::bundled)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn registry(&self) -> &HashMap<String, Price> {
        &self.prices
    }

    pub fn became_available(&self, unpriced_models: &[String]) -> bool {
        unpriced_models
            .iter()
            .any(|model| self.resolve(model).is_some())
    }

    fn get(&self, model: &str) -> Option<&Price> {
        self.prices.get(model).filter(|price| price.billable())
    }

    pub fn resolve(&self, model: &str) -> Option<&Price> {
        let price = self.resolve_price(model);
        dependencies::record(model, price);
        price
    }

    fn resolve_price(&self, model: &str) -> Option<&Price> {
        let model = normalize(model);
        if let Some(price) = self.get(&model) {
            return Some(price);
        }
        let versionless = without_date(model.split('@').next().unwrap_or(""));
        let stripped = versionless.rsplit('/').next().unwrap_or(versionless);
        let mut candidates = vec![
            versionless.to_owned(),
            alias(versionless).to_owned(),
            stripped.to_owned(),
            alias(stripped).to_owned(),
        ];
        candidates.extend(
            [
                "anthropic",
                "openai",
                "openrouter/openai",
                "openrouter/anthropic",
                "moonshotai",
                "novita/moonshotai",
            ]
            .map(|prefix| format!("{prefix}/{stripped}")),
        );
        for candidate in &candidates {
            if let Some(price) = self.get(candidate).or_else(|| self.get(alias(candidate))) {
                return Some(price);
            }
        }
        for candidate in &candidates {
            for (index, character) in candidate.char_indices().rev() {
                if matches!(character, '-' | '@')
                    && !drops_version(&candidate[..index], &candidate[index + 1..])
                    && let Some(price) = self.get(&candidate[..index])
                {
                    return Some(price);
                }
            }
        }
        None
    }

    pub fn estimate(
        &self,
        model: Option<&str>,
        tokens: &MessageTokens,
        web_search: f64,
    ) -> Option<f64> {
        self.estimate_with(model, tokens, web_search, false)
    }

    fn estimate_with(
        &self,
        model: Option<&str>,
        tokens: &MessageTokens,
        web_search: f64,
        aggregate: bool,
    ) -> Option<f64> {
        let model = model.filter(|model| !model.is_empty())?;
        let (model, multiplier) = tier::split(model);
        let Some(price) = self.resolve(model) else {
            cost::record_miss(model);
            return None;
        };
        let price = if aggregate {
            price
        } else {
            price.for_request(tokens)
        };
        let positive = |value: Option<f64>| {
            value
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(0.0)
        };
        let cost = price.token_costs(tokens).total() * multiplier
            + positive(Some(web_search)) * price.web_search_cost_per_request;
        (cost > 0.0 && cost.is_finite()).then(|| round_cost(cost))
    }
}

pub(crate) fn round_cost(cost: f64) -> f64 {
    if cost >= 67_108_864.0 {
        return cost;
    }
    let bits = cost.to_bits();
    let exponent_bits = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let (mantissa, exponent) = if exponent_bits == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1_u64 << 52), exponent_bits - 1023 - 52)
    };
    if exponent >= 0 {
        return cost;
    }
    let shift = (-exponent) as u32;
    if shift >= 128 {
        return 0.0;
    }
    // JS toFixed rounds exact binary halfway values upward, unlike Rust's ties-to-even formatter.
    let scaled = u128::from(mantissa) * 100_000_000;
    let rounded = (scaled + (1_u128 << (shift - 1))) >> shift;
    rounded as f64 / 100_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cost_rounding_matches_javascript_at_binary_halfway() {
        assert_eq!(round_cost(1.0 / 512.0), 0.00195313);
        assert_eq!(round_cost(3.0 / 512.0), 0.00585938);
        assert_eq!(round_cost(1e-100), 0.0);
    }

    #[test]
    fn fallback_never_prices_a_model_as_another_version() {
        let pricing = Pricing::bundled();
        let price = |model| pricing.resolve_price(model);
        assert_eq!(price("claude-opus-4-9"), None);
        assert_eq!(price("claude-opus-4-9-thinking"), None);
        assert_eq!(price("claude-opus-4-9@eu"), None);
        assert_eq!(
            price("claude-sonnet-4-20250514-thinking"),
            price("claude-sonnet-4")
        );
        assert_eq!(price("gpt-4.1-2025-04-14"), price("gpt-4.1"));
    }

    #[test]
    fn aliases_keep_the_model_generation_price() {
        let pricing = Pricing::bundled();
        let price = |model| pricing.resolve_price(model);
        assert_eq!(price("claude-4-opus"), price("claude-opus-4"));
        assert_eq!(price("gpt-5.1-codex-high"), price("gpt-5.1-codex"));
    }

    #[test]
    fn kimi_aliases_price_the_matching_api_model() {
        let pricing = Pricing::from_prices(parse_models_dev(&serde_json::json!({
            "moonshotai":{"models":{
                "kimi-k2-0905":{"cost":{"input":0.6,"output":2.5}},
                "kimi-k2.5":{"cost":{"input":0.6,"output":3}},
                "kimi-k2.6":{"cost":{"input":0.95,"output":4}}}},
            "kimi-code-plan-global":{"models":{"kimi-for-coding":{"cost":{"input":0,"output":0}}}}
        })));
        let output = |model| pricing.resolve(model).map(|p| p.output_cost_per_token);
        assert_eq!(output("kimi-for-coding"), Some(4e-6));
        assert_eq!(output("moonshot-cn/kimi-k2.5"), Some(3e-6));
    }
}
