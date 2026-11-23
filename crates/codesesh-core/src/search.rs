mod cjk;
pub(crate) use cjk::index_parts;
mod file_activity;
mod parser;
mod reader;
pub use file_activity::{FileActivityOptions, list_file_activity};
use reader::{search_files, search_prepared};
mod snippet;
mod sql;

use crate::model::{SessionHead, SessionReference};
pub(crate) use crate::projects::ProjectScopeMatcher as ProjectScope;
pub(crate) use crate::wire::SearchHighlightRange as HighlightRange;
use anyhow::Result;
pub(crate) use parser::ParsedQuery;
pub use parser::parse_query;
use rusqlite::{Connection, params_from_iter, types::Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default)]
pub struct QueryScope {
    pub source_node_id: Option<String>,
    pub agents: Vec<String>,
    pub project_scope: Option<ProjectScope>,
}

#[derive(Clone, Debug, Default)]
pub struct SearchOptions {
    pub model: Option<String>,
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

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub reference: SessionReference,
    pub session: SessionHead,
    pub snippet: String,
    pub snippet_highlights: Vec<HighlightRange>,
    pub match_type: String,
    pub message_index: Option<usize>,
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

pub(crate) fn scope_where(
    connection: &Connection,
    scope: &QueryScope,
) -> Result<(String, Vec<Value>)> {
    let (_, options) = prepare(
        connection,
        "",
        &SearchOptions {
            query_scope: Some(scope.clone()),
            ..Default::default()
        },
    )?;
    let filters = sql::build(connection, &options)?;
    Ok((filters.where_sql(), filters.params))
}

pub(crate) fn execute(
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
        || options.model.is_some()
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
            message_index: None,
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
    let tree = crate::session_list::SessionTree::new(snapshot);
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

pub(crate) fn matches_head(
    session: &SessionHead,
    options: &SearchOptions,
    inclusive_cost: f64,
) -> bool {
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
    if options.model.is_none()
        && !crate::session_list::in_window(activity, options.from, options.to)
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
    if candidates.is_empty() {
        return Ok(candidates);
    }
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
    if options.file.is_none()
        && options.file_kind.is_none()
        && options.tools.is_empty()
        && options.model.is_none()
    {
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
            from: options.from,
            to: options.to,
            model: options.model,
            query_scope: options.query_scope,
            agent: options.agent,
            project_kind: options.project_kind,
            project_key: options.project_key,
            ..Default::default()
        },
    )?;
    Ok(candidates
        .into_iter()
        .filter(|r| matches.contains(&r.reference))
        .collect())
}

#[cfg(test)]
pub(crate) fn search_sessions(
    connection: &Connection,
    query: &str,
    options: &SearchOptions,
) -> Result<Vec<SearchResult>> {
    let (parsed, options) = prepare(connection, query, options)?;
    search_prepared(connection, &parsed.text, &options)
}

pub(crate) fn filter_indexed_references(
    connection: &Connection,
    references: &[SessionReference],
    options: &SearchOptions,
) -> Result<HashSet<SessionReference>> {
    let (_, options) = prepare(connection, "", options)?;
    let filters = sql::build(connection, &options)?;
    let mut found = HashSet::new();
    for chunk in references.chunks(200) {
        let conditions =
            vec!["(s.source_node_id=? AND s.agent_name=? AND s.session_id=?)"; chunk.len()]
                .join(" OR ");
        let mut params: Vec<Value> = chunk
            .iter()
            .flat_map(|r| {
                [
                    r.source_node_id.clone().into(),
                    r.agent_name.clone().into(),
                    r.session_id.clone().into(),
                ]
            })
            .collect();
        params.extend(filters.params.clone());
        let mut statement = connection.prepare(&format!("SELECT s.agent_name,s.session_id,s.source_node_id FROM sessions s WHERE ({conditions}) AND s.publication_id IS NULL {}",filters.where_sql()))?;
        for row in statement.query_map(params_from_iter(params), |r| {
            Ok(SessionReference {
                source_node_id: r.get(2)?,
                agent_name: r.get(0)?,
                session_id: r.get(1)?,
            })
        })? {
            found.insert(row?);
        }
    }
    Ok(found)
}

fn append_find_value(value: &serde_json::Value, fields: &mut Vec<String>, depth: u8) {
    use serde_json::Value;
    if depth > 8 {
        return;
    }
    match value {
        Value::String(text) if !text.is_empty() => fields.push(text.clone()),
        Value::Number(_) | Value::Bool(_) => fields.push(value.to_string()),
        Value::Array(values) => values
            .iter()
            .for_each(|value| append_find_value(value, fields, depth + 1)),
        Value::Object(values)
            if values.get("type").and_then(Value::as_str) == Some("text")
                && values.get("text").is_some_and(Value::is_string) =>
        {
            if let Some(text) = values["text"].as_str().filter(|text| !text.is_empty()) {
                fields.push(text.to_owned());
            }
        }
        Value::Object(values) => values
            .values()
            .for_each(|value| append_find_value(value, fields, depth + 1)),
        _ => {}
    }
}

fn find_message_text(parts: Vec<crate::model::MessagePart>) -> String {
    use crate::model::MessagePart;
    let mut fields = Vec::new();
    for part in parts {
        match part {
            MessagePart::Text { text, .. }
            | MessagePart::Reasoning { text, .. }
            | MessagePart::Plan { text, .. } => {
                if !text.is_empty() {
                    fields.push(text);
                }
            }
            MessagePart::Tool {
                tool, title, state, ..
            } => {
                if !tool.is_empty() {
                    fields.push(tool);
                }
                fields.extend(title.filter(|value| !value.is_empty()));
                for value in [&state.input, &state.output, &state.error, &state.metadata]
                    .into_iter()
                    .flatten()
                {
                    append_find_value(value, &mut fields, 0);
                }
            }
            MessagePart::Image { .. } => {}
        }
    }
    fields.join("\n")
}

fn ascii_contains_ignore_case(haystack: &[u8], needle_lower: &[u8]) -> bool {
    if needle_lower.is_empty() {
        return true;
    }
    if needle_lower.len() > haystack.len() {
        return false;
    }
    let first = needle_lower[0];
    let first_upper = first.to_ascii_uppercase();
    let limit = haystack.len() - needle_lower.len();
    for i in 0..=limit {
        let b = haystack[i];
        if (b == first || b == first_upper)
            && haystack[i..i + needle_lower.len()]
                .iter()
                .zip(needle_lower)
                .all(|(h, n)| h.to_ascii_lowercase() == *n)
        {
            return true;
        }
    }
    false
}

fn plain_ascii_json_safe(term: &str) -> bool {
    !term.is_empty()
        && term
            .bytes()
            .all(|b| b.is_ascii() && !b.is_ascii_control() && b != b'"' && b != b'\\')
}

pub fn find_session_message_matches(
    connection: &Connection,
    reference: &SessionReference,
    query: &str,
) -> Result<Vec<usize>> {
    let tokens = parser::split_tokens(query);
    let any = tokens.iter().any(|token| token.eq_ignore_ascii_case("OR"));
    let terms: Vec<_> = tokens
        .iter()
        .filter(|token| !token.eq_ignore_ascii_case("OR"))
        .map(|token| parser::unwrap_value(token).to_lowercase())
        .filter(|term| !term.is_empty())
        .collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let can_prefilter = terms.iter().all(|term| plain_ascii_json_safe(term));
    let mut statement = connection.prepare_cached(
        "SELECT message_index, parts_json, parts_format_version FROM messages WHERE source_node_id=? AND agent_name=? AND session_id=? ORDER BY message_index",
    )?;
    let mut rows = statement.query(rusqlite::params![
        reference.source_node_id,
        reference.agent_name,
        reference.session_id
    ])?;
    let mut indices = Vec::new();
    while let Some(row) = rows.next()? {
        let index: i64 = row.get(0)?;
        let raw = crate::storage::body::unpack(row.get_ref(1)?)?;
        // Only prefilter when raw JSON is pure ASCII with no \uXXXX escapes; non-ASCII text
        // (e.g. U+212A Kelvin sign -> 'k') and unicode escapes can fold into ASCII search terms.
        if can_prefilter && raw.is_ascii() && !raw.contains("\\u") {
            let raw_bytes = raw.as_bytes();
            let may_match = if any {
                terms
                    .iter()
                    .any(|term| ascii_contains_ignore_case(raw_bytes, term.as_bytes()))
            } else {
                terms
                    .iter()
                    .all(|term| ascii_contains_ignore_case(raw_bytes, term.as_bytes()))
            };
            if !may_match {
                continue;
            }
        }
        let content_text =
            find_message_text(crate::storage::body::decode_parts(&raw, row.get(2)?)?);
        let lower = content_text.to_lowercase();
        let mut hits = terms.iter().map(|term| lower.contains(term));
        let matched = if any {
            hits.any(|hit| hit)
        } else {
            hits.all(|hit| hit)
        };
        if index >= 0 && matched {
            indices.push(index as usize);
        }
    }
    Ok(indices)
}

#[cfg(test)]
mod tests;
