use super::DashboardTimeZone;
use super::{
    CostFactsIndex, DashboardOptions, active_hours, build_dashboard, load_scoped_cost_facts,
};
use crate::{
    contract::SessionHead,
    search::{FileActivityOptions, QueryScope, list_file_activity},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Default, serde::Serialize)]
pub struct DashboardTimings {
    pub aggregate_ms: f64,
    pub active_hours_ms: f64,
    pub file_activity_ms: f64,
}

pub struct DashboardResponseOptions<'a> {
    pub aggregate: DashboardOptions<'a>,
    pub time_zone: &'a str,
    pub days: i64,
    pub query_scope: Option<QueryScope>,
}

pub fn dashboard_response(
    connection: &Connection,
    sessions: &[SessionHead],
    options: &DashboardResponseOptions<'_>,
) -> anyhow::Result<(Value, DashboardTimings)> {
    let mut timings = DashboardTimings::default();
    let time_zone: DashboardTimeZone = options
        .time_zone
        .parse()
        .map_err(|_| anyhow::anyhow!("timeZone must be a valid IANA time zone"))?;
    let aggregate = &options.aggregate;
    let loaded_facts;
    let facts = if let Some(facts) = aggregate.cost_facts {
        facts
    } else {
        loaded_facts = CostFactsIndex::from(load_scoped_cost_facts(
            connection,
            sessions,
            aggregate.scope,
            aggregate.compare.map(|(from, _)| from).or(aggregate.from),
            Some(aggregate.to),
            true,
        )?);
        &loaded_facts
    };
    let phase = Instant::now();
    let mut result = build_dashboard(
        sessions,
        &DashboardOptions {
            cost_facts: Some(facts),
            ..*aggregate
        },
    );
    timings.aggregate_ms = phase.elapsed().as_secs_f64() * 1000.0;
    let phase = Instant::now();
    result["activeHours"] = active_hours(
        connection,
        sessions,
        aggregate.scope,
        aggregate.from,
        aggregate.to,
        time_zone,
    )?;
    timings.active_hours_ms = phase.elapsed().as_secs_f64() * 1000.0;
    let phase = Instant::now();
    result["recentFileActivities"] = serde_json::to_value(list_file_activity(
        connection,
        &FileActivityOptions {
            agent: aggregate.scope.agent.clone(),
            project_kind: aggregate.scope.project_kind.clone(),
            project_key: aggregate.scope.project_key.clone(),
            from: aggregate.from,
            to: Some(aggregate.to),
            limit: Some(12),
            query_scope: options.query_scope.clone(),
            ..FileActivityOptions::default()
        },
    )?)?;
    timings.file_activity_ms = phase.elapsed().as_secs_f64() * 1000.0;
    let mut window = json!({"to":aggregate.to,"days":options.days});
    if let Some(from) = aggregate.from {
        window["from"] = json!(from);
    }
    if let Some((from, to)) = aggregate.compare {
        window["compareFrom"] = json!(from);
        window["compareTo"] = json!(to);
    }
    result["window"] = window;
    Ok((result, timings))
}
