use super::{State, decorate_wire, error, etag, params::Params};
use axum::{
    Extension, Json,
    extract::{RawQuery, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use codesesh_core::{
    analytics, projects,
    session_list::{self, PaginationError},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Condvar, Mutex},
    time::Instant,
};

#[derive(Default, serde::Serialize)]
struct QueryTimings {
    read_wait_ms: f64,
    heads_ms: f64,
    cost_facts_ms: f64,
    build_ms: f64,
    #[serde(flatten)]
    dashboard: analytics::DashboardTimings,
    cache_hit: bool,
}

fn log_query(
    context: crate::logging::LogContext,
    route: &str,
    started: Instant,
    timings: QueryTimings,
) {
    let Some(logger) = crate::logging::current() else {
        return;
    };
    let duration_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut data = serde_json::to_value(timings).unwrap();
    data["duration_ms"] = json!(duration_ms);
    data["route"] = json!(route);
    let logger = logger.with_context(context);
    // Keep routine polling at debug level and expose slow loads in normal logs.
    if duration_ms >= 500.0 {
        logger.info("perf.query", &data);
    } else {
        logger.debug("perf.query", &data);
    }
}

pub(super) const ANALYTICS_REVISION_QUERY: &str = concat!(
    "SELECT CAST(COALESCE((SELECT value FROM cache_meta ",
    "WHERE key='analytics_revision'), '0') AS INTEGER)"
);

enum InFlightState<T> {
    Running,
    Ready(T),
    Failed(String),
}

struct InFlight<T> {
    state: Mutex<InFlightState<T>>,
    done: Condvar,
}

impl<T> InFlight<T> {
    fn new() -> Self {
        Self {
            state: Mutex::new(InFlightState::Running),
            done: Condvar::new(),
        }
    }
}

pub struct CatalogCache<T = Value> {
    revision: i64,
    entries: VecDeque<(Value, T)>,
    in_flight: Vec<(i64, Value, Arc<InFlight<T>>)>,
}

impl<T> Default for CatalogCache<T> {
    fn default() -> Self {
        Self {
            revision: 0,
            entries: VecDeque::new(),
            in_flight: Vec::new(),
        }
    }
}

impl<T: Clone> CatalogCache<T> {
    fn get(&mut self, revision: i64, key: &Value) -> Option<T> {
        if revision != self.revision {
            return None;
        }
        let index = self
            .entries
            .iter()
            .position(|(candidate, _)| candidate == key)?;
        let entry = self.entries.remove(index)?;
        let result = entry.1.clone();
        self.entries.push_back(entry);
        Some(result)
    }

    fn insert(&mut self, revision: i64, key: Value, value: T) {
        // A read that began before the latest commit must not evict newer results.
        if revision < self.revision {
            return;
        }
        if revision > self.revision {
            self.revision = revision;
            self.entries.clear();
        }
        self.entries.retain(|(candidate, _)| candidate != &key);
        if self.entries.len() == 64 {
            self.entries.pop_front();
        }
        self.entries.push_back((key, value));
    }
}

struct InFlightGuard<'a, T> {
    cache: &'a Mutex<CatalogCache<T>>,
    revision: i64,
    key: Value,
    slot: Arc<InFlight<T>>,
    completed: bool,
}

impl<T> Drop for InFlightGuard<'_, T> {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        if let Ok(mut guard) = self.cache.lock() {
            guard
                .in_flight
                .retain(|(rev, candidate, _)| *rev != self.revision || *candidate != self.key);
        }
        if let Ok(mut state) = self.slot.state.lock() {
            *state = InFlightState::Failed("catalog computation aborted".into());
            self.slot.done.notify_all();
        }
    }
}

pub(super) fn cached_catalog<T: Clone>(
    cache: &Mutex<CatalogCache<T>>,
    revision: i64,
    key: Value,
    build: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let slot = {
        let mut guard = cache
            .lock()
            .map_err(|_| anyhow::anyhow!("catalog cache poisoned"))?;
        if let Some(value) = guard.get(revision, &key) {
            return Ok(value);
        }
        if let Some((_, _, existing)) = guard
            .in_flight
            .iter()
            .find(|(rev, candidate, _)| *rev == revision && *candidate == key)
        {
            Err(existing.clone())
        } else {
            let slot = Arc::new(InFlight::new());
            guard.in_flight.push((revision, key.clone(), slot.clone()));
            Ok(slot)
        }
    };
    let slot = match slot {
        Ok(leader) => leader,
        Err(existing) => {
            let mut state = existing
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("catalog flight poisoned"))?;
            while matches!(*state, InFlightState::Running) {
                state = existing
                    .done
                    .wait(state)
                    .map_err(|_| anyhow::anyhow!("catalog flight poisoned"))?;
            }
            return match &*state {
                InFlightState::Ready(value) => Ok(value.clone()),
                InFlightState::Failed(message) => anyhow::bail!("{message}"),
                InFlightState::Running => unreachable!(),
            };
        }
    };

    let mut guard = InFlightGuard {
        cache,
        revision,
        key: key.clone(),
        slot: slot.clone(),
        completed: false,
    };
    let result = build();
    {
        let mut cache_guard = cache
            .lock()
            .map_err(|_| anyhow::anyhow!("catalog cache poisoned"))?;
        cache_guard
            .in_flight
            .retain(|(rev, candidate, _)| *rev != revision || *candidate != key);
        if let Ok(ref value) = result {
            cache_guard.insert(revision, key, value.clone());
        }
    }
    if let Ok(mut state) = slot.state.lock() {
        *state = match &result {
            Ok(value) => InFlightState::Ready(value.clone()),
            Err(error) => InFlightState::Failed(error.to_string()),
        };
        slot.done.notify_all();
    }
    guard.completed = true;
    result
}

pub async fn config(
    AxumState(state): AxumState<Arc<State>>,
) -> Json<codesesh_core::wire::AppConfig> {
    Json(codesesh_core::wire::AppConfig {
        hub_enabled: state.hub_enabled.then_some(true),
        public_hub_url: state
            .hub_enabled
            .then(|| state.options.public_origin.clone())
            .flatten(),
        window: codesesh_core::wire::SessionWindow {
            from: state.options.default_from,
            to: state.options.default_to,
            days: state.options.default_days.map(f64::from),
        },
    })
}
pub async fn status(AxumState(state): AxumState<Arc<State>>) -> Json<Value> {
    Json(serde_json::to_value(state.runtime.status().as_ref()).unwrap())
}
pub async fn agents(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    let query = Params::new(raw.as_deref());
    let (from, to) = match query.window(&state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let source_node_id = query.optional("sourceNodeId");
    let (revision, raw_snapshot) = state.runtime.snapshot_with_revision();
    let tag = etag::weak_etag(
        state.etag_namespace,
        &json!(["agents", revision, from, to, source_node_id]),
    );
    if etag::matches_if_none_match(&headers, &tag) {
        return etag::not_modified(&tag);
    }
    let scope = state.scope(source_node_id);
    let scoped = super::scoped_shared_heads(&raw_snapshot, &scope);
    let selected = session_list::filter_activity_window(&scoped, from, to);
    let mut counts = HashMap::new();
    for s in selected {
        *counts.entry(s.reference.agent_name).or_insert(0) += 1;
    }
    let mut response = Json(agent_info(&counts)).into_response();
    etag::apply_headers(&mut response, &tag);
    response
}

enum ProjectsLookup {
    NotModified {
        etag: String,
        timings: QueryTimings,
    },
    Loaded {
        groups: Vec<Value>,
        summary: Value,
        timings: QueryTimings,
        etag: String,
    },
}

pub async fn projects(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    Extension(context): Extension<crate::logging::LogContext>,
) -> Response {
    let query = Params::new(raw.as_deref());
    let limit = match query.limit(100, 250) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let identity = match query.project() {
        Ok(v) => v.map(|(a, b)| (a.to_owned(), b.to_owned())),
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let (from, to) = match query.window(&state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let sort = match query.optional("sort") {
        None => analytics::ProjectSort::Latest,
        Some(raw) => match analytics::ProjectSort::parse(raw) {
            Some(sort) => sort,
            None => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "sort must be one of latest, sessions, cost",
                );
            }
        },
    };
    let query_scope = state.scope(query.optional("sourceNodeId"));
    let etag_namespace = state.etag_namespace;
    let cache = state.catalog_cache.clone();
    let started = Instant::now();
    if query.get("cursor").is_some_and(|cursor| !cursor.is_empty()) {
        log_query(
            context,
            "/api/projects",
            started,
            QueryTimings {
                cache_hit: true,
                ..Default::default()
            },
        );
        return paginated_projects(&state, &query, sort, limit, Vec::new(), Value::Null, None);
    }
    let result = state
        .runtime
        .read(move |conn| {
            let mut timings = QueryTimings {
                read_wait_ms: started.elapsed().as_secs_f64() * 1000.0,
                cache_hit: true,
                ..Default::default()
            };
            let revision =
                conn.query_row(ANALYTICS_REVISION_QUERY, [], |row| row.get::<_, i64>(0))?;
            let tag = etag::weak_etag(
                etag_namespace,
                &json!([
                    "projects",
                    revision,
                    from,
                    to,
                    query_scope.source_node_id,
                    identity,
                    sort.as_str(),
                    limit
                ]),
            );
            if etag::matches_if_none_match(&headers, &tag) {
                return Ok(ProjectsLookup::NotModified { etag: tag, timings });
            }
            let value = cached_catalog(
                &cache,
                revision,
                json!([
                    "projects",
                    from,
                    to,
                    query_scope.source_node_id,
                    identity,
                    sort.as_str()
                ]),
                || {
                    timings.cache_hit = false;
                    let phase = Instant::now();
                    let heads = codesesh_core::storage::snapshot_from_connection(conn)?;
                    let sessions = super::scoped_heads(&heads, &query_scope);
                    timings.heads_ms = phase.elapsed().as_secs_f64() * 1000.0;
                    let phase = Instant::now();
                    let groups = projects::build_project_groups(&sessions)
                        .into_iter()
                        .filter(|g| {
                            identity.as_ref().is_none_or(|(kind, key)| {
                                g.identity_kind == *kind && g.identity_key == *key
                            })
                        })
                        .map(serde_json::to_value)
                        .collect::<serde_json::Result<Vec<_>>>()?;
                    timings.build_ms = phase.elapsed().as_secs_f64() * 1000.0;
                    let phase = Instant::now();
                    let facts = analytics::CostFactsIndex::from(analytics::load_scoped_cost_facts(
                        conn,
                        &sessions,
                        &analytics::DashboardScope {
                            agent: None,
                            project_kind: identity.as_ref().map(|(kind, _)| kind.clone()),
                            project_key: identity.as_ref().map(|(_, key)| key.clone()),
                        },
                        from,
                        to,
                        false,
                    )?);
                    timings.cost_facts_ms = phase.elapsed().as_secs_f64() * 1000.0;
                    let phase = Instant::now();
                    let mut groups = analytics::attach_project_metrics(
                        &groups,
                        &sessions,
                        from,
                        to,
                        Some(&facts),
                    );
                    groups.retain(|g| {
                        ["sessionCount", "messages", "tokens", "cost"]
                            .iter()
                            .any(|k| g[*k].as_f64().unwrap_or(0.0) > 0.0)
                    });
                    analytics::sort_projects(&mut groups, sort);
                    timings.build_ms += phase.elapsed().as_secs_f64() * 1000.0;
                    Ok(Value::Array(groups))
                },
            )?;
            let Value::Array(groups) = value else {
                anyhow::bail!("invalid project aggregate");
            };
            let summary = analytics::summarize_projects(&groups);
            Ok(ProjectsLookup::Loaded {
                groups,
                summary,
                timings,
                etag: tag,
            })
        })
        .await;
    match result {
        Ok(ProjectsLookup::NotModified { etag: tag, timings }) => {
            log_query(context, "/api/projects", started, timings);
            etag::not_modified(&tag)
        }
        Ok(ProjectsLookup::Loaded {
            groups,
            summary,
            timings,
            etag: tag,
        }) => {
            log_query(context, "/api/projects", started, timings);
            paginated_projects(&state, &query, sort, limit, groups, summary, Some(&tag))
        }
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load projects"),
    }
}

fn paginated_projects(
    state: &State,
    query: &Params,
    sort: analytics::ProjectSort,
    limit: usize,
    groups: Vec<Value>,
    summary: Value,
    tag: Option<&str>,
) -> Response {
    let Ok(mut pages) = state.project_pages.lock() else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load projects");
    };
    let mut pagination_query: Vec<(String, String)> = query
        .pairs
        .iter()
        .filter(|(key, _)| key != "sort")
        .cloned()
        .collect();
    pagination_query.push(("sort".into(), sort.as_str().into()));
    match pages.paginate(
        chrono::Utc::now().timestamp_millis(),
        &pagination_query,
        query.get("cursor"),
        limit,
        || (groups, summary),
    ) {
        Ok(page) => {
            let has_next = page.next_cursor.is_some();
            let mut v = json!({"projects":page.items,"summary":page.view});
            if let Some(c) = page.next_cursor {
                v["nextCursor"] = json!(c);
            }
            let mut response = Json(v).into_response();
            // Only emit ETag when there is no ephemeral cursor so clients never cache an expiring cursor.
            if !has_next && let Some(tag) = tag {
                etag::apply_headers(&mut response, tag);
            }
            response
        }
        Err(PaginationError::InvalidCursor) => error(
            StatusCode::BAD_REQUEST,
            "cursor is invalid for this request",
        ),
        Err(PaginationError::StaleSnapshot) => error(
            StatusCode::CONFLICT,
            "project snapshot expired; restart pagination",
        ),
    }
}

pub(super) struct DashboardWindow {
    pub(super) from: Option<f64>,
    pub(super) to: f64,
    pub(super) base_to: Option<f64>,
    pub(super) days: i64,
    pub(super) zone: analytics::DashboardTimeZone,
}

pub(super) fn resolve_dashboard_window(
    query: &Params,
    options: &super::Options,
) -> Result<DashboardWindow, String> {
    let zone = query
        .optional("timeZone")
        .map(str::to_owned)
        .unwrap_or_else(|| iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into()));
    let (base_from, base_to) = query.window(options)?;
    let zone: analytics::DashboardTimeZone = zone.parse().map_err(str::to_owned)?;
    let to = base_to.unwrap_or_else(|| chrono::Utc::now().timestamp_millis() as f64);
    let parsed_days = query
        .optional("days")
        .filter(|v| {
            v.bytes()
                .enumerate()
                .all(|(i, b)| b.is_ascii_digit() || (i == 0 && b == b'-'))
        })
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| {
            v.checked_mul(86_400_000)
                .is_some_and(|x| x.unsigned_abs() <= 9_007_199_254_740_991)
        });
    let request_days = parsed_days.or(options.default_days.map(i64::from));
    let (from, days) = if query.optional("from").is_some() {
        (base_from, count_days(&zone, base_from.unwrap(), to))
    } else if request_days == Some(0) {
        (None, 0)
    } else if let Some(days) = request_days.filter(|v| *v > 0) {
        (zone.add_days(zone.start_of_day(to), -(days - 1)), days)
    } else if let Some(from) = base_from {
        (Some(from), count_days(&zone, from, to))
    } else {
        (zone.add_days(zone.start_of_day(to), -29), 30)
    };
    Ok(DashboardWindow {
        from,
        to,
        base_to,
        days,
        zone,
    })
}

enum DashboardLookup {
    NotModified {
        etag: String,
        timings: QueryTimings,
    },
    Loaded {
        value: Box<codesesh_core::wire::DashboardData>,
        timings: QueryTimings,
        etag: String,
    },
}

pub async fn dashboard(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
    Extension(context): Extension<crate::logging::LogContext>,
) -> Response {
    let query = Params::new(raw.as_deref());
    let project = match query.project() {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let DashboardWindow {
        from,
        to,
        base_to,
        days,
        zone,
    } = match resolve_dashboard_window(&query, &state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let compare = from.and_then(|from| {
        zone.add_days(from, -days)
            .map(|previous| (previous, from - 1.0))
    });
    let scope = analytics::DashboardScope {
        agent: query.optional("agent").map(str::to_lowercase),
        project_kind: project.map(|(kind, _)| kind.to_owned()),
        project_key: project.map(|(_, key)| key.to_owned()),
    };
    let names = state.options.enabled_agents.clone();
    let query_scope = state.scope(query.optional("sourceNodeId"));
    let cache = state.dashboard_cache.clone();
    // Open-ended windows are reused until the next calendar day in the request time zone.
    let cache_to = base_to.unwrap_or_else(|| zone.start_of_day(to));
    let key = json!([
        "dashboard",
        query_scope.source_node_id,
        scope.agent,
        scope.project_kind,
        scope.project_key,
        from,
        cache_to,
        compare,
        days,
        zone.name()
    ]);
    let aliases = state.aliases().await;
    let etag_namespace = state.etag_namespace;
    let aliases_fp = etag::aliases_fingerprint(&aliases);
    let started = Instant::now();
    let result = state
        .runtime
        .read(move |conn| {
            let mut timings = QueryTimings {
                read_wait_ms: started.elapsed().as_secs_f64() * 1000.0,
                cache_hit: true,
                ..Default::default()
            };
            let revision =
                conn.query_row(ANALYTICS_REVISION_QUERY, [], |row| row.get::<_, i64>(0))?;
            let tag = etag::weak_etag(etag_namespace, &json!([revision, &key, &aliases_fp]));
            if etag::matches_if_none_match(&headers, &tag) {
                return Ok(DashboardLookup::NotModified { etag: tag, timings });
            }
            let value = cached_catalog(&cache, revision, key, || {
                timings.cache_hit = false;
                let phase = Instant::now();
                let heads = codesesh_core::storage::snapshot_from_connection(conn)?;
                let sessions = super::scoped_heads(&heads, &query_scope);
                timings.heads_ms = phase.elapsed().as_secs_f64() * 1000.0;
                let phase = Instant::now();
                let facts = analytics::CostFactsIndex::from(analytics::load_scoped_cost_facts(
                    conn,
                    &sessions,
                    &scope,
                    compare.map(|(from, _)| from).or(from),
                    Some(to),
                    true,
                )?);
                timings.cost_facts_ms = phase.elapsed().as_secs_f64() * 1000.0;
                let phase = Instant::now();
                let info = agent_info(&HashMap::new())
                    .into_iter()
                    .map(|a| (a["name"].as_str().unwrap().to_owned(), a))
                    .collect();
                let (value, dashboard_timings) = analytics::dashboard_response(
                    conn,
                    &sessions,
                    &analytics::DashboardResponseOptions {
                        aggregate: analytics::DashboardOptions {
                            by_agent_names: &names,
                            scope: &scope,
                            from,
                            to,
                            agent_info: Some(&info),
                            compare,
                            cost_facts: Some(&facts),
                            time_zone: &zone,
                        },
                        days,
                        query_scope: Some(query_scope),
                    },
                )?;
                timings.build_ms = phase.elapsed().as_secs_f64() * 1000.0;
                timings.dashboard = dashboard_timings;
                Ok(value)
            })?;
            Ok(DashboardLookup::Loaded {
                value: Box::new(value),
                timings,
                etag: tag,
            })
        })
        .await;
    match result {
        Ok(DashboardLookup::NotModified { etag: tag, timings }) => {
            log_query(context, "/api/dashboard", started, timings);
            etag::not_modified(&tag)
        }
        Ok(DashboardLookup::Loaded {
            mut value,
            timings,
            etag: tag,
        }) => {
            value.window.to = to;
            for row in &mut value.aggregate.recent_sessions {
                decorate_wire(&mut row.session, &aliases);
            }
            for row in &mut value.recent_file_activities {
                decorate_wire(&mut row.session, &aliases);
            }
            log_query(context, "/api/dashboard", started, timings);
            let mut response = Json(*value).into_response();
            etag::apply_headers(&mut response, &tag);
            response
        }
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to load dashboard",
        ),
    }
}
fn count_days(zone: &analytics::DashboardTimeZone, from: f64, to: f64) -> i64 {
    ((zone.date(to) - zone.date(from)).num_days() + 1).max(1)
}

fn agent_info(counts: &HashMap<String, usize>) -> Vec<Value> {
    let mut entries: Vec<Value> = serde_json::from_str(include_str!(
        "../../../codesesh-core/src/agents/catalog.json"
    ))
    .expect("bundled agent catalog");
    for entry in &mut entries {
        let name = entry["name"].as_str().unwrap();
        let count = counts.get(name).copied().unwrap_or(0);
        let object = entry.as_object_mut().unwrap();
        object.remove("sourceKind");
        object.remove("toolStrategy");
        object.remove("support");
        object.insert("count".into(), json!(count));
    }
    entries
}

#[cfg(test)]
mod tests;
