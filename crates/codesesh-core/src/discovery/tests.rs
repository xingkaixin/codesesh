use super::*;
use std::collections::HashMap;

mod agent_layouts;
mod backfill_pages;
mod codex;
mod databases;
mod pricing;
mod refresh;
mod sources;

fn environment(root: &Path) -> PathEnvironment {
    PathEnvironment {
        home: root.join("home"),
        cwd: root.join("cwd"),
        platform: "linux".into(),
        variables: HashMap::new(),
    }
}

fn pi_source(root: &Path) -> AgentSource {
    AgentSource {
        agent: "pi".into(),
        data_root: root.to_owned(),
        scan_path: root.join("agent/sessions"),
    }
}

fn write_pi(source: &AgentSource, text: &str) -> std::path::PathBuf {
    std::fs::create_dir_all(&source.scan_path).unwrap();
    let file = source.scan_path.join("session.jsonl");
    let records = [
        serde_json::json!({"type":"session","cwd":"/tmp/discovery-fixture","timestamp":1000}),
        serde_json::json!({"type":"message","id":"u","parentId":null,"message":{"role":"user","content":text}}),
    ];
    std::fs::write(
        &file,
        records
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    file
}

fn commit_page(cache: &mut crate::storage::Cache, batch: &mut crate::runtime::ScanBatch) {
    cache
        .apply_checkpoint(
            &mut batch.sessions,
            &batch.removed,
            "pi",
            &batch.checkpoint,
            batch.complete,
        )
        .unwrap();
    batch.on_reject.take();
}
