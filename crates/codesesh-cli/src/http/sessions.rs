use super::{State, error, etag, params::Params, retry};
use axum::{
    Json,
    extract::{Path, RawQuery, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use codesesh_core::model::{SessionHead, SessionReference};
use codesesh_core::wire::{SessionMessageMatches, WireSessionListPage};
use codesesh_core::{
    projects,
    session_list::{SessionFilter, filter_sessions_indexed_shared, filter_sessions_shared},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fmt::Write, sync::Arc};

#[derive(Serialize, Deserialize)]
struct SessionCursor {
    v: u8,
    ns: String,
    r: u64,
    a: String,
    q: String,
    o: usize,
}

fn namespace_token(namespace: uuid::Uuid) -> String {
    let bytes = namespace.as_bytes();
    let mut hex = String::with_capacity(16);
    for byte in &bytes[..8] {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn canonical_query_hash(pairs: &[(String, String)]) -> String {
    let mut query: Vec<(&str, &str)> = pairs
        .iter()
        .filter(|(key, _)| key != "cursor" && key != "limit")
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    query.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let mut hasher = Sha256::new();
    for (k, v) in query {
        hasher.update((k.len() as u64).to_le_bytes());
        hasher.update(k.as_bytes());
        hasher.update((v.len() as u64).to_le_bytes());
        hasher.update(v.as_bytes());
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(16);
    for byte in &digest[..8] {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

fn encode_cursor(
    namespace: &str,
    revision: u64,
    aliases_fp: &str,
    query_hash: &str,
    offset: usize,
) -> String {
    let payload = serde_json::to_vec(&SessionCursor {
        v: 2,
        ns: namespace.to_owned(),
        r: revision,
        a: aliases_fp.to_owned(),
        q: query_hash.to_owned(),
        o: offset,
    })
    .expect("serializable session cursor");
    URL_SAFE_NO_PAD.encode(payload)
}

fn decode_cursor(raw: &str) -> Option<SessionCursor> {
    if raw.len() > 512
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).ok()?;
    let cursor: SessionCursor = serde_json::from_slice(&bytes).ok()?;
    if cursor.v != 2 || cursor.o == 0 || cursor.ns.is_empty() {
        return None;
    }
    Some(cursor)
}

async fn filter_live_shared(
    state: &State,
    snapshot: &codesesh_core::runtime::SnapshotView,
    aliases: &HashMap<SessionReference, String>,
    query_scope: codesesh_core::search::QueryScope,
    cwd: Option<String>,
    source_node_id: Option<&str>,
    filter: &SessionFilter<'_>,
) -> Result<Vec<Arc<SessionHead>>, Response> {
    if cwd.is_none()
        && source_node_id.is_none()
        && state.query_scope.project_scope.is_none()
        && state.all_agents_enabled
        && filter.agent.is_none()
        && filter.project.is_none()
    {
        return Ok(filter_sessions_indexed_shared(
            &snapshot.heads,
            snapshot.root_times(),
            filter,
            aliases,
        ));
    }
    let selected: Vec<Arc<SessionHead>> = if let Some(cwd) = cwd {
        let raw_snapshot = Arc::clone(&snapshot.heads);
        match tokio::task::spawn_blocking(move || {
            let scope = projects::create_project_scope_matcher(&cwd);
            raw_snapshot
                .iter()
                .filter(|s| {
                    super::matches_scope(s, &query_scope)
                        && projects::matches_project_scope(s, &scope)
                })
                .cloned()
                .collect::<Vec<_>>()
        })
        .await
        {
            Ok(v) => v,
            Err(_) => {
                return Err(error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Project scope unavailable",
                ));
            }
        }
    } else {
        snapshot
            .heads
            .iter()
            .filter(|s| super::matches_scope(s, &query_scope))
            .cloned()
            .collect()
    };
    Ok(filter_sessions_shared(&selected, filter, aliases))
}

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
    let (live_aliases, live_aliases_fp) = state.aliases_with_fingerprint().await;
    let snapshot = state.runtime.snapshot_view();
    let query_hash = canonical_query_hash(&query.pairs);
    let ns_token = namespace_token(state.etag_namespace);
    let now = chrono::Utc::now().timestamp_millis();
    let raw_cursor = query.get("cursor").filter(|c| !c.is_empty());

    let (offset, pinned_revision, pinned_aliases_fp, retained) = if let Some(encoded) = raw_cursor {
        let Some(cursor) = decode_cursor(encoded) else {
            return error(
                StatusCode::BAD_REQUEST,
                "cursor is invalid for this request",
            );
        };
        if cursor.q != query_hash {
            return error(
                StatusCode::BAD_REQUEST,
                "cursor is invalid for this request",
            );
        }
        // Reject cursors minted by a previous process whose revision counter reset.
        if cursor.ns != ns_token {
            return error(
                StatusCode::CONFLICT,
                "session snapshot expired; restart pagination",
            );
        }
        let cache_key = (cursor.r, cursor.a.clone(), query_hash.clone());
        let cached = state
            .session_pages
            .lock()
            .ok()
            .and_then(|mut pages| pages.get(&cache_key, now));
        if let Some(entry) = cached {
            (cursor.o, cursor.r, cursor.a, Some(entry))
        } else if cursor.r != snapshot.revision || cursor.a != live_aliases_fp.as_str() {
            return error(
                StatusCode::CONFLICT,
                "session snapshot expired; restart pagination",
            );
        } else {
            (
                cursor.o,
                snapshot.revision,
                live_aliases_fp.as_str().to_owned(),
                None,
            )
        }
    } else {
        (
            0,
            snapshot.revision,
            live_aliases_fp.as_str().to_owned(),
            None,
        )
    };

    let source_node_id = query.optional("sourceNodeId");
    let query_scope = state.scope(source_node_id);
    let cwd = query
        .optional("cwd")
        .filter(|_| project.is_none())
        .map(str::to_owned);
    let paginated = query.get("limit").is_some() || raw_cursor.is_some();
    let tag = etag::weak_etag(
        state.etag_namespace,
        &json!([
            "sessions",
            pinned_revision,
            pinned_aliases_fp,
            paginated,
            limit,
            offset,
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

    let filter = SessionFilter {
        agent: query.get("agent"),
        project,
        tag: query.get("tag"),
        query: query.get("q"),
        from,
        to,
    };

    if !paginated {
        let items = match filter_live_shared(
            &state,
            &snapshot,
            &live_aliases,
            query_scope,
            cwd,
            source_node_id,
            &filter,
        )
        .await
        {
            Ok(v) => v,
            Err(response) => return response,
        };
        return session_page(&items, &live_aliases, None, &tag, true);
    }

    let (items, aliases) = if let Some(entry) = retained {
        entry
    } else {
        let cache_key = (
            pinned_revision,
            pinned_aliases_fp.clone(),
            query_hash.clone(),
        );
        let cached = state
            .session_pages
            .lock()
            .ok()
            .and_then(|mut pages| pages.get(&cache_key, now));
        if let Some(entry) = cached {
            entry
        } else {
            let computed = match filter_live_shared(
                &state,
                &snapshot,
                &live_aliases,
                query_scope,
                cwd,
                source_node_id,
                &filter,
            )
            .await
            {
                Ok(v) => Arc::new(v),
                Err(response) => return response,
            };
            if offset.saturating_add(limit) < computed.len()
                && let Ok(mut pages) = state.session_pages.lock()
            {
                pages.insert(
                    cache_key,
                    Arc::clone(&computed),
                    Arc::clone(&live_aliases),
                    now,
                );
            }
            (computed, live_aliases)
        }
    };

    if raw_cursor.is_some() && offset >= items.len() {
        return error(
            StatusCode::BAD_REQUEST,
            "cursor is invalid for this request",
        );
    }
    let end = offset.saturating_add(limit).min(items.len());
    let next_cursor = (end < items.len()).then(|| {
        encode_cursor(
            &ns_token,
            pinned_revision,
            &pinned_aliases_fp,
            &query_hash,
            end,
        )
    });
    session_page(&items[offset..end], &aliases, next_cursor, &tag, false)
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
        (*state.aliases().await).clone(),
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
    items: &[Arc<SessionHead>],
    aliases: &HashMap<SessionReference, String>,
    next_cursor: Option<String>,
    tag: &str,
    stream: bool,
) -> Response {
    match items
        .iter()
        .map(|head| {
            let mut item = (**head).clone();
            if let Some(alias) = aliases.get(&item.reference) {
                item.display_title = Some(alias.clone());
            }
            super::wire::head(item.public())
        })
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(sessions) => {
            let payload = WireSessionListPage {
                sessions,
                next_cursor,
            };
            let mut response = if stream {
                super::streaming::json_stream_with_guard(payload, ())
            } else {
                super::streaming::json_with_guard(payload, ())
            };
            etag::apply_headers(&mut response, tag);
            response
        }
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invalid session contract",
        ),
    }
}
