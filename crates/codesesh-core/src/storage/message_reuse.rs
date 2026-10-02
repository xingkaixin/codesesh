use crate::contract::SessionReference;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use std::collections::HashMap;

pub(super) fn stored_digests(
    connection: &Connection,
    reference: &SessionReference,
) -> Result<HashMap<i64, String>> {
    // Repricing updates costs without replacing chain digests; those rows must be rebuilt.
    let reusable = connection.query_row(
        "SELECT CASE WHEN json_valid(s.meta_json) THEN
             json_extract(s.meta_json,'$.parserVersion')=?
             AND COALESCE(json_extract(s.meta_json,'$.rustPricingRevision'),0)=0
         ELSE 0 END
         AND NOT EXISTS(SELECT 1 FROM pending_reindex p
             WHERE p.source_node_id=s.source_node_id AND p.agent_name=s.agent_name AND p.session_id=s.session_id)
         FROM sessions s WHERE s.source_node_id=? AND s.agent_name=? AND s.session_id=?",
        params![crate::agents::parser_version(&reference.agent_name), reference.source_node_id, reference.agent_name, reference.session_id],
        |row| row.get::<_, Option<bool>>(0),
    ).optional()?.flatten().unwrap_or(false);
    if !reusable {
        return Ok(HashMap::new());
    }
    let mut query = connection.prepare(
        "SELECT message_index,content_chain_digest FROM messages
         WHERE source_node_id=? AND agent_name=? AND session_id=? AND content_chain_digest IS NOT NULL",
    )?;
    Ok(query
        .query_map(
            params![
                reference.source_node_id,
                reference.agent_name,
                reference.session_id
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
