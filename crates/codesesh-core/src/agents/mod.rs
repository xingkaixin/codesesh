pub mod codex;

use crate::contract::AgentInfo;

pub fn catalog(count: usize) -> Vec<AgentInfo> {
    let entries: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("catalog.json")).expect("valid bundled agent catalog");
    entries
        .into_iter()
        .map(|entry| {
            let name = entry["name"].as_str().unwrap().to_owned();
            let count = if name == "codex" { count } else { 0 };
            AgentInfo {
                name,
                display_name: entry["displayName"].as_str().unwrap().into(),
                count,
                available: count > 0,
            }
        })
        .collect()
}
