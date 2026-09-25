mod catalog;
mod compression;
mod event_buffer;
mod events;
mod logs;
mod params;
mod saved;
mod search;
mod security;
mod sessions;
mod streaming;
mod wire;

use axum::{
    Json, Router,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use codesesh_core::{
    contract::{SessionHead, SessionReference},
    query::SnapshotPaginator,
    runtime::Runtime,
    state::StateStore,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct Options {
    pub token: String,
    pub hostname: String,
    pub port: u16,
    pub tls: bool,
    pub trust_proxy: bool,
    pub loopback_authority: bool,
    pub default_from: Option<f64>,
    pub default_to: Option<f64>,
    pub default_days: Option<u32>,
    pub enabled_agents: Vec<String>,
    pub cwd: Option<String>,
}

pub struct State {
    runtime: Runtime,
    saved: Arc<Mutex<Option<StateStore>>>,
    options: Options,
    session_pages: Mutex<SnapshotPaginator<SessionHead, ()>>,
    project_pages: Mutex<SnapshotPaginator<Value, Value>>,
    streams: Arc<Semaphore>,
    details: Arc<Semaphore>,
    catalog_cache: Arc<Mutex<catalog::CatalogCache>>,
    query_scope: codesesh_core::search::QueryScope,
}

impl State {
    pub fn new(runtime: Runtime, saved: Option<StateStore>, options: Options) -> Self {
        let query_scope = codesesh_core::search::QueryScope {
            agents: options.enabled_agents.clone(),
            project_scope: options
                .cwd
                .as_deref()
                .map(codesesh_core::projects::create_project_scope_matcher),
        };
        Self {
            runtime,
            query_scope,
            saved: Arc::new(Mutex::new(saved)),
            options,
            session_pages: Mutex::new(SnapshotPaginator::default()),
            project_pages: Mutex::new(SnapshotPaginator::default()),
            streams: Arc::new(Semaphore::new(32)),
            details: Arc::new(Semaphore::new(2)),
            catalog_cache: Arc::new(Mutex::new(catalog::CatalogCache::default())),
        }
    }
    fn snapshot(&self) -> Arc<Vec<SessionHead>> {
        Arc::new(scoped_heads(&self.runtime.snapshot(), &self.query_scope))
    }
    async fn aliases(&self) -> HashMap<SessionReference, String> {
        let saved = self.saved.clone();
        tokio::task::spawn_blocking(move || {
            saved
                .lock()
                .ok()
                .and_then(|s| s.as_ref().and_then(|s| s.list_aliases().ok()))
                .unwrap_or_default()
                .into_iter()
                .map(|a| (a.reference, a.alias))
                .collect()
        })
        .await
        .unwrap_or_default()
    }
    fn known(&self, agent: &str) -> bool {
        codesesh_core::agents::catalog(0)
            .iter()
            .any(|a| a.name == agent.trim().to_lowercase())
    }
}

pub fn router(state: Arc<State>) -> Router {
    Router::new()
        .route("/api/config", get(catalog::config))
        .route("/api/status", get(catalog::status))
        .route("/api/agents", get(catalog::agents))
        .route("/api/projects", get(catalog::projects))
        .route("/api/sessions", get(sessions::list))
        .route("/api/sessions/{agent}/{id}", get(sessions::detail))
        .route("/api/search", get(search::search))
        .route("/api/file-activity", get(search::file_activity))
        .route("/api/dashboard", get(catalog::dashboard))
        .route("/api/bookmarks", get(saved::list).put(saved::put))
        .route("/api/bookmarks/import", post(saved::import))
        .route("/api/bookmarks/{agent}/{id}", delete(saved::delete))
        .route(
            "/api/session-aliases/{agent}/{id}",
            put(saved::alias_put).delete(saved::alias_delete),
        )
        .route("/api/events", get(events::events))
        .route("/api/logs", post(logs::post))
        .fallback(security::static_file)
        .layer(middleware::from_fn(compression::middleware))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security::guard,
        ))
        .with_state(state)
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}
fn retry(message: &str) -> Response {
    let mut response = error(StatusCode::SERVICE_UNAVAILABLE, message);
    response
        .headers_mut()
        .insert("retry-after", "1".parse().unwrap());
    response
}
fn decorate(head: &mut SessionHead, aliases: &HashMap<SessionReference, String>) {
    if let Some(alias) = aliases.get(&head.reference) {
        head.display_title = Some(alias.clone());
    }
}
fn decorate_value(value: &mut Value, aliases: &HashMap<SessionReference, String>) {
    if let Ok(reference) = serde_json::from_value::<SessionReference>(value["reference"].clone())
        && let Some(alias) = aliases.get(&reference)
    {
        value["display_title"] = json!(alias);
    }
}

#[cfg(test)]
mod tests;

fn scoped_heads(
    heads: &[SessionHead],
    scope: &codesesh_core::search::QueryScope,
) -> Vec<SessionHead> {
    heads
        .iter()
        .filter(|s| {
            scope.agents.contains(&s.reference.agent_name)
                && scope
                    .project_scope
                    .as_ref()
                    .is_none_or(|p| codesesh_core::projects::matches_project_scope(s, p))
        })
        .cloned()
        .collect()
}
