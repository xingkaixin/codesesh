use crate::contract::{SessionHead, SessionReference};
use std::collections::{HashMap, HashSet};

mod pagination;
pub use pagination::{Page, PaginationError, SnapshotPaginator};

pub fn in_window(time: f64, from: Option<f64>, to: Option<f64>) -> bool {
    from.is_none_or(|value| time >= value) && to.is_none_or(|value| time <= value)
}

pub struct SessionTree<'a> {
    pub sessions: Vec<&'a SessionHead>,
    pub children: Vec<Vec<usize>>,
    pub entries: Vec<usize>,
}

impl<'a> SessionTree<'a> {
    pub fn new(sessions: &'a [SessionHead]) -> Self {
        let mut by_ref = HashMap::new();
        let mut unique = Vec::new();
        for session in sessions {
            if !by_ref.contains_key(&session.reference) {
                by_ref.insert(session.reference.clone(), unique.len());
                unique.push(session);
            }
        }
        let parents: Vec<_> = unique
            .iter()
            .map(|s| {
                s.parent_reference
                    .as_ref()
                    .and_then(|r| by_ref.get(r).copied())
            })
            .collect();
        let mut terminates = vec![None; unique.len()];
        for start in 0..unique.len() {
            if terminates[start].is_some() {
                continue;
            }
            let mut path = Vec::new();
            let mut seen = HashSet::new();
            let mut current = Some(start);
            let mut valid = true;
            while let Some(index) = current {
                if let Some(result) = terminates[index] {
                    valid = result;
                    break;
                }
                if !seen.insert(index) {
                    valid = false;
                    break;
                }
                path.push(index);
                current = parents[index];
            }
            for index in path {
                terminates[index] = Some(valid);
            }
        }
        let mut children = vec![Vec::new(); unique.len()];
        let mut entries = Vec::new();
        for (index, parent) in parents.iter().enumerate() {
            if let Some(parent) = parent.filter(|_| terminates[index] == Some(true)) {
                children[parent].push(index);
            } else {
                entries.push(index);
            }
        }
        Self {
            sessions: unique,
            children,
            entries,
        }
    }

    pub fn descendants(&self, entry: usize) -> Vec<usize> {
        let mut pending = vec![entry];
        let mut result = Vec::new();
        while let Some(index) = pending.pop() {
            result.push(index);
            pending.extend(self.children[index].iter().copied());
        }
        result
    }
}

pub fn filter_activity_window(
    sessions: &[SessionHead],
    from: Option<f64>,
    to: Option<f64>,
) -> Vec<SessionHead> {
    if from.is_none() && to.is_none() {
        return sessions.to_vec();
    }
    let tree = SessionTree::new(sessions);
    let visible: HashSet<_> = tree
        .entries
        .iter()
        .filter(|&&entry| in_window(tree.sessions[entry].time_updated, from, to))
        .flat_map(|&entry| tree.descendants(entry))
        .map(|index| &tree.sessions[index].reference)
        .collect();
    sessions
        .iter()
        .filter(|s| visible.contains(&s.reference))
        .cloned()
        .collect()
}

#[derive(Default)]
pub struct SessionFilter<'a> {
    pub agent: Option<&'a str>,
    pub project: Option<(&'a str, &'a str)>,
    pub tag: Option<&'a str>,
    pub query: Option<&'a str>,
    pub from: Option<f64>,
    pub to: Option<f64>,
}

pub fn filter_sessions(
    sessions: &[SessionHead],
    filter: &SessionFilter<'_>,
    aliases: &HashMap<SessionReference, String>,
) -> Vec<SessionHead> {
    let agent = filter.agent.map(|value| value.trim().to_lowercase());
    let selected: Vec<_> = sessions
        .iter()
        .filter(|s| {
            agent
                .as_ref()
                .is_none_or(|a| *a == s.reference.agent_name.to_lowercase())
                && filter.project.is_none_or(|(kind, key)| {
                    s.project_identity.kind == kind && s.project_identity.key == key
                })
        })
        .cloned()
        .collect();
    let query = filter.query.map(str::to_lowercase);
    let tag = filter.tag.map(str::to_lowercase);
    filter_activity_window(&selected, filter.from, filter.to)
        .into_iter()
        .filter(|s| {
            tag.as_ref()
                .is_none_or(|t| t.is_empty() || s.smart_tags.contains(t))
                && query.as_ref().is_none_or(|q| {
                    s.title.to_lowercase().contains(q)
                        || aliases
                            .get(&s.reference)
                            .is_some_and(|a| a.to_lowercase().contains(q))
                })
        })
        .map(|mut s| {
            if let Some(alias) = aliases.get(&s.reference) {
                s.display_title = Some(alias.clone());
            }
            s.public()
        })
        .collect()
}

pub fn parse_limit(
    value: Option<&str>,
    default: usize,
    maximum: usize,
) -> Result<usize, &'static str> {
    let Some(value) = value else {
        return Ok(default);
    };
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("limit must be a positive integer");
    }
    let digits = value.trim_start_matches('0');
    if digits.is_empty() {
        return Err("limit must be a positive integer");
    }
    Ok(digits.parse::<usize>().unwrap_or(maximum).min(maximum))
}

pub fn parse_project_filter<'a>(
    kind: Option<&'a str>,
    key: Option<&'a str>,
) -> Result<Option<(&'a str, &'a str)>, &'static str> {
    let kind = kind.map(str::trim).filter(|s| !s.is_empty());
    let key = key.map(str::trim).filter(|s| !s.is_empty());
    match (kind, key) {
        (None, None) => Ok(None),
        (
            Some(
                kind @ ("git_remote" | "git_common_dir" | "manifest_path" | "synthetic" | "path"
                | "loose"),
            ),
            Some(key),
        ) => Ok(Some((kind, key))),
        _ => Err("projectKind and projectKey must form a valid project identity"),
    }
}
