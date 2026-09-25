pub(crate) const PARSER_VERSION: &str = "rust-parser-v2";

pub mod cherrystudio;
pub mod claudecode;
pub mod codex;
mod codex_exec;
pub mod cursor;
pub mod deepchat;
pub mod dsh;
pub mod grok;
mod jsonl;
pub mod kimi;
pub mod kimi_code;
mod message_text;
pub mod minimax_code;
pub mod opencode;
pub mod pi;
pub mod zcode;

use crate::{contract::AgentInfo, pricing::Pricing};
pub use codex::ParsedSession;

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
use std::{collections::HashMap, path::Path};

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
        "claudecode" => claudecode::scan(scan_path, pricing),
        "codex" => codex::scan(data_root, pricing),
        "cursor" => cursor::scan(scan_path, pricing),
        "kimi" => kimi::scan_with_data_root(scan_path, data_root, pricing),
        "kimi-code" => kimi_code::scan(scan_path, pricing),
        "grok" => grok::scan(scan_path, pricing),
        "pi" => pi::scan(scan_path, pricing),
        "opencode" => opencode::scan_database(scan_path, "opencode", true, pricing),
        "zcode" => zcode::scan(scan_path, pricing),
        "minimax-code" => minimax_code::scan(scan_path, pricing),
        "dsh" => dsh::scan(scan_path, pricing),
        "deepchat" => deepchat::scan(scan_path, pricing),
        "cherrystudio" => cherrystudio::scan(scan_path, pricing),
        _ => anyhow::bail!("Unknown agent: {agent}"),
    }
}

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
mod file_activity;
