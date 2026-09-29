use anyhow::Result;
use codesesh_core::{
    discovery::{AgentScanner, AgentSource},
    runtime::ScanBatch,
    sync::WorkerStore,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;

type ScanResult = (AgentScanner, Result<ScanBatch>);

pub(super) struct Scanning {
    sources: Vec<AgentSource>,
    path: PathBuf,
    scanners: Vec<Option<AgentScanner>>,
    pending: Option<(usize, u64, JoinHandle<ScanResult>)>,
    generation: u64,
    cursor: usize,
    next_scan: Instant,
    errors: BTreeMap<String, String>,
}

impl Scanning {
    pub(super) fn new(sources: Vec<AgentSource>, path: PathBuf) -> Self {
        let scanners = sources
            .iter()
            .cloned()
            .map(|source| Some(AgentScanner::for_worker(source, path.clone())))
            .collect();
        Self {
            sources,
            path,
            scanners,
            pending: None,
            generation: 0,
            cursor: 0,
            next_scan: Instant::now(),
            errors: BTreeMap::new(),
        }
    }

    pub(super) fn reset(&mut self) {
        self.generation += 1;
        self.scanners = self
            .sources
            .iter()
            .cloned()
            .map(|source| Some(AgentScanner::for_worker(source, self.path.clone())))
            .collect();
        self.cursor = 0;
        self.next_scan = Instant::now();
    }

    pub(super) fn status(
        &self,
        store: &WorkerStore,
    ) -> Result<codesesh_core::sync::CollectionStatus> {
        Ok(codesesh_core::sync::CollectionStatus {
            active_agent: self
                .pending
                .as_ref()
                .filter(|(_, generation, _)| *generation == self.generation)
                .map(|(index, _, _)| self.sources[*index].agent.clone()),
            last_success_at: store.last_scan_success()?,
            errors: self.errors.clone(),
        })
    }

    pub(super) fn error(&self) -> Option<String> {
        (!self.errors.is_empty()).then(|| {
            self.errors
                .values()
                .cloned()
                .collect::<Vec<_>>()
                .join("; ")
                .chars()
                .take(2048)
                .collect()
        })
    }

    pub(super) async fn tick(&mut self, store: &mut WorkerStore, paused: bool) -> Result<()> {
        if paused
            && self
                .pending
                .as_ref()
                .is_some_and(|(_, generation, _)| *generation == self.generation)
        {
            self.reset();
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|(_, _, task)| task.is_finished())
        {
            let (index, generation, task) = self.pending.take().unwrap();
            let (mut scanner, result) = task.await?;
            if generation == self.generation {
                let agent = &self.sources[index].agent;
                if paused {
                    self.scanners[index] = Some(AgentScanner::for_worker(
                        self.sources[index].clone(),
                        self.path.clone(),
                    ));
                } else {
                    let result = result.and_then(|mut batch| store.save_batch(agent, &mut batch));
                    match result {
                        Ok(()) => {
                            self.errors.remove(agent);
                        }
                        Err(error) => {
                            let message: String =
                                format!("SOURCE_OR_STORAGE_ERROR [{agent}]: {error:#}")
                                    .chars()
                                    .take(2048)
                                    .collect();
                            eprintln!("Worker scan failed; progress retained: {message}");
                            self.errors.insert(agent.clone(), message);
                            scanner = AgentScanner::for_worker(
                                self.sources[index].clone(),
                                self.path.clone(),
                            );
                        }
                    }
                    self.scanners[index] = Some(scanner);
                }
                self.cursor = (index + 1) % self.sources.len();
                if self.cursor == 0 {
                    if !paused && self.errors.is_empty() {
                        store.record_scan_success()?;
                    }
                    self.next_scan = Instant::now() + Duration::from_secs(5);
                }
            }
        }
        if paused
            || self.pending.is_some()
            || self.sources.is_empty()
            || Instant::now() < self.next_scan
        {
            return Ok(());
        }
        let index = self.cursor;
        let checkpoint = store.checkpoint(&self.sources[index].agent)?;
        let mut scanner = self.scanners[index].take().unwrap();
        self.pending = Some((
            index,
            self.generation,
            tokio::task::spawn_blocking(move || {
                let result = scanner.refresh_with_checkpoint(None, checkpoint.as_ref());
                (scanner, result)
            }),
        ));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Scanning, WorkerStore) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("worker.db");
        let store = WorkerStore::open(&path).unwrap();
        let sources = ["codex", "claudecode"]
            .map(|agent| AgentSource {
                agent: agent.into(),
                data_root: dir.path().into(),
                scan_path: dir.path().join(agent),
            })
            .to_vec();
        (dir, Scanning::new(sources, path), store)
    }

    fn batch() -> ScanBatch {
        ScanBatch {
            sessions: vec![],
            removed: vec![],
            checkpoint: None,
            complete: true,
            on_reject: None,
            pricing: None,
        }
    }

    async fn finish(scanning: &Scanning) {
        while !scanning.pending.as_ref().unwrap().2.is_finished() {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn slow_scan_leaves_store_available_and_reset_discards_old_checkpoint() {
        let (_dir, mut scanning, mut store) = fixture();
        let scanner = scanning.scanners[0].take().unwrap();
        let (send, receive) = tokio::sync::oneshot::channel();
        scanning.pending = Some((
            0,
            0,
            tokio::spawn(async move {
                receive.await.unwrap();
                (scanner, Ok(batch()))
            }),
        ));
        tokio::time::timeout(Duration::from_millis(100), scanning.tick(&mut store, false))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(store.queue_status().unwrap().batches, 0);
        assert!(!store.collection_complete(&["codex".into()]).unwrap());
        scanning.reset();
        send.send(()).unwrap();
        finish(&scanning).await;
        scanning.tick(&mut store, true).await.unwrap();
        assert!(!store.collection_complete(&["codex".into()]).unwrap());
    }

    #[tokio::test]
    async fn failed_agent_does_not_prevent_next_agent_from_committing() {
        let (_dir, mut scanning, mut store) = fixture();
        let scanner = scanning.scanners[0].take().unwrap();
        scanning.pending = Some((
            0,
            0,
            tokio::spawn(async move { (scanner, Err(anyhow::anyhow!("unreadable source"))) }),
        ));
        finish(&scanning).await;
        scanning.tick(&mut store, false).await.unwrap();
        assert!(scanning.error().unwrap().contains("codex"));
        assert_eq!(scanning.pending.as_ref().unwrap().0, 1);
        finish(&scanning).await;
        scanning.tick(&mut store, false).await.unwrap();
        assert!(store.collection_complete(&["claudecode".into()]).unwrap());
        assert!(!store.collection_complete(&["codex".into()]).unwrap());
    }

    #[tokio::test]
    async fn pause_discards_inflight_result_even_after_resume() {
        let (_dir, mut scanning, mut store) = fixture();
        let scanner = scanning.scanners[0].take().unwrap();
        let (send, receive) = tokio::sync::oneshot::channel();
        scanning.pending = Some((
            0,
            0,
            tokio::spawn(async move {
                receive.await.unwrap();
                (scanner, Ok(batch()))
            }),
        ));
        scanning.tick(&mut store, true).await.unwrap();
        send.send(()).unwrap();
        finish(&scanning).await;
        scanning.tick(&mut store, false).await.unwrap();
        assert!(!store.collection_complete(&["codex".into()]).unwrap());
    }
}
