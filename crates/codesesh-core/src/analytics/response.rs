use super::{
    CostFactsIndex, DashboardOptions, active_hours, build_dashboard, load_scoped_cost_facts,
};
use crate::{
    contract::SessionHead,
    public_contract::{DashboardData, DashboardWindow},
    search::{FileActivityOptions, QueryScope, list_file_activity},
};
use rusqlite::Connection;
use std::time::Instant;

#[derive(Default, serde::Serialize)]
pub struct DashboardTimings {
    pub aggregate_ms: f64,
    pub active_hours_ms: f64,
    pub file_activity_ms: f64,
}

pub struct DashboardResponseOptions<'a> {
    pub aggregate: DashboardOptions<'a>,
    pub days: i64,
    pub query_scope: Option<QueryScope>,
}

pub fn dashboard_response(
    connection: &Connection,
    sessions: &[SessionHead],
    options: &DashboardResponseOptions<'_>,
) -> anyhow::Result<(DashboardData, DashboardTimings)> {
    let mut timings = DashboardTimings::default();
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
    let dashboard = build_dashboard(
        sessions,
        &DashboardOptions {
            cost_facts: Some(facts),
            ..*aggregate
        },
    )?;
    timings.aggregate_ms = phase.elapsed().as_secs_f64() * 1000.0;
    let phase = Instant::now();
    let hours = active_hours(
        connection,
        sessions,
        aggregate.scope,
        aggregate.from,
        aggregate.to,
        aggregate.time_zone.clone(),
    )?;
    timings.active_hours_ms = phase.elapsed().as_secs_f64() * 1000.0;
    let phase = Instant::now();
    let recent_file_activities = list_file_activity(
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
    )?;
    timings.file_activity_ms = phase.elapsed().as_secs_f64() * 1000.0;
    let window = DashboardWindow {
        to: aggregate.to,
        days: Some(options.days),
        from: aggregate.from,
        compare_from: aggregate.compare.map(|(from, _)| from),
        compare_to: aggregate.compare.map(|(_, to)| to),
    };
    Ok((
        DashboardData {
            aggregate: dashboard,
            active_hours: Some(hours),
            recent_file_activities,
            window,
        },
        timings,
    ))
}
