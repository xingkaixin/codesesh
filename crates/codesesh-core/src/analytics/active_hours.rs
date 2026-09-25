use super::{DashboardScope, DashboardTimeZone};
use crate::contract::{SessionHead, SessionReference};
use chrono::DateTime;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn active_hours(
    connection: &Connection,
    sessions: &[SessionHead],
    scope: &DashboardScope,
    from: Option<f64>,
    to: f64,
    time_zone: DashboardTimeZone,
) -> rusqlite::Result<Value> {
    let allowed: HashSet<_> = sessions
        .iter()
        .filter(|s| scope.matches(s))
        .map(|s| &s.reference)
        .collect();
    let mut query=connection.prepare("SELECT m.agent_name,m.session_id,m.time_created FROM messages m INDEXED BY idx_messages_user_activity JOIN sessions s ON s.agent_name=m.agent_name AND s.session_id=m.session_id WHERE s.publication_id IS NULL AND s.parent_agent_name IS NULL AND s.parent_session_id IS NULL AND m.role='user' AND m.automated=0 AND m.time_created>0 AND m.time_created<=?1 AND (?2 IS NULL OR m.time_created>=?2)")?;
    let mut counts = vec![0_u64; 84];
    for row in query.query_map(rusqlite::params![to, from], |r| {
        Ok((
            SessionReference {
                agent_name: r.get(0)?,
                session_id: r.get(1)?,
            },
            r.get::<_, f64>(2)?,
        ))
    })? {
        let (reference, time) = row?;
        if !allowed.contains(&reference) {
            continue;
        }
        if let Some(time) =
            crate::time::date_time_clip(time).and_then(DateTime::from_timestamp_millis)
        {
            counts[time_zone.slot(time)] += 1;
        }
    }
    Ok(json!({"timeZone":time_zone.name(),"counts":counts}))
}
