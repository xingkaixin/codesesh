use crate::contract::MessageTokens;
use serde::Deserialize;
use std::{collections::HashMap, path::Path, sync::LazyLock};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Price {
    input_cost_per_token: f64,
    output_cost_per_token: f64,
    cache_create_cost_per_token: Option<f64>,
    cache_read_cost_per_token: Option<f64>,
    reasoning_cost_per_token: Option<f64>,
    web_search_cost_per_request: Option<f64>,
}

impl Price {
    fn billable(&self) -> bool {
        [
            self.input_cost_per_token,
            self.output_cost_per_token,
            self.cache_create_cost_per_token.unwrap_or(0.0),
            self.cache_read_cost_per_token.unwrap_or(0.0),
            self.reasoning_cost_per_token.unwrap_or(0.0),
        ]
        .iter()
        .any(|value| value.is_finite() && *value > 0.0)
    }
}

static ALIASES: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../packages/core/src/pricing/data/aliases.json"
    ))
    .expect("bundled pricing aliases")
});

pub struct Pricing {
    prices: HashMap<String, Price>,
}

fn normalize(model: &str) -> String {
    model.trim().to_lowercase().replace('_', "-")
}
fn alias(model: &str) -> &str {
    ALIASES.get(model).map(String::as_str).unwrap_or(model)
}

impl Pricing {
    pub fn bundled() -> Self {
        let snapshot: HashMap<String, Vec<Option<f64>>> = serde_json::from_str(include_str!(
            "../../../../packages/core/src/pricing/data/snapshot.json"
        ))
        .expect("bundled pricing snapshot");
        let prices = snapshot
            .into_iter()
            .map(|(model, values)| {
                (
                    normalize(&model),
                    Price {
                        input_cost_per_token: values[0].unwrap_or(0.0),
                        output_cost_per_token: values[1].unwrap_or(0.0),
                        cache_create_cost_per_token: values.get(2).copied().flatten(),
                        cache_read_cost_per_token: values.get(3).copied().flatten(),
                        reasoning_cost_per_token: None,
                        web_search_cost_per_request: None,
                    },
                )
            })
            .collect();
        Self { prices }
    }

    pub fn load(home: &Path) -> Self {
        let mut pricing = Self::bundled();
        let path = home.join(".cache/codesesh/models-dev-pricing.json");
        #[derive(Deserialize)]
        struct Cache {
            data: HashMap<String, Price>,
        }
        if let Ok(bytes) = std::fs::read(path)
            && let Ok(cache) = serde_json::from_slice::<Cache>(&bytes)
        {
            for (model, price) in cache.data {
                if price.billable() {
                    pricing.prices.insert(normalize(&model), price);
                }
            }
        }
        pricing
    }

    fn get(&self, model: &str) -> Option<&Price> {
        self.prices.get(model).filter(|price| price.billable())
    }

    fn resolve(&self, model: &str) -> Option<&Price> {
        let model = normalize(model);
        if let Some(price) = self.get(&model) {
            return Some(price);
        }
        let mut versionless = model.split('@').next().unwrap_or("");
        if let Some((base, suffix)) = versionless.rsplit_once('-')
            && suffix.len() == 8
            && suffix.bytes().all(|byte| byte.is_ascii_digit())
        {
            versionless = base;
        }
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
        let price = self.resolve(model?)?;
        let positive = |value: Option<f64>| {
            value
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(0.0)
        };
        let read = positive(tokens.cache_read);
        let create = positive(tokens.cache_create);
        let input = (positive(tokens.input) - read - create).max(0.0);
        let cost = input * price.input_cost_per_token
            + positive(tokens.output) * price.output_cost_per_token
            + positive(tokens.reasoning)
                * price
                    .reasoning_cost_per_token
                    .unwrap_or(price.output_cost_per_token)
            + read
                * price
                    .cache_read_cost_per_token
                    .unwrap_or(price.input_cost_per_token * 0.1)
            + create
                * price
                    .cache_create_cost_per_token
                    .unwrap_or(price.input_cost_per_token * 1.25)
            + positive(Some(web_search)) * price.web_search_cost_per_request.unwrap_or(0.01);
        (cost > 0.0 && cost.is_finite()).then(|| round_cost(cost))
    }
}

fn round_cost(cost: f64) -> f64 {
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
}
