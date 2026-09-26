use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
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
            path: home.join(".cache/codesesh/models-dev-pricing.json"),
        }
    }

    pub fn current(&self) -> Pricing {
        self.published.clone()
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn synchronize(&mut self, expected: u64) -> Result<()> {
        if expected == 0 || expected > 9_007_199_254_740_991 {
            bail!("Invalid pricing generation: {expected}");
        }
        if self.published.generation() == expected {
            return Ok(());
        }
        let cached = read_cache(&self.path, false);
        if let Some(cached) = cached
            .as_ref()
            .filter(|cache| cache.generation() == expected)
        {
            self.published = cached.clone();
            return Ok(());
        }
        bail!(
            "Pricing generation {expected} is unavailable (current {}, cached {})",
            self.published.generation(),
            cached.map_or_else(|| "none".to_owned(), |cache| cache.generation().to_string())
        );
    }

    pub async fn refresh(&mut self) -> Result<bool> {
        self.refresh_from(MODELS_DEV_URL, Duration::from_secs(10))
            .await
    }

    pub async fn refresh_from(&mut self, url: &str, timeout: Duration) -> Result<bool> {
        if !self.needs_refresh() {
            return Ok(false);
        }
        let data = fetch_remote(url, timeout).await?;
        Ok(self.stage_remote(&data))
    }

    pub(super) fn needs_refresh(&self) -> bool {
        self.pending.is_none() && read_cache(&self.path, true).is_none()
    }

    pub fn stage_remote(&mut self, data: &Value) -> bool {
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

    pub fn publish_pending(&mut self) -> Result<bool> {
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
    use crate::{contract::MessageTokens, pricing::capture_misses};
    use serde_json::json;

    fn server(responses: Vec<(&'static str, Duration)>) -> (String, std::thread::JoinHandle<()>) {
        use std::{io::Read, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/prices", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            for (status, delay) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 8192];
                let _ = stream.read(&mut buffer);
                std::thread::sleep(delay);
                let body = r#"{"openai":{"models":{"remote-p3":{"cost":{"input":2,"output":8}}}}}"#;
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (url, worker)
    }

    #[tokio::test]
    async fn refresh_retries_failure_and_skips_fresh_cache_after_restart() {
        let home = tempfile::tempdir().unwrap();
        let mut manager = PricingManager::load(home.path());
        let generation = manager.current().generation();
        let (url, server) = server(vec![
            ("500 Server Error", Duration::ZERO),
            ("200 OK", Duration::ZERO),
        ]);
        assert!(
            manager
                .refresh_from(&url, Duration::from_secs(2))
                .await
                .is_err()
        );
        assert!(!manager.has_pending());
        assert_eq!(manager.current().generation(), generation);
        assert!(
            manager
                .refresh_from(&url, Duration::from_secs(2))
                .await
                .unwrap()
        );
        assert_eq!(manager.current().generation(), generation);
        assert!(
            !manager
                .refresh_from(&url, Duration::from_secs(2))
                .await
                .unwrap()
        );
        assert!(manager.publish_pending().unwrap());
        let mut restarted = PricingManager::load(home.path());
        assert!(
            !restarted
                .refresh_from(&url, Duration::from_secs(2))
                .await
                .unwrap()
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn timeout_and_cancellation_leave_generation_untouched() {
        let home = tempfile::tempdir().unwrap();
        let mut manager = PricingManager::load(home.path());
        let generation = manager.current().generation();
        let (url, server) = server(vec![
            ("200 OK", Duration::from_millis(150)),
            ("200 OK", Duration::from_millis(150)),
        ]);
        assert!(
            manager
                .refresh_from(&url, Duration::from_millis(50))
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(50),
                manager.refresh_from(&url, Duration::from_secs(2))
            )
            .await
            .is_err()
        );
        assert!(!manager.has_pending());
        assert_eq!(manager.current().generation(), generation);
        server.join().unwrap();
    }

    #[test]
    fn publication_pins_scans_and_survives_restart_and_worker_sync() {
        let home = tempfile::tempdir().unwrap();
        let mut manager = PricingManager::load(home.path());
        let old = manager.current();
        let mut worker = PricingManager::load(home.path());
        let tokens = MessageTokens {
            input: Some(1_000_000.0),
            output: None,
            reasoning: None,
            cache_read: None,
            cache_create: None,
        };
        let (_, misses) = capture_misses(|| {
            assert_eq!(old.estimate(Some("new-p3-model"), &tokens, 0.0), None);
            old.estimate(Some("new-p3-model"), &tokens, 0.0);
        });
        assert_eq!(misses, ["new-p3-model"]);
        assert!(manager.stage_remote(&json!({"openai":{"models":{
            "new-p3-model":{"cost":{"input":2,"output":8}},
            "free-p3-model":{"cost":{"input":0,"output":0}}
        }}})));
        assert_eq!(manager.current().generation(), old.generation());
        assert!(!manager.path.exists());
        assert!(!manager.current().became_available(&misses));
        assert!(manager.publish_pending().unwrap());
        let new = manager.current();
        assert_ne!(new.generation(), old.generation());
        assert_eq!(new.estimate(Some("new-p3-model"), &tokens, 0.0), Some(2.0));
        assert_eq!(old.estimate(Some("new-p3-model"), &tokens, 0.0), None);
        assert!(new.became_available(&misses));
        assert!(new.resolve("free-p3-model").is_none());
        assert!(new.registry().contains_key("free-p3-model"));
        let reloaded = Pricing::load(home.path());
        assert_eq!(reloaded.generation(), new.generation());
        worker.synchronize(new.generation()).unwrap();
        assert_eq!(worker.current().generation(), new.generation());
        assert!(worker.synchronize(0).is_err());
        assert!(worker.synchronize(9_007_199_254_740_992).is_err());
        assert!(worker.synchronize(1).is_err());
        assert!(read_cache(&manager.path, true).is_some());
    }

    #[test]
    fn stale_prices_load_but_invalid_and_future_caches_do_not() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(".cache/codesesh/models-dev-pricing.json");
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

    #[test]
    fn failed_atomic_write_keeps_current_and_pending_generation() {
        let home = tempfile::tempdir().unwrap();
        let mut manager = PricingManager::load(home.path());
        let generation = manager.current().generation();
        fs::create_dir_all(&manager.path).unwrap();
        fs::write(manager.path.join("blocker"), "x").unwrap();
        assert!(
            manager
                .stage_remote(&json!({"openai":{"models":{"p3":{"cost":{"input":1,"output":2}}}}}))
        );
        assert!(manager.publish_pending().is_err());
        assert_eq!(manager.current().generation(), generation);
        assert!(manager.has_pending());
        assert!(
            !manager
                .path
                .with_file_name(format!(
                    "models-dev-pricing.json.{}.tmp",
                    std::process::id()
                ))
                .exists()
        );
        fs::remove_dir_all(&manager.path).unwrap();
        assert!(manager.publish_pending().unwrap());
        assert!(!manager.has_pending());
    }
}
