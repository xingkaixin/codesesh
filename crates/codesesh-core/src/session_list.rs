use crate::model::{SessionHead, SessionReference};
use std::collections::{HashMap, HashSet};

mod pagination;
pub use pagination::{PaginationError, SnapshotPaginator};

pub(crate) fn in_window(time: f64, from: Option<f64>, to: Option<f64>) -> bool {
    from.is_none_or(|value| time >= value) && to.is_none_or(|value| time <= value)
}

pub(crate) struct SessionTree<'a> {
    pub sessions: Vec<&'a SessionHead>,
    pub children: Vec<Vec<usize>>,
    pub entries: Vec<usize>,
}

impl<'a> SessionTree<'a> {
    pub fn new(sessions: &'a [SessionHead]) -> Self {
        Self::from_refs(sessions.iter())
    }

    pub fn from_refs(sessions: impl IntoIterator<Item = &'a SessionHead>) -> Self {
        let mut by_ref: HashMap<&'a SessionReference, usize> = HashMap::new();
        let mut unique: Vec<&'a SessionHead> = Vec::new();
        for session in sessions {
            if !by_ref.contains_key(&session.reference) {
                by_ref.insert(&session.reference, unique.len());
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
            if parents[start].is_none() {
                terminates[start] = Some(true);
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

pub fn count_agents_in_activity_window<'a>(
    sessions: impl IntoIterator<Item = &'a SessionHead>,
    from: Option<f64>,
    to: Option<f64>,
) -> HashMap<String, usize> {
    let mut counts: HashMap<&'a str, usize> = HashMap::new();
    if from.is_none() && to.is_none() {
        for session in sessions {
            *counts
                .entry(session.reference.agent_name.as_str())
                .or_insert(0) += 1;
        }
        return counts
            .into_iter()
            .map(|(agent, count)| (agent.to_owned(), count))
            .collect();
    }
    let items: Vec<&'a SessionHead> = sessions.into_iter().collect();
    let tree = SessionTree::from_refs(items.iter().copied());
    let visible: HashSet<&'a SessionReference> = tree
        .entries
        .iter()
        .filter(|&&entry| in_window(tree.sessions[entry].time_updated, from, to))
        .flat_map(|&entry| tree.descendants(entry))
        .map(|index| &tree.sessions[index].reference)
        .collect();
    for session in items {
        if visible.contains(&session.reference) {
            *counts
                .entry(session.reference.agent_name.as_str())
                .or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .map(|(agent, count)| (agent.to_owned(), count))
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

/// For each head in `heads`, computes the `time_updated` of its root ancestor in the session tree.
/// Cycle members and orphan sessions use their own `time_updated`, matching `SessionTree::from_refs`.
pub fn compute_root_activity_times(heads: &[std::sync::Arc<SessionHead>]) -> Vec<f64> {
    let mut by_ref: HashMap<&SessionReference, usize> = HashMap::with_capacity(heads.len());
    let mut dedup_index = Vec::with_capacity(heads.len());
    for (idx, head) in heads.iter().enumerate() {
        let canonical = *by_ref.entry(&head.reference).or_insert(idx);
        dedup_index.push(canonical);
    }
    let parents: Vec<Option<usize>> = heads
        .iter()
        .enumerate()
        .map(|(idx, head)| {
            if dedup_index[idx] != idx {
                return None;
            }
            head.parent_reference
                .as_ref()
                .and_then(|parent| by_ref.get(parent).copied())
        })
        .collect();
    let mut root_idx: Vec<Option<usize>> = vec![None; heads.len()];
    for start in 0..heads.len() {
        if dedup_index[start] != start || root_idx[start].is_some() {
            continue;
        }
        if parents[start].is_none() {
            root_idx[start] = Some(start);
            continue;
        }
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let mut current = Some(start);
        let mut resolved: Option<usize> = None;
        while let Some(index) = current {
            if let Some(root) = root_idx[index] {
                resolved = Some(root);
                break;
            }
            if !seen.insert(index) {
                resolved = None;
                break;
            }
            path.push(index);
            match parents[index] {
                Some(parent) => current = Some(parent),
                None => {
                    resolved = Some(index);
                    break;
                }
            }
        }
        match resolved {
            Some(root) => {
                for index in path {
                    root_idx[index] = Some(root);
                }
            }
            None => {
                // Cycle: every node on the cycle acts as its own entry.
                for index in path {
                    root_idx[index] = Some(index);
                }
            }
        }
    }
    heads
        .iter()
        .enumerate()
        .map(|(idx, _)| {
            let canonical = dedup_index[idx];
            let root = root_idx[canonical].unwrap_or(canonical);
            heads[root].time_updated
        })
        .collect()
}

pub fn count_agents_with_root_times(
    heads: &[std::sync::Arc<SessionHead>],
    root_times: &[f64],
    from: Option<f64>,
    to: Option<f64>,
) -> HashMap<String, usize> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for (head, &root_time) in heads.iter().zip(root_times.iter()) {
        if in_window(root_time, from, to) {
            *counts
                .entry(head.reference.agent_name.as_str())
                .or_insert(0) += 1;
        }
    }
    counts
        .into_iter()
        .map(|(agent, count)| (agent.to_owned(), count))
        .collect()
}

pub fn filter_sessions_indexed_shared(
    heads: &[std::sync::Arc<SessionHead>],
    root_times: &[f64],
    filter: &SessionFilter<'_>,
    aliases: &HashMap<SessionReference, String>,
) -> Vec<std::sync::Arc<SessionHead>> {
    let query = filter.query.map(str::to_lowercase);
    let tag = filter.tag.map(str::to_lowercase);
    let mut out = Vec::new();
    for (head, &root_time) in heads.iter().zip(root_times.iter()) {
        if !in_window(root_time, filter.from, filter.to) {
            continue;
        }
        if let Some(ref t) = tag
            && !t.is_empty()
            && !head.smart_tags.contains(t)
        {
            continue;
        }
        if let Some(ref q) = query {
            let matches_title = head.title.to_lowercase().contains(q);
            let matches_alias = !matches_title
                && aliases
                    .get(&head.reference)
                    .is_some_and(|a| a.to_lowercase().contains(q));
            if !matches_title && !matches_alias {
                continue;
            }
        }
        out.push(std::sync::Arc::clone(head));
    }
    out
}

pub fn filter_sessions_shared(
    sessions: &[std::sync::Arc<SessionHead>],
    filter: &SessionFilter<'_>,
    aliases: &HashMap<SessionReference, String>,
) -> Vec<std::sync::Arc<SessionHead>> {
    let agent = filter.agent.map(|value| value.trim().to_lowercase());
    let selected: Vec<std::sync::Arc<SessionHead>> = sessions
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
    let in_time_window: Vec<std::sync::Arc<SessionHead>> = if filter.from.is_none()
        && filter.to.is_none()
    {
        selected
    } else {
        let tree = SessionTree::from_refs(selected.iter().map(std::sync::Arc::as_ref));
        let visible: HashSet<&SessionReference> = tree
            .entries
            .iter()
            .filter(|&&entry| in_window(tree.sessions[entry].time_updated, filter.from, filter.to))
            .flat_map(|&entry| tree.descendants(entry))
            .map(|index| &tree.sessions[index].reference)
            .collect();
        selected
            .iter()
            .filter(|s| visible.contains(&s.reference))
            .cloned()
            .collect()
    };
    let query = filter.query.map(str::to_lowercase);
    let tag = filter.tag.map(str::to_lowercase);
    in_time_window
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
        .collect()
}
