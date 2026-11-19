use super::{Cancellation, Event, ScanBatch, ScanStatus};
use crate::wire::{PricingHistoryPhase, PricingHistoryStatus};
use crate::{model::SessionHead, storage::Cache};
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
        phase: crate::wire::AgentScanPhase,
        error: Option<String>,
    },
    HubControl(Box<dyn FnOnce(&mut Cache) + Send>),
    Reprice {
        pricing: crate::pricing::PricingSnapshot,
        response: oneshot::Sender<Result<bool>>,
    },
    Upload {
        credential: String,
        upload: crate::sync::Upload,
        pricing: crate::pricing::PricingSnapshot,
        response: oneshot::Sender<Result<crate::sync::Receipt>>,
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
    retain_history: bool,
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
    let mut unpublished_heads = Vec::new();
    while let Some(command) = commands.blocking_recv() {
        match command {
            Command::HubControl(operation) => operation(&mut cache),
            Command::Reprice { pricing, response } => {
                let result = pricing.with_latest(|active_pricing| {
                    let generation = active_pricing.generation();
                    if statuses
                        .borrow()
                        .pricing_history
                        .as_ref()
                        .is_none_or(|previous| {
                            previous.generation != generation
                                || previous.phase == PricingHistoryPhase::Failed
                        })
                    {
                        publish_pricing_status(
                            &statuses,
                            &events,
                            generation,
                            PricingHistoryPhase::Repricing,
                        );
                    }
                    let mut result =
                        cache
                            .reprice_batch(active_pricing)
                            .map(|(changed, complete)| {
                                unpublished_heads.extend(changed);
                                complete
                            });
                    if !matches!(result, Ok(false))
                        && let Err(error) = publish_changes(
                            &cache,
                            &snapshots,
                            &events,
                            &mut unpublished_heads,
                            Vec::new(),
                        )
                    {
                        result = Err(error);
                    }
                    let phase = match &result {
                        Ok(true) => PricingHistoryPhase::Current,
                        Ok(false) => PricingHistoryPhase::Repricing,
                        Err(_) => PricingHistoryPhase::Failed,
                    };
                    publish_pricing_status(&statuses, &events, generation, phase);
                    result
                });
                let _ = response.send(result);
            }
            Command::Upload {
                credential,
                upload,
                pricing,
                response,
            } => {
                let result = pricing.with_latest(|active_pricing| {
                    let node = cache.authenticate_worker(&credential)?;
                    let receipt = cache.receive_upload(&node, &upload, active_pricing)?;
                    if let Some(reference) = &receipt.changed {
                        unpublished_heads.push(reference.clone());
                        publish_changes(
                            &cache,
                            &snapshots,
                            &events,
                            &mut unpublished_heads,
                            Vec::new(),
                        )?;
                    }
                    Ok(receipt)
                });
                let _ = response.send(result);
            }
            Command::Publish {
                agent,
                mut batch,
                cancellation,
                response,
            } => {
                if retain_history {
                    batch.removed.clear();
                }
                let pricing = batch.pricing.take();
                let mut publish = |active_pricing: Option<&crate::pricing::Pricing>| -> Result<()> {
                    cancellation.check()?;
                    let write_started = Instant::now();
                    if let Some(active_pricing) = active_pricing {
                        for session in &mut batch.sessions {
                            crate::storage::reprice_session(session, active_pricing);
                        }
                    }
                    cache.apply_checkpoint(
                        &mut batch.sessions,
                        &batch.removed,
                        &agent,
                        &batch.checkpoint,
                        batch.complete,
                    )?;
                    let write_elapsed = write_started.elapsed();
                    let snapshot_started = Instant::now();
                    batch.on_reject.take();
                    if !batch.sessions.is_empty() || !batch.removed.is_empty() {
                        unpublished_heads.extend(
                            batch
                                .sessions
                                .iter()
                                .map(|session| session.head.reference.clone()),
                        );
                        publish_changes(
                            &cache,
                            &snapshots,
                            &events,
                            &mut unpublished_heads,
                            std::mem::take(&mut batch.removed),
                        )?;
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
                    let progress = batch.checkpoint.as_ref().and_then(|checkpoint| {
                        Some(super::status::ScanProgress {
                            phase: if checkpoint["incremental"] == true {
                                crate::wire::BackfillPhase::Checking
                            } else {
                                crate::wire::BackfillPhase::Scanning
                            },
                            processed: checkpoint["offset"].as_u64()? as usize,
                            total: checkpoint["total"].as_u64()? as usize,
                        })
                    });
                    status.published(
                        &agent,
                        batch.complete,
                        batch.source_presence.clone(),
                        progress,
                    );
                    let status = Arc::new(status);
                    statuses.send_replace(status.clone());
                    let _ = events.send(Event::Status(status));
                    Ok(())
                };
                let result = match &pricing {
                    Some(ticket) => {
                        ticket.with_latest(|active_pricing| publish(Some(active_pricing)))
                    }
                    None => publish(None),
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
                phase,
                error,
            } => {
                let count = snapshots
                    .borrow()
                    .iter()
                    .filter(|head| head.reference.agent_name == agent)
                    .count();
                let mut status = statuses.borrow().as_ref().clone();
                status.update(&agent, phase, error, count);
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
        match cache.release_index_memory() {
            Ok(true) => {
                release_unused_memory();
                last_reclaim = Instant::now();
            }
            Ok(false) => {}
            Err(error) => eprintln!("codesesh: cannot release index memory: {error:#}"),
        }
    }
}

fn publish_pricing_status(
    statuses: &watch::Sender<Arc<ScanStatus>>,
    events: &broadcast::Sender<Event>,
    generation: u64,
    phase: PricingHistoryPhase,
) {
    let history = PricingHistoryStatus { generation, phase };
    if statuses.borrow().pricing_history.as_ref() == Some(&history) {
        return;
    }
    let mut status = statuses.borrow().as_ref().clone();
    status.pricing_history = Some(history);
    status.updated_at = chrono::Utc::now().timestamp_millis();
    let status = Arc::new(status);
    statuses.send_replace(status.clone());
    let _ = events.send(Event::Status(status));
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

fn publish_changes(
    cache: &Cache,
    snapshots: &watch::Sender<Arc<Vec<SessionHead>>>,
    events: &broadcast::Sender<Event>,
    references: &mut Vec<crate::model::SessionReference>,
    removed: Vec<crate::model::SessionReference>,
) -> Result<()> {
    if references.is_empty() && removed.is_empty() {
        return Ok(());
    }
    let heads = Arc::new(cache.refresh_snapshot(snapshots.borrow().as_ref(), references)?);
    let changed_references: std::collections::HashSet<_> = references.iter().collect();
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
        removed: Arc::new(removed),
    });
    references.clear();
    Ok(())
}
