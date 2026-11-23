mod catalog;
mod compression;
mod etag;
mod event_buffer;
mod events;
mod logs;
mod params;
mod pricing;
mod saved;
mod search;
mod security;
mod sessions;
mod streaming;
mod sync;
mod wire;

use axum::{
    Json, Router,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use codesesh_core::{
    model::{SessionHead, SessionReference},
    runtime::Runtime,
    session_list::SnapshotPaginator,
    state::StateStore,
    wire::{DashboardData, UnmatchedModelsResponse, WireSessionHead},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, RwLock},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};

#[derive(Clone)]
pub struct Options {
    pub token: Option<String>,
    pub hostname: String,
    pub port: u16,
    pub tls: bool,
    pub trust_proxy: bool,
    pub public_origin: Option<String>,
    pub loopback_authority: bool,
    pub default_from: Option<f64>,
    pub default_to: Option<f64>,
    pub default_days: Option<u32>,
    pub enabled_agents: Vec<String>,
    pub cwd: Option<String>,
}

type CachedAliases = (Arc<HashMap<SessionReference, String>>, Arc<String>);
type VersionedAliases = (
    (i64, u64),
    Arc<HashMap<SessionReference, String>>,
    Arc<String>,
);

const MAX_SESSION_PAGE_SNAPSHOTS: usize = 32;
const SESSION_PAGE_TTL_MS: i64 = 60_000;

pub(super) type SessionPageKey = (u64, String, String);
pub(super) type RetainedSessionItems = (
    Arc<Vec<Arc<SessionHead>>>,
    Arc<HashMap<SessionReference, String>>,
);

struct RetainedSessionPage {
    items: Arc<Vec<Arc<SessionHead>>>,
    aliases: Arc<HashMap<SessionReference, String>>,
    expires_at: i64,
}

#[derive(Default)]
pub(super) struct SessionPageCache {
    entries: HashMap<SessionPageKey, RetainedSessionPage>,
}

impl SessionPageCache {
    pub(super) fn get(&mut self, key: &SessionPageKey, now: i64) -> Option<RetainedSessionItems> {
        self.prune(now);
        let entry = self.entries.get_mut(key)?;
        entry.expires_at = now.saturating_add(SESSION_PAGE_TTL_MS);
        Some((Arc::clone(&entry.items), Arc::clone(&entry.aliases)))
    }

    pub(super) fn insert(
        &mut self,
        key: SessionPageKey,
        items: Arc<Vec<Arc<SessionHead>>>,
        aliases: Arc<HashMap<SessionReference, String>>,
        now: i64,
    ) {
        self.prune(now);
        if !self.entries.contains_key(&key)
            && self.entries.len() >= MAX_SESSION_PAGE_SNAPSHOTS
            && let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.expires_at)
                .map(|(k, _)| k.clone())
        {
            self.entries.remove(&oldest_key);
        }
        self.entries.insert(
            key,
            RetainedSessionPage {
                items,
                aliases,
                expires_at: now.saturating_add(SESSION_PAGE_TTL_MS),
            },
        );
    }

    pub(super) fn prune(&mut self, now: i64) {
        self.entries.retain(|_, entry| entry.expires_at > now);
    }
}

pub struct State {
    etag_namespace: uuid::Uuid,
    hub_enabled: bool,
    all_agents_enabled: bool,
    index_html: Option<security::PrebuiltHtml>,
    runtime: Runtime,
    pricing: codesesh_core::pricing::PricingController,
    saved: Arc<Mutex<Option<StateStore>>>,
    aliases_cache: Arc<RwLock<Option<VersionedAliases>>>,
    options: Options,
    session_pages: Mutex<SessionPageCache>,
    project_pages: Mutex<SnapshotPaginator<Value, Value>>,
    streams: Arc<Semaphore>,
    upload_slots: Arc<Semaphore>,
    node_uploads: Mutex<HashMap<String, Arc<Semaphore>>>,
    details: Arc<Semaphore>,
    catalog_cache: Arc<Mutex<catalog::CatalogCache>>,
    dashboard_cache: Arc<Mutex<catalog::CatalogCache<DashboardData>>>,
    pricing_unmatched_cache: Arc<Mutex<catalog::CatalogCache<UnmatchedModelsResponse>>>,
    pricing_write_lock: Arc<AsyncMutex<()>>,
    query_scope: codesesh_core::search::QueryScope,
}

impl State {
    pub fn with_hub(mut self) -> Self {
        self.hub_enabled = true;
        self.index_html = security::build_bootstrapped_html(&self.options, true);
        self
    }

    pub fn new(
        runtime: Runtime,
        pricing: codesesh_core::pricing::PricingController,
        saved: Option<StateStore>,
        options: Options,
    ) -> Self {
        let all_agents_enabled = codesesh_core::agents::catalog(0)
            .iter()
            .all(|agent| options.enabled_agents.contains(&agent.name));
        let query_scope = codesesh_core::search::QueryScope {
            source_node_id: None,
            agents: options.enabled_agents.clone(),
            project_scope: options
                .cwd
                .as_deref()
                .map(codesesh_core::projects::create_project_scope_matcher),
        };
        let index_html = security::build_bootstrapped_html(&options, false);
        Self {
            etag_namespace: uuid::Uuid::new_v4(),
            hub_enabled: false,
            all_agents_enabled,
            index_html,
            runtime,
            pricing,
            query_scope,
            saved: Arc::new(Mutex::new(saved)),
            aliases_cache: Arc::new(RwLock::new(None)),
            options,
            session_pages: Mutex::new(SessionPageCache::default()),
            project_pages: Mutex::new(SnapshotPaginator::default()),
            streams: Arc::new(Semaphore::new(32)),
            upload_slots: Arc::new(Semaphore::new(8)),
            node_uploads: Mutex::new(HashMap::new()),
            details: Arc::new(Semaphore::new(2)),
            catalog_cache: Arc::new(Mutex::new(catalog::CatalogCache::default())),
            dashboard_cache: Arc::new(Mutex::new(catalog::CatalogCache::default())),
            pricing_unmatched_cache: Arc::new(Mutex::new(catalog::CatalogCache::default())),
            pricing_write_lock: Arc::new(AsyncMutex::new(())),
        }
    }
    async fn aliases_with_fingerprint(&self) -> CachedAliases {
        let saved = self.saved.clone();
        let cache = self.aliases_cache.clone();
        // Check SQLite data_version via StateStore or reuse cached map when unchanged;
        // state.db is tiny (~36KB) so a quick check catches external mutations while avoiding
        // re-reading rows and recomputing SHA-256 on every request.
        if let Ok(store_guard) = saved.lock() {
            let Some(store) = store_guard.as_ref() else {
                return (Arc::new(HashMap::new()), Arc::new(String::new()));
            };
            let current_version = store.change_stamp().ok();
            if let Some(version) = current_version
                && let Ok(cached_guard) = cache.read()
                && let Some((cached_version, map, fp)) = cached_guard.as_ref()
                && *cached_version == version
            {
                return (Arc::clone(map), Arc::clone(fp));
            }
            let map: HashMap<SessionReference, String> = store
                .list_aliases()
                .unwrap_or_default()
                .into_iter()
                .map(|a| (a.reference, a.alias))
                .collect();
            let fp = etag::aliases_fingerprint(&map);
            let map = Arc::new(map);
            let fp = Arc::new(fp);
            if let Some(version) = current_version
                && let Ok(mut cached_guard) = cache.write()
            {
                *cached_guard = Some((version, Arc::clone(&map), Arc::clone(&fp)));
            }
            return (map, fp);
        }
        (Arc::new(HashMap::new()), Arc::new(String::new()))
    }
    async fn aliases(&self) -> Arc<HashMap<SessionReference, String>> {
        self.aliases_with_fingerprint().await.0
    }
    fn invalidate_aliases(&self) {
        if let Ok(mut guard) = self.aliases_cache.write() {
            *guard = None;
        }
    }
    fn scope(&self, source: Option<&str>) -> codesesh_core::search::QueryScope {
        codesesh_core::search::QueryScope {
            source_node_id: source.map(str::to_owned),
            ..self.query_scope.clone()
        }
    }
    fn state_change_stamp(&self) -> Option<(i64, u64)> {
        self.saved
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().and_then(|s| s.change_stamp().ok()))
    }
    fn known(&self, agent: &str) -> bool {
        codesesh_core::agents::catalog(0)
            .iter()
            .any(|a| a.name == agent.trim().to_lowercase())
    }
}

/// Paginate only drops expired snapshots on its next call, which an idle client never makes.
pub fn spawn_page_expiry(state: &Arc<State>) {
    let state = Arc::downgrade(state);
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            ticks.tick().await;
            let Some(state) = state.upgrade() else {
                return;
            };
            let now = chrono::Utc::now().timestamp_millis();
            if let Ok(mut pages) = state.session_pages.lock() {
                pages.prune(now);
            }
            if let Ok(mut pages) = state.project_pages.lock() {
                pages.prune(now);
            }
        }
    });
}

pub fn router(state: Arc<State>) -> Router {
    Router::new()
        .route("/api/worker/pair", post(sync::pair))
        .route("/api/worker/hello", post(sync::hello))
        .route("/api/worker/goodbye", post(sync::goodbye))
        .route("/api/worker/recover", post(sync::recover))
        .route("/api/worker/upload", post(sync::upload))
        .route("/api/nodes", get(sync::nodes))
        .route("/api/nodes/rescan", post(sync::rescan))
        .route("/api/nodes/{node}/tasks", get(sync::task_history))
        .route(
            "/api/nodes/{node}/tasks/{task}/cancel",
            post(sync::cancel_task),
        )
        .route("/api/nodes/{node}/name", put(sync::rename))
        .route(
            "/api/nodes/{node}/sources/{agent}/ignored",
            put(sync::ignore_source),
        )
        .route("/api/nodes/pairing-token", post(sync::pairing_token))
        .route("/api/nodes/pairing-status", post(sync::pairing_status))
        .route("/api/nodes/{node}/revoke", post(sync::revoke))
        .route(
            "/api/nodes/{node}/replacement-token",
            post(sync::replacement_token),
        )
        .route("/api/config", get(catalog::config))
        .route("/api/status", get(catalog::status))
        .route("/api/agents", get(catalog::agents))
        .route("/api/projects", get(catalog::projects))
        .route("/api/sessions", get(sessions::list))
        .route("/api/sessions/{agent}/{id}", get(sessions::detail))
        .route(
            "/api/sessions/nodes/{source}/{agent}/{id}",
            get(sessions::detail),
        )
        .route("/api/sessions/{agent}/{id}/matches", get(sessions::matches))
        .route(
            "/api/sessions/nodes/{source}/{agent}/{id}/matches",
            get(sessions::matches),
        )
        .route("/api/search", get(search::search))
        .route("/api/file-activity", get(search::file_activity))
        .route("/api/dashboard", get(catalog::dashboard))
        .route("/api/pricing/unmatched", get(pricing::unmatched))
        .route("/api/pricing/models", get(pricing::models))
        .route("/api/pricing/refresh", post(pricing::refresh))
        .route(
            "/api/pricing/overrides",
            get(pricing::overrides).put(pricing::put_override),
        )
        .route(
            "/api/pricing/overrides/acknowledge",
            post(pricing::acknowledge_override),
        )
        .route(
            "/api/pricing/overrides/delete",
            post(pricing::delete_override),
        )
        .route("/api/bookmarks", get(saved::list).put(saved::put))
        .route("/api/bookmarks/import", post(saved::import))
        .route("/api/bookmarks/{agent}/{id}", delete(saved::delete))
        .route(
            "/api/bookmarks/nodes/{source}/{agent}/{id}",
            delete(saved::delete),
        )
        .route(
            "/api/session-aliases/{agent}/{id}",
            put(saved::alias_put).delete(saved::alias_delete),
        )
        .route(
            "/api/session-aliases/nodes/{source}/{agent}/{id}",
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
fn decorate_wire(head: &mut WireSessionHead, aliases: &HashMap<SessionReference, String>) {
    if let Some(alias) = aliases.get(&head.reference) {
        head.display_title = Some(alias.clone());
    }
}

#[cfg(test)]
mod tests;

fn matches_scope(head: &SessionHead, scope: &codesesh_core::search::QueryScope) -> bool {
    scope
        .source_node_id
        .as_ref()
        .is_none_or(|source| source == &head.reference.source_node_id)
        && scope.agents.contains(&head.reference.agent_name)
        && scope
            .project_scope
            .as_ref()
            .is_none_or(|p| codesesh_core::projects::matches_project_scope(head, p))
}
