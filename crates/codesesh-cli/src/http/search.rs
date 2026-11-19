use super::{State, decorate, decorate_wire, error, params::Params};
use axum::{
    Json,
    extract::{RawQuery, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use codesesh_core::{
    search::{self, FileActivityOptions, SearchOptions, SearchResult},
    wire::SearchResultParent,
};
use serde_json::json;
use std::{collections::HashSet, sync::Arc};

pub async fn search(AxumState(state): AxumState<Arc<State>>, RawQuery(raw): RawQuery) -> Response {
    let params = Params::new(raw.as_deref());
    let limit = match params.limit(50, 100) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let project = match params.project() {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let (from, to) = match params.window(&state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    if params.get("agent").is_some_and(|a| !state.known(a)) {
        return Json(json!({"results":[]})).into_response();
    }
    let query = params.get("q").unwrap_or("").trim().to_owned();
    let num = |key| {
        params
            .optional(key)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    let options = SearchOptions {
        agent: params.get("agent").map(|v| v.trim().to_lowercase()),
        project: params.optional("project").map(str::to_owned),
        project_kind: project.map(|(k, _)| k.to_owned()),
        project_key: project.map(|(_, k)| k.to_owned()),
        cwd: params.optional("cwd").map(str::to_owned),
        query_scope: Some(state.scope(params.optional("sourceNodeId"))),
        tags: params
            .values(&["tag", "tags", "signal"])
            .into_iter()
            .map(|v| v.to_lowercase())
            .filter(|v| {
                matches!(
                    v.as_str(),
                    "bugfix"
                        | "refactoring"
                        | "feature-dev"
                        | "testing"
                        | "docs"
                        | "git-ops"
                        | "build-deploy"
                        | "exploration"
                        | "planning"
                )
            })
            .collect(),
        tools: params
            .values(&["tool", "tools"])
            .into_iter()
            .map(|v| v.to_lowercase())
            .collect(),
        file: params
            .get("file")
            .or_else(|| params.get("path"))
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
        file_kind: kind(
            params
                .get("fileKind")
                .or_else(|| params.get("fileActivity")),
        ),
        cost_min: num("costMin"),
        cost_max: num("costMax"),
        from,
        to,
        limit: Some(limit),
        ..Default::default()
    };
    let aliases = state.aliases().await;
    let query_scope = state.scope(params.optional("sourceNodeId"));
    let result = state
        .runtime
        .read_snapshot(move |conn, heads| {
            let parsed = search::parse_query(&query);
            let uses_sql_search = !parsed.text.is_empty()
                || options.model.is_some()
                || parsed.filters.model.is_some()
                || options.file.is_some()
                || parsed.filters.file.is_some()
                || options.file_kind.is_some()
                || parsed.filters.file_kind.is_some()
                || !options.tools.is_empty()
                || !parsed.filters.tools.is_empty();
            let scoped: Vec<_> = if uses_sql_search {
                Vec::new()
            } else {
                heads
                    .iter()
                    .map(Arc::as_ref)
                    .filter(|s| super::matches_scope(s, &query_scope))
                    .collect()
            };
            let ranked = if uses_sql_search {
                search::execute_with_snapshot(conn, &query, &options, &[])?
            } else {
                let snapshot = scoped.iter().map(|s| (*s).clone()).collect::<Vec<_>>();
                search::execute_with_snapshot(conn, &query, &options, &snapshot)?
            };
            let needle = parsed.text.trim().to_lowercase();
            let mut candidates = Vec::new();
            if !needle.is_empty() {
                for (reference, alias) in &aliases {
                    if !alias.to_lowercase().contains(&needle) {
                        continue;
                    }
                    if let Some(session) =
                        codesesh_core::storage::head_from_connection(conn, reference)?
                        && super::matches_scope(&session, &query_scope)
                    {
                        candidates.push(SearchResult {
                            reference: reference.clone(),
                            snippet: format!("Alias · {}", session.directory),
                            session,
                            snippet_highlights: vec![],
                            match_type: "title".into(),
                            message_index: None,
                        });
                    }
                }
            }
            let mut alias_results = if candidates.is_empty() {
                Vec::new()
            } else {
                let needs_inclusive_costs = options.cost_min.is_some()
                    || options.cost_max.is_some()
                    || parsed.filters.cost_min.is_some()
                    || parsed.filters.cost_max.is_some();
                if needs_inclusive_costs {
                    let snapshot = codesesh_core::storage::snapshot_from_connection(conn)?
                        .into_iter()
                        .filter(|s| super::matches_scope(s, &query_scope))
                        .collect::<Vec<_>>();
                    search::filter_candidates(conn, candidates, &query, &options, &snapshot)?
                } else {
                    search::filter_candidates(conn, candidates, &query, &options, &[])?
                }
            };
            alias_results.sort_by(|a, b| {
                b.session
                    .time_updated
                    .total_cmp(&a.session.time_updated)
                    .then_with(|| {
                        (
                            &a.reference.source_node_id,
                            &a.reference.agent_name,
                            &a.reference.session_id,
                        )
                            .cmp(&(
                                &b.reference.source_node_id,
                                &b.reference.agent_name,
                                &b.reference.session_id,
                            ))
                    })
            });
            let merged = merge(ranked, alias_results, limit);
            let mut values = Vec::with_capacity(merged.len());
            for mut result in merged {
                decorate(&mut result.session, &aliases);
                let parent = if let Some(reference) = result.session.parent_reference.as_ref() {
                    let stored;
                    let head = if uses_sql_search {
                        stored = codesesh_core::storage::head_from_connection(conn, reference)?;
                        stored
                            .as_ref()
                            .filter(|head| super::matches_scope(head, &query_scope))
                    } else {
                        scoped.iter().copied().find(|s| s.reference == *reference)
                    };
                    head.map(|head| SearchResultParent {
                        reference: reference.clone(),
                        title: aliases.get(reference).unwrap_or(&head.title).clone(),
                    })
                } else {
                    None
                };
                values.push(super::wire::search_result(result, parent)?);
            }
            Ok(values)
        })
        .await;
    match result {
        Ok(results) => Json(json!({"results":results})).into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to search sessions",
        ),
    }
}

pub async fn file_activity(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
) -> Response {
    let params = Params::new(raw.as_deref());
    let limit = match params.limit(50, 200) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let project = match params.project() {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let (from, to) = match params.window(&state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    if params.get("agent").is_some_and(|a| !state.known(a)) {
        return Json(json!({"activity":[]})).into_response();
    }
    let cwd = params.optional("cwd").map(str::to_owned);
    let options = FileActivityOptions {
        agent: params.get("agent").map(|v| v.trim().to_lowercase()),
        session_id: params.optional("sessionId").map(str::to_owned),
        project_kind: project.map(|(k, _)| k.to_owned()),
        project_key: project.map(|(_, k)| k.to_owned()),
        project: params.optional("project").map(str::to_owned),
        query_scope: Some(state.scope(params.optional("sourceNodeId"))),
        path: params.optional("path").map(str::to_owned),
        kind: kind(params.optional("kind")),
        from,
        to,
        limit: Some(limit),
        ..Default::default()
    };
    let aliases = state.aliases().await;
    match state
        .runtime
        .read(move |conn| {
            let mut options = options;
            options.project_scope = cwd
                .as_deref()
                .map(codesesh_core::projects::create_project_scope_matcher);
            let mut activity = search::list_file_activity(conn, &options)?;
            for a in &mut activity {
                decorate_wire(&mut a.session, &aliases);
            }
            Ok(activity)
        })
        .await
    {
        Ok(activity) => Json(json!({"activity":activity})).into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load file activity",
        ),
    }
}
fn kind(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| matches!(*v, "read" | "edit" | "write" | "delete"))
        .map(str::to_owned)
}
fn merge(ranked: Vec<SearchResult>, aliases: Vec<SearchResult>, limit: usize) -> Vec<SearchResult> {
    let mut seen = HashSet::new();
    let ranked: Vec<_> = ranked
        .into_iter()
        .filter(|r| seen.insert(r.reference.clone()))
        .collect();
    let aliases: Vec<_> = aliases
        .into_iter()
        .filter(|r| seen.insert(r.reference.clone()))
        .collect();
    let quota = if ranked.is_empty() {
        limit
    } else if aliases.is_empty() {
        0
    } else {
        (limit / 4).max(1).min(limit.saturating_sub(1))
    };
    let mut ranked = ranked.into_iter();
    let mut aliases = aliases.into_iter();
    let mut result: Vec<_> = ranked.by_ref().take(limit - quota).collect();
    result.extend(aliases.by_ref().take(quota));
    result.extend(ranked.take(limit.saturating_sub(result.len())));
    result.extend(aliases.take(limit.saturating_sub(result.len())));
    result
}
