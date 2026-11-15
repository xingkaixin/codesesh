mod controller;
mod cost;
mod dependencies;
mod inputs;
mod manager;
#[cfg(test)]
pub(crate) use inputs::assert_cached_repricing;
pub(crate) use inputs::{CostInput, TokenCostBreakdown};
mod registry;
mod tier;

pub use controller::PricingController;
pub use controller::PricingSnapshot;
pub(crate) use dependencies::{PriceDependencies, capture_dependencies};
pub use manager::MODELS_DEV_URL;
pub(crate) use manager::PricingManager;
pub(crate) use registry::Price;
pub(crate) use tier::priced_model;

use crate::{
    model::MessageTokens,
    state::ModelPriceOverrideRecord,
    wire::{
        ModelPriceOverrideView, OfficialModelListResponse, OfficialModelOption,
        PricingOverrideKind, PricingRatePerMillion,
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fmt::Write,
    path::Path,
    sync::{Arc, LazyLock},
};

static ALIASES: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    let aliases: HashMap<String, String> =
        serde_json::from_str(include_str!("pricing/data/aliases.json"))
            .expect("bundled pricing aliases");
    aliases
        .into_iter()
        .map(|(key, value)| (normalize(&key), normalize(&value)))
        .collect()
});

#[derive(Clone, Debug)]
pub struct Pricing {
    official: Arc<HashMap<String, Price>>,
    overrides: Arc<HashMap<String, ResolvedPrice>>,
    generation: u64,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize, PartialEq)]
pub(crate) struct ResolvedPrice {
    #[serde(flatten)]
    price: Price,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    target_model: Option<String>,
}

fn normalize(model: &str) -> String {
    model.trim().to_lowercase().replace('_', "-")
}

pub fn normalize_override_model_key(raw: &str) -> Option<String> {
    let trimmed = crate::state::js_trim(raw);
    let (base, _) = tier::split(trimmed);
    let key = normalize(crate::state::js_trim(base));
    (!key.is_empty() && key.encode_utf16().count() <= 256).then_some(key)
}

pub(crate) fn strip_service_tier(raw: &str) -> &str {
    crate::state::js_trim(tier::split(crate::state::js_trim(raw)).0)
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
    pub(crate) fn capture_only() -> Self {
        Self::from_prices(HashMap::new())
    }

    pub fn bundled() -> Self {
        Self::from_prices(registry::snapshot())
    }

    fn from_prices(official: HashMap<String, Price>) -> Self {
        Self::from_official_and_overrides(official, &[])
    }

    pub fn from_official_and_overrides(
        official: HashMap<String, Price>,
        override_records: &[ModelPriceOverrideRecord],
    ) -> Self {
        let overrides = compile_overrides(&official, override_records);
        let generation = registry::generation_with_overrides(&official, &overrides);
        Self {
            official: Arc::new(official),
            overrides: Arc::new(overrides),
            generation,
        }
    }

    pub(crate) fn with_overrides(&self, override_records: &[ModelPriceOverrideRecord]) -> Self {
        let overrides = compile_overrides(&self.official, override_records);
        let generation = registry::generation_with_overrides(&self.official, &overrides);
        Self {
            official: Arc::clone(&self.official),
            overrides: Arc::new(overrides),
            generation,
        }
    }

    pub fn load(home: &Path) -> Self {
        Self::load_with_overrides(home, &[])
    }

    pub fn load_with_overrides(home: &Path, override_records: &[ModelPriceOverrideRecord]) -> Self {
        let official = manager::read_cache_prices(
            &crate::app_paths::root(home).join("models-dev-pricing.json"),
            false,
        )
        .unwrap_or_else(registry::snapshot);
        Self::from_official_and_overrides(official, override_records)
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    fn resolve_override(&self, model: &str) -> Option<&ResolvedPrice> {
        let key = normalize_override_model_key(model)?;
        self.overrides.get(&key)
    }

    fn resolve_entry(&self, model: &str) -> Option<(&Price, Option<&str>)> {
        if let Some(entry) = self.resolve_override(model) {
            return Some((&entry.price, entry.target_model.as_deref()));
        }
        official_resolve_price_in(&self.official, model).map(|price| (price, None))
    }

    fn resolve_dependency(&self, model: &str) -> Option<ResolvedPrice> {
        self.resolve_entry(model)
            .map(|(price, target_model)| ResolvedPrice {
                price: price.clone(),
                target_model: target_model.map(str::to_owned),
            })
    }

    pub fn resolve(&self, model: &str) -> Option<&Price> {
        dependencies::record(model, || self.resolve_dependency(model));
        self.resolve_entry(model).map(|(price, _)| price)
    }

    pub(crate) fn official_price(&self, model: &str) -> Option<&Price> {
        let (base, _) = tier::split(crate::state::js_trim(model));
        official_resolve_price_in(&self.official, base)
    }

    pub fn official_price_hash_and_json(&self, model: &str) -> Option<(String, String)> {
        let price = self.official_price(model)?;
        let json = price.json();
        let digest = Sha256::digest(json.as_bytes());
        let mut hex = String::with_capacity(64);
        for byte in digest {
            let _ = write!(hex, "{byte:02x}");
        }
        Some((hex, json))
    }

    pub fn list_official_models(
        &self,
        query: Option<&str>,
        limit: usize,
    ) -> OfficialModelListResponse {
        let raw_query = query.map(crate::state::js_trim).unwrap_or("");
        let lower_query = raw_query.to_lowercase();
        let normalized_query = normalize(raw_query);
        let mut models: Vec<OfficialModelOption> = self
            .official
            .iter()
            .filter(|(_, price)| price.billable())
            .filter(|(name, _)| {
                lower_query.is_empty()
                    || name.contains(&lower_query)
                    || (!normalized_query.is_empty() && name.contains(&normalized_query))
            })
            .map(|(model, price)| OfficialModelOption {
                model: model.clone(),
                rates: price_rates_per_million(price),
                has_long_context: price.long_context.is_some(),
            })
            .collect();
        models.sort_by(|left, right| {
            let rank = |name: &str| {
                (
                    !normalized_query.is_empty() && name != normalized_query,
                    !normalized_query.is_empty() && !name.starts_with(&normalized_query),
                    name.contains('/'),
                )
            };
            rank(&left.model)
                .cmp(&rank(&right.model))
                .then_with(|| left.model.cmp(&right.model))
        });
        let total = models.len();
        models.truncate(limit);
        OfficialModelListResponse { models, total }
    }

    pub fn describe_overrides(
        &self,
        records: &[ModelPriceOverrideRecord],
    ) -> Vec<ModelPriceOverrideView> {
        records
            .iter()
            .map(|record| {
                let compiled = self.resolve_override(&record.model_key);
                let effective_rates = compiled.map(|entry| price_rates_per_million(&entry.price));
                let target_missing =
                    record.kind == PricingOverrideKind::Remap && compiled.is_none();
                let official = self.official_price(&record.model_key);
                let official_rates = official.map(price_rates_per_million);
                let current_hash = self
                    .official_price_hash_and_json(&record.model_key)
                    .map(|(hash, _)| hash);
                let official_price_available = current_hash.is_some()
                    && current_hash.as_deref() != record.acknowledged_official_hash.as_deref();
                ModelPriceOverrideView {
                    model_key: record.model_key.clone(),
                    display_model: record.display_model.clone(),
                    kind: record.kind,
                    target_model: record.target_model.clone(),
                    effective_rates,
                    target_missing,
                    official_price_available,
                    official_rates,
                    updated_at: record.updated_at,
                }
            })
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn estimate(
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
        dependencies::record(model, || self.resolve_dependency(model));
        let Some((price, target_model)) = self.resolve_entry(model) else {
            cost::record_miss(model);
            return None;
        };
        let multiplier = tier::split_for_target(model, target_model).1;
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
        if !cost.is_finite() {
            return None;
        }
        let has_usage = [
            tokens.input,
            tokens.output,
            tokens.reasoning,
            tokens.cache_read,
            tokens.cache_create,
        ]
        .into_iter()
        .any(|value| positive(value) > 0.0)
            || positive(Some(web_search)) > 0.0;
        (cost > 0.0 || (!price.billable() && has_usage)).then(|| round_cost(cost))
    }
}

fn official_get<'a>(official: &'a HashMap<String, Price>, model: &str) -> Option<&'a Price> {
    official.get(model).filter(|price| price.billable())
}

fn official_resolve_price_in<'a>(
    official: &'a HashMap<String, Price>,
    model: &str,
) -> Option<&'a Price> {
    let model = normalize(model);
    if let Some(price) = official_get(official, &model) {
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
        if let Some(price) =
            official_get(official, candidate).or_else(|| official_get(official, alias(candidate)))
        {
            return Some(price);
        }
    }
    for candidate in &candidates {
        for (index, character) in candidate.char_indices().rev() {
            if matches!(character, '-' | '@')
                && !drops_version(&candidate[..index], &candidate[index + 1..])
                && let Some(price) = official_get(official, &candidate[..index])
            {
                return Some(price);
            }
        }
    }
    None
}

fn compile_overrides(
    official: &HashMap<String, Price>,
    records: &[ModelPriceOverrideRecord],
) -> HashMap<String, ResolvedPrice> {
    let mut compiled = HashMap::new();
    for record in records {
        let Some(key) = normalize_override_model_key(&record.model_key) else {
            continue;
        };
        let entry = match record.kind {
            PricingOverrideKind::Remap => record.target_model.as_deref().and_then(|target| {
                Some(ResolvedPrice {
                    price: official_resolve_price_in(official, target)?.clone(),
                    target_model: Some(normalize(target)),
                })
            }),
            PricingOverrideKind::Manual => {
                record
                    .rates
                    .as_ref()
                    .and_then(manual_price)
                    .map(|price| ResolvedPrice {
                        price,
                        target_model: None,
                    })
            }
        };
        if let Some(entry) = entry {
            compiled.insert(key, entry);
        }
    }
    compiled
}

fn manual_price(rates: &PricingRatePerMillion) -> Option<Price> {
    for value in [
        rates.input,
        rates.output,
        rates.cache_read,
        rates.cache_write,
    ] {
        if !value.is_finite() || value < 0.0 {
            return None;
        }
    }
    let output = rates.output / 1_000_000.0;
    Some(Price {
        input_cost_per_token: rates.input / 1_000_000.0,
        output_cost_per_token: output,
        cache_create_cost_per_token: rates.cache_write / 1_000_000.0,
        cache_create_1h_cost_per_token: Some(rates.cache_write / 1_000_000.0),
        cache_read_cost_per_token: rates.cache_read / 1_000_000.0,
        reasoning_cost_per_token: output,
        web_search_cost_per_request: 0.0,
        long_context: None,
    })
}

fn round_rate(per_token: f64) -> f64 {
    let per_million = per_token * 1_000_000.0;
    if !per_million.is_finite() {
        return 0.0;
    }
    if per_million >= 1_000_000_000.0 {
        return per_million;
    }
    let rounded = (per_million * 1_000_000.0).round() / 1_000_000.0;
    if rounded == 0.0 { 0.0 } else { rounded }
}

fn price_rates_per_million(price: &Price) -> PricingRatePerMillion {
    PricingRatePerMillion {
        input: round_rate(price.input_cost_per_token),
        output: round_rate(price.output_cost_per_token),
        cache_read: round_rate(price.cache_read_cost_per_token),
        cache_write: round_rate(price.cache_create_cost_per_token),
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
    fn fallback_never_prices_a_model_as_another_version() {
        let pricing = Pricing::bundled();
        let price = |model| pricing.resolve(model);
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
        let price = |model| pricing.resolve(model);
        assert_eq!(price("claude-4-opus"), price("claude-opus-4"));
        assert_eq!(price("gpt-5.1-codex-high"), price("gpt-5.1-codex"));
    }

    fn override_record(
        model_key: &str,
        kind: PricingOverrideKind,
        target_model: Option<&str>,
        rates: Option<PricingRatePerMillion>,
    ) -> ModelPriceOverrideRecord {
        ModelPriceOverrideRecord {
            model_key: model_key.to_owned(),
            display_model: model_key.to_owned(),
            kind,
            target_model: target_model.map(str::to_owned),
            rates,
            acknowledged_official_hash: None,
            acknowledged_official_json: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn normalize_override_key_preserves_scope_and_strips_registered_tiers() {
        assert_eq!(
            normalize_override_model_key(
                " \u{3000}OpenRouter/Anthropic/Claude_Sonnet_4_20250514@fast "
            ),
            Some("openrouter/anthropic/claude-sonnet-4-20250514".into())
        );
        assert_eq!(
            normalize_override_model_key("custom_model@flex"),
            Some("custom-model".into())
        );
        assert_eq!(
            normalize_override_model_key("vertex_model@eu"),
            Some("vertex-model@eu".into())
        );
        assert_eq!(normalize_override_model_key("  \u{3000}@fast "), None);
        assert_eq!(normalize_override_model_key(&"a".repeat(257)), None);
        assert_eq!(normalize_override_model_key(&"😀".repeat(129)), None);
    }

    #[test]
    fn two_layer_overrides_handle_zero_manual_remap_tiers_and_generation() {
        let official = registry::parse_models_dev(&serde_json::json!({
            "openai": {
                "models": {
                    "free": { "cost": { "input": 0, "output": 0 } },
                    "gpt-5.4": {
                        "cost": {
                            "input": 2.5,
                            "output": 10.0,
                            "cache_read": 0.25,
                            "tiers": [{ "input": 5.0, "output": 20.0, "tier": { "type": "context", "size": 200_000 } }]
                        }
                    }
                }
            }
        }));
        let zero_rates = PricingRatePerMillion {
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
        };
        let mut records = vec![
            override_record(
                "local-zero",
                PricingOverrideKind::Manual,
                None,
                Some(zero_rates.clone()),
            ),
            override_record(
                "remapped-gpt",
                PricingOverrideKind::Remap,
                Some("gpt-5.4"),
                None,
            ),
            override_record(
                "chained-bad",
                PricingOverrideKind::Remap,
                Some("remapped-gpt"),
                None,
            ),
            override_record(
                "missing-target",
                PricingOverrideKind::Remap,
                Some("no-such-model"),
                None,
            ),
            override_record(
                "gpt-5.4",
                PricingOverrideKind::Manual,
                None,
                Some(PricingRatePerMillion {
                    input: 1.0,
                    output: 2.0,
                    cache_read: 0.5,
                    cache_write: 1.25,
                }),
            ),
        ];
        let pricing = Pricing::from_official_and_overrides(official.clone(), &records);
        let tokens: MessageTokens = serde_json::from_value(serde_json::json!({
            "input": 1_000_000,
            "output": 0,
            "cache_create": 500_000,
            "cache_create_1h": 500_000
        }))
        .unwrap();

        assert!(pricing.resolve("free").is_none());
        assert_eq!(pricing.estimate(Some("free"), &tokens, 0.0), None);
        assert_eq!(
            pricing.estimate(Some("local-zero"), &tokens, 0.0),
            Some(0.0)
        );
        assert_eq!(
            pricing.estimate(Some("remapped-gpt"), &tokens, 1.0),
            Some(7.51)
        );
        assert!(pricing.resolve("chained-bad").is_none());
        assert!(pricing.resolve("missing-target").is_none());
        assert_eq!(
            pricing.estimate(Some("gpt-5.4@fast"), &tokens, 0.0),
            Some(2.25)
        );

        let (hash, _) = pricing.official_price_hash_and_json("gpt-5.4").unwrap();
        records[4].acknowledged_official_hash = Some(hash.clone());
        records[4].display_model = "Renamed".into();
        records[4].updated_at = 9999;
        let acknowledged = Pricing::from_official_and_overrides(official, &records);
        assert_eq!(pricing.generation(), acknowledged.generation());

        let views = acknowledged.describe_overrides(&records);
        assert!(views[2].target_missing);
        assert!(views[3].target_missing);
        assert!(!views[4].official_price_available);
        records[4].acknowledged_official_hash = Some("old-hash".into());
        let stale_ack = acknowledged.describe_overrides(&records);
        assert!(stale_ack[4].official_price_available);
        assert_eq!(
            stale_ack[4].official_rates,
            Some(PricingRatePerMillion {
                input: 2.5,
                output: 10.0,
                cache_read: 0.25,
                cache_write: 2.5,
            })
        );

        let list = acknowledged.list_official_models(Some("gpt-5.4"), 10);
        assert_eq!(list.total, 2);
        assert_eq!(list.models[0].model, "gpt-5.4");
        assert!(list.models[0].has_long_context);
        assert_eq!(list.models[0].rates.cache_read, 0.25);
        assert!(
            acknowledged
                .list_official_models(Some("free"), 10)
                .models
                .is_empty()
        );
    }

    #[test]
    fn remap_uses_target_tiers_and_invalidates_same_rate_dependencies() {
        let official = registry::snapshot();
        let record =
            |target| override_record("acme/alias", PricingOverrideKind::Remap, Some(target), None);
        let pricing = Pricing::from_official_and_overrides(official.clone(), &[record("gpt-5.4")]);
        let tokens = serde_json::from_value(serde_json::json!({"input": 1_000_000})).unwrap();
        for (tier, expected) in [("", 2.5), ("@fast", 5.0), ("@flex", 1.25)] {
            assert_eq!(
                pricing.estimate(Some(&format!("acme/alias{tier}")), &tokens, 0.0),
                Some(expected)
            );
            assert_eq!(
                pricing.estimate(Some(&format!("gpt-5.4{tier}")), &tokens, 0.0),
                Some(expected)
            );
        }
        let (_, dependencies) =
            capture_dependencies(|| pricing.estimate(Some("acme/alias@fast"), &tokens, 0.0));
        let mut official = official;
        official.insert("same-rate-model".into(), official["gpt-5.4"].clone());
        let changed =
            Pricing::from_official_and_overrides(official.clone(), &[record("same-rate-model")]);
        let unchanged = Pricing::from_official_and_overrides(official, &[record("gpt-5.4")]);
        assert_ne!(changed.generation(), unchanged.generation());
        assert!(!changed.matches_dependencies(&dependencies));
        assert!(unchanged.matches_dependencies(&dependencies));
        assert_eq!(
            changed.estimate(Some("acme/alias@fast"), &tokens, 0.0),
            Some(2.5)
        );

        let legacy: PriceDependencies = serde_json::from_value(serde_json::json!({
            "gpt-5.4": serde_json::to_value(pricing.official_price("gpt-5.4").unwrap()).unwrap()
        }))
        .unwrap();
        assert!(pricing.matches_dependencies(&legacy));
    }

    #[test]
    fn remote_publish_retains_overrides_without_writing_them_to_official_cache() {
        let home = tempfile::tempdir().unwrap();
        let records = vec![override_record(
            "my-local-model",
            PricingOverrideKind::Remap,
            Some("remote-model"),
            None,
        )];
        let controller = PricingController::load_with_overrides(home.path(), records);
        assert!(
            controller
                .snapshot()
                .unwrap()
                .pricing
                .resolve("my-local-model")
                .is_none()
        );
        let before_gen = controller.generation();

        assert!(
            controller
                .stage_remote(&serde_json::json!({
                    "openai": { "models": { "remote-model": { "cost": { "input": 3, "output": 9 } } } }
                }))
                .unwrap()
        );
        assert!(controller.publish_pending().unwrap());
        assert_ne!(controller.generation(), before_gen);
        assert!(
            controller
                .snapshot()
                .unwrap()
                .pricing
                .resolve("my-local-model")
                .is_some()
        );

        let cache_file =
            std::fs::read_to_string(home.path().join(".codesesh/models-dev-pricing.json")).unwrap();
        assert!(!cache_file.contains("my-local-model"));
        assert!(cache_file.contains("remote-model"));
    }
}
