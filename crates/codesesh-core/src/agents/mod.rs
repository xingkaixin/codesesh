pub(crate) fn parser_version(agent: &str) -> &'static str {
    if agent == "codex" {
        "rust-parser-v8"
    } else {
        "rust-parser-v4"
    }
}

pub mod antigravity_cli;
pub mod cherrystudio;
pub mod claudecode;
pub mod codex;
mod codex_exec;
mod codex_tool_events;
pub mod cursor;
pub mod deepchat;
pub mod droid;
pub mod dsh;
pub mod gemini_cli;
pub mod grok;
pub(crate) mod jsonl;
pub mod kimi;
pub mod kimi_code;
mod message_text;
pub mod minimax_code;
pub mod omp;
pub mod opencode;
pub mod pi;
pub mod zcode;

use crate::{
    contract::{AgentInfo, SessionDetail, SessionHead},
    pricing::Pricing,
};

#[derive(Clone, Debug)]
pub struct ParsedSession {
    pub head: SessionHead,
    pub source: std::path::PathBuf,
    pub detail: SessionDetail,
}

impl ParsedSession {
    pub fn set_source_node(&mut self, node: &str) {
        self.head.set_source_node(node);
        self.detail.head = self.head.clone();
        for activity in &mut self.detail.file_activity {
            activity.reference = self.head.reference.clone();
            activity.project_identity_key = self.head.project_identity.key.clone();
        }
    }
}

#[derive(Clone, Debug)]
pub struct SessionRecord {
    pub head: crate::contract::SessionHead,
    pub source: std::path::PathBuf,
    pub attachments: dsh::AttachmentReferences,
}
impl From<&ParsedSession> for SessionRecord {
    fn from(session: &ParsedSession) -> Self {
        Self {
            head: session.head.clone(),
            source: session.source.clone(),
            attachments: if session.head.reference.agent_name == "dsh" {
                dsh::AttachmentReferences::from_messages(&session.detail.messages)
            } else {
                Default::default()
            },
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ScanDelta {
    pub upserts: Vec<ParsedSession>,
    pub removed: Vec<crate::contract::SessionReference>,
    pub complete: bool,
}
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub fn catalog(count: usize) -> Vec<AgentInfo> {
    catalog_counts(&HashMap::from([("codex".into(), count)]))
}

pub fn catalog_counts(counts: &HashMap<String, usize>) -> Vec<AgentInfo> {
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("catalog.json")).expect("valid bundled agent catalog");
    entries
        .into_iter()
        .map(|entry| {
            let name = entry["name"].as_str().unwrap().to_owned();
            let count = counts.get(&name).copied().unwrap_or(0);
            AgentInfo {
                name,
                display_name: entry["displayName"].as_str().unwrap().into(),
                count,
                available: count > 0,
            }
        })
        .collect()
}

pub fn scan_agent(
    agent: &str,
    scan_path: &Path,
    data_root: &Path,
    pricing: &Pricing,
) -> anyhow::Result<Vec<ParsedSession>> {
    match agent {
        "antigravity-cli" => antigravity_cli::scan(scan_path, data_root, pricing),
        "gemini-cli" => gemini_cli::scan(scan_path, pricing),
        "claudecode" | "qoder" | "qoder-cn" => claudecode::scan_as(scan_path, agent, pricing),
        "codex" => codex::scan(data_root, pricing),
        "cursor" => cursor::scan(scan_path, pricing),
        "droid" => droid::scan(scan_path, data_root, pricing),
        "kimi" => kimi::scan_with_data_root(scan_path, data_root, pricing),
        "kimi-code" => kimi_code::scan(scan_path, pricing),
        "grok" => grok::scan(scan_path, pricing),
        "pi" => pi::scan(scan_path, pricing),
        "omp" => omp::scan(scan_path, pricing),
        "opencode" => opencode::scan_database(scan_path, "opencode", true, pricing),
        "zcode" => zcode::scan(scan_path, pricing),
        "minimax-code" => minimax_code::scan(scan_path, pricing),
        "dsh" => dsh::scan(scan_path, pricing),
        "deepchat" => deepchat::scan(scan_path, pricing),
        "cherrystudio" => cherrystudio::scan(scan_path, pricing),
        _ => anyhow::bail!("Unknown agent: {agent}"),
    }
}

/// The SQLite file of a database-backed source; `None` for file-backed sources.
pub fn database_path(agent: &str, scan_path: &Path) -> Option<PathBuf> {
    match agent {
        "cursor" => Some(scan_path.join("globalStorage/state.vscdb")),
        "opencode" => Some(scan_path.to_owned()),
        "zcode" => Some(scan_path.join("cli/db/db.sqlite")),
        "deepchat" => Some(scan_path.join("app_db/agent.db")),
        "cherrystudio" => Some(scan_path.join("Data/cherrystudio.sqlite")),
        "minimax-code" => Some(scan_path.join("v2/sqlite/runtime-state.sqlite")),
        _ => None,
    }
}

/// The directory a file-backed source walks for session files.
pub(crate) fn session_root(agent: &str, scan_path: &Path) -> PathBuf {
    if agent == "dsh" {
        scan_path.join("sessions")
    } else {
        scan_path.to_owned()
    }
}

/// Whether a file found while walking `root` is a session source the adapter reads.
pub(crate) fn is_session_file(
    agent: &str,
    root: &Path,
    entry: &walkdir::DirEntry,
) -> std::io::Result<bool> {
    let name = entry.file_name().to_string_lossy();
    let path = entry.path();
    Ok(match agent {
        "claudecode" | "qoder" | "qoder-cn" => {
            name.ends_with(".jsonl")
                && (entry.depth() == 2 || claudecode::subagents_dir(path).is_some())
        }
        "pi" | "omp" => name.ends_with(".jsonl"),
        "antigravity-cli" => name.ends_with(".db"),
        "gemini-cli" => gemini_cli::is_source(root, path),
        "grok" => name == "summary.json",
        "droid" => entry.depth() <= 2 && name.ends_with(".jsonl"),
        "dsh" => entry.depth() == 3 && dsh::generation(&name).is_some(),
        // A session directory holding both files is one session, listed by its state.json.
        "kimi" => {
            entry.depth() == 3
                && (name == "state.json"
                    || name == "metadata.json"
                        && !path.with_file_name("state.json").try_exists()?)
        }
        "kimi-code" => {
            entry.depth() == 3
                && name == "state.json"
                && path
                    .parent()
                    .unwrap()
                    .join("agents/main/wire.jsonl")
                    .try_exists()?
        }
        _ => false,
    })
}

// The only place smart tags are derived; parsers leave them empty for this pass to fill.
pub fn complete_projections(session: &mut ParsedSession) {
    let source_updated_at = session.head.time_updated;
    let smart_tags = smart_tags::classify(&session.detail.messages);
    for head in [&mut session.head, &mut session.detail.head] {
        let projection = crate::projects::compute_identity_projection(&head.directory);
        head.project_identity = projection.identity;
        head.project_identity_resolver_revision = Some(projection.resolver_revision);
        head.project_identity_input_signature = Some(projection.input_signature);
        head.smart_tags = smart_tags.clone();
        head.smart_tags_source_updated_at = Some(source_updated_at);
        head.smart_tags_classifier_revision = Some("smart-tags-v1".into());
    }
    session.detail.file_activity =
        file_activity::summarize(&session.detail.head, &session.detail.messages);
}

mod codex_usage;

mod smart_tags;

mod codex_patch;
pub(crate) mod codex_rollout;
mod file_activity;
