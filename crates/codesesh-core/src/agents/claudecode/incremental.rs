use super::{Child, child, common::changed_sources, parse};
use crate::{
    agents::{ScanDelta, codex::ParsedSession},
    pricing::Pricing,
};
use anyhow::Result;
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

pub fn scan_changed(
    root: &Path,
    pricing: &Pricing,
    changed_paths: &[PathBuf],
    previous: &[crate::agents::SessionRecord],
) -> Result<ScanDelta> {
    let nested = root.join("projects");
    let root = if nested.is_dir() {
        nested.as_path()
    } else {
        root
    };
    let mut changed = changed_paths.to_vec();
    for path in changed_paths.iter().filter(|p| p.starts_with(root)) {
        if path.file_name().is_some_and(|n| n == "sessions-index.json") {
            if let Some(project) = path.parent() {
                changed.push(project.to_owned());
            }
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(".meta.json"))
        {
            let stem = path.file_name().unwrap().to_string_lossy();
            changed.push(
                path.with_file_name(format!("{}.jsonl", stem.trim_end_matches(".meta.json"))),
            );
        }
    }
    let mut sources = changed_sources(root, &changed, previous)?;
    sources.retain(|path| {
        path.parent().and_then(Path::parent) == Some(root)
            || path
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|n| n == "subagents")
    });
    let previous_by_source: HashMap<_, _> =
        previous.iter().map(|s| (s.source.as_path(), s)).collect();
    let previous_by_id: HashMap<_, _> = previous
        .iter()
        .map(|s| (s.head.reference.session_id.as_str(), s))
        .collect();
    let mut contexts = HashMap::<PathBuf, Child>::new();
    let mut tool_children = HashMap::new();
    let mut containers = BTreeSet::new();
    for source in &sources {
        if source
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == "subagents")
        {
            containers.insert(source.parent().unwrap().to_owned());
        } else if let (Some(project), Some(id)) = (source.parent(), source.file_stem()) {
            containers.insert(project.join(id).join("subagents"));
        }
    }
    for container in &containers {
        let entries = match fs::read_dir(container) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_file()
                || entry.path().extension().is_none_or(|e| e != "jsonl")
            {
                continue;
            }
            if let Some(context) = child(&entry.path()) {
                if let Some(tool) = &context.tool_id {
                    tool_children.insert(tool.clone(), context.id.clone());
                }
                contexts.insert(entry.path(), context);
            }
        }
    }
    let current_by_id: HashMap<_, _> = contexts
        .iter()
        .map(|(path, child)| (child.id.as_str(), path))
        .collect();
    let mut associated = Vec::new();
    for source in &sources {
        let is_child = source
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|n| n == "subagents");
        if !is_child {
            continue;
        }
        let old_parent = previous_by_source
            .get(source.as_path())
            .and_then(|s| s.head.parent_reference.as_ref())
            .map(|r| r.session_id.as_str());
        let new_parent = contexts.get(source).and_then(|c| c.parent.as_deref());
        for id in [old_parent, new_parent].into_iter().flatten() {
            if let Some(path) = current_by_id.get(id) {
                associated.push((*path).clone());
            } else if let Some(old) = previous_by_id.get(id) {
                associated.push(old.source.clone());
            }
        }
        if let Some(parent_dir) = source.parent().and_then(Path::parent)
            && let (Some(project), Some(parent_id)) = (parent_dir.parent(), parent_dir.file_name())
        {
            associated.push(project.join(format!("{}.jsonl", parent_id.to_string_lossy())));
        }
    }
    sources.extend(associated);
    let mut indexes = HashMap::<PathBuf, Value>::new();
    let mut upserts = Vec::new();
    let mut removed = HashSet::new();
    for source in sources {
        let old = previous_by_source.get(source.as_path());
        let parsed = match fs::metadata(&source) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
            Ok(_) => {
                let context = contexts.get(&source);
                let project = context
                    .map(|c| c.project.as_path())
                    .unwrap_or_else(|| source.parent().unwrap());
                let index = indexes.entry(project.to_owned()).or_insert_with(|| {
                    fs::read(project.join("sessions-index.json"))
                        .ok()
                        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                        .unwrap_or(Value::Null)
                });
                parse(&source, context, project, index, &tool_children, pricing)?
            }
        };
        if let Some(old) = old
            && parsed
                .as_ref()
                .is_none_or(|(head, _)| head.reference != old.head.reference)
        {
            removed.insert(old.head.reference.clone());
        }
        if let Some((head, detail)) = parsed {
            upserts.push(ParsedSession {
                source,
                head,
                detail,
            });
        }
    }
    let mut removed: Vec<_> = removed.into_iter().collect();
    removed.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    Ok(ScanDelta {
        upserts,
        removed,
        complete: false,
    })
}
