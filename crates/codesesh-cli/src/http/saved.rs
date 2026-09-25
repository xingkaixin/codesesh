use super::{State, decorate_value, error};
use axum::{
    Json,
    body::Bytes,
    extract::{Path, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use codesesh_core::{
    bookmarks::materialize_bookmarks,
    contract::{SessionHead, SessionReference},
    state::{
        BookmarkRecord, StateStore, normalize_session_alias, parse_bookmark_import,
        parse_bookmark_reference, reference_key,
    },
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

async fn perform<T: Send + 'static>(
    state: &State,
    f: impl FnOnce(&mut StateStore) -> anyhow::Result<T> + Send + 'static,
) -> anyhow::Result<T> {
    let saved = state.saved.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = saved
            .lock()
            .map_err(|_| anyhow::anyhow!("state lock poisoned"))?;
        f(store
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("SQLite state database is unavailable"))?)
    })
    .await?
}
fn unavailable(alias: bool) -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        if alias {
            "Session alias storage is unavailable"
        } else {
            "Bookmark storage is unavailable"
        },
    )
}
fn invalid() -> Response {
    error(StatusCode::BAD_REQUEST, "Invalid bookmark payload")
}
fn known(state: &State, reference: &SessionReference) -> Result<(), String> {
    if state.known(&reference.agent_name) {
        Ok(())
    } else {
        Err(format!("Unknown agent: {}", reference.agent_name))
    }
}
async fn materialize(state: &State, records: Vec<BookmarkRecord>) -> anyhow::Result<Value> {
    let query_scope = state.query_scope.clone();
    let known: HashSet<_> = codesesh_core::agents::catalog(0)
        .into_iter()
        .map(|a| a.name)
        .collect();
    let views = state
        .runtime
        .read_snapshot(move |conn, heads| {
            let live: HashMap<String, SessionHead> = super::scoped_heads(heads, &query_scope)
                .into_iter()
                .map(|s| (reference_key(&s.reference), s))
                .collect();
            materialize_bookmarks(&records, &live, &known, |refs| {
                refs.iter()
                    .filter_map(
                        |r| match codesesh_core::storage::head_from_connection(conn, r) {
                            Ok(Some(head)) => Some(Ok((r.clone(), head))),
                            Ok(None) => None,
                            Err(e) => Some(Err(e)),
                        },
                    )
                    .collect()
            })
        })
        .await?;
    let aliases = state.aliases().await;
    let mut views = serde_json::to_value(views)?;
    for view in views.as_array_mut().unwrap() {
        if view["availability"] == "available" {
            decorate_value(&mut view["session"], &aliases);
        } else {
            decorate_value(view, &aliases);
        }
    }
    Ok(json!({"bookmarks":views,"storageAvailable":true}))
}
pub async fn list(AxumState(state): AxumState<Arc<State>>) -> Response {
    match perform(&state, |s| s.list_bookmarks()).await {
        Ok(records) => match materialize(&state, records).await {
            Ok(v) => Json(v).into_response(),
            Err(_) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load bookmarks",
            ),
        },
        Err(_) => unavailable(false),
    }
}
pub async fn put(AxumState(state): AxumState<Arc<State>>, bytes: Bytes) -> Response {
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let Some(reference) = parse_bookmark_reference(&body) else {
        return invalid();
    };
    if let Err(e) = known(&state, &reference) {
        return error(StatusCode::BAD_REQUEST, &e);
    }
    match perform(&state, move |s| s.upsert_bookmark(&reference)).await {
        Ok(record) => Json(json!({"bookmark":record,"storageAvailable":true})).into_response(),
        Err(_) => unavailable(false),
    }
}
pub async fn import(AxumState(state): AxumState<Arc<State>>, bytes: Bytes) -> Response {
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let Some(values) = body.as_array() else {
        return invalid();
    };
    let Some(mut records): Option<Vec<_>> = values
        .iter()
        .map(|v| parse_bookmark_import(v, chrono::Utc::now().timestamp_millis()))
        .collect()
    else {
        return invalid();
    };
    let count = records.len();
    records.retain(|b| state.known(&b.reference.agent_name));
    let skipped = count - records.len();
    match perform(&state, move |s| s.import_bookmarks(&records)).await {
        Ok(records) => match materialize(&state, records).await {
            Ok(mut v) => {
                if skipped > 0 {
                    v["skippedUnknownAgents"] = json!(skipped);
                }
                Json(v).into_response()
            }
            Err(_) => error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to load bookmarks",
            ),
        },
        Err(_) => unavailable(false),
    }
}
pub async fn delete(
    AxumState(state): AxumState<Arc<State>>,
    Path((agent, id)): Path<(String, String)>,
) -> Response {
    let reference = SessionReference {
        agent_name: agent,
        session_id: id,
    };
    if let Err(e) = known(&state, &reference) {
        return error(StatusCode::BAD_REQUEST, &e);
    }
    match perform(&state, move |s| s.delete_bookmark(&reference)).await {
        Ok(()) => Json(json!({"ok":true,"storageAvailable":true})).into_response(),
        Err(_) => unavailable(false),
    }
}
pub async fn alias_put(
    AxumState(state): AxumState<Arc<State>>,
    Path((agent, id)): Path<(String, String)>,
    bytes: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let Some(alias) = body["alias"].as_str() else {
        return error(StatusCode::BAD_REQUEST, "Invalid session alias payload");
    };
    let reference = SessionReference {
        agent_name: agent,
        session_id: id,
    };
    if let Err(e) = known(&state, &reference) {
        return error(StatusCode::BAD_REQUEST, &e);
    }
    let Some(alias) = normalize_session_alias(alias) else {
        return error(
            StatusCode::BAD_REQUEST,
            "Session alias must be non-empty and at most 160 characters",
        );
    };
    match perform(&state, move |s| s.upsert_alias(&reference, &alias)).await {
        Ok(alias) => Json(json!({"alias":alias})).into_response(),
        Err(_) => unavailable(true),
    }
}
pub async fn alias_delete(
    AxumState(state): AxumState<Arc<State>>,
    Path((agent, id)): Path<(String, String)>,
) -> Response {
    let reference = SessionReference {
        agent_name: agent,
        session_id: id,
    };
    if let Err(e) = known(&state, &reference) {
        return error(StatusCode::BAD_REQUEST, &e);
    }
    match perform(&state, move |s| s.delete_alias(&reference)).await {
        Ok(()) => Json(json!({"ok":true})).into_response(),
        Err(_) => unavailable(true),
    }
}
