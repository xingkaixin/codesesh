use super::{Cancellation, Event, ScanBatch, ScanStatus};
use crate::{contract::SessionHead, storage::Cache};
use anyhow::Result;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

pub(super) enum Command {
    Publish {
        agent: String,
        batch: ScanBatch,
        cancellation: Cancellation,
        response: oneshot::Sender<Result<()>>,
    },
    Status {
        agent: String,
        state: String,
        error: Option<String>,
    },
    Stop(oneshot::Sender<Result<()>>),
}

pub(super) fn run(
    path: PathBuf,
    mut commands: mpsc::Receiver<Command>,
    snapshots: watch::Sender<Arc<Vec<SessionHead>>>,
    statuses: watch::Sender<Arc<ScanStatus>>,
    events: broadcast::Sender<Event>,
    ready: oneshot::Sender<Result<(Duration, Duration)>>,
) {
    let started = Instant::now();
    let mut cache = match Cache::open(Some(&path)) {
        Ok(cache) => cache,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    let cache_open = started.elapsed();
    let started = Instant::now();
    match cache.snapshot() {
        Ok(heads) => {
            snapshots.send_replace(Arc::new(heads));
            let _ = ready.send(Ok((cache_open, started.elapsed())));
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    }
    let mut last_reclaim = Instant::now();
    let mut priced_generations = std::collections::HashMap::new();
    while let Some(command) = commands.blocking_recv() {
        match command {
            Command::Publish {
                agent,
                mut batch,
                cancellation,
                response,
            } => {
                let pricing = batch.pricing.take();
                let mut publish = || -> Result<()> {
                    cancellation.check()?;
                    let write_started = Instant::now();
                    if let Some(ticket) = &pricing {
                        for session in &mut batch.sessions {
                            crate::storage::reprice_session(session, &ticket.pricing);
                        }
                    }
                    cache.apply_checkpoint(
                        &mut batch.sessions,
                        &batch.removed,
                        &agent,
                        &batch.checkpoint,
                        batch.complete,
                    )?;
                    let mut repriced = Vec::new();
                    if let Some(ticket) = &pricing
                        && priced_generations.get(&agent) != Some(&ticket.generation())
                    {
                        repriced = cache.reprice(&agent, &ticket.pricing)?;
                        priced_generations.insert(agent.clone(), ticket.generation());
                    }
                    let write_elapsed = write_started.elapsed();
                    let snapshot_started = Instant::now();
                    batch.on_reject.take();
                    if !batch.sessions.is_empty()
                        || !batch.removed.is_empty()
                        || !repriced.is_empty()
                    {
                        let mut changed_references: Vec<_> = batch
                            .sessions
                            .iter()
                            .map(|session| session.head.reference.clone())
                            .collect();
                        changed_references.append(&mut repriced);
                        changed_references.sort_by(|a, b| {
                            a.agent_name
                                .cmp(&b.agent_name)
                                .then(a.session_id.cmp(&b.session_id))
                        });
                        changed_references.dedup();
                        let heads =
                            Arc::new(cache.refresh_snapshot(
                                snapshots.borrow().as_ref(),
                                &changed_references,
                            )?);
                        let changed_references: std::collections::HashSet<_> =
                            changed_references.iter().collect();
                        let changed = Arc::new(
                            heads
                                .iter()
                                .filter(|head| changed_references.contains(&head.reference))
                                .cloned()
                                .collect(),
                        );
                        snapshots.send_replace(heads.clone());
                        let _ = events.send(Event::Sessions {
                            snapshot: heads,
                            changed,
                            removed: Arc::new(std::mem::take(&mut batch.removed)),
                        });
                    }
                    if std::env::var_os("CODESESH_PROFILE_SCAN").is_some() {
                        eprintln!(
                            "scan-profile publish agent={} sessions={} write_ms={:.3} snapshot_ms={:.3}",
                            agent,
                            batch.sessions.len(),
                            write_elapsed.as_secs_f64() * 1000.0,
                            snapshot_started.elapsed().as_secs_f64() * 1000.0
                        );
                    }
                    let mut status = statuses.borrow().as_ref().clone();
                    if !batch.complete
                        || status
                            .backfill
                            .pending_agents
                            .iter()
                            .any(|name| name == &agent)
                    {
                        status.backfill(&agent, batch.complete);
                        if !batch.complete
                            && let Some(checkpoint) = &batch.checkpoint
                            && let (Some(processed), Some(total)) =
                                (checkpoint["offset"].as_u64(), checkpoint["total"].as_u64())
                        {
                            status.backfill.current_agent = Some(agent.clone());
                            status.backfill.progress = Some(super::status::ScanProgress {
                                phase: if checkpoint["incremental"] == true {
                                    "checking"
                                } else {
                                    "scanning"
                                },
                                processed: processed as usize,
                                total: total as usize,
                            });
                        }
                    }
                    if !batch.sessions.is_empty()
                        && !status
                            .search_index_maintenance
                            .completed_agents
                            .contains(&agent)
                    {
                        status
                            .search_index_maintenance
                            .completed_agents
                            .push(agent.clone());
                    }
                    let status = Arc::new(status);
                    statuses.send_replace(status.clone());
                    let _ = events.send(Event::Status(status));
                    Ok(())
                };
                let result = match &pricing {
                    Some(ticket) => ticket.with_current(publish),
                    None => publish(),
                };
                let complete = batch.complete;
                drop(batch);
                if complete || last_reclaim.elapsed() >= Duration::from_secs(1) {
                    release_unused_memory();
                    last_reclaim = Instant::now();
                }
                let _ = response.send(result);
            }
            Command::Status {
                agent,
                state,
                error,
            } => {
                let count = snapshots
                    .borrow()
                    .iter()
                    .filter(|head| head.reference.agent_name == agent)
                    .count();
                let mut status = statuses.borrow().as_ref().clone();
                status.update(&agent, state, error, count);
                let status = Arc::new(status);
                statuses.send_replace(status.clone());
                let _ = events.send(Event::Status(status));
            }
            Command::Stop(response) => {
                let result = cache
                    .connection()
                    .execute_batch("PRAGMA wal_checkpoint(PASSIVE)")
                    .map_err(Into::into);
                let _ = response.send(result);
                break;
            }
        }
    }
}

fn release_unused_memory() {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // NULL selects all allocator zones; zero asks to release unused pages after batch data is dropped.
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
    }
}
