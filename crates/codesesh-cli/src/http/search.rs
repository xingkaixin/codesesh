use super::{State, decorate, error, params::Params};
use axum::{
    Json,
    extract::{RawQuery, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use codesesh_core::search::{self, FileActivityOptions, SearchOptions, SearchResult};
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
        query_scope: Some(state.query_scope.clone()),
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
    let query_scope = state.query_scope.clone();
    let result=state.runtime.read_snapshot(move |conn,heads| {
        let snapshot=super::scoped_heads(heads,&query_scope);
        let ranked=search::execute_with_snapshot(conn,&query,&options,&snapshot)?;
        let needle=search::parse_query(&query).text.trim().to_lowercase();
        let candidates=if needle.is_empty() {Vec::new()} else {snapshot.iter().filter(|s|aliases.get(&s.reference).is_some_and(|a|a.to_lowercase().contains(&needle))).map(|s|SearchResult {reference:s.reference.clone(),session:s.clone(),snippet:format!("Alias · {}",s.directory),snippet_highlights:vec![],match_type:"title".into()}).collect()};
        let mut alias_results=search::filter_candidates(conn,candidates,&query,&options,&snapshot)?;
        alias_results.sort_by(|a,b|b.session.time_updated.total_cmp(&a.session.time_updated));
        let mut merged=merge(ranked,alias_results,limit);let mut values=Vec::with_capacity(merged.len());
        for result in &mut merged {
            decorate(&mut result.session,&aliases);result.session=result.session.public();
            let mut value=serde_json::to_value(&*result)?;
            if let Some(parent_ref)=&result.session.parent_reference && let Some(parent)=snapshot.iter().find(|s|s.reference==*parent_ref) {value["parent"]=json!({"reference":parent_ref,"title":aliases.get(parent_ref).unwrap_or(&parent.title)});}
            values.push(value);
        }
        Ok(values)
    }).await;
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
        query_scope: Some(state.query_scope.clone()),
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
                decorate(&mut a.session, &aliases);
                a.session = a.session.public();
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
