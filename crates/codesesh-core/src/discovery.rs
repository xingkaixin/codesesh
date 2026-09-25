mod backfill;
mod incremental;
pub use incremental::AgentScanner;
pub mod paths;
use crate::{
    agents::{self, ParsedSession},
    contract::AgentInfo,
    pricing::Pricing,
    projects::{create_project_scope_matcher, matches_project_scope},
    query::filter_activity_window,
};
use anyhow::{Context, Result};
use chrono::{Days, Local, TimeZone};
pub use paths::{AgentSource, PathEnvironment};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

#[derive(Clone, Debug, Default)]
pub struct ScanOptions {
    pub agents: Vec<String>,
    pub cwd: Option<String>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub days: Option<u32>,
    pub now: Option<f64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFailure {
    pub agent_name: String,
    pub source_path: String,
    pub stage: String,
    pub message: String,
}
#[derive(Debug)]
pub struct ScanResult {
    pub sessions: Vec<ParsedSession>,
    pub agents: Vec<AgentInfo>,
    pub available_agents: Vec<String>,
    pub failures: Vec<ScanFailure>,
}
#[derive(Debug)]
pub struct AgentScan {
    pub available: bool,
    pub sessions: Vec<ParsedSession>,
}

pub fn selected_sources(environment: &PathEnvironment, names: &[String]) -> Vec<AgentSource> {
    let selected: HashSet<_> = names.iter().map(|name| name.to_lowercase()).collect();
    agents::catalog(0)
        .into_iter()
        .filter(|agent| selected.is_empty() || selected.contains(&agent.name))
        .filter_map(|agent| environment.source(&agent.name))
        .collect()
}

pub fn scan(options: &ScanOptions, pricing: &Pricing) -> Result<ScanResult> {
    let environment = PathEnvironment::current()?;
    Ok(scan_sources(
        &selected_sources(&environment, &options.agents),
        options,
        pricing,
    ))
}

pub fn scan_sources(
    sources: &[AgentSource],
    options: &ScanOptions,
    pricing: &Pricing,
) -> ScanResult {
    let mut sessions = Vec::new();
    let mut available_agents = Vec::new();
    let mut failures = Vec::new();
    for source in sources {
        match scan_source(source, pricing) {
            Ok(result) => {
                if result.available {
                    available_agents.push(source.agent.clone());
                }
                sessions.extend(result.sessions);
            }
            Err(error) => {
                available_agents.push(source.agent.clone());
                failures.push(ScanFailure {
                    agent_name: source.agent.clone(),
                    source_path: source.scan_path.to_string_lossy().into_owned(),
                    stage: "scanning sessions".into(),
                    message: format!("{error:#}"),
                });
            }
        }
    }
    filter_sessions(&mut sessions, options);
    let mut counts = HashMap::<String, usize>::new();
    for session in &sessions {
        *counts
            .entry(session.head.reference.agent_name.clone())
            .or_default() += 1;
    }
    ScanResult {
        sessions,
        agents: agents::catalog_counts(&counts),
        available_agents,
        failures,
    }
}

pub fn scan_source(source: &AgentSource, pricing: &Pricing) -> Result<AgentScan> {
    if !exists(&source.scan_path)? {
        return Ok(AgentScan {
            available: false,
            sessions: vec![],
        });
    }
    let mut sessions =
        agents::scan_agent(&source.agent, &source.scan_path, &source.data_root, pricing)
            .with_context(|| {
                format!(
                    "scanning {} at {}",
                    source.agent,
                    source.scan_path.display()
                )
            })?;
    for session in &mut sessions {
        agents::complete_projections(session);
    }
    let available = !sessions.is_empty() || has_sources(source)?;
    Ok(AgentScan {
        available,
        sessions,
    })
}

fn exists(path: &Path) -> std::io::Result<bool> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}
fn has_sources(source: &AgentSource) -> Result<bool> {
    let database = match source.agent.as_str() {
        "cursor" => Some(source.scan_path.join("globalStorage/state.vscdb")),
        "opencode" => Some(source.scan_path.clone()),
        "zcode" => Some(source.scan_path.join("cli/db/db.sqlite")),
        "deepchat" => Some(source.scan_path.join("app_db/agent.db")),
        "cherrystudio" => Some(source.scan_path.join("Data/cherrystudio.sqlite")),
        "minimax-code" => Some(source.scan_path.join("v2/sqlite/runtime-state.sqlite")),
        _ => None,
    };
    if let Some(database) = database {
        return Ok(exists(&database)?);
    }
    let root = if source.agent == "dsh" {
        source.scan_path.join("sessions")
    } else {
        source.scan_path.clone()
    };
    if !exists(&root)? {
        return Ok(false);
    }
    for entry in walkdir::WalkDir::new(&root).follow_links(false) {
        let entry =
            entry.with_context(|| format!("checking source availability at {}", root.display()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        let present = match source.agent.as_str() {
            "claudecode" => entry.depth() == 2 && name.ends_with(".jsonl"),
            "codex" => name.starts_with("rollout-") && name.ends_with(".jsonl"),
            "pi" => name.ends_with(".jsonl"),
            "grok" => name == "summary.json",
            "kimi" => entry.depth() == 3 && matches!(name.as_ref(), "metadata.json" | "state.json"),
            "kimi-code" => {
                entry.depth() == 3
                    && name == "state.json"
                    && exists(
                        &entry
                            .path()
                            .parent()
                            .unwrap()
                            .join("agents/main/wire.jsonl"),
                    )?
            }
            "dsh" => {
                entry.depth() == 3
                    && matches!(name.as_ref(), "session.jsonl" | "session.jsonl.zstd")
            }
            _ => false,
        };
        if present {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn filter_sessions(sessions: &mut Vec<ParsedSession>, options: &ScanOptions) {
    if let Some(cwd) = options.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        let scope = create_project_scope_matcher(cwd);
        sessions.retain(|session| matches_project_scope(&session.head, &scope));
    }
    let from = options.from.or_else(|| {
        calendar_window_start(
            options.days,
            options
                .to
                .or(options.now)
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as f64),
        )
    });
    if from.is_none() && options.to.is_none() {
        return;
    }
    let heads: Vec<_> = sessions
        .iter()
        .map(|session| session.head.clone())
        .collect();
    let selected: HashSet<_> = filter_activity_window(&heads, from, options.to)
        .into_iter()
        .map(|head| head.reference)
        .collect();
    sessions.retain(|session| selected.contains(&session.head.reference));
}

pub fn calendar_window_start(days: Option<u32>, timestamp: f64) -> Option<f64> {
    let days = days.filter(|days| *days > 0)?;
    let date = Local
        .timestamp_millis_opt(timestamp as i64)
        .single()?
        .date_naive()
        .checked_sub_days(Days::new(u64::from(days - 1)))?;
    Local
        .from_local_datetime(&date.and_hms_opt(0, 0, 0)?)
        .earliest()
        .map(|date| date.timestamp_millis() as f64)
}

pub fn source_inventory_signature(source: &AgentSource) -> Result<String> {
    let items = backfill::inventory(source)?;
    Ok(backfill::Backfill::new(items, None, None, 0, None, false).signature)
}

#[cfg(test)]
mod tests;
