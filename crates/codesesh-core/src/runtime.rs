mod status;
mod watcher;
mod writer;

use crate::{
    agents::codex::ParsedSession,
    contract::{SessionHead, SessionReference},
};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, broadcast, mpsc, oneshot, watch};

pub use status::{AgentStatus, ScanStatus};

pub type Scanner = dyn Fn(ScanRequest) -> Result<ScanBatch> + Send + Sync;

pub struct AgentSource {
    pub name: String,
    pub roots: Vec<PathBuf>,
    pub scan: Arc<Scanner>,
}

#[derive(Clone)]
pub struct Cancellation {
    stopped: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    expected: u64,
}

impl Cancellation {
    pub fn is_cancelled(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
            || self.generation.load(Ordering::Acquire) != self.expected
    }

    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            bail!("scan generation cancelled");
        }
        Ok(())
    }
}

pub struct ScanRequest {
    pub changed_paths: Option<Vec<PathBuf>>,
    pub checkpoint: Option<Value>,
    pub cancellation: Cancellation,
}

pub struct ScanBatch {
    pub sessions: Vec<ParsedSession>,
    pub removed: Vec<SessionReference>,
    pub checkpoint: Option<Value>,
    pub complete: bool,
    pub on_reject: Option<Box<dyn FnOnce() + Send>>,
    pub pricing: Option<crate::pricing::PricingSnapshot>,
}

impl Drop for ScanBatch {
    fn drop(&mut self) {
        if let Some(reject) = self.on_reject.take() {
            reject();
        }
    }
}

#[derive(Clone, Debug)]
pub enum Event {
    Sessions {
        snapshot: Arc<Vec<SessionHead>>,
        changed: Arc<Vec<SessionHead>>,
        removed: Arc<Vec<SessionReference>>,
    },
    Status(Arc<ScanStatus>),
}

#[derive(Debug)]
pub struct ReadBusy;

impl std::fmt::Display for ReadBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("database readers are busy")
    }
}
impl std::error::Error for ReadBusy {}

#[derive(Clone)]
pub struct Runtime {
    inner: Arc<Inner>,
}

struct Inner {
    cache_path: PathBuf,
    snapshots: watch::Receiver<Arc<Vec<SessionHead>>>,
    statuses: watch::Receiver<Arc<ScanStatus>>,
    events: broadcast::Sender<Event>,
    writer: mpsc::Sender<writer::Command>,
    controls: Vec<Control>,
    readers: Arc<Semaphore>,
    idle_readers: Mutex<Vec<Connection>>,
    read_queue: Arc<Semaphore>,
    stopped: Arc<AtomicBool>,
    shutdown: watch::Sender<bool>,
}

struct Control {
    name: String,
    roots: Vec<PathBuf>,
    generation: Arc<AtomicU64>,
    pending: watch::Sender<Pending>,
}

#[derive(Clone, Default)]
struct Pending {
    generation: u64,
    paths: Option<BTreeSet<PathBuf>>,
}

impl Runtime {
    pub async fn start(
        cache_path: PathBuf,
        sources: Vec<AgentSource>,
        concurrency: usize,
    ) -> Result<Self> {
        if concurrency == 0 {
            bail!("runtime concurrency must be positive");
        }
        let stopped = Arc::new(AtomicBool::new(false));
        let (shutdown, _) = watch::channel(false);
        let (events, _) = broadcast::channel(128);
        let (snapshots_tx, snapshots) = watch::channel(Arc::new(Vec::new()));
        let (statuses_tx, statuses) = watch::channel(Arc::new(ScanStatus::new(
            sources.iter().map(|source| source.name.clone()),
        )));
        let (writer, receiver) = mpsc::channel(16);
        let (ready_tx, ready_rx) = oneshot::channel();
        let path = cache_path.clone();
        let writer_events = events.clone();
        std::thread::Builder::new()
            .name("codesesh-sqlite-writer".into())
            .spawn(move || {
                writer::run(
                    path,
                    receiver,
                    snapshots_tx,
                    statuses_tx,
                    writer_events,
                    ready_tx,
                );
            })?;
        ready_rx
            .await
            .context("SQLite writer exited during startup")??;
        let controls: Vec<_> = sources
            .iter()
            .map(|source| {
                let (pending, _) = watch::channel(Pending::default());
                Control {
                    name: source.name.clone(),
                    roots: source.roots.clone(),
                    generation: Arc::new(AtomicU64::new(0)),
                    pending,
                }
            })
            .collect();
        let runtime = Self {
            inner: Arc::new(Inner {
                cache_path,
                snapshots,
                statuses,
                events,
                writer,
                controls,
                readers: Arc::new(Semaphore::new(concurrency)),
                idle_readers: Mutex::new(Vec::with_capacity(concurrency)),
                read_queue: Arc::new(Semaphore::new(64)),
                stopped,
                shutdown,
            }),
        };
        let scanners = Arc::new(Semaphore::new(concurrency));
        for (index, source) in sources.into_iter().enumerate() {
            let runtime = runtime.clone();
            let scans = scanners.clone();
            tokio::spawn(async move {
                runtime.agent_loop(index, source, scans).await;
            });
        }
        if let Err(error) = runtime.watch_sources() {
            let _ = runtime.shutdown().await;
            return Err(error);
        }
        Ok(runtime)
    }

    pub fn shutdown_receiver(&self) -> watch::Receiver<bool> {
        self.inner.shutdown.subscribe()
    }

    pub fn snapshot(&self) -> Arc<Vec<SessionHead>> {
        self.inner.snapshots.borrow().clone()
    }
    pub fn status(&self) -> Arc<ScanStatus> {
        self.inner.statuses.borrow().clone()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }
    pub fn snapshots(&self) -> watch::Receiver<Arc<Vec<SessionHead>>> {
        self.inner.snapshots.clone()
    }
    pub fn statuses(&self) -> watch::Receiver<Arc<ScanStatus>> {
        self.inner.statuses.clone()
    }

    pub fn refresh_all(&self) {
        for control in &self.inner.controls {
            Self::invalidate(control, None, true);
        }
    }

    pub fn refresh(&self, agent: &str) -> Result<()> {
        let Some(control) = self
            .inner
            .controls
            .iter()
            .find(|control| control.name == agent)
        else {
            bail!("unknown agent {agent}");
        };
        Self::invalidate(control, None, true);
        Ok(())
    }

    pub async fn read_snapshot<T: Send + 'static>(
        &self,
        query: impl FnOnce(&Connection, &[SessionHead]) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        self.read(move |connection| {
            let heads = crate::storage::snapshot_from_connection(connection)?;
            query(connection, &heads)
        })
        .await
    }

    pub async fn read<T: Send + 'static>(
        &self,
        query: impl FnOnce(&Connection) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let queued = self
            .inner
            .read_queue
            .clone()
            .try_acquire_owned()
            .map_err(|_| ReadBusy)?;
        let permit = self.inner.readers.clone().acquire_owned().await?;
        drop(queued);
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let connection = inner
                .idle_readers
                .lock()
                .map_err(|_| anyhow::anyhow!("SQLite reader pool poisoned"))?
                .pop();
            let connection = match connection {
                Some(connection) => connection,
                None => {
                    let connection = Connection::open_with_flags(
                        &inner.cache_path,
                        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                    )?;
                    connection.busy_timeout(Duration::from_secs(5))?;
                    connection.execute_batch("PRAGMA query_only=ON")?;
                    connection
                }
            };
            connection.execute_batch("BEGIN DEFERRED")?;
            let result = query(&connection);
            let rollback = if connection.is_autocommit() {
                Ok(())
            } else {
                connection.execute_batch("ROLLBACK")
            };
            if rollback.is_ok() {
                inner
                    .idle_readers
                    .lock()
                    .map_err(|_| anyhow::anyhow!("SQLite reader pool poisoned"))?
                    .push(connection);
            }
            let value = result?;
            rollback.context("failed to release SQLite read snapshot")?;
            Ok(value)
        })
        .await?
    }

    pub async fn shutdown(&self) -> Result<()> {
        if self.inner.stopped.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        self.inner.shutdown.send_replace(true);
        for control in &self.inner.controls {
            control.generation.fetch_add(1, Ordering::AcqRel);
        }
        let (tx, rx) = oneshot::channel();
        self.inner
            .writer
            .send(writer::Command::Stop(tx))
            .await
            .map_err(|_| anyhow::anyhow!("SQLite writer stopped"))?;
        rx.await
            .context("SQLite writer failed to acknowledge shutdown")?
    }

    fn invalidate(control: &Control, paths: Option<Vec<PathBuf>>, cancel: bool) {
        if cancel {
            control.generation.fetch_add(1, Ordering::AcqRel);
        }
        control.pending.send_modify(|pending| {
            pending.generation = pending.generation.wrapping_add(1);
            match (&mut pending.paths, paths) {
                (Some(existing), Some(paths)) => {
                    existing.extend(paths);
                    if existing.len() > 1024 {
                        pending.paths = None;
                    }
                }
                (_, None) => pending.paths = None,
                (None, Some(_)) => (),
            }
        });
    }

    async fn agent_loop(&self, index: usize, source: AgentSource, scans: Arc<Semaphore>) {
        let control = &self.inner.controls[index];
        let mut pending = control.pending.subscribe();
        let mut shutdown = self.inner.shutdown.subscribe();
        let mut first = true;
        loop {
            if !first {
                tokio::select! { result = pending.changed() => if result.is_err() { return; }, _ = shutdown.changed() => return }
                tokio::select! { _ = tokio::time::sleep(Duration::from_millis(150)) => (), _ = shutdown.changed() => return }
            }
            first = false;
            if self.inner.stopped.load(Ordering::Acquire) {
                return;
            }
            let request = take_pending(control, &mut pending);
            let cancellation = Cancellation {
                stopped: self.inner.stopped.clone(),
                generation: control.generation.clone(),
                expected: control.generation.load(Ordering::Acquire),
            };
            let mut checkpoint = match self.checkpoint(&source.name).await {
                Ok(value) => value,
                Err(error) => {
                    self.report(&source.name, "failed", Some(error.to_string()))
                        .await;
                    continue;
                }
            };
            let mut changed_paths = request.paths.map(|paths| paths.into_iter().collect());
            let mut prefetched = None;
            loop {
                if cancellation.is_cancelled() {
                    break;
                }
                self.report(&source.name, "scanning", None).await;
                let task = match prefetched.take() {
                    Some(task) => task,
                    None => {
                        let permit = tokio::select! { permit = scans.clone().acquire_owned() => match permit { Ok(permit) => permit, Err(_) => return }, _ = shutdown.changed() => return };
                        spawn_scan(
                            source.scan.clone(),
                            ScanRequest {
                                changed_paths: changed_paths.take(),
                                checkpoint: checkpoint.clone(),
                                cancellation: cancellation.clone(),
                            },
                            permit,
                        )
                    }
                };
                let result = task.await;
                let (result, permit) = match result {
                    Ok((result, permit, elapsed)) => {
                        if std::env::var_os("CODESESH_PROFILE_SCAN").is_some() {
                            eprintln!(
                                "scan-profile parse agent={} ms={:.3}",
                                source.name,
                                elapsed.as_secs_f64() * 1000.0
                            );
                        }
                        (Ok(result), Some(permit))
                    }
                    Err(error) => (Err(error), None),
                };
                let batch = match result {
                    Ok(Ok(batch)) => batch,
                    error => {
                        if !cancellation.is_cancelled() {
                            self.report(
                                &source.name,
                                "failed",
                                Some(match error {
                                    Ok(Err(error)) => error.to_string(),
                                    Err(error) => error.to_string(),
                                    _ => unreachable!(),
                                }),
                            )
                            .await;
                        }
                        break;
                    }
                };
                if cancellation.is_cancelled() {
                    break;
                }
                if !batch.complete && (batch.checkpoint.is_none() || batch.checkpoint == checkpoint)
                {
                    self.report(
                        &source.name,
                        "failed",
                        Some("incomplete scan did not advance its durable checkpoint".into()),
                    )
                    .await;
                    break;
                }
                checkpoint = batch.checkpoint.clone();
                let complete = batch.complete;
                self.report(&source.name, "publishing", None).await;
                let (tx, rx) = oneshot::channel();
                if self
                    .inner
                    .writer
                    .send(writer::Command::Publish {
                        agent: source.name.clone(),
                        batch,
                        cancellation: cancellation.clone(),
                        response: tx,
                    })
                    .await
                    .is_err()
                {
                    return;
                }
                if !complete
                    && changed_paths.is_none()
                    && !pending.has_changed().unwrap_or(false)
                    && let Ok(next_permit) = scans.clone().try_acquire_owned()
                {
                    prefetched = Some(spawn_scan(
                        source.scan.clone(),
                        ScanRequest {
                            changed_paths: None,
                            checkpoint: checkpoint.clone(),
                            cancellation: cancellation.clone(),
                        },
                        next_permit,
                    ));
                }
                let publication = rx.await;
                drop(permit);
                match publication {
                    Ok(Ok(())) if complete => {
                        self.report(&source.name, "complete", None).await;
                        break;
                    }
                    Ok(Ok(())) => {
                        if prefetched.is_none() && pending.has_changed().unwrap_or(false) {
                            let pending_request = take_pending(control, &mut pending);
                            changed_paths = pending_request
                                .paths
                                .map(|paths| paths.into_iter().collect());
                        }
                    }
                    error => {
                        if !cancellation.is_cancelled() {
                            self.report(
                                &source.name,
                                "failed",
                                Some(format!("publication failed: {error:?}")),
                            )
                            .await;
                        }
                        break;
                    }
                }
            }
            if let Some(task) = prefetched {
                // Await and reject speculative work before restarting the same scanner.
                let _ = task.await;
            }
        }
    }

    async fn checkpoint(&self, agent: &str) -> Result<Option<Value>> {
        let agent = agent.to_owned();
        self.read(move |connection| {
            use rusqlite::OptionalExtension;
            let value: Option<String> = connection
                .query_row(
                    "SELECT value FROM cache_meta WHERE key=?",
                    [format!("rust_sync_checkpoint:{agent}")],
                    |row| row.get(0),
                )
                .optional()?;
            value
                .map(|value| serde_json::from_str(&value).map_err(Into::into))
                .transpose()
        })
        .await
    }

    async fn report(&self, agent: &str, state: &str, error: Option<String>) {
        let _ = self
            .inner
            .writer
            .send(writer::Command::Status {
                agent: agent.to_owned(),
                state: state.to_owned(),
                error,
            })
            .await;
    }
}

fn take_pending(control: &Control, receiver: &mut watch::Receiver<Pending>) -> Pending {
    let pending = receiver.borrow_and_update().clone();
    control.pending.send_if_modified(|value| {
        if value.generation == pending.generation {
            value.paths = Some(BTreeSet::new());
        }
        false
    });
    pending
}

#[cfg(test)]
mod tests;

fn spawn_scan(
    scan: Arc<Scanner>,
    request: ScanRequest,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> tokio::task::JoinHandle<(
    Result<ScanBatch>,
    tokio::sync::OwnedSemaphorePermit,
    Duration,
)> {
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let result = request.cancellation.check().and_then(|()| scan(request));
        (result, permit, started.elapsed())
    })
}
