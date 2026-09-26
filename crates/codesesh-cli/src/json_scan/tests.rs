use super::*;
use std::{fs, path::PathBuf};

fn fixture() -> (tempfile::TempDir, AgentSource, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("codex");
    fs::create_dir_all(root.join("sessions")).unwrap();
    write(&root, "first", "first body");
    let cache = temp.path().join("cache.db");
    (
        temp,
        AgentSource {
            agent: "codex".into(),
            scan_path: root.join("sessions"),
            data_root: root,
        },
        cache,
    )
}
fn write(root: &Path, id: &str, text: &str) {
    let lines = [
        serde_json::json!({"type":"session_meta","timestamp":"2026-09-01T10:00:00Z","payload":{"id":id,"cwd":root.to_string_lossy()}}),
        serde_json::json!({"type":"response_item","timestamp":"2026-09-01T10:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text}]}}),
    ];
    fs::write(
        root.join("sessions").join(format!("rollout-{id}.jsonl")),
        lines
            .iter()
            .map(|line| line.to_string())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
}
#[test]
fn warm_json_does_not_rewrite_messages_and_detects_add_modify_delete() {
    let (_temp, source, path) = fixture();
    let options = ScanOptions::default();
    let pricing = Pricing::bundled();
    let first = run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    let cache = Cache::open(Some(&path)).unwrap();
    cache.connection().execute_batch("CREATE TRIGGER reject_json_write BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'warm JSON rewrote messages'); END").unwrap();
    drop(cache);
    let warm = run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(warm).unwrap(),
        serde_json::to_value(&first).unwrap()
    );
    let cache = Cache::open(Some(&path)).unwrap();
    cache
        .connection()
        .execute_batch("DROP TRIGGER reject_json_write")
        .unwrap();
    drop(cache);
    write(&source.data_root, "first", "changed body");
    write(&source.data_root, "second", "new body");
    let changed = run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    assert_eq!(changed.sessions.len(), 2);
    assert!(
        changed
            .sessions
            .iter()
            .any(|head| head.title == "changed body")
    );
    fs::remove_file(source.scan_path.join("rollout-first.jsonl")).unwrap();
    let deleted = run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    assert_eq!(deleted.sessions.len(), 1);
    fs::remove_file(source.scan_path.join("rollout-second.jsonl")).unwrap();
    assert!(
        run(
            std::slice::from_ref(&source),
            &options,
            &pricing,
            &path,
            None
        )
        .unwrap()
        .sessions
        .is_empty()
    );
}
#[test]
fn filtered_json_keeps_full_cache_and_failures_preserve_last_good_data() {
    let (_temp, source, path) = fixture();
    let pricing = Pricing::bundled();
    let options = ScanOptions {
        from: Some(1_900_000_000_000.0),
        ..Default::default()
    };
    assert!(
        run(
            std::slice::from_ref(&source),
            &options,
            &pricing,
            &path,
            None
        )
        .unwrap()
        .sessions
        .is_empty()
    );
    assert_eq!(
        run(
            std::slice::from_ref(&source),
            &ScanOptions::default(),
            &pricing,
            &path,
            None,
        )
        .unwrap()
        .sessions
        .len(),
        1
    );
    fs::write(source.scan_path.join("rollout-first.jsonl"), "not json").unwrap();
    let failed = run(
        std::slice::from_ref(&source),
        &ScanOptions::default(),
        &pricing,
        &path,
        None,
    );
    if failed.is_err() {
        assert_eq!(
            Cache::open_read_only(&path)
                .unwrap()
                .snapshot()
                .unwrap()
                .len(),
            1
        );
    } else {
        panic!("invalid source must not replace last-known-good data");
    }
}

#[test]
fn external_publication_invalidates_the_index_but_pricing_does_not() {
    let (temp, source, path) = fixture();
    let options = ScanOptions::default();
    let pricing = Pricing::bundled();
    run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    let cache = Cache::open(Some(&path)).unwrap();
    cache.connection().execute_batch("UPDATE sessions SET title='external publication'; UPDATE cache_meta SET value=CAST(value AS INTEGER)+1 WHERE key='analytics_revision'").unwrap();
    drop(cache);
    let refreshed = run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    assert_eq!(refreshed.sessions[0].title, "first body");
    let directory = temp.path().join(".cache/codesesh");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("models-dev-pricing.json"), serde_json::json!({"timestamp":1,"data":{"json-cache-test-model":{"inputCostPerToken":1,"outputCostPerToken":2}}}).to_string()).unwrap();
    let changed = Pricing::load(temp.path());
    assert_ne!(changed.generation(), pricing.generation());
    let cache = Cache::open(Some(&path)).unwrap();
    cache.connection().execute_batch("CREATE TRIGGER reject_json_write BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'pricing reindex detected'); END").unwrap();
    drop(cache);
    let repriced = run(
        std::slice::from_ref(&source),
        &options,
        &changed,
        &path,
        None,
    )
    .unwrap();
    assert_eq!(repriced.sessions[0].title, "first body");
}

#[test]
fn price_changes_update_json_costs_without_invalidating_content_fingerprints() {
    let (temp, source, path) = fixture();
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(source.scan_path.join("rollout-first.jsonl"))
        .unwrap();
    for value in [
        serde_json::json!({"type":"turn_context","payload":{"model":"json-cost-model"}}),
        serde_json::json!({"type":"response_item","timestamp":"2026-09-01T10:00:02Z","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"unchanged response"}]}}),
        serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000000,"output_tokens":0},"total_token_usage":{"total_tokens":1000000,"input_tokens":1000000}}}}),
    ] {
        writeln!(file, "{value}").unwrap();
    }
    let options = ScanOptions::default();
    let first = run(
        std::slice::from_ref(&source),
        &options,
        &Pricing::bundled(),
        &path,
        None,
    )
    .unwrap();
    assert_eq!(first.sessions[0].stats.total_cost, 0.0);
    let cache = Cache::open(Some(&path)).unwrap();
    cache.connection().execute_batch("CREATE TRIGGER reject_json_reparse BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'price update reparsed history'); END").unwrap();
    let controller = codesesh_core::pricing::PricingController::load(temp.path());
    controller.stage_remote(&serde_json::json!({"openai":{"models":{"json-cost-model":{"cost":{"input":12,"output":8}}}}})).unwrap();
    controller.publish_pending().unwrap();
    let pricing = controller.snapshot().unwrap().pricing;
    let result = run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    assert_eq!(result.sessions[0].stats.total_cost, 12.0);
    let stable = run(
        std::slice::from_ref(&source),
        &options,
        &pricing,
        &path,
        None,
    )
    .unwrap();
    assert_eq!(stable.sessions[0].stats.total_cost, 12.0);
}
