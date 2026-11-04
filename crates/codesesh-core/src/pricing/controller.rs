use std::{
    path::Path,
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use tokio::sync::Mutex;

use super::{Pricing, PricingManager, manager::fetch_remote};

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
        let manager = PricingManager::load(home);
        Self {
            inner: Arc::new(Inner {
                generation: AtomicU64::new(manager.current().generation()),
                manager: RwLock::new(manager),
                refresh: Mutex::new(()),
            }),
        }
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

    #[cfg(test)]
    pub(crate) fn has_pending(&self) -> Result<bool> {
        Ok(self
            .inner
            .manager
            .read()
            .map_err(|_| anyhow!("pricing lock poisoned"))?
            .has_pending())
    }

    pub fn stage_remote(&self, data: &Value) -> Result<bool> {
        Ok(self
            .inner
            .manager
            .write()
            .map_err(|_| anyhow!("pricing lock poisoned"))?
            .stage_remote(data))
    }

    pub async fn refresh_from(&self, url: &str, timeout: Duration) -> Result<bool> {
        let _refresh = self.inner.refresh.lock().await;
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
        let data = fetch_remote(url, timeout).await?;
        let controller = self.clone();
        tokio::task::spawn_blocking(move || controller.stage_remote(&data)).await?
    }

    pub fn publish_pending(&self) -> Result<bool> {
        let mut manager = self
            .inner
            .manager
            .write()
            .map_err(|_| anyhow!("pricing lock poisoned"))?;
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

    #[cfg(test)]
    pub(crate) fn is_current(&self) -> bool {
        self.controller.generation() == self.generation()
    }

    #[cfg(test)]
    pub(crate) fn check(&self) -> Result<()> {
        if !self.is_current() {
            bail!("pricing generation cancelled");
        }
        Ok(())
    }

    pub(crate) fn with_current<T>(&self, commit: impl FnOnce() -> Result<T>) -> Result<T> {
        // Hold the read lock through SQLite commit and snapshot publication, not just the check.
        let manager = self
            .controller
            .inner
            .manager
            .read()
            .map_err(|_| anyhow!("pricing lock poisoned"))?;
        if manager.current().generation() != self.generation() {
            bail!("pricing generation cancelled");
        }
        commit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn remote() -> Value {
        json!({"openai":{"models":{"controller-new-model":{"cost":{"input":2,"output":8}}}}})
    }

    #[test]
    fn pending_does_not_interrupt_scans_and_old_commits_are_rejected_after_publication() {
        let home = tempfile::tempdir().unwrap();
        let controller = PricingController::load(home.path());
        let before = controller.snapshot().unwrap();
        assert!(controller.stage_remote(&remote()).unwrap());
        assert!(controller.has_pending().unwrap());
        assert!(before.is_current());
        assert_eq!(before.with_current(|| Ok(7)).unwrap(), 7);
        assert!(controller.publish_pending().unwrap());
        assert!(!before.is_current());
        assert!(before.check().is_err());
        let mut committed = false;
        assert!(
            before
                .with_current(|| {
                    committed = true;
                    Ok(())
                })
                .is_err()
        );
        assert!(!committed);
        let current = controller.snapshot().unwrap();
        assert!(current.is_current());
        assert!(current.pricing.resolve("controller-new-model").is_some());
        assert!(before.pricing.resolve("controller-new-model").is_none());
    }
}
