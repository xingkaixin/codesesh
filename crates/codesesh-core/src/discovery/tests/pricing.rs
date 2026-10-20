use super::*;

#[test]
fn unrelated_pricing_changes_preserve_scans_and_replace_commit_ticket() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    write_pi(&source, "Priced session");
    let controller = crate::pricing::PricingController::load(temporary.path());
    let mut scanner = AgentScanner::with_pricing_controller(
        source.clone(),
        temporary.path().join("cache.db"),
        controller.clone(),
    )
    .unwrap();
    let mut initial = scanner.refresh(None).unwrap();
    let old = initial.pricing.clone().unwrap();
    initial.on_reject.take();
    let mut unchanged = scanner
        .refresh(Some(&[source.scan_path.join("unrelated.txt")]))
        .unwrap();
    assert!(unchanged.sessions.is_empty());
    unchanged.on_reject.take();
    controller.stage_remote(&serde_json::json!({"openai":{"models":{"discovery-new-model":{"cost":{"input":2,"output":8}}}}})).unwrap();
    assert!(controller.publish_pending().unwrap());
    assert!(old.check().is_err());
    let refreshed = scanner
        .refresh(Some(&[source.scan_path.join("unrelated.txt")]))
        .unwrap();
    assert!(refreshed.sessions.is_empty());
    assert!(refreshed.complete);
    assert_eq!(
        refreshed.pricing.as_ref().unwrap().generation(),
        controller.generation()
    );
}

#[test]
fn durable_pricing_dependencies_reuse_unrelated_changes_and_refresh_used_prices() {
    for model in ["discovery-missing-model", "gpt-4o-2024-08-06"] {
        let temporary = tempfile::tempdir().unwrap();
        let source = pi_source(temporary.path());
        let file = write_pi(&source, "Priced session");
        use std::io::Write;
        writeln!(
            std::fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap(),
            "\n{}",
            serde_json::json!({"type":"message","id":"a","parentId":"u","message":{
                "role":"assistant","model":model,"usage":{"input":1000000,"output":0},
                "content":[{"type":"text","text":"Answer"}]}})
        )
        .unwrap();
        let db = temporary.path().join("cache.db");
        let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
        let controller = crate::pricing::PricingController::load(temporary.path());
        let mut scanner =
            AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
                .unwrap();
        let mut initial = scanner.refresh(None).unwrap();
        let old_cost = initial.sessions[0].head.stats.total_cost;
        assert!(
            initial.checkpoint.as_ref().unwrap()["sourceState"]["priceDependencies"]
                .get(model)
                .is_some()
        );
        commit_page(&mut cache, &mut initial);
        controller.stage_remote(&serde_json::json!({"openai":{"models":{"unrelated-model":{"cost":{"input":2,"output":8}}}}})).unwrap();
        controller.publish_pending().unwrap();
        let mut warm = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
        assert!(warm.complete);
        assert!(warm.sessions.is_empty());
        // Leave the old generation on disk to exercise restart across a pricing change.
        warm.on_reject.take();
        let mut scanner =
            AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
                .unwrap();
        let mut restarted = scanner.refresh(None).unwrap();
        assert!(restarted.complete);
        assert!(restarted.sessions.is_empty());
        assert_eq!(restarted.checkpoint.as_ref().unwrap()["incremental"], true);
        commit_page(&mut cache, &mut restarted);
        controller
            .stage_remote(
                &serde_json::json!({"openai":{"models":{model:{"cost":{"input":123,"output":8}}}}}),
            )
            .unwrap();
        controller.publish_pending().unwrap();
        let mut repriced = scanner.refresh(Some(std::slice::from_ref(&file))).unwrap();
        assert!(repriced.sessions.is_empty());
        assert!(repriced.complete);
        commit_page(&mut cache, &mut repriced);
        let updated = cache
            .reprice("pi", &controller.snapshot().unwrap().pricing)
            .unwrap();
        assert_eq!(updated.len(), 1);
        let head = cache.head(&updated[0]).unwrap().unwrap();
        assert_ne!(head.stats.total_cost, old_cost);
        assert_eq!(head.stats.total_cost, 123.0);
        let mut scanner = AgentScanner::with_pricing_controller(source, db, controller).unwrap();
        let mut stable = scanner.refresh(None).unwrap();
        assert!(stable.sessions.is_empty());
        commit_page(&mut cache, &mut stable);
    }
}

#[test]
fn legacy_pricing_state_stays_unknown_until_reparsed() {
    let temporary = tempfile::tempdir().unwrap();
    let source = pi_source(temporary.path());
    write_pi(&source, "Legacy session");
    let db = temporary.path().join("cache.db");
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    let controller = crate::pricing::PricingController::load(temporary.path());
    let mut scanner =
        AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
            .unwrap();
    let mut initial = scanner.refresh(None).unwrap();
    commit_page(&mut cache, &mut initial);
    cache.connection().execute("UPDATE cache_meta SET value=json_remove(value,'$.priceDependencies') WHERE key='rust_source_state:pi'", []).unwrap();
    cache
        .connection()
        .execute(
            "UPDATE sessions SET meta_json=json_remove(meta_json,'$.rustPricing')",
            [],
        )
        .unwrap();
    let mut scanner =
        AgentScanner::with_pricing_controller(source.clone(), db.clone(), controller.clone())
            .unwrap();
    let mut warm = scanner.refresh(None).unwrap();
    assert!(warm.sessions.is_empty());
    assert!(warm.checkpoint.as_ref().unwrap()["sourceState"]["priceDependencies"].is_null());
    commit_page(&mut cache, &mut warm);
    controller.stage_remote(&serde_json::json!({"openai":{"models":{"unrelated-model":{"cost":{"input":2,"output":8}}}}})).unwrap();
    controller.publish_pending().unwrap();
    let mut scanner = AgentScanner::with_pricing_controller(source, db, controller).unwrap();
    let mut refreshed = scanner.refresh(None).unwrap();
    assert_eq!(refreshed.sessions.len(), 1);
    commit_page(&mut cache, &mut refreshed);
}
