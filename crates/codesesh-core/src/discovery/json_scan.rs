use super::{AgentSource, ScanOptions};
use crate::{
    agents,
    model::{SessionHead, SessionIndex},
    pricing::Pricing,
    projects::{
        compute_identity_projection_with_context, create_project_scope_matcher,
        matches_project_scope,
    },
    session_list::filter_activity_window,
    storage::Cache,
};
use anyhow::{Result, bail};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{Duration, Instant},
};

fn signature(source: &AgentSource) -> Result<String> {
    Ok(serde_json::to_string(&(
        "json-index-v1",
        env!("CARGO_PKG_VERSION"),
        agents::parser_version(&source.agent),
        &source.scan_path,
        &source.data_root,
        &source.antigravity_profiles,
        super::source_inventory_signature(source)?,
    ))?)
}
fn project_identities_current(heads: &[SessionHead]) -> bool {
    heads.iter().all(|head| {
        let mut local = head.clone();
        local.set_source_node("local");
        let head = &local;
        let projection = compute_identity_projection_with_context(
            &head.directory,
            &head.recorded_git_remotes,
            Some((
                &head.project_identity,
                head.project_identity_input_signature.as_deref(),
            )),
        );
        projection.identity == head.project_identity
            && head.project_identity_resolver_revision.as_deref()
                == Some(&projection.resolver_revision)
            && head.project_identity_input_signature.as_deref() == Some(&projection.input_signature)
    })
}
fn source_present(source: &AgentSource) -> Result<bool> {
    if let Some(path) = agents::database_path(&source.agent, &source.scan_path) {
        return Ok(path.try_exists()?);
    }
    for root in source.scan_roots()? {
        if root.try_exists()? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn output(mut heads: Vec<SessionHead>, options: &ScanOptions) -> SessionIndex {
    if let Some(cwd) = options.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        let scope = create_project_scope_matcher(cwd);
        heads.retain(|head| matches_project_scope(head, &scope));
    }
    heads = filter_activity_window(&heads, options.from, options.to);
    heads.sort_by(|left, right| right.time_updated.total_cmp(&left.time_updated));
    for head in &mut heads {
        head.recorded_git_remotes.clear();
    }
    let mut counts = HashMap::new();
    for head in &heads {
        *counts.entry(head.reference.agent_name.clone()).or_default() += 1;
    }
    SessionIndex {
        agents: agents::catalog_counts(&counts),
        sessions: heads,
    }
}
/// Scans `sources` into the cache at `path` and returns the filtered index, reusing cached
/// sessions of sources whose inventory is unchanged. `record` receives per-agent timings.
pub fn run(
    sources: &[AgentSource],
    options: &ScanOptions,
    pricing: &Pricing,
    path: &Path,
    node: &str,
    mut record: impl FnMut(String, Duration),
) -> Result<SessionIndex> {
    let mut cache = Cache::open(Some(path))?;
    for source in sources {
        cache.reprice(&source.agent, pricing)?;
    }
    for _ in 0..3 {
        let baseline = cache.source_json_baseline(node)?;
        let mut previous = HashMap::<String, Vec<SessionHead>>::new();
        for head in baseline.heads {
            previous
                .entry(head.reference.agent_name.clone())
                .or_default()
                .push(head);
        }
        let mut heads = Vec::new();
        let mut sessions = Vec::new();
        let mut removed = Vec::new();
        let mut fingerprints = Vec::new();
        let mut failures = Vec::new();
        let mut needs_publication = false;
        for source in sources {
            let old = previous.remove(&source.agent).unwrap_or_default();
            let agent_started = Instant::now();
            let read = (|| -> Result<()> {
                if !old.is_empty() && !source_present(source)? {
                    bail!("Agent source is unavailable; retaining cached sessions");
                }
                let before = format!("{node}:{}", signature(source)?);
                if baseline.fingerprints.get(&source.agent) == Some(&before)
                    && project_identities_current(&old)
                {
                    heads.extend(old.iter().cloned());
                    fingerprints.push((source.agent.clone(), before));
                    record(
                        format!("agent:{}:cache", source.agent),
                        agent_started.elapsed(),
                    );
                    return Ok(());
                }
                let scan_started = Instant::now();
                let cached_sources = agents::jsonl::CachedSources {
                    paths: old
                        .iter()
                        .filter_map(|head| {
                            baseline.source_paths.get(&head.reference).map(Path::new)
                        })
                        .collect(),
                    damaged: Some(Default::default()),
                };
                let scanned = super::scan_source_raw(source, pricing, &cached_sources);
                record(
                    format!("agent:{}:scan", source.agent),
                    scan_started.elapsed(),
                );
                let mut scanned = scanned?;
                let damaged = cached_sources.damaged.unwrap().into_inner();
                let previous_identities: HashMap<_, _> = old
                    .iter()
                    .map(|head| {
                        let mut local = head.clone();
                        local.set_source_node("local");
                        (
                            local.reference,
                            (
                                local.project_identity,
                                local.project_identity_input_signature,
                            ),
                        )
                    })
                    .collect();
                for session in &mut scanned.sessions {
                    let previous = previous_identities
                        .get(&session.head.reference)
                        .map(|(identity, signature)| (identity, signature.as_deref()));
                    agents::complete_projections_with_previous(session, previous);
                    session.set_source_node(node);
                }
                let mut references: HashSet<_> = scanned
                    .sessions
                    .iter()
                    .map(|session| session.head.reference.clone())
                    .collect();
                if !damaged.is_empty() {
                    let scanned_by_id: HashMap<_, _> = scanned
                        .sessions
                        .iter()
                        .map(|session| (session.head.reference.session_id.as_str(), session))
                        .collect();
                    for head in old
                        .iter()
                        .filter(|head| damaged.contains(&head.reference.session_id))
                    {
                        let id = &head.reference.session_id;
                        let Some(session) = scanned_by_id.get(id.as_str()) else {
                            bail!("Malformed JSONL in session {id}; retaining cached messages");
                        };
                        let previous = cache
                            .detail(head.clone())?
                            .ok_or_else(|| anyhow::anyhow!("Cached session body is unavailable"))?;
                        // Cold scans accept good records around a bad line. Compare published
                        // messages after the same normalization used to create the cached body.
                        let next = &session.detail.messages;
                        anyhow::ensure!(
                            next.len() >= previous.messages.len()
                                && previous
                                    .messages
                                    .iter()
                                    .zip(next)
                                    .all(|(old, new)| old.id == new.id
                                        && old.role == new.role
                                        && old.parts == new.parts),
                            "Malformed JSONL in {}; retaining cached messages",
                            session.source.display()
                        );
                    }
                }
                if agents::database_path(&source.agent, &source.scan_path).is_none() {
                    for head in &old {
                        if references.contains(&head.reference) {
                            continue;
                        }
                        let Some(path) = baseline.source_paths.get(&head.reference).map(Path::new)
                        else {
                            continue;
                        };
                        if source.retains_missing_source(path)? {
                            references.insert(head.reference.clone());
                            heads.push(head.clone());
                        } else if path.try_exists()? {
                            bail!(
                                "Previously cached session could not be parsed from {}; retaining cached sessions",
                                path.display()
                            );
                        }
                    }
                }
                removed.extend(
                    old.iter()
                        .filter(|head| !references.contains(&head.reference))
                        .map(|head| head.reference.clone()),
                );
                heads.extend(scanned.sessions.iter().map(|session| session.head.clone()));
                sessions.extend(scanned.sessions);
                // The pre-scan fingerprint: if an agent wrote during the scan, the next run no longer
                // matches it and scans the source again.
                fingerprints.push((source.agent.clone(), before));
                needs_publication = true;
                Ok(())
            })();
            if let Err(error) = read {
                failures.push(format!(
                    "[{}] Scan failed at {}: {error:#}",
                    source.agent,
                    source.scan_path.display()
                ));
            }
        }
        if needs_publication
            && !cache.apply_json_index(
                &mut sessions,
                &removed,
                &fingerprints,
                &baseline.revision,
            )?
        {
            continue;
        }
        if !failures.is_empty() {
            bail!("{}", failures.join("\n"));
        }
        return Ok(output(heads, options));
    }
    bail!(
        "Cache changed repeatedly during the JSON scan; retry after the active publication completes"
    )
}

#[cfg(test)]
mod tests;
