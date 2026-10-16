use anyhow::Result;
use codesesh_core::{
    discovery::{AgentScanner, AgentSource},
    runtime::ScanBatch,
    sync::WorkerStore,
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};

type ScanResult = (AgentScanner, Result<ScanBatch>);

const RESCAN_INTERVAL: Duration = Duration::from_secs(5);

pub(super) struct Scanning {
    sources: Vec<AgentSource>,
    path: PathBuf,
    scanners: Vec<Option<AgentScanner>>,
    pending: Option<(usize, u64, JoinHandle<ScanResult>)>,
    generation: u64,
    cursor: usize,
    schedules: Vec<Schedule>,
    changed: Arc<[AtomicBool]>,
    /// Dropping the sender stops the watcher; `None` means every source is polled.
    watching: Option<watch::Sender<bool>>,
    errors: BTreeMap<String, String>,
    source_statuses: BTreeMap<String, codesesh_core::discovery::AgentCollectionStatus>,
}

#[derive(Clone, Copy)]
struct Schedule {
    next_scan: Instant,
    unfinished: bool,
    failed: bool,
}

impl Scanning {
    pub(super) fn new(sources: Vec<AgentSource>, path: PathBuf) -> Self {
        let scanners = sources
            .iter()
            .cloned()
            .map(|source| Some(AgentScanner::for_worker(source, path.clone())))
            .collect();
        let changed: Arc<[AtomicBool]> = sources.iter().map(|_| AtomicBool::new(true)).collect();
        let (stop, shutdown) = watch::channel(false);
        let marked = changed.clone();
        let watching = match codesesh_core::runtime::watch_paths(
            sources.iter().map(AgentSource::watch_roots).collect(),
            Arc::new(move |index, _| marked[index].store(true, Ordering::Release)),
            shutdown,
        ) {
            Ok(_) => Some(stop),
            Err(error) => {
                eprintln!("Worker cannot watch agent sources; polling instead: {error:#}");
                super::log_warn(
                    "worker.watch.failed",
                    serde_json::json!({"error":format!("{error:#}")}),
                );
                None
            }
        };
        Self {
            source_statuses: sources
                .iter()
                .map(|source| (source.agent.clone(), Default::default()))
                .collect(),
            schedules: vec![
                Schedule {
                    next_scan: Instant::now(),
                    unfinished: false,
                    failed: false,
                };
                sources.len()
            ],
            sources,
            path,
            scanners,
            pending: None,
            generation: 0,
            cursor: 0,
            changed,
            watching,
            errors: BTreeMap::new(),
        }
    }

    pub(super) fn reset(&mut self) {
        self.generation += 1;
        for status in self.source_statuses.values_mut() {
            status.complete = false;
        }
        self.scanners = self
            .sources
            .iter()
            .cloned()
            .map(|source| Some(AgentScanner::for_worker(source, self.path.clone())))
            .collect();
        self.cursor = 0;
        for (schedule, changed) in self.schedules.iter_mut().zip(self.changed.iter()) {
            schedule.next_scan = Instant::now();
            schedule.unfinished = false;
            changed.store(true, Ordering::Release);
        }
    }

    fn due(&self, index: usize, now: Instant) -> bool {
        let schedule = &self.schedules[index];
        schedule.unfinished
            || now >= schedule.next_scan
                && (self.watching.is_none()
                    || schedule.failed
                    || self.changed[index].load(Ordering::Acquire))
    }

    pub(super) fn status(
        &self,
        store: &WorkerStore,
    ) -> Result<codesesh_core::sync::CollectionStatus> {
        Ok(codesesh_core::sync::CollectionStatus {
            sources: Some(self.source_statuses.clone()),
            rescan: store.rescan_scan_progress()?,
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
                let complete = result.as_ref().is_ok_and(|batch| batch.complete);
                if paused {
                    self.scanners[index] = Some(AgentScanner::for_worker(
                        self.sources[index].clone(),
                        self.path.clone(),
                    ));
                    self.changed[index].store(true, Ordering::Release);
                } else {
                    let result = result.and_then(|mut batch| {
                        store.save_batch(agent, &mut batch)?;
                        if let Some(presence) = batch.source_presence.clone() {
                            self.source_statuses
                                .entry(agent.clone())
                                .or_default()
                                .collected(presence, batch.complete);
                        }
                        Ok(())
                    });
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
                            super::log_warn(
                                "worker.scan.failed",
                                serde_json::json!({"agent":agent,"error":format!("{error:#}")}),
                            );
                            self.errors.insert(agent.clone(), message);
                            let status = self.source_statuses.entry(agent.clone()).or_default();
                            status.error = self.errors.get(agent).cloned();
                            status.complete = false;
                            scanner = AgentScanner::for_worker(
                                self.sources[index].clone(),
                                self.path.clone(),
                            );
                        }
                    }
                    self.scanners[index] = Some(scanner);
                }
                let failed = self.errors.contains_key(agent);
                self.schedules[index] = Schedule {
                    next_scan: Instant::now() + RESCAN_INTERVAL,
                    unfinished: !paused && !failed && !complete,
                    failed,
                };
                if !paused && self.errors.is_empty() {
                    store.record_scan_success()?;
                }
                self.cursor = (index + 1) % self.sources.len();
            }
        }
        if paused || self.pending.is_some() || self.sources.is_empty() {
            return Ok(());
        }
        let now = Instant::now();
        let Some(index) = (0..self.sources.len())
            .map(|offset| (self.cursor + offset) % self.sources.len())
            .find(|index| self.due(*index, now))
        else {
            return Ok(());
        };
        self.changed[index].store(false, Ordering::Release);
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
        // Keep worker.db writes outside the watched agent directory.
        let agents = dir.path().join("agents");
        std::fs::create_dir(&agents).unwrap();
        let sources = ["codex", "claudecode"]
            .map(|agent| AgentSource {
                agent: agent.into(),
                data_root: agents.clone(),
                scan_path: agents.join(agent),
            })
            .to_vec();
        (dir, Scanning::new(sources, path), store)
    }

    fn batch() -> ScanBatch {
        ScanBatch {
            source_presence: None,
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
        let report = scanning.status(&store).unwrap();
        assert!(
            report.sources.unwrap()["codex"]
                .error
                .as_ref()
                .unwrap()
                .contains("unreadable source")
        );
        assert_eq!(scanning.pending.as_ref().unwrap().0, 1);
        finish(&scanning).await;
        scanning.tick(&mut store, false).await.unwrap();
        assert!(store.collection_complete(&["claudecode".into()]).unwrap());
        let report = scanning.status(&store).unwrap();
        assert_eq!(
            report.sources.unwrap()["claudecode"].presence,
            codesesh_core::discovery::SourcePresence::NotFound
        );
        assert!(!store.collection_complete(&["codex".into()]).unwrap());
        assert!(scanning.pending.is_none());
        scanning.tick(&mut store, false).await.unwrap();
        assert!(scanning.pending.is_none());
    }

    #[tokio::test]
    async fn unfinished_history_continues_then_idle_sources_wait_for_changes() {
        let (_dir, mut scanning, mut store) = fixture();
        let mut incomplete = batch();
        incomplete.complete = false;
        let scanner = scanning.scanners[0].take().unwrap();
        scanning.pending = Some((0, 0, tokio::spawn(async move { (scanner, Ok(incomplete)) })));
        finish(&scanning).await;
        scanning.tick(&mut store, false).await.unwrap();
        assert_eq!(scanning.pending.as_ref().map(|pending| pending.0), Some(1));
        finish(&scanning).await;
        scanning.tick(&mut store, false).await.unwrap();
        assert_eq!(scanning.pending.as_ref().map(|pending| pending.0), Some(0));
        finish(&scanning).await;
        scanning.tick(&mut store, false).await.unwrap();
        assert!(
            store
                .collection_complete(&["codex".into(), "claudecode".into()])
                .unwrap()
        );
        assert!(scanning.pending.is_none());
        scanning.schedules[1].next_scan = Instant::now();
        scanning.tick(&mut store, false).await.unwrap();
        assert!(scanning.pending.is_none());
        scanning.changed[1].store(true, Ordering::Release);
        scanning.tick(&mut store, false).await.unwrap();
        assert_eq!(scanning.pending.as_ref().map(|pending| pending.0), Some(1));
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
