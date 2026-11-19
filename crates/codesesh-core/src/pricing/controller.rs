use std::{
    path::Path,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Result, anyhow};
use serde_json::Value;
use tokio::sync::Mutex;

use super::{Pricing, PricingManager, manager::fetch_remote};
use crate::state::ModelPriceOverrideRecord;

#[derive(Clone, Debug)]
pub struct PricingController {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    manager: RwLock<PricingManager>,
    generation: AtomicU64,
    refresh: Mutex<()>,
}

#[derive(Clone, Debug)]
pub struct PricingSnapshot {
    pub pricing: Pricing,
    controller: PricingController,
}

impl PricingController {
    pub fn load(home: &Path) -> Self {
        Self::load_with_overrides(home, Vec::new())
    }

    pub fn load_with_overrides(home: &Path, overrides: Vec<ModelPriceOverrideRecord>) -> Self {
        let manager = PricingManager::load_with_overrides(home, overrides);
        Self {
            inner: Arc::new(Inner {
                generation: AtomicU64::new(manager.current().generation()),
                manager: RwLock::new(manager),
                refresh: Mutex::new(()),
            }),
        }
    }

    pub fn replace_overrides(
        &self,
        overrides: Vec<ModelPriceOverrideRecord>,
    ) -> Result<PricingSnapshot> {
        let mut manager = self
            .inner
            .manager
            .write()
            .map_err(|_| anyhow!("pricing lock poisoned"))?;
        let pricing = manager.replace_overrides(overrides);
        self.inner
            .generation
            .store(pricing.generation(), Ordering::Release);
        Ok(PricingSnapshot {
            pricing,
            controller: self.clone(),
        })
    }

    pub fn snapshot(&self) -> Result<PricingSnapshot> {
        let manager = self
            .inner
            .manager
            .read()
            .map_err(|_| anyhow!("pricing lock poisoned"))?;
        Ok(PricingSnapshot {
            pricing: manager.current(),
            controller: self.clone(),
        })
    }

    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::Acquire)
    }

    pub fn stage_remote(&self, data: &Value) -> Result<bool> {
        Ok(self
            .inner
            .manager
            .write()
            .map_err(|_| anyhow!("pricing lock poisoned"))?
            .stage_remote(data))
    }

    pub async fn refresh_from(&self, url: &str, timeout: Duration, force: bool) -> Result<bool> {
        let _refresh = self.inner.refresh.lock().await;
        if !force {
            let controller = self.clone();
            let needed = tokio::task::spawn_blocking(move || -> Result<bool> {
                Ok(controller
                    .inner
                    .manager
                    .read()
                    .map_err(|_| anyhow!("pricing lock poisoned"))?
                    .needs_refresh())
            })
            .await??;
            if !needed {
                return Ok(false);
            }
        }
        let data = fetch_remote(url, timeout).await?;
        let controller = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut manager = controller
                .inner
                .manager
                .write()
                .map_err(|_| anyhow!("pricing lock poisoned"))?;
            anyhow::ensure!(
                manager.stage_remote(&data),
                "No model prices in the downloaded catalog"
            );
            controller.publish(&mut manager)
        })
        .await?
    }

    pub fn publish_pending(&self) -> Result<bool> {
        let mut manager = self
            .inner
            .manager
            .write()
            .map_err(|_| anyhow!("pricing lock poisoned"))?;
        self.publish(&mut manager)
    }

    fn publish(&self, manager: &mut PricingManager) -> Result<bool> {
        let published = manager.publish_pending()?;
        if published {
            self.inner
                .generation
                .store(manager.current().generation(), Ordering::Release);
        }
        Ok(published)
    }
}

impl PricingSnapshot {
    pub fn generation(&self) -> u64 {
        self.pricing.generation()
    }

    pub(crate) fn with_latest<T>(&self, commit: impl FnOnce(&Pricing) -> Result<T>) -> Result<T> {
        // Hold the read lock through SQLite commit and snapshot publication using the latest pricing.
        let manager = self
            .controller
            .inner
            .manager
            .read()
            .map_err(|_| anyhow!("pricing lock poisoned"))?;
        commit(manager.current_ref())
    }
}
