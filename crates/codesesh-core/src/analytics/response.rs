use super::DashboardTimeZone;
use super::{DashboardOptions, active_hours, build_dashboard, load_cost_facts};
use crate::{
    contract::SessionHead,
    search::{FileActivityOptions, QueryScope, list_file_activity},
};
use rusqlite::Connection;
use serde_json::{Value, json};

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
) -> anyhow::Result<Value> {
    let time_zone: DashboardTimeZone = options
        .time_zone
        .parse()
        .map_err(|_| anyhow::anyhow!("timeZone must be a valid IANA time zone"))?;
    let aggregate = &options.aggregate;
    let facts = load_cost_facts(
        connection,
        aggregate.compare.map(|(from, _)| from).or(aggregate.from),
        Some(aggregate.to),
        true,
    )?;
    let mut result = build_dashboard(
        sessions,
        &DashboardOptions {
            cost_facts: Some(&facts),
            ..*aggregate
        },
    );
    result["activeHours"] = active_hours(
        connection,
        sessions,
        aggregate.scope,
        aggregate.from,
        aggregate.to,
        time_zone,
    )?;
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
    let mut window = json!({"to":aggregate.to,"days":options.days});
    if let Some(from) = aggregate.from {
        window["from"] = json!(from);
    }
    if let Some((from, to)) = aggregate.compare {
        window["compareFrom"] = json!(from);
        window["compareTo"] = json!(to);
    }
    result["window"] = window;
    Ok(result)
}
