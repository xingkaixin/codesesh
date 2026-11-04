use super::*;
use codesesh_core::{
    agents::{ParsedSession, parse_codex},
    pricing::Pricing,
    runtime::Runtime,
    state::StateStore,
    storage::Cache,
};

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
    let data = parse_codex(&source, &Default::default(), &Pricing::bundled())
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
        codesesh_core::pricing::PricingController::load(dir.path()),
        Some(StateStore::memory().unwrap()),
        super::super::Options {
            token: Some("test".into()),
            hostname: "127.0.0.1".into(),
            port: 4521,
            tls: false,
            trust_proxy: false,
            public_origin: None,
            loopback_authority: true,
            default_from: None,
            default_to: None,
            default_days: Some(0),
            enabled_agents: vec!["codex".into()],
            cwd: None,
        },
    ));
    let query = "from=2026-09-01&to=2026-09-02&timeZone=UTC";
    let first = body(
        dashboard(
            AxumState(state.clone()),
            RawQuery(Some(query.into())),
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    assert_eq!(first["recentSessions"].as_array().unwrap().len(), 1);
    let second = body(
        dashboard(
            AxumState(state.clone()),
            RawQuery(Some(query.into())),
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    assert_eq!(first, second);
    state
        .saved
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .upsert_alias(&reference, "Changed alias")
        .unwrap();
    let aliased = body(
        dashboard(
            AxumState(state.clone()),
            RawQuery(Some(query.into())),
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    assert_eq!(
        aliased["recentSessions"][0]["session"]["display_title"],
        "Changed alias"
    );
    for filter in ["&agent=claude", "&projectKind=path&projectKey=/other"] {
        let scoped = body(
            dashboard(
                AxumState(state.clone()),
                RawQuery(Some(format!("{query}{filter}"))),
                Extension(Default::default()),
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
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    assert!(excluded["recentSessions"].as_array().unwrap().is_empty());
    let zone = body(
        dashboard(
            AxumState(state.clone()),
            RawQuery(Some(query.replace("UTC", "Asia/Shanghai"))),
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    assert_ne!(first["activeHours"], zone["activeHours"]);
    sessions[0].head.title = "New generation".into();
    sessions[0].detail.head.title = "New generation".into();
    writer.publish(&mut sessions).unwrap();
    let updated = body(
        dashboard(
            AxumState(state.clone()),
            RawQuery(Some(query.into())),
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    assert_eq!(
        updated["recentSessions"][0]["session"]["title"],
        "New generation"
    );
    assert!(state.catalog_cache.lock().unwrap().entries.len() <= 64);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn dashboard_days_follow_the_request_time_zone() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("rollout.jsonl");
    std::fs::write(&source, concat!(
        "{\"timestamp\":\"2026-09-01T23:30:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
        "{\"timestamp\":\"2026-09-01T23:30:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Morning\"}]}}\n"
    )).unwrap();
    let data = parse_codex(&source, &Default::default(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    let path = dir.path().join("cache.db");
    Cache::open(Some(&path))
        .unwrap()
        .publish(&mut [ParsedSession {
            head: data.head.clone(),
            detail: data,
            source,
        }])
        .unwrap();
    let runtime = Runtime::start(path, vec![], 1).await.unwrap();
    let state = Arc::new(State::new(
        runtime.clone(),
        codesesh_core::pricing::PricingController::load(dir.path()),
        Some(StateStore::memory().unwrap()),
        super::super::Options {
            token: Some("test".into()),
            hostname: "127.0.0.1".into(),
            port: 4521,
            tls: false,
            trust_proxy: false,
            public_origin: None,
            loopback_authority: true,
            default_from: None,
            default_to: None,
            default_days: Some(0),
            enabled_agents: vec!["codex".into()],
            cwd: None,
        },
    ));
    let shanghai_day =
        "from=2026-09-01T16:00:00Z&to=2026-09-02T15:59:59.999Z&timeZone=Asia/Shanghai";
    let value = body(
        dashboard(
            AxumState(state),
            RawQuery(Some(shanghai_day.into())),
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    assert_eq!(value["window"]["days"], 1);
    let daily = value["dailyActivity"].as_array().unwrap();
    assert_eq!(daily.len(), 1);
    assert_eq!(daily[0]["date"], "2026-09-02");
    assert_eq!(daily[0]["sessions"], 1);
    runtime.shutdown().await.unwrap();
}
