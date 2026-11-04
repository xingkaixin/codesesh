use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use serde_json::Value;

use super::{
    Pricing, normalize,
    registry::{Price, parse_models_dev, snapshot},
};

pub const CACHE_TTL_MS: u64 = 24 * 60 * 60 * 1000;
pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";

#[derive(Debug)]
pub struct PricingManager {
    published: Pricing,
    pending: Option<Pricing>,
    path: PathBuf,
}

impl PricingManager {
    pub fn load(home: &Path) -> Self {
        Self {
            published: Pricing::load(home),
            pending: None,
            path: crate::app_paths::root(home).join("models-dev-pricing.json"),
        }
    }

    pub(crate) fn current(&self) -> Pricing {
        self.published.clone()
    }

    #[cfg(test)]
    pub(crate) fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub(super) fn needs_refresh(&self) -> bool {
        self.pending.is_none() && read_cache(&self.path, true).is_none()
    }

    pub(crate) fn stage_remote(&mut self, data: &Value) -> bool {
        if self.pending.is_some() {
            return false;
        }
        let remote = parse_models_dev(data);
        if remote.is_empty() {
            return false;
        }
        let mut prices = snapshot();
        prices.extend(remote);
        self.pending = Some(Pricing::from_prices(prices));
        true
    }

    pub(crate) fn publish_pending(&mut self) -> Result<bool> {
        let Some(pending) = &self.pending else {
            return Ok(false);
        };
        write_cache(&self.path, &pending.prices)?;
        self.published = self.pending.take().expect("pending pricing generation");
        Ok(true)
    }
}

pub(super) async fn fetch_remote(url: &str, timeout: Duration) -> Result<Value> {
    Ok(reqwest::Client::builder()
        .timeout(timeout)
        .build()?
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

pub(super) fn read_cache(path: &Path, fresh: bool) -> Option<Pricing> {
    let cache: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let timestamp = cache.get("timestamp")?.as_f64()?;
    let now = now_ms();
    if !timestamp.is_finite()
        || timestamp > now
        || (fresh && now - timestamp >= CACHE_TTL_MS as f64)
    {
        return None;
    }
    let data = cache.get("data")?.as_object()?;
    let mut prices = snapshot();
    let mut valid = 0;
    for (model, value) in data {
        if let Some(price) = Price::from_cache(value) {
            prices.insert(normalize(model), price);
            valid += 1;
        }
    }
    (valid > 0).then(|| Pricing::from_prices(prices))
}

fn write_cache(path: &Path, prices: &HashMap<String, Price>) -> Result<()> {
    let directory = path.parent().context("pricing cache has no directory")?;
    fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let temporary = path.with_file_name(format!(
        "models-dev-pricing.json.{}.tmp",
        std::process::id()
    ));
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        let mut payload = format!("{{\"timestamp\":{},\"data\":{{", now_ms() as u64);
        let mut entries: Vec<_> = prices.iter().collect();
        entries.sort_by_key(|(name, _)| *name);
        for (index, (name, price)) in entries.into_iter().enumerate() {
            if index > 0 {
                payload.push(',');
            }
            payload.push_str(&serde_json::to_string(name)?);
            payload.push(':');
            payload.push_str(&price.json());
        }
        payload.push_str("}}");
        file.write_all(payload.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{model::MessageTokens, pricing::CostInput};
    use serde_json::json;

    #[test]
    fn long_context_tier_prices_the_whole_request_and_survives_restart() {
        let home = tempfile::tempdir().unwrap();
        let mut manager = PricingManager::load(home.path());
        assert!(
            manager.stage_remote(&json!({"openai":{"models":{"tiered-p4":{"cost":{
            "input":2,"output":8,"cache_read":0.5,"tiers":[
                {"input":9,"output":9,"tier":{"type":"context","size":400_000}},
                {"input":4,"output":12,"tier":{"type":"context","size":200_000}},
                {"input":99,"output":99,"tier":{"type":"output","size":1}}
            ]}}}}}))
        );
        manager.publish_pending().unwrap();
        let tokens = |input: f64| -> MessageTokens {
            serde_json::from_value(json!({"input":input,"output":10_000,"cache_read":100_000}))
                .unwrap()
        };
        let reloaded = Pricing::load(home.path());
        assert_eq!(reloaded.generation(), manager.current().generation());
        for pricing in [manager.current(), reloaded] {
            assert_eq!(
                pricing.estimate(Some("tiered-p4"), &tokens(200_000.0), 0.0),
                Some(0.33)
            );
            assert_eq!(
                pricing.estimate(Some("tiered-p4"), &tokens(300_000.0), 0.0),
                Some(0.97)
            );
        }
    }

    #[test]
    fn aggregate_inputs_keep_base_rates_through_repricing() {
        let home = tempfile::tempdir().unwrap();
        let mut manager = PricingManager::load(home.path());
        assert!(manager.stage_remote(&json!({"openai":{"models":{"tiered-p4":{"cost":{
            "input":2,"output":8,"tiers":[{"input":4,"output":12,"tier":{"type":"context","size":1000}}]
        }}}}})));
        manager.publish_pending().unwrap();
        let pricing = manager.current();
        let tokens: MessageTokens = serde_json::from_value(json!({"input":1_000_000})).unwrap();
        let mut inputs = Vec::new();
        assert_eq!(
            pricing.estimate_tracked(Some("tiered-p4"), &tokens, 0.0, &mut inputs),
            Some(4.0)
        );
        assert_eq!(
            pricing.estimate_aggregate_tracked(Some("tiered-p4"), &tokens, 0.0, &mut inputs),
            Some(2.0)
        );
        let stored = serde_json::to_string(&inputs).unwrap();
        assert_eq!(stored.matches("aggregate").count(), 1);
        let restored: Vec<CostInput> = serde_json::from_str(&stored).unwrap();
        let repriced: Vec<_> = restored
            .iter()
            .map(|input| pricing.estimate_input(input))
            .collect();
        assert_eq!(repriced, [Some(4.0), Some(2.0)]);
    }

    #[test]
    fn stale_prices_load_but_invalid_and_future_caches_do_not() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".codesesh/models-dev-pricing.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let data = json!({"cache_model":{"inputCostPerToken":0.000001,"outputCostPerToken":0.000002,
            "cacheReadCostPerToken":-1,"cacheCreateCostPerToken":"bad"},
            "broken":{"inputCostPerToken":-1,"outputCostPerToken":2}});
        fs::write(
            &path,
            json!({"timestamp":now_ms() - CACHE_TTL_MS as f64,"data":data}).to_string(),
        )
        .unwrap();
        let stale = read_cache(&path, false).unwrap();
        assert!(read_cache(&path, true).is_none());
        let price = stale.resolve("cache-model").unwrap();
        assert_eq!(price.cache_read_cost_per_token, 0.000001 * 0.1);
        assert_eq!(price.cache_create_cost_per_token, 0.000001 * 1.25);
        assert!(stale.resolve("broken").is_none());
        fs::write(
            &path,
            json!({"timestamp":now_ms() - 23.0 * 60.0 * 60.0 * 1000.0,"data":data}).to_string(),
        )
        .unwrap();
        assert!(read_cache(&path, true).is_some());
        fs::write(
            &path,
            json!({"timestamp":now_ms()+100_000.0,"data":data}).to_string(),
        )
        .unwrap();
        assert!(read_cache(&path, false).is_none());
        fs::write(&path, json!({"timestamp":now_ms(),"data":{}}).to_string()).unwrap();
        assert!(read_cache(&path, false).is_none());
    }
}
