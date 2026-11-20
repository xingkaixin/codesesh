use anyhow::Result;
use codesesh_core::{
    discovery::{AgentScanner, AgentSource},
    runtime::ScanBatch,
    sync::WorkerStore,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    sync::{Notify, watch},
    task::JoinHandle,
};

type ScanResult = (AgentScanner, Result<ScanBatch>);

const RESCAN_INTERVAL: Duration = Duration::from_secs(5);
const SUCCESS_RECORD_INTERVAL: Duration = Duration::from_secs(60);
const RECLAIM_INTERVAL: Duration = Duration::from_secs(1);
const PENDING_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_TRACKED_PATHS: usize = 1024;
#[cfg(not(test))]
const IDLE_RELEASE_DELAY: Duration = Duration::from_secs(10 * 60);
#[cfg(test)]
const IDLE_RELEASE_DELAY: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, PartialEq, Eq)]
enum PendingChange {
    None,
    Paths(BTreeSet<PathBuf>),
    Full,
}

impl PendingChange {
    fn record(&mut self, paths: Option<Vec<PathBuf>>) {
        match (self, paths) {
            (Self::Full, _) => {}
            (slot, None) => *slot = Self::Full,
            (slot, Some(paths)) if paths.is_empty() => *slot = Self::Full,
            (slot @ Self::None, Some(paths)) => {
                let set: BTreeSet<PathBuf> = paths.into_iter().collect();
                *slot = if set.len() > MAX_TRACKED_PATHS {
                    Self::Full
                } else {
                    Self::Paths(set)
                };
            }
            (slot @ Self::Paths(_), Some(paths)) => {
                let Self::Paths(existing) = slot else {
                    unreachable!()
                };
                existing.extend(paths);
                if existing.len() > MAX_TRACKED_PATHS {
                    *slot = Self::Full;
                }
            }
        }
    }

    fn is_pending(&self) -> bool {
        !matches!(self, Self::None)
    }
}

pub(super) struct Scanning {
    sources: Vec<AgentSource>,
    path: PathBuf,
    scanners: Vec<Option<AgentScanner>>,
    pending: Option<(usize, u64, JoinHandle<ScanResult>)>,
    generation: u64,
    cursor: usize,
    schedules: Vec<Schedule>,
    changes: Arc<[Mutex<PendingChange>]>,
    wake: Arc<Notify>,
    last_success_recorded: Option<Instant>,
    last_reclaim: Option<Instant>,
    reclaim_due: Option<Instant>,
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
    initialized: bool,
    idle_release_at: Option<Instant>,
}

impl Scanning {
    pub(super) fn new(sources: Vec<AgentSource>, path: PathBuf) -> Self {
        let scanners = sources
            .iter()
            .cloned()
            .map(|source| Some(AgentScanner::for_worker(source, path.clone())))
            .collect();
        let changes: Arc<[Mutex<PendingChange>]> = sources
            .iter()
            .map(|_| Mutex::new(PendingChange::Full))
            .collect();
        let wake = Arc::new(Notify::new());
        let (stop, shutdown) = watch::channel(false);
        let marked = changes.clone();
        let notify = wake.clone();
        let watching = match codesesh_core::runtime::watch_paths(
            sources.iter().map(AgentSource::watch_roots).collect(),
            Arc::new(move |index, paths| {
                if let Ok(mut slot) = marked[index].lock() {
                    slot.record(paths);
                }
                notify.notify_one();
            }),
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
                    initialized: false,
                    idle_release_at: None,
                };
                sources.len()
            ],
            sources,
            path,
            scanners,
            pending: None,
            generation: 0,
            cursor: 0,
            changes,
            wake,
            last_success_recorded: None,
            last_reclaim: None,
            reclaim_due: None,
            watching,
            errors: BTreeMap::new(),
        }
    }

    pub(super) fn notifier(&self) -> Arc<Notify> {
        self.wake.clone()
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
        for (schedule, change) in self.schedules.iter_mut().zip(self.changes.iter()) {
            schedule.next_scan = Instant::now();
            schedule.unfinished = false;
            schedule.initialized = false;
            schedule.idle_release_at = None;
            *change
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = PendingChange::Full;
        }
        self.wake.notify_one();
    }

    fn has_pending_change(&self, index: usize) -> bool {
        self.changes[index]
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .is_pending()
    }

    fn take_paths(
        &self,
        index: usize,
        schedule: Schedule,
        has_checkpoint: bool,
    ) -> Option<Vec<PathBuf>> {
        let mut slot = self.changes[index]
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.sources[index].is_database_source() {
            // A database path can represent the entire history. Keep events received mid-page
            // pending for the next bounded pass.
            if !schedule.unfinished {
                *slot = PendingChange::None;
            }
            return None;
        }
        if schedule.unfinished {
            return match std::mem::replace(&mut *slot, PendingChange::None) {
                PendingChange::Paths(paths) => Some(paths.into_iter().collect()),
                PendingChange::Full => {
                    *slot = PendingChange::Full;
                    None
                }
                PendingChange::None => None,
            };
        }
        let change = std::mem::replace(&mut *slot, PendingChange::None);
        if !schedule.initialized || schedule.failed || has_checkpoint {
            return None;
        }
        if self.watching.is_none() {
            return Some(Vec::new());
        }
        match change {
            PendingChange::Paths(paths) => Some(paths.into_iter().collect()),
            PendingChange::Full | PendingChange::None => None,
        }
    }

    fn due(&self, index: usize, now: Instant) -> bool {
        let schedule = &self.schedules[index];
        schedule.unfinished
            || now >= schedule.next_scan
                && (self.watching.is_none() || schedule.failed || self.has_pending_change(index))
    }

    pub(super) fn next_wake(&self, paused: bool) -> Option<Instant> {
        let now = Instant::now();
        if let Some((_, _, task)) = &self.pending {
            return Some(if task.is_finished() {
                now
            } else {
                now + PENDING_POLL_INTERVAL
            });
        }
        let mut earliest = self.reclaim_due;
        let mut consider = |instant: Instant| {
            earliest = Some(match earliest {
                Some(current) => current.min(instant),
                None => instant,
            });
        };
        for (index, schedule) in self.schedules.iter().enumerate() {
            if let Some(release_at) = schedule.idle_release_at {
                consider(release_at);
            }
            if paused {
                continue;
            }
            if schedule.unfinished {
                return Some(now);
            }
            if self.watching.is_none() || schedule.failed || self.has_pending_change(index) {
                consider(schedule.next_scan);
            }
        }
        earliest
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

    fn reclaim_memory(&mut self) {
        let now = Instant::now();
        if let Some(next) = self.last_reclaim.map(|at| at + RECLAIM_INTERVAL)
            && now < next
        {
            self.reclaim_due = Some(next);
            return;
        }
        codesesh_core::runtime::release_unused_memory();
        self.last_reclaim = Some(now);
        self.reclaim_due = None;
    }

    pub(super) async fn tick(&mut self, store: &mut WorkerStore, paused: bool) -> Result<bool> {
        let now = Instant::now();
        let mut released_idle = false;
        for (schedule, slot) in self.schedules.iter_mut().zip(self.scanners.iter_mut()) {
            if schedule.idle_release_at.is_some_and(|at| now >= at)
                && let Some(scanner) = slot.as_mut()
            {
                scanner.release_idle();
                schedule.idle_release_at = None;
                released_idle = true;
            }
        }
        if released_idle || self.reclaim_due.is_some_and(|at| now >= at) {
            self.reclaim_memory();
        }
        if paused
            && self
                .pending
                .as_ref()
                .is_some_and(|(_, generation, _)| *generation == self.generation)
        {
            self.reset();
        }
        let mut enqueued = false;
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
                let mut has_changes = false;
                let mut cleared_error = false;
                if paused {
                    self.scanners[index] = Some(AgentScanner::for_worker(
                        self.sources[index].clone(),
                        self.path.clone(),
                    ));
                    *self.changes[index]
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) = PendingChange::Full;
                } else {
                    let result = result.and_then(|mut batch| {
                        let batch_enqueued = !batch.sessions.is_empty();
                        let batch_changed = batch_enqueued || !batch.removed.is_empty();
                        store.save_batch(agent, &mut batch)?;
                        if let Some(presence) = batch.source_presence.clone() {
                            self.source_statuses
                                .entry(agent.clone())
                                .or_default()
                                .collected(presence, batch.complete);
                        }
                        Ok((batch_enqueued, batch_changed))
                    });
                    match result {
                        Ok((batch_enqueued, batch_changed)) => {
                            enqueued |= batch_enqueued;
                            has_changes = batch_changed;
                            cleared_error = self.errors.remove(agent).is_some();
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
                if !paused && (has_changes || complete) {
                    self.reclaim_memory();
                }
                let finished_at = Instant::now();
                self.schedules[index] = Schedule {
                    next_scan: finished_at + RESCAN_INTERVAL,
                    unfinished: !paused && !failed && !complete,
                    failed,
                    initialized: !paused && !failed && complete,
                    idle_release_at: (!paused && !failed)
                        .then_some(finished_at + IDLE_RELEASE_DELAY),
                };
                if !paused && self.errors.is_empty() {
                    let should_record = has_changes
                        || cleared_error
                        || self.last_success_recorded.is_none_or(|at| {
                            finished_at.saturating_duration_since(at) >= SUCCESS_RECORD_INTERVAL
                        });
                    if should_record {
                        store.record_scan_success()?;
                        self.last_success_recorded = Some(finished_at);
                    }
                }
                self.cursor = (index + 1) % self.sources.len();
            }
        }
        if paused || self.pending.is_some() || self.sources.is_empty() {
            return Ok(enqueued);
        }
        let now = Instant::now();
        let Some(index) = (0..self.sources.len())
            .map(|offset| (self.cursor + offset) % self.sources.len())
            .find(|index| self.due(*index, now))
        else {
            return Ok(enqueued);
        };
        let checkpoint = store.checkpoint(&self.sources[index].agent)?;
        let paths = self.take_paths(index, self.schedules[index], checkpoint.is_some());
        let mut scanner = self.scanners[index].take().unwrap();
        let wake = self.wake.clone();
        self.pending = Some((
            index,
            self.generation,
            tokio::task::spawn_blocking(move || {
                let result = scanner.refresh_with_checkpoint(paths.as_deref(), checkpoint.as_ref());
                wake.notify_one();
                (scanner, result)
            }),
        ));
        Ok(enqueued)
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
                antigravity_profiles: None,
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
            completion: None,
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

    fn write_codex_session(dir: &std::path::Path, id: &str, text: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(format!("rollout-2026-09-01T00-00-00-{id}.jsonl"));
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "timestamp": "2026-09-01T00:00:00Z",
                    "payload": {"id": id, "cwd": "/fixture"}
                }),
                serde_json::json!({
                    "type": "response_item",
                    "timestamp": "2026-09-01T00:00:01Z",
                    "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}
                }),
            ),
        )
        .unwrap();
        path
    }

    #[tokio::test]
    async fn watcher_paths_run_targeted_incremental_scan_and_overflow_upgrades_to_full() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("worker.db");
        let mut store = WorkerStore::open(&path).unwrap();
        let codex_root = dir.path().join("codex");
        let sessions = codex_root.join("sessions");
        let first = write_codex_session(
            &sessions,
            "019f0000-0000-0000-0000-000000000001",
            "First session",
        );
        let second = write_codex_session(
            &sessions,
            "019f0000-0000-0000-0000-000000000002",
            "Second session",
        );
        let source = AgentSource {
            antigravity_profiles: None,
            agent: "codex".into(),
            data_root: codex_root,
            scan_path: sessions.clone(),
        };
        let mut scanning = Scanning::new(vec![source], path);

        scanning.changes = Arc::new([Mutex::new(PendingChange::Full)]);

        // Initial scan runs full page mode and initializes the source.
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        finish(&scanning).await;
        assert!(scanning.tick(&mut store, false).await.unwrap());
        assert!(scanning.schedules[0].initialized);
        assert_eq!(store.queue_status().unwrap().batches, 4);

        // Make an unrelated compressed rollout unreadable; a targeted scan of `first` must not touch it.
        let broken = second.with_extension("jsonl.zst");
        std::fs::remove_file(&second).unwrap();
        std::fs::write(&broken, b"not valid zstd").unwrap();
        write_codex_session(
            &sessions,
            "019f0000-0000-0000-0000-000000000001",
            "First session updated with targeted path",
        );

        // Record a targeted watcher path for `first` only and make it due immediately.
        *scanning.changes[0].lock().unwrap() = PendingChange::None;
        scanning.changes[0]
            .lock()
            .unwrap()
            .record(Some(vec![first.clone()]));
        scanning.schedules[0].next_scan = Instant::now();

        assert!(!scanning.tick(&mut store, false).await.unwrap());
        finish(&scanning).await;
        assert!(scanning.tick(&mut store, false).await.unwrap());
        assert!(scanning.error().is_none());

        // Over 1024 tracked paths or an explicit `None` rescan upgrades to `Full`.
        let mut pending = PendingChange::None;
        let many: Vec<_> = (0..=MAX_TRACKED_PATHS)
            .map(|i| sessions.join(format!("rollout-{i}.jsonl")))
            .collect();
        pending.record(Some(many));
        assert_eq!(pending, PendingChange::Full);

        // During unfinished backfill, `Full` stays queued while `Paths` are forwarded as hints.
        let mut unfinished = scanning.schedules[0];
        unfinished.unfinished = true;
        *scanning.changes[0].lock().unwrap() = PendingChange::Full;
        assert_eq!(scanning.take_paths(0, unfinished, true), None);
        assert_eq!(*scanning.changes[0].lock().unwrap(), PendingChange::Full);
    }

    #[tokio::test]
    async fn database_events_during_backfill_schedule_another_paged_scan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.db");
        let source = AgentSource {
            agent: "opencode".into(),
            data_root: dir.path().into(),
            scan_path: path.clone(),
            antigravity_profiles: None,
        };
        let mut scanning = Scanning::new(vec![source], dir.path().join("worker.db"));
        scanning.changes = Arc::new([Mutex::new(PendingChange::Paths(BTreeSet::from([path])))]);
        let mut schedule = scanning.schedules[0];
        schedule.unfinished = true;
        assert_eq!(scanning.take_paths(0, schedule, true), None);
        assert!(scanning.has_pending_change(0));
        schedule.unfinished = false;
        schedule.initialized = true;
        assert_eq!(scanning.take_paths(0, schedule, false), None);
        assert!(!scanning.has_pending_change(0));
        scanning.watching = None;
        assert_eq!(scanning.take_paths(0, schedule, false), None);
    }

    #[tokio::test]
    async fn unchanged_scans_throttle_last_scan_success_and_go_idle_without_polling() {
        let (_dir, mut scanning, mut store) = fixture();
        // Complete initial scan for both sources; first success records timestamp.
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        finish(&scanning).await;
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        let first_recorded = store.last_scan_success().unwrap().unwrap();
        finish(&scanning).await;
        assert!(!scanning.tick(&mut store, false).await.unwrap());

        // Trigger another unchanged scan immediately after: timestamp must not be rewritten within 60s.
        tokio::time::sleep(Duration::from_millis(15)).await;
        scanning.changes[0].lock().unwrap().record(None);
        scanning.schedules[0].next_scan = Instant::now();
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        finish(&scanning).await;
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        assert_eq!(store.last_scan_success().unwrap().unwrap(), first_recorded);

        // Once the throttle window elapses, an unchanged scan refreshes `last_scan_success`.
        scanning.last_success_recorded =
            Some(Instant::now() - SUCCESS_RECORD_INTERVAL - Duration::from_secs(1));
        scanning.changes[0].lock().unwrap().record(None);
        scanning.schedules[0].next_scan = Instant::now();
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        finish(&scanning).await;
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        assert!(store.last_scan_success().unwrap().unwrap() > first_recorded);

        // After idle release fires and no changes are pending, `next_wake` stops waking the loop.
        tokio::time::sleep(IDLE_RELEASE_DELAY + Duration::from_millis(15)).await;
        scanning.last_reclaim = Some(Instant::now());
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        let due = scanning.reclaim_due.unwrap();
        assert_eq!(scanning.next_wake(false), Some(due));
        scanning.last_reclaim = Some(Instant::now() - RECLAIM_INTERVAL);
        scanning.reclaim_due = Some(Instant::now());
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        assert_eq!(scanning.next_wake(false), None);

        // Error recovery immediately refreshes `last_scan_success` even inside the 60s window.
        let before_recovery = store.last_scan_success().unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(15)).await;
        let scanner = scanning.scanners[0].take().unwrap();
        scanning.errors.insert("codex".into(), "transient".into());
        scanning.pending = Some((
            0,
            scanning.generation,
            tokio::spawn(async move { (scanner, Ok(batch())) }),
        ));
        finish(&scanning).await;
        assert!(!scanning.tick(&mut store, false).await.unwrap());
        assert!(scanning.error().is_none());
        assert!(store.last_scan_success().unwrap().unwrap() > before_recovery);
    }
}
