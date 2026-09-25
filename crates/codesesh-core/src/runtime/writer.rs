use super::{Cancellation, Event, ScanBatch, ScanStatus};
use crate::{contract::SessionHead, storage::Cache};
use anyhow::Result;
use std::{path::PathBuf, sync::Arc};
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
    ready: oneshot::Sender<Result<()>>,
) {
    let mut cache = match Cache::open(Some(&path)) {
        Ok(cache) => cache,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };
    match cache.snapshot() {
        Ok(heads) => {
            snapshots.send_replace(Arc::new(heads));
            let _ = ready.send(Ok(()));
        }
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    }
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
                    cache.apply_checkpoint(
                        &mut batch.sessions,
                        &batch.removed,
                        &agent,
                        &batch.checkpoint,
                        batch.complete,
                    )?;
                    let heads = Arc::new(cache.snapshot()?);
                    batch.on_reject.take();
                    if !batch.sessions.is_empty() || !batch.removed.is_empty() {
                        let changed = Arc::new(
                            batch
                                .sessions
                                .iter()
                                .map(|session| session.head.clone())
                                .collect(),
                        );
                        snapshots.send_replace(heads.clone());
                        let _ = events.send(Event::Sessions {
                            snapshot: heads,
                            changed,
                            removed: Arc::new(std::mem::take(&mut batch.removed)),
                        });
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
                let result = match pricing {
                    Some(ticket) => ticket.with_current(publish),
                    None => publish(),
                };
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
