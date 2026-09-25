mod file_activity;
mod parser;
mod reader;
pub use file_activity::{FileActivityOptions, FileActivityResult, list_file_activity};
use reader::{search_files, search_prepared};
mod snippet;
mod sql;

use crate::contract::{SessionHead, SessionReference};
pub use crate::projects::ProjectScopeMatcher as ProjectScope;
use anyhow::Result;
pub use parser::{ParsedQuery, parse_query, split_tokens, to_fts_query};
use rusqlite::{Connection, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default)]
pub struct QueryScope {
    pub agents: Vec<String>,
    pub project_scope: Option<ProjectScope>,
}

#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    pub agent: Option<String>,
    pub project: Option<String>,
    pub project_kind: Option<String>,
    pub project_key: Option<String>,
    pub project_scope: Option<ProjectScope>,
    pub query_scope: Option<QueryScope>,
    pub cwd: Option<String>,
    pub tags: Vec<String>,
    pub tools: Vec<String>,
    pub file: Option<String>,
    pub file_kind: Option<String>,
    pub cost_min: Option<f64>,
    pub cost_max: Option<f64>,
    pub cost_min_exclusive: bool,
    pub cost_max_exclusive: bool,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct HighlightRange {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub reference: SessionReference,
    pub session: SessionHead,
    pub snippet: String,
    pub snippet_highlights: Vec<HighlightRange>,
    pub match_type: String,
}

fn prepare(
    connection: &Connection,
    query: &str,
    options: &SearchOptions,
) -> Result<(ParsedQuery, SearchOptions)> {
    let (parsed, mut options) = parser::merge(query, options);
    if options.project_scope.is_none()
        && let Some(cwd) = &options.cwd
    {
        options.project_scope = Some(crate::projects::create_project_scope_matcher(cwd));
    }
    connection.create_scalar_function(
        "codesesh_project_scope_path",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |context| {
            let value = context.get::<String>(0)?;
            Ok(crate::projects::normalize_project_scope_path(&value))
        },
    )?;
    Ok((parsed, options))
}

pub fn execute(
    connection: &Connection,
    query: &str,
    options: &SearchOptions,
) -> Result<Vec<SearchResult>> {
    let (parsed, options) = prepare(connection, query, options)?;
    if options.limit == Some(0) {
        return Ok(Vec::new());
    }
    let file_query = options.file.clone().unwrap_or_else(|| {
        if !parsed.has_qualifiers && !query.is_empty() {
            parsed.text.clone()
        } else {
            String::new()
        }
    });
    let sessions = if !file_query.is_empty() && parsed.text.is_empty() {
        Vec::new()
    } else {
        search_prepared(connection, &parsed.text, &options)?
    };
    if file_query.is_empty() {
        return Ok(sessions);
    }
    let file_results = search_files(connection, &file_query, &options)?;
    let matching_text: HashSet<_> = sessions.iter().map(|r| r.reference.clone()).collect();
    let filter_text = !parsed.text.is_empty() && options.file.is_some();
    let mut seen = HashSet::new();
    Ok(file_results
        .into_iter()
        .filter(|r| !filter_text || matching_text.contains(&r.reference))
        .chain(sessions)
        .filter(|r| seen.insert(r.reference.clone()))
        .take(options.limit.unwrap_or(50))
        .collect())
}

pub fn execute_with_snapshot(
    connection: &Connection,
    query: &str,
    options: &SearchOptions,
    snapshot: &[SessionHead],
) -> Result<Vec<SearchResult>> {
    let (parsed, options) = prepare(connection, query, options)?;
    if !parsed.text.is_empty()
        || options.file.is_some()
        || options.file_kind.is_some()
        || !options.tools.is_empty()
    {
        return execute(connection, query, &options);
    }
    let costs = inclusive_costs(snapshot, &options);
    Ok(snapshot
        .iter()
        .filter(|session| {
            matches_head(
                session,
                &options,
                costs
                    .get(&session.reference)
                    .copied()
                    .unwrap_or(session.stats.total_cost),
            )
        })
        .take(options.limit.unwrap_or(50))
        .map(|session| SearchResult {
            reference: session.reference.clone(),
            session: session.clone(),
            snippet: format!("Recent session · {}", session.directory),
            snippet_highlights: Vec::new(),
            match_type: "recent".into(),
        })
        .collect())
}

fn inclusive_costs(
    snapshot: &[SessionHead],
    options: &SearchOptions,
) -> HashMap<SessionReference, f64> {
    if options.cost_min.is_none() && options.cost_max.is_none() {
        return HashMap::new();
    }
    let tree = crate::query::SessionTree::new(snapshot);
    let mut costs: Vec<f64> = tree.sessions.iter().map(|s| s.stats.total_cost).collect();
    let mut order = Vec::with_capacity(tree.sessions.len());
    let mut pending = tree.entries.clone();
    while let Some(index) = pending.pop() {
        order.push(index);
        pending.extend(tree.children[index].iter().copied());
    }
    for index in order.into_iter().rev() {
        for &child in &tree.children[index] {
            costs[index] += costs[child];
        }
    }
    tree.sessions
        .iter()
        .zip(costs)
        .map(|(s, c)| (s.reference.clone(), c))
        .collect()
}

pub fn matches_head(session: &SessionHead, options: &SearchOptions, inclusive_cost: f64) -> bool {
    if options
        .agent
        .as_ref()
        .is_some_and(|a| a != &session.reference.agent_name)
    {
        return false;
    }
    let activity = if session.time_updated > 0.0 {
        session.time_updated
    } else {
        session.time_created
    };
    if options.from.is_some_and(|from| activity < from)
        || options.to.is_some_and(|to| activity > to)
    {
        return false;
    }
    if let Some(scope) = &options.query_scope {
        if !scope.agents.is_empty() && !scope.agents.contains(&session.reference.agent_name) {
            return false;
        }
        if scope
            .project_scope
            .as_ref()
            .is_some_and(|p| !crate::projects::matches_project_scope(session, p))
        {
            return false;
        }
    }
    if options
        .project_scope
        .as_ref()
        .is_some_and(|p| !crate::projects::matches_project_scope(session, p))
    {
        return false;
    }
    match (&options.project_kind, &options.project_key) {
        (Some(kind), Some(key))
            if kind != &session.project_identity.kind || key != &session.project_identity.key =>
        {
            return false;
        }
        (Some(_), None) | (None, Some(_)) => return false,
        _ => (),
    }
    if options.project.as_ref().is_some_and(|p| {
        !format!(
            "{}\n{}\n{}",
            session.project_identity.key, session.project_identity.display_name, session.directory
        )
        .to_lowercase()
        .contains(&p.to_lowercase())
    }) {
        return false;
    }
    if !options
        .tags
        .iter()
        .all(|tag| session.smart_tags.contains(tag))
    {
        return false;
    }
    if options.cost_min.is_some_and(|cost| {
        if options.cost_min_exclusive {
            inclusive_cost <= cost
        } else {
            inclusive_cost < cost
        }
    }) {
        return false;
    }
    if options.cost_max.is_some_and(|cost| {
        if options.cost_max_exclusive {
            inclusive_cost >= cost
        } else {
            inclusive_cost > cost
        }
    }) {
        return false;
    }
    true
}

pub fn filter_candidates(
    connection: &Connection,
    candidates: Vec<SearchResult>,
    query: &str,
    options: &SearchOptions,
    snapshot: &[SessionHead],
) -> Result<Vec<SearchResult>> {
    let (_, options) = prepare(connection, query, options)?;
    let costs = inclusive_costs(snapshot, &options);
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|r| {
            matches_head(
                &r.session,
                &options,
                costs
                    .get(&r.reference)
                    .copied()
                    .unwrap_or(r.session.stats.total_cost),
            )
        })
        .collect();
    if options.file.is_none() && options.file_kind.is_none() && options.tools.is_empty() {
        return Ok(candidates);
    }
    let references: Vec<_> = candidates.iter().map(|r| r.reference.clone()).collect();
    let matches = filter_indexed_references(
        connection,
        &references,
        &SearchOptions {
            file: options.file,
            file_kind: options.file_kind,
            tools: options.tools,
            ..Default::default()
        },
    )?;
    Ok(candidates
        .into_iter()
        .filter(|r| matches.contains(&r.reference))
        .collect())
}

pub fn search_sessions(
    connection: &Connection,
    query: &str,
    options: &SearchOptions,
) -> Result<Vec<SearchResult>> {
    let (parsed, options) = prepare(connection, query, options)?;
    search_prepared(connection, &parsed.text, &options)
}

pub fn filter_indexed_references(
    connection: &Connection,
    references: &[SessionReference],
    options: &SearchOptions,
) -> Result<HashSet<SessionReference>> {
    let (_, options) = prepare(connection, "", options)?;
    let filters = sql::build(&options);
    let mut found = HashSet::new();
    for chunk in references.chunks(200) {
        let conditions = vec!["(s.agent_name=? AND s.session_id=?)"; chunk.len()].join(" OR ");
        let mut params: Vec<Value> = chunk
            .iter()
            .flat_map(|r| [r.agent_name.clone().into(), r.session_id.clone().into()])
            .collect();
        params.extend(filters.params.clone());
        let mut statement = connection.prepare(&format!("SELECT s.agent_name,s.session_id FROM sessions s WHERE ({conditions}) AND s.publication_id IS NULL {}",filters.where_sql()))?;
        for row in statement.query_map(params_from_iter(params), |r| {
            Ok(SessionReference {
                agent_name: r.get(0)?,
                session_id: r.get(1)?,
            })
        })? {
            found.insert(row?);
        }
    }
    Ok(found)
}

#[cfg(test)]
mod tests;
