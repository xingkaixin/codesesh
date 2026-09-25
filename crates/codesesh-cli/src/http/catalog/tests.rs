use super::*;
use codesesh_core::{
    agents::codex::{self, ParsedSession},
    pricing::Pricing,
    runtime::Runtime,
    state::StateStore,
    storage::Cache,
};

#[test]
fn cache_evicts_old_queries_and_failed_builds_are_retryable() {
    let cache = std::sync::Mutex::new(CatalogCache::default());
    for key in 0..64 {
        cached_catalog(&cache, "1".into(), json!(key), || Ok(json!(key))).unwrap();
    }
    cached_catalog(&cache, "1".into(), json!(0), || panic!("cache miss")).unwrap();
    cached_catalog(&cache, "1".into(), json!(64), || Ok(json!(64))).unwrap();
    assert_eq!(cache.lock().unwrap().entries.len(), 64);
    assert!(cache.lock().unwrap().get("1", &json!(1)).is_none());
    assert!(
        cached_catalog(&cache, "2".into(), json!(0), || anyhow::bail!(
            "read failed"
        ))
        .is_err()
    );
    assert_eq!(
        cached_catalog(&cache, "2".into(), json!(0), || {
            assert!(cache.try_lock().is_ok());
            Ok(json!("new"))
        })
        .unwrap(),
        json!("new")
    );
    cached_catalog(&cache, "1".into(), json!(65), || {
        Ok(json!("late old snapshot"))
    })
    .unwrap();
    assert_eq!(
        cached_catalog(&cache, "2".into(), json!(0), || panic!(
            "old snapshot evicted current generation"
        ))
        .unwrap(),
        json!("new")
    );
}

async fn body(response: Response) -> Value {
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn cached_dashboard_keeps_scopes_windows_zones_aliases_and_publications_distinct() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("rollout.jsonl");
    std::fs::write(&source, concat!(
        "{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
        "{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Original\"}]}}\n"
    )).unwrap();
    let data = codex::parse(&source, &Default::default(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    let reference = data.head.reference.clone();
    let mut sessions = [ParsedSession {
        head: data.head.clone(),
        detail: data,
        source,
    }];
    let path = dir.path().join("cache.db");
    let mut writer = Cache::open(Some(&path)).unwrap();
    writer.publish(&mut sessions).unwrap();
    let runtime = Runtime::start(path, vec![], 1).await.unwrap();
    let state = Arc::new(State::new(
        runtime.clone(),
        Some(StateStore::memory().unwrap()),
        super::super::Options {
            token: "test".into(),
            hostname: "127.0.0.1".into(),
            port: 4521,
            tls: false,
            trust_proxy: false,
            loopback_authority: true,
            default_from: None,
            default_to: None,
            default_days: Some(0),
            enabled_agents: vec!["codex".into()],
            cwd: None,
        },
    ));
    let query = "from=2026-09-01&to=2026-09-02&timeZone=UTC";
    let first = body(dashboard(AxumState(state.clone()), RawQuery(Some(query.into()))).await).await;
    assert_eq!(first["recentSessions"].as_array().unwrap().len(), 1);
    let second =
        body(dashboard(AxumState(state.clone()), RawQuery(Some(query.into()))).await).await;
    assert_eq!(first, second);
    state
        .saved
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .upsert_alias(&reference, "Changed alias")
        .unwrap();
    let aliased =
        body(dashboard(AxumState(state.clone()), RawQuery(Some(query.into()))).await).await;
    assert_eq!(
        aliased["recentSessions"][0]["session"]["display_title"],
        "Changed alias"
    );
    for filter in ["&agent=claude", "&projectKind=path&projectKey=/other"] {
        let scoped = body(
            dashboard(
                AxumState(state.clone()),
                RawQuery(Some(format!("{query}{filter}"))),
            )
            .await,
        )
        .await;
        assert!(scoped["recentSessions"].as_array().unwrap().is_empty());
    }
    let excluded = body(
        dashboard(
            AxumState(state.clone()),
            RawQuery(Some("from=2026-09-03&to=2026-09-04&timeZone=UTC".into())),
        )
        .await,
    )
    .await;
    assert!(excluded["recentSessions"].as_array().unwrap().is_empty());
    let zone = body(
        dashboard(
            AxumState(state.clone()),
            RawQuery(Some(query.replace("UTC", "Asia/Shanghai"))),
        )
        .await,
    )
    .await;
    assert_ne!(first["activeHours"], zone["activeHours"]);
    sessions[0].head.title = "New generation".into();
    sessions[0].detail.head.title = "New generation".into();
    writer.publish(&mut sessions).unwrap();
    let updated =
        body(dashboard(AxumState(state.clone()), RawQuery(Some(query.into()))).await).await;
    assert_eq!(
        updated["recentSessions"][0]["session"]["title"],
        "New generation"
    );
    assert!(state.catalog_cache.lock().unwrap().entries.len() <= 64);
    runtime.shutdown().await.unwrap();
}
