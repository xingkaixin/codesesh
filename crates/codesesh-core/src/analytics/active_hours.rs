use super::{DashboardScope, DashboardTimeZone};
use crate::{model::SessionHead, wire::DashboardActiveHours};
use chrono::DateTime;
use rusqlite::Connection;
use std::collections::HashSet;

#[cfg(test)]
pub fn active_hours(
    connection: &Connection,
    sessions: &[SessionHead],
    scope: &DashboardScope,
    from: Option<f64>,
    to: f64,
    time_zone: DashboardTimeZone,
) -> rusqlite::Result<DashboardActiveHours> {
    let refs: Vec<&SessionHead> = sessions.iter().collect();
    active_hours_refs(connection, &refs, scope, from, to, time_zone)
}

pub fn active_hours_refs(
    connection: &Connection,
    sessions: &[&SessionHead],
    scope: &DashboardScope,
    from: Option<f64>,
    to: f64,
    time_zone: DashboardTimeZone,
) -> rusqlite::Result<DashboardActiveHours> {
    let allowed: HashSet<(&str, &str, &str)> = sessions
        .iter()
        .copied()
        .filter(|s| s.parent_reference.is_none() && scope.matches(s))
        .map(|s| {
            (
                s.reference.source_node_id.as_str(),
                s.reference.agent_name.as_str(),
                s.reference.session_id.as_str(),
            )
        })
        .collect();
    let mut counts = vec![0_usize; 84];
    if allowed.is_empty() {
        return Ok(DashboardActiveHours {
            time_zone: time_zone.name().into(),
            counts,
        });
    }
    // Covering index scan avoids both json_each serialization and per-message joins to sessions.
    let mut query = connection.prepare_cached(
        "SELECT m.time_created, m.source_node_id, m.agent_name, m.session_id \
         FROM messages m INDEXED BY idx_messages_user_activity \
         WHERE m.role='user' AND m.automated=0 AND m.time_created>0 AND m.time_created BETWEEN ?2 AND ?1",
    )?;
    let mut rows = query.query(rusqlite::params![to, from.unwrap_or(0.0)])?;
    while let Some(row) = rows.next()? {
        let source_node_id = row.get_ref(1)?.as_str().unwrap_or("");
        let agent_name = row.get_ref(2)?.as_str().unwrap_or("");
        let session_id = row.get_ref(3)?.as_str().unwrap_or("");
        if !allowed.contains(&(source_node_id, agent_name, session_id)) {
            continue;
        }
        let time: f64 = row.get(0)?;
        if let Some(time) =
            crate::time::date_time_clip(time).and_then(DateTime::from_timestamp_millis)
        {
            counts[time_zone.slot(time)] += 1;
        }
    }
    Ok(DashboardActiveHours {
        time_zone: time_zone.name().into(),
        counts,
    })
}
