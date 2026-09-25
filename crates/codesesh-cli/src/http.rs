use axum::{
    Json, Router,
    extract::{Path, Query, Request, State as AxumState},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use codesesh_core::{agents, contract::SessionHead, storage::Cache};
use serde_json::{Value, json};
use std::{
    path::{Component, PathBuf},
    sync::{Arc, Mutex},
};

pub struct State {
    pub sessions: Vec<SessionHead>,
    pub cache: Mutex<Cache>,
    pub token: String,
    pub days: u32,
}

pub fn router(state: Arc<State>) -> Router {
    Router::new()
        .route("/api/config", get(config))
        .route("/api/status", get(status))
        .route("/api/agents", get(agent_list))
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{agent}/{id}", get(detail))
        .fallback(static_file)
        .layer(middleware::from_fn_with_state(state.clone(), authorize))
        .with_state(state)
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}

async fn authorize(
    AxumState(state): AxumState<Arc<State>>,
    request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let authority = host.parse::<axum::http::uri::Authority>().ok();
    if !authority.is_some_and(|a| matches!(a.host(), "localhost" | "127.0.0.1" | "[::1]")) {
        return error(StatusCode::FORBIDDEN, "Invalid Host");
    }
    if let Some(origin) = request.headers().get(header::ORIGIN) {
        let expected = format!("http://{host}");
        if origin.as_bytes() != expected.as_bytes() {
            return error(StatusCode::FORBIDDEN, "Invalid Origin");
        }
    }
    if request.uri().path().starts_with("/api/") {
        let bearer = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let cookie = request
            .headers()
            .get(header::COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|cookie| {
                cookie
                    .split(';')
                    .find_map(|part| part.trim().strip_prefix("codesesh_access_token="))
            });
        if bearer.or(cookie) != Some(state.token.as_str()) {
            return error(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}

async fn config(AxumState(state): AxumState<Arc<State>>) -> Json<Value> {
    Json(json!({"window":{"days":state.days}}))
}
async fn status() -> Json<Value> {
    Json(json!({"type":"scan-status","active":false,"phase":"idle",
        "pendingAgents":[],"scanningAgents":[],"completedAgents":["codex"],
        "agentStatuses":{},"totalAgents":1,"updatedAt":chrono::Utc::now().timestamp_millis(),
        "backfill":{"active":false,"pendingAgents":[],"completedAgents":[],"failedAgents":[]}}))
}
async fn agent_list(AxumState(state): AxumState<Arc<State>>) -> Json<Value> {
    Json(serde_json::to_value(agents::catalog(state.sessions.len())).unwrap())
}
async fn sessions(
    AxumState(state): AxumState<Arc<State>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if query
        .keys()
        .any(|key| !matches!(key.as_str(), "limit" | "agent" | "from" | "to"))
    {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            "Rust P1 query filtering is not yet implemented",
        );
    }
    let limit = match query.get("limit").map(|text| text.parse::<usize>()) {
        Some(Ok(value)) if value > 0 => value,
        Some(_) => return error(StatusCode::BAD_REQUEST, "limit must be a positive integer"),
        None => 250,
    };
    let mut from = None;
    let mut to = None;
    for (key, target) in [("from", &mut from), ("to", &mut to)] {
        if let Some(value) = query.get(key) {
            match chrono::DateTime::parse_from_rfc3339(value) {
                Ok(date) => *target = Some(date.timestamp_millis()),
                Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid date window"),
            }
        }
    }
    let sessions = state
        .sessions
        .iter()
        .filter(|session| {
            query
                .get("agent")
                .is_none_or(|agent| *agent == session.reference.agent_name)
        })
        .filter(|session| {
            from.is_none_or(|from| session.time_updated >= from)
                && to.is_none_or(|to| session.time_updated <= to)
        })
        .map(|session| session.public())
        .collect::<Vec<_>>();
    if sessions.len() > limit {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            "Rust P1 pagination is not yet implemented",
        );
    }
    Json(json!({"sessions":sessions})).into_response()
}

async fn detail(
    AxumState(state): AxumState<Arc<State>>,
    Path((agent, id)): Path<(String, String)>,
) -> Response {
    let Some(head) = state
        .sessions
        .iter()
        .find(|session| session.reference.agent_name == agent && session.reference.session_id == id)
        .cloned()
    else {
        return error(StatusCode::NOT_FOUND, "Session not found");
    };
    let result = tokio::task::spawn_blocking(move || {
        state
            .cache
            .lock()
            .map_err(|_| anyhow::anyhow!("cache reader lock poisoned"))?
            .detail(head)
    })
    .await;
    match result {
        Ok(Ok(Some(detail))) => Json(detail).into_response(),
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND, "Session not found"),
        _ => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Session detail is not ready",
        ),
    }
}

async fn static_file(AxumState(state): AxumState<Arc<State>>, request: Request) -> Response {
    let path = request.uri().path();
    if path.starts_with("/api/") {
        return error(
            StatusCode::NOT_IMPLEMENTED,
            "Rust P1 endpoint is pending migration",
        );
    }
    let relative = path.trim_start_matches('/');
    if PathBuf::from(relative)
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist");
    let requested = root.join(relative);
    let file = if requested.is_file() {
        requested
    } else {
        root.join("index.html")
    };
    let mime = match file.extension().and_then(|ext| ext.to_str()) {
        Some("js") => "text/javascript",
        Some("css") => "text/css",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("woff2") => "font/woff2",
        _ => "text/html; charset=utf-8",
    };
    let Ok(bytes) = tokio::task::spawn_blocking(move || std::fs::read(file))
        .await
        .unwrap_or_else(|error| Err(std::io::Error::other(error)))
    else {
        return error(
            StatusCode::NOT_FOUND,
            "Build apps/web before running the Rust preview",
        );
    };
    let mut response = ([(header::CONTENT_TYPE, mime)], bytes).into_response();
    if request.uri().query().is_some_and(|query| {
        query
            .split('&')
            .any(|entry| entry == format!("access_token={}", state.token))
    }) {
        response.headers_mut().insert(
            header::SET_COOKIE,
            format!(
                "codesesh_access_token={}; HttpOnly; SameSite=Strict; Path=/",
                state.token
            )
            .parse()
            .unwrap(),
        );
    }
    response
}
