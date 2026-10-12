use super::{ParsedSession, ScanDelta, SessionRecord};
use crate::{contract::SessionReference, pricing::Pricing};
use anyhow::Result;
use serde_json::Value;
use std::{
    fs::File,
    path::{Path, PathBuf},
};

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    super::pi::scan_as(root, "omp", pricing)
}

pub fn scan_changed(
    root: &Path,
    pricing: &Pricing,
    changed_paths: &[PathBuf],
    previous: &[SessionRecord],
) -> Result<ScanDelta> {
    super::pi::scan_changed_as(root, "omp", pricing, changed_paths, previous)
}

// Subagent and advisor transcripts live in the artifacts directory named after the owning transcript.
pub(super) fn parent(path: &Path) -> Option<SessionReference> {
    let mut owner = path.parent()?.as_os_str().to_owned();
    owner.push(".jsonl");
    let mut lines = super::jsonl::JsonLines::new(File::open(owner).ok()?);
    for _ in 0..2 {
        let line = lines.next_line().ok()??;
        if let Ok(record) = serde_json::from_str::<Value>(line)
            && record["type"] == "session"
        {
            let id = record["id"].as_str()?.trim();
            return (!id.is_empty()).then(|| SessionReference {
                source_node_id: crate::contract::local_source_node_id(),
                agent_name: "omp".into(),
                session_id: id.into(),
            });
        }
    }
    None
}
