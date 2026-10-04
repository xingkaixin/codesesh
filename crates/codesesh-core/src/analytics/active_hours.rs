use super::{
    DashboardScope, DashboardTimeZone,
    read::{encode_references, reference_condition},
};
use crate::contract::SessionHead;
use chrono::DateTime;
use rusqlite::Connection;
use serde_json::{Value, json};

pub fn active_hours(
    connection: &Connection,
    sessions: &[SessionHead],
    scope: &DashboardScope,
    from: Option<f64>,
    to: f64,
    time_zone: DashboardTimeZone,
) -> rusqlite::Result<Value> {
    let allowed = encode_references(
        sessions
            .iter()
            .filter(|s| scope.matches(s))
            .map(|s| &s.reference),
    );
    // Keep the covering index and BETWEEN bounds; session filters and >0 can otherwise scan history.
    let mut query=connection.prepare(&format!("SELECT m.time_created FROM messages m INDEXED BY idx_messages_user_activity JOIN sessions s ON s.source_node_id=m.source_node_id AND s.agent_name=m.agent_name AND s.session_id=m.session_id WHERE s.publication_id IS NULL AND s.parent_agent_name IS NULL AND s.parent_session_id IS NULL AND m.role='user' AND m.automated=0 AND m.time_created>0 AND m.time_created BETWEEN ?2 AND ?1 AND {}", reference_condition("m")))?;
    let mut counts = vec![0_u64; 84];
    for time in query.query_map(rusqlite::params![to, from.unwrap_or(0.0), allowed], |r| {
        r.get::<_, f64>(0)
    })? {
        if let Some(time) =
            crate::time::date_time_clip(time?).and_then(DateTime::from_timestamp_millis)
        {
            counts[time_zone.slot(time)] += 1;
        }
    }
    Ok(json!({"timeZone":time_zone.name(),"counts":counts}))
}
