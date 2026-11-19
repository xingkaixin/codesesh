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
            HeaderMap::new(),
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
            HeaderMap::new(),
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
            HeaderMap::new(),
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
                HeaderMap::new(),
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
            HeaderMap::new(),
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
            HeaderMap::new(),
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
            HeaderMap::new(),
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
            HeaderMap::new(),
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

#[tokio::test]
async fn projects_sort_globally_before_pagination_and_scope_cursors() {
    let dir = tempfile::tempdir().unwrap();
    let specs = [
        ("p-recent", "/workspace/recent", "2026-09-05T10:00:00Z", 1.0),
        ("p-busy-1", "/workspace/busy", "2026-09-01T10:00:00Z", 0.5),
        ("p-busy-2", "/workspace/busy", "2026-09-02T10:00:00Z", 0.5),
        ("p-busy-3", "/workspace/busy", "2026-09-03T10:00:00Z", 0.5),
        (
            "p-costly",
            "/workspace/costly",
            "2026-09-02T12:00:00Z",
            25.0,
        ),
        ("p-tie-b", "/workspace/tie-b", "2026-09-04T10:00:00Z", 2.0),
        ("p-tie-a", "/workspace/tie-a", "2026-09-04T10:00:00Z", 2.0),
    ];
    let mut sessions = Vec::new();
    for (id, cwd, timestamp, cost) in specs {
        let source = dir.path().join(format!("{id}.jsonl"));
        std::fs::write(
            &source,
            format!(
                "{{\"timestamp\":\"{timestamp}\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":\"{cwd}\"}}}}\n\
                 {{\"timestamp\":\"{timestamp}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"text\":\"hi\"}}]}}}}\n"
            ),
        )
        .unwrap();
        let mut data = parse_codex(&source, &Default::default(), &Pricing::bundled())
            .unwrap()
            .unwrap();
        data.head.stats.total_cost = cost;
        data.head.stats.total_input_tokens = 100.0;
        sessions.push(ParsedSession {
            head: data.head.clone(),
            detail: data,
            source,
        });
    }
    let path = dir.path().join("cache.db");
    Cache::open(Some(&path))
        .unwrap()
        .publish(&mut sessions)
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

    let collect_all = |sort_query: Option<&'static str>| {
        let state = state.clone();
        async move {
            let mut keys = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let mut q = String::from("limit=2");
                if let Some(sort) = sort_query {
                    q.push_str(&format!("&sort={sort}"));
                }
                if let Some(c) = &cursor {
                    q.push_str(&format!("&cursor={c}"));
                }
                let page = body(
                    projects(
                        AxumState(state.clone()),
                        RawQuery(Some(q)),
                        HeaderMap::new(),
                        Extension(Default::default()),
                    )
                    .await,
                )
                .await;
                for item in page["projects"].as_array().unwrap() {
                    keys.push(item["identityKey"].as_str().unwrap().to_owned());
                }
                cursor = page["nextCursor"].as_str().map(str::to_owned);
                if cursor.is_none() {
                    break;
                }
            }
            keys
        }
    };

    // Default (latest): sorted by lastActivity desc, deterministic tie-break on identityKey asc.
    assert_eq!(
        collect_all(None).await,
        vec![
            "/workspace/recent",
            "/workspace/tie-a",
            "/workspace/tie-b",
            "/workspace/busy",
            "/workspace/costly",
        ]
    );
    // Global sessions sort puts /workspace/busy first even though it was page 2 in latest order.
    assert_eq!(
        collect_all(Some("sessions")).await,
        vec![
            "/workspace/busy",
            "/workspace/recent",
            "/workspace/tie-a",
            "/workspace/tie-b",
            "/workspace/costly",
        ]
    );
    // Global cost sort puts /workspace/costly first even though it was last in latest order.
    assert_eq!(
        collect_all(Some("cost")).await,
        vec![
            "/workspace/costly",
            "/workspace/tie-a",
            "/workspace/tie-b",
            "/workspace/busy",
            "/workspace/recent",
        ]
    );

    // Cursor created for default/latest sort works with explicit sort=latest, fails for sort=cost.
    let first = body(
        projects(
            AxumState(state.clone()),
            RawQuery(Some("limit=2".into())),
            HeaderMap::new(),
            Extension(Default::default()),
        )
        .await,
    )
    .await;
    let cursor = first["nextCursor"].as_str().unwrap();
    let explicit_latest = projects(
        AxumState(state.clone()),
        RawQuery(Some(format!("limit=2&sort=latest&cursor={cursor}"))),
        HeaderMap::new(),
        Extension(Default::default()),
    )
    .await;
    assert_eq!(explicit_latest.status(), StatusCode::OK);

    let mismatched = projects(
        AxumState(state.clone()),
        RawQuery(Some(format!("limit=2&sort=cost&cursor={cursor}"))),
        HeaderMap::new(),
        Extension(Default::default()),
    )
    .await;
    assert_eq!(mismatched.status(), StatusCode::BAD_REQUEST);

    // Invalid sort value returns 400.
    let invalid = projects(
        AxumState(state),
        RawQuery(Some("limit=2&sort=invalid".into())),
        HeaderMap::new(),
        Extension(Default::default()),
    )
    .await;
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    runtime.shutdown().await.unwrap();
}

#[test]
fn cached_catalog_coalesces_concurrent_misses_per_revision_and_key() {
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering},
    };
    let cache = Arc::new(Mutex::new(CatalogCache::<u64>::default()));
    let builds = Arc::new(AtomicUsize::new(0));
    let start = Arc::new(Barrier::new(8));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let cache = cache.clone();
        let builds = builds.clone();
        let start = start.clone();
        handles.push(std::thread::spawn(move || {
            start.wait();
            cached_catalog(&cache, 7, json!(["dashboard", "same"]), || {
                builds.fetch_add(1, Ordering::AcqRel);
                std::thread::sleep(std::time::Duration::from_millis(40));
                Ok(42)
            })
            .unwrap()
        }));
    }
    for handle in handles {
        assert_eq!(handle.join().unwrap(), 42);
    }
    assert_eq!(builds.load(Ordering::Acquire), 1);

    // Failed leader clears in-flight entry and wakes waiters so subsequent callers can retry.
    let fail_start = Arc::new(Barrier::new(2));
    let mut fail_handles = Vec::new();
    for _ in 0..2 {
        let cache = cache.clone();
        let fail_start = fail_start.clone();
        fail_handles.push(std::thread::spawn(move || {
            fail_start.wait();
            cached_catalog(&cache, 8, json!(["dashboard", "err"]), || {
                std::thread::sleep(std::time::Duration::from_millis(20));
                anyhow::bail!("transient failure")
            })
        }));
    }
    for handle in fail_handles {
        assert!(handle.join().unwrap().is_err());
    }
    let recovered = cached_catalog(&cache, 8, json!(["dashboard", "err"]), || Ok(99)).unwrap();
    assert_eq!(recovered, 99);
}
