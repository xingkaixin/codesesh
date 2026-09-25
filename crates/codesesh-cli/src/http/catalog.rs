use super::{State, decorate_value, error, params::Params};
use axum::{
    Json,
    extract::{RawQuery, State as AxumState},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{Days, Local, TimeZone};
use codesesh_core::{
    analytics, projects,
    query::{self, PaginationError},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

const ANALYTICS_REVISION_QUERY: &str = concat!(
    "SELECT COALESCE((SELECT value FROM cache_meta ",
    "WHERE key='analytics_revision'), '0')"
);

#[derive(Default)]
pub struct CatalogCache {
    entries: VecDeque<(String, Value, Value)>,
}

impl CatalogCache {
    fn get(&mut self, revision: &str, key: &Value) -> Option<Value> {
        let index = self
            .entries
            .iter()
            .position(|(generation, candidate, _)| generation == revision && candidate == key)?;
        let entry = self.entries.remove(index)?;
        let result = entry.2.clone();
        self.entries.push_back(entry);
        Some(result)
    }

    fn insert(&mut self, revision: String, key: Value, value: Value) {
        self.entries
            .retain(|(generation, candidate, _)| generation != &revision || candidate != &key);
        if self.entries.len() == 64 {
            self.entries.pop_front();
        }
        self.entries.push_back((revision, key, value));
    }
}

fn cached_catalog(
    cache: &std::sync::Mutex<CatalogCache>,
    revision: String,
    key: Value,
    build: impl FnOnce() -> anyhow::Result<Value>,
) -> anyhow::Result<Value> {
    let cached = cache
        .lock()
        .map_err(|_| anyhow::anyhow!("catalog cache poisoned"))?
        .get(&revision, &key);
    if let Some(value) = cached {
        return Ok(value);
    }
    let value = build()?;
    cache
        .lock()
        .map_err(|_| anyhow::anyhow!("catalog cache poisoned"))?
        .insert(revision, key, value.clone());
    Ok(value)
}

pub async fn config(
    AxumState(state): AxumState<Arc<State>>,
) -> Json<codesesh_core::public_contract::AppConfig> {
    Json(codesesh_core::public_contract::AppConfig {
        window: codesesh_core::public_contract::SessionWindow {
            from: state.options.default_from,
            to: state.options.default_to,
            days: state.options.default_days.map(f64::from),
        },
    })
}
pub async fn status(AxumState(state): AxumState<Arc<State>>) -> Json<Value> {
    Json(serde_json::to_value(state.runtime.status().as_ref()).unwrap())
}
pub async fn agents(AxumState(state): AxumState<Arc<State>>, RawQuery(raw): RawQuery) -> Response {
    let query = Params::new(raw.as_deref());
    let (from, to) = match query.window(&state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let selected = query::filter_activity_window(&state.snapshot(), from, to);
    let mut counts = HashMap::new();
    for s in selected {
        *counts.entry(s.reference.agent_name).or_insert(0) += 1;
    }
    Json(agent_info(&counts)).into_response()
}
pub async fn projects(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
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
    let query_scope = state.query_scope.clone();
    let cache = state.catalog_cache.clone();
    let result = state
        .runtime
        .read(move |conn| {
            let revision =
                conn.query_row(ANALYTICS_REVISION_QUERY, [], |row| row.get::<_, String>(0))?;
            let value = cached_catalog(&cache, revision, json!(["projects", from, to]), || {
                let heads = codesesh_core::storage::snapshot_from_connection(conn)?;
                let sessions = super::scoped_heads(&heads, &query_scope);
                let groups = projects::build_project_groups(&sessions)
                    .into_iter()
                    .map(serde_json::to_value)
                    .collect::<serde_json::Result<Vec<_>>>()?;
                let facts = analytics::load_cost_facts(conn, from, to, false)?;
                let mut groups =
                    analytics::attach_project_metrics(&groups, &sessions, from, to, Some(&facts));
                groups.retain(|g| {
                    ["sessionCount", "messages", "tokens", "cost"]
                        .iter()
                        .any(|k| g[*k].as_f64().unwrap_or(0.0) > 0.0)
                });
                Ok(Value::Array(groups))
            })?;
            let Value::Array(mut groups) = value else {
                anyhow::bail!("invalid project aggregate");
            };
            groups.retain(|g| {
                identity.as_ref().is_none_or(|(kind, key)| {
                    g["identityKind"] == *kind && g["identityKey"] == *key
                })
            });
            let summary = analytics::summarize_projects(&groups);
            Ok((groups, summary))
        })
        .await;
    let Ok((groups, summary)) = result else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load projects");
    };
    let Ok(mut pages) = state.project_pages.lock() else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to load projects");
    };
    match pages.paginate(
        chrono::Utc::now().timestamp_millis(),
        &query.pairs,
        query.get("cursor"),
        limit,
        || (groups, summary),
    ) {
        Ok(page) => {
            let mut v = json!({"projects":page.items,"summary":page.view});
            if let Some(c) = page.next_cursor {
                v["nextCursor"] = json!(c);
            }
            Json(v).into_response()
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

pub async fn dashboard(
    AxumState(state): AxumState<Arc<State>>,
    RawQuery(raw): RawQuery,
) -> Response {
    let query = Params::new(raw.as_deref());
    let zone = query
        .optional("timeZone")
        .map(str::to_owned)
        .unwrap_or_else(|| iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into()));
    let project = match query.project() {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
    let (base_from, base_to) = match query.window(&state.options) {
        Ok(v) => v,
        Err(e) => return error(StatusCode::BAD_REQUEST, &e),
    };
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
    let request_days = parsed_days.or(state.options.default_days.map(i64::from));
    let (from, days) = if query.optional("from").is_some() {
        (base_from, count_days(base_from.unwrap(), to))
    } else if request_days == Some(0) {
        (None, 0)
    } else if let Some(days) = request_days.filter(|v| *v > 0) {
        (calendar_add(start_day(to), -(days - 1)), days)
    } else if let Some(from) = base_from {
        (Some(from), count_days(from, to))
    } else {
        (calendar_add(start_day(to), -29), 30)
    };
    let compare =
        from.and_then(|from| calendar_add(from, -days).map(|previous| (previous, from - 1.0)));
    let scope = analytics::DashboardScope {
        agent: query.optional("agent").map(str::to_lowercase),
        project_kind: project.map(|(kind, _)| kind.to_owned()),
        project_key: project.map(|(_, key)| key.to_owned()),
    };
    let names = state.options.enabled_agents.clone();
    let query_scope = state.query_scope.clone();
    let cache = state.catalog_cache.clone();
    // The Node backend reuses open-ended windows until the next local calendar day.
    let cache_to = base_to.unwrap_or_else(|| start_day(to));
    let key = json!([
        "dashboard",
        scope.agent,
        scope.project_kind,
        scope.project_key,
        from,
        cache_to,
        compare,
        days,
        zone
    ]);
    let result = state
        .runtime
        .read(move |conn| {
            let revision =
                conn.query_row(ANALYTICS_REVISION_QUERY, [], |row| row.get::<_, String>(0))?;
            cached_catalog(&cache, revision, key, || {
                let heads = codesesh_core::storage::snapshot_from_connection(conn)?;
                let sessions = super::scoped_heads(&heads, &query_scope);
                let info = agent_info(&HashMap::new())
                    .into_iter()
                    .map(|a| (a["name"].as_str().unwrap().to_owned(), a))
                    .collect();
                analytics::dashboard_response(
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
                            cost_facts: None,
                        },
                        time_zone: &zone,
                        days,
                        query_scope: Some(query_scope),
                    },
                )
            })
        })
        .await;
    match result {
        Ok(mut value) => {
            value["window"]["to"] = json!(to);
            let aliases = state.aliases().await;
            for key in ["recentSessions", "recentFileActivities"] {
                if let Some(rows) = value[key].as_array_mut() {
                    for row in rows {
                        public_session(&mut row["session"]);
                        decorate_value(&mut row["session"], &aliases);
                    }
                }
            }
            Json(value).into_response()
        }
        Err(e) => {
            if e.to_string().contains("timeZone must") {
                error(
                    StatusCode::BAD_REQUEST,
                    "timeZone must be a valid IANA time zone",
                )
            } else {
                error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Failed to load dashboard",
                )
            }
        }
    }
}
pub fn public_session(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        for key in [
            "model_usage",
            "project_identity_resolver_revision",
            "project_identity_input_signature",
            "smart_tags_source_updated_at",
            "smart_tags_classifier_revision",
        ] {
            object.remove(key);
        }
    }
}
fn start_day(time: f64) -> f64 {
    Local
        .timestamp_millis_opt(time as i64)
        .single()
        .and_then(|d| {
            Local
                .from_local_datetime(&d.date_naive().and_hms_opt(0, 0, 0)?)
                .earliest()
        })
        .map(|d| d.timestamp_millis() as f64)
        .unwrap_or(time)
}
fn calendar_add(time: f64, days: i64) -> Option<f64> {
    let date = Local.timestamp_millis_opt(time as i64).single()?;
    let date = if days >= 0 {
        date.checked_add_days(Days::new(days as u64))?
    } else {
        date.checked_sub_days(Days::new(days.unsigned_abs()))?
    };
    Some(date.timestamp_millis() as f64)
}
fn count_days(from: f64, to: f64) -> i64 {
    let date = |v: f64| {
        Local
            .timestamp_millis_opt(v as i64)
            .single()
            .map(|d| d.date_naive())
    };
    date(from)
        .zip(date(to))
        .map(|(a, b)| (b - a).num_days() + 1)
        .unwrap_or(1)
        .max(1)
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
        object.insert("count".into(), json!(count));
    }
    entries
}

#[cfg(test)]
mod tests;
