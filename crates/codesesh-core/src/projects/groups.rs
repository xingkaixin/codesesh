use super::get_project_identity_key;
use crate::model::{SessionHead, SessionReference};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub identity_kind: String,
    pub identity_key: String,
    pub display_name: String,
    pub sources: Vec<String>,
    pub session_count: usize,
    pub last_activity: Option<f64>,
}
fn key(reference: &SessionReference) -> String {
    crate::state::reference_key(reference)
}

fn is_fallback_display_name(identity: &crate::model::ProjectIdentity) -> bool {
    identity.kind == "git_remote" && identity.display_name == super::remote_tail(&identity.key)
}

fn better_display_candidate(
    candidate: (bool, f64, &SessionReference),
    current: (bool, f64, &SessionReference),
) -> bool {
    candidate
        .0
        .cmp(&current.0)
        .then_with(|| candidate.1.total_cmp(&current.1))
        .then_with(|| {
            (
                &current.2.source_node_id,
                &current.2.agent_name,
                &current.2.session_id,
            )
                .cmp(&(
                    &candidate.2.source_node_id,
                    &candidate.2.agent_name,
                    &candidate.2.session_id,
                ))
        })
        .is_gt()
}

pub(crate) fn preferred_project_display_names(sessions: &[SessionHead]) -> HashMap<String, String> {
    let mut best = HashMap::<String, (bool, f64, &SessionReference, &str)>::new();
    for session in sessions {
        let identity = &session.project_identity;
        let name = identity.display_name.as_str();
        if name.is_empty() {
            continue;
        }
        let group_key = get_project_identity_key(identity);
        let non_fallback = !is_fallback_display_name(identity);
        let replace = match best.get(&group_key) {
            None => true,
            Some(&(cur_non_fallback, cur_time, cur_ref, _)) => better_display_candidate(
                (non_fallback, session.time_updated, &session.reference),
                (cur_non_fallback, cur_time, cur_ref),
            ),
        };
        if replace {
            best.insert(
                group_key,
                (non_fallback, session.time_updated, &session.reference, name),
            );
        }
    }
    best.into_iter()
        .map(|(key, (_, _, _, name))| (key, name.to_owned()))
        .collect()
}

pub fn build_project_groups(sessions: &[SessionHead]) -> Vec<ProjectGroup> {
    let preferred_names = preferred_project_display_names(sessions);
    let mut by_key = HashMap::new();
    for session in sessions {
        by_key.entry(key(&session.reference)).or_insert(session);
    }
    let mut terminates = HashMap::new();
    for start in by_key.keys() {
        let mut chain = Vec::new();
        let mut on_path = HashSet::new();
        let mut current = start.clone();
        let reaches_root = loop {
            if let Some(result) = terminates.get(&current) {
                break *result;
            }
            if !on_path.insert(current.clone()) {
                break false;
            }
            chain.push(current.clone());
            match by_key[&current]
                .parent_reference
                .as_ref()
                .map(key)
                .filter(|parent| by_key.contains_key(parent))
            {
                Some(parent) => current = parent,
                None => break true,
            }
        };
        for item in chain {
            terminates.insert(item, reaches_root);
        }
    }
    let mut indices = HashMap::<String, usize>::new();
    let mut groups = Vec::<ProjectGroup>::new();
    let mut sources = Vec::<BTreeSet<String>>::new();
    for session in sessions {
        let reference = key(&session.reference);
        let owner = by_key[&reference];
        if owner
            .parent_reference
            .as_ref()
            .is_some_and(|parent| by_key.contains_key(&key(parent)))
            && terminates[&reference]
        {
            continue;
        }
        let identity = &session.project_identity;
        let group_key = get_project_identity_key(identity);
        let agent = session.reference.agent_name.trim().to_lowercase();
        if let Some(&index) = indices.get(&group_key) {
            groups[index].session_count += 1;
            groups[index].last_activity = Some(
                groups[index]
                    .last_activity
                    .unwrap_or(0.0)
                    .max(session.time_updated),
            );
            sources[index].insert(agent);
        } else {
            let display_name = preferred_names
                .get(&group_key)
                .cloned()
                .unwrap_or_else(|| identity.display_name.clone());
            indices.insert(group_key, groups.len());
            groups.push(ProjectGroup {
                identity_kind: identity.kind.clone(),
                identity_key: identity.key.clone(),
                display_name,
                sources: Vec::new(),
                session_count: 1,
                last_activity: Some(session.time_updated),
            });
            sources.push(BTreeSet::from([agent]));
        }
    }
    for (group, source) in groups.iter_mut().zip(sources) {
        group.sources = source.into_iter().collect();
        if group.last_activity == Some(0.0) {
            group.last_activity = None;
        }
    }
    groups.sort_by(|a, b| {
        (a.identity_kind == "loose")
            .cmp(&(b.identity_kind == "loose"))
            .then_with(|| {
                b.last_activity
                    .unwrap_or(0.0)
                    .total_cmp(&a.last_activity.unwrap_or(0.0))
            })
    });
    groups
}
