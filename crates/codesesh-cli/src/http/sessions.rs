use super::{State, decorate, error, params::Params, retry};
use axum::{
    Json,
    extract::{Path, RawQuery, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use codesesh_core::public_contract::WireSessionListPage;
use codesesh_core::{
    contract::SessionReference,
    projects,
    query::{PaginationError, SessionFilter, filter_sessions},
};
use std::sync::Arc;

pub async fn list(AxumState(state): AxumState<Arc<State>>, RawQuery(raw): RawQuery) -> Response {
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
    let aliases = state.aliases().await;
    let snapshot = state.snapshot();
    let cwd = query
        .optional("cwd")
        .filter(|_| project.is_none())
        .map(str::to_owned);
    let selected = if let Some(cwd) = cwd {
        let snapshot = snapshot.clone();
        match tokio::task::spawn_blocking(move || {
            let scope = projects::create_project_scope_matcher(&cwd);
            snapshot
                .iter()
                .filter(|s| projects::matches_project_scope(s, &scope))
                .cloned()
                .collect::<Vec<_>>()
        })
        .await
        {
            Ok(v) => v,
            Err(_) => return error(StatusCode::SERVICE_UNAVAILABLE, "Project scope unavailable"),
        }
    } else {
        snapshot.as_ref().clone()
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
    if query.get("limit").is_none() && query.get("cursor").is_none() {
        return session_page(items, None);
    }
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
        Ok(page) => session_page(page.items, page.next_cursor),
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
    Path((agent, id)): Path<(String, String)>,
    RawQuery(raw): RawQuery,
) -> Response {
    if !state.options.enabled_agents.contains(&agent) {
        return error(StatusCode::NOT_FOUND, &format!("Unknown agent: {agent}"));
    }
    let Ok(_permit) = state.details.clone().try_acquire_owned() else {
        return retry("Session details busy; retry later");
    };
    let reference = SessionReference {
        agent_name: agent,
        session_id: id,
    };
    let query = Params::new(raw.as_deref());
    let cursor = query.optional("messageCursor").map(str::to_owned);
    let result = state
        .runtime
        .read(move |conn| {
            let Some(head) = codesesh_core::storage::head_from_connection(conn, &reference)? else {
                return Ok(None);
            };
            codesesh_core::storage::detail_with_cursor(conn, head, cursor.as_deref())
        })
        .await;
    match result {
        Ok(Some(mut detail)) => {
            decorate(&mut detail.head, &state.aliases().await);
            match super::wire::detail(detail) {
                Ok(detail) => super::streaming::json_with_guard(detail, _permit),
                Err(_) => error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Invalid session contract",
                ),
            }
        }
        Ok(None) => retry("Session detail not ready; retry later"),
        Err(e)
            if e.downcast_ref::<codesesh_core::runtime::ReadBusy>()
                .is_some() =>
        {
            retry("Session details busy; retry later")
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load session"),
    }
}

fn session_page(
    items: Vec<codesesh_core::contract::SessionHead>,
    next_cursor: Option<String>,
) -> Response {
    match items
        .into_iter()
        .map(super::wire::head)
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(sessions) => Json(WireSessionListPage {
            sessions,
            next_cursor,
        })
        .into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid session contract",
        ),
    }
}
