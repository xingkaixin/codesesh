use anyhow::{Result, bail};
use codesesh_core::{
    agents,
    contract::{SessionHead, SessionIndex},
    discovery::{self, AgentSource, ScanOptions},
    pricing::Pricing,
    projects::{compute_identity_projection, create_project_scope_matcher, matches_project_scope},
    query::filter_activity_window,
    storage::Cache,
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

fn signature(source: &AgentSource, pricing: &Pricing) -> Result<String> {
    Ok(serde_json::to_string(&(
        "json-index-v1",
        env!("CARGO_PKG_VERSION"),
        &source.scan_path,
        &source.data_root,
        pricing.generation(),
        discovery::source_inventory_signature(source)?,
    ))?)
}
fn project_identities_current(heads: &[SessionHead]) -> bool {
    let mut projections = HashMap::new();
    heads.iter().all(|head| {
        let projection = projections
            .entry(&head.directory)
            .or_insert_with(|| compute_identity_projection(&head.directory));
        projection.identity == head.project_identity
            && head.project_identity_resolver_revision.as_deref()
                == Some(&projection.resolver_revision)
            && head.project_identity_input_signature.as_deref() == Some(&projection.input_signature)
    })
}
fn source_present(source: &AgentSource) -> Result<bool> {
    let path = match source.agent.as_str() {
        "cursor" => source.scan_path.join("globalStorage/state.vscdb"),
        "zcode" => source.scan_path.join("cli/db/db.sqlite"),
        "deepchat" => source.scan_path.join("app_db/agent.db"),
        "cherrystudio" => source.scan_path.join("Data/cherrystudio.sqlite"),
        "minimax-code" => source.scan_path.join("v2/sqlite/runtime-state.sqlite"),
        _ => source.scan_path.clone(),
    };
    Ok(path.try_exists()?)
}
fn output(mut heads: Vec<SessionHead>, options: &ScanOptions) -> SessionIndex {
    if let Some(cwd) = options.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        let scope = create_project_scope_matcher(cwd);
        heads.retain(|head| matches_project_scope(head, &scope));
    }
    heads = filter_activity_window(&heads, options.from, options.to);
    heads.sort_by(|left, right| right.time_updated.total_cmp(&left.time_updated));
    let mut counts = HashMap::new();
    for head in &heads {
        *counts.entry(head.reference.agent_name.clone()).or_default() += 1;
    }
    SessionIndex {
        agents: agents::catalog_counts(&counts),
        sessions: heads,
    }
}
pub fn run(
    sources: &[AgentSource],
    options: &ScanOptions,
    pricing: &Pricing,
    path: &Path,
) -> Result<SessionIndex> {
    let mut cache = Cache::open(Some(path))?;
    for _ in 0..3 {
        let baseline = cache.json_baseline()?;
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
            let read = (|| -> Result<()> {
                if !old.is_empty() && !source_present(source)? {
                    bail!("Agent source is unavailable; retaining cached sessions");
                }
                let before = signature(source, pricing)?;
                if baseline.fingerprints.get(&source.agent) == Some(&before)
                    && project_identities_current(&old)
                {
                    heads.extend(old.iter().cloned());
                    fingerprints.push((source.agent.clone(), before));
                    return Ok(());
                }
                let scanned = discovery::scan_source(source, pricing)?;
                let after = signature(source, pricing)?;
                if before != after {
                    bail!("Agent source changed during scan; retaining cached sessions");
                }
                let references: HashSet<_> = scanned
                    .sessions
                    .iter()
                    .map(|session| session.head.reference.clone())
                    .collect();
                if !matches!(
                    source.agent.as_str(),
                    "cursor" | "opencode" | "zcode" | "deepchat" | "cherrystudio" | "minimax-code"
                ) {
                    for head in old
                        .iter()
                        .filter(|head| !references.contains(&head.reference))
                    {
                        if let Some(path) = baseline.source_paths.get(&head.reference)
                            && Path::new(path).try_exists()?
                        {
                            bail!(
                                "Previously cached session could not be parsed from {}; retaining cached sessions",
                                path
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
                fingerprints.push((source.agent.clone(), after));
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
