use super::{State, error, etag, params::Params, retry};
use axum::{
    Json,
    extract::{Path, RawQuery, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use codesesh_core::wire::{SessionMessageMatches, WireSessionListPage};
use codesesh_core::{
    projects,
    session_list::{PaginationError, SessionFilter, filter_sessions},
};
use serde_json::json;
use std::sync::Arc;

pub async fn list(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let query = Params::new(raw.as_deref());
    let limit = match query.limit(250, 500) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let project = match query.project() {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let (from, to) = match query.window(&state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    if query.get("cursor").is_some_and(|cursor| !cursor.is_empty()) {
        return paginated_sessions(&state, &query, limit, Vec::new(), None);
    }
    let aliases = state.aliases().await;
    let source_node_id = query.optional("sourceNodeId");
    let query_scope = state.scope(source_node_id);
    let (revision, raw_snapshot) = state.runtime.snapshot_with_revision();
    let cwd = query
        .optional("cwd")
        .filter(|_| project.is_none())
        .map(str::to_owned);
    let paginated = query.get("limit").is_some();
    let tag = etag::weak_etag(
        state.etag_namespace,
        &json!([
            "sessions",
            revision,
            etag::aliases_fingerprint(&aliases),
            paginated,
            limit,
            cwd,
            source_node_id,
            query.get("agent"),
            project,
            query.get("tag"),
            query.get("q"),
            from,
            to
        ]),
    );
    if etag::matches_if_none_match(&headers, &tag) {
        return etag::not_modified(&tag);
    }
    let selected = if let Some(cwd) = cwd {
        match tokio::task::spawn_blocking(move || {
            let scope = projects::create_project_scope_matcher(&cwd);
            raw_snapshot
                .iter()
                .filter(|s| {
                    super::matches_scope(s, &query_scope)
                        && projects::matches_project_scope(s, &scope)
                })
                .map(|s| (**s).clone())
                .collect::<Vec<_>>()
        })
        .await
        {
            Ok(v) => v,
            Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "Project scope unavailable"),
        }
    } else {
        super::scoped_shared_heads(&raw_snapshot, &query_scope)
    };
    let filter = SessionFilter {
        agent: query.get("agent"),
        project,
        tag: query.get("tag"),
        query: query.get("q"),
        from,
        to,
    };
    let items = filter_sessions(&selected, &filter, &aliases);
    if !paginated {
        return session_page(items, None, Some(&tag));
    }
    paginated_sessions(&state, &query, limit, items, Some(&tag))
}

fn paginated_sessions(
    state: &State,
    query: &Params,
    limit: usize,
    items: Vec<codesesh_core::model::SessionHead>,
    tag: Option<&str>,
) -> Response {
    let Ok(mut pages) = state.session_pages.lock() else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load sessions");
    };
    match pages.paginate(
        chrono::Utc::now().timestamp_millis(),
        &query.pairs,
        query.get("cursor"),
        limit,
        || (items, ()),
    ) {
        Ok(page) => session_page(page.items, page.next_cursor, tag),
        Err(PaginationError::InvalidCursor) => error(
            StatusCode::BAD_REQUEST,
            "cursor is invalid for this request",
        ),
        Err(PaginationError::StaleSnapshot) => error(
            StatusCode::CONFLICT,
            "session snapshot expired; restart pagination",
        ),
    }
}

pub async fn detail(
    AxumState(state): AxumState<Arc<State>>,
    Path(path): Path<super::params::SessionPath>,
    RawQuery(raw): RawQuery,
) -> Response {
    let reference = path.reference();
    if !state.options.enabled_agents.contains(&reference.agent_name) {
        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown agent: {}", reference.agent_name),
        );
    }
    let Ok(_permit) = state.details.clone().try_acquire_owned() else {
        return retry("Session details busy; retry later");
    };
    let query = Params::new(raw.as_deref());
    let cursor = query.optional("messageCursor").map(str::to_owned);
    let message_limit = match query.get("messageLimit") {
        None => None,
        Some(raw) => match raw.parse::<usize>() {
            Ok(limit @ 1..=200) => Some(limit),
            _ => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "messageLimit must be between 1 and 200",
                );
            }
        },
    };
    let pricing = match state.pricing.snapshot() {
        Ok(snapshot) => snapshot.pricing,
        Err(_) => return retry("Pricing unavailable; retry later"),
    };
    super::streaming::detail(
        state.runtime.clone(),
        pricing,
        reference,
        cursor,
        message_limit,
        state.aliases().await,
        _permit,
    )
    .await
}

pub async fn matches(
    AxumState(state): AxumState<Arc<State>>,
    Path(path): Path<super::params::SessionPath>,
    RawQuery(raw): RawQuery,
) -> Response {
    let reference = path.reference();
    if !state.options.enabled_agents.contains(&reference.agent_name) {
        return error(
            StatusCode::NOT_FOUND,
            &format!("Unknown agent: {}", reference.agent_name),
        );
    }
    let query = Params::new(raw.as_deref());
    let needle = query.get("q").unwrap_or("").trim().to_owned();
    let scope = state.query_scope.clone();
    match state
        .runtime
        .read(move |connection| {
            let Some(head) = codesesh_core::storage::head_from_connection(connection, &reference)?
            else {
                return Ok(None);
            };
            if scope
                .project_scope
                .as_ref()
                .is_some_and(|matcher| !projects::matches_project_scope(&head, matcher))
            {
                return Ok(None);
            }
            if needle.is_empty() {
                return Ok(Some(Vec::new()));
            }
            let message_indices = codesesh_core::search::find_session_message_matches(
                connection, &reference, &needle,
            )?;
            Ok(Some(message_indices))
        })
        .await
    {
        Ok(Some(message_indices)) => {
            Json(SessionMessageMatches { message_indices }).into_response()
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "Session not found"),
        Err(err)
            if err
                .downcast_ref::<codesesh_core::runtime::ReadBusy>()
                .is_some() =>
        {
            retry("Session search busy; retry later")
        }
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to search session messages",
        ),
    }
}

fn session_page(
    items: Vec<codesesh_core::model::SessionHead>,
    next_cursor: Option<String>,
    tag: Option<&str>,
) -> Response {
    match items
        .into_iter()
        .map(super::wire::head)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(sessions) => {
            let has_next = next_cursor.is_some();
            let mut response = super::streaming::json_with_guard(
                WireSessionListPage {
                    sessions,
                    next_cursor,
                },
                (),
            );
            // Only emit ETag when there is no ephemeral cursor so clients never cache an expiring cursor.
            if !has_next && let Some(tag) = tag {
                etag::apply_headers(&mut response, tag);
            }
            response
        }
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid session contract",
        ),
    }
}
