use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Method, Request},
};
use tower::ServiceExt;

async fn app() -> (Router, codesesh_core::runtime::Runtime, tempfile::TempDir) {
    app_mode(false).await
}
async fn app_mode(hub: bool) -> (Router, codesesh_core::runtime::Runtime, tempfile::TempDir) {
    app_options(hub, Some("secret".into())).await
}
async fn app_options(
    hub: bool,
    token: Option<String>,
) -> (Router, codesesh_core::runtime::Runtime, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = codesesh_core::runtime::Runtime::start(dir.path().join("cache.db"), vec![], 1)
        .await
        .unwrap();
    let options = Options {
        token,
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
    };
    let state = State::new(
        runtime.clone(),
        codesesh_core::pricing::PricingController::load(dir.path()),
        Some(StateStore::memory().unwrap()),
        options,
    );
    let state = if hub {
        runtime
            .hub_control(|cache| cache.initialize_hub("fixture-hub"))
            .await
            .unwrap();
        state.with_hub()
    } else {
        state
    };
    (router(Arc::new(state)), runtime, dir)
}
async fn request(
    app: &Router,
    method: Method,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "localhost:4521");
    for (k, v) in headers {
        request = request.header(*k, *v);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_owned())).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn local_access_without_auth_preserves_request_boundaries() {
    let (app, runtime, _dir) = app_options(false, None).await;
    for (headers, expected) in [
        (vec![], StatusCode::OK),
        (vec![("authorization", "Bearer stale")], StatusCode::OK),
        (vec![("origin", "http://evil.test")], StatusCode::FORBIDDEN),
        (
            vec![("sec-fetch-site", "cross-site")],
            StatusCode::FORBIDDEN,
        ),
        (vec![("host", "evil.test:4521")], StatusCode::FORBIDDEN),
    ] {
        assert_eq!(
            request(&app, Method::GET, "/api/config", &headers, "")
                .await
                .0,
            expected
        );
    }
    assert_eq!(
        request(&app, Method::PUT, "/api/bookmarks", &[], "{}")
            .await
            .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/api/bookmarks",
            &[("content-type", "application/json")],
            r#"{"reference":{"agentName":"codex","sessionId":"local"}}"#
        )
        .await
        .0,
        StatusCode::OK
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn source_qualified_alias_routes_preserve_identity() {
    let (app, runtime, _dir) = app().await;
    let headers = [
        ("authorization", "Bearer secret"),
        ("origin", "http://localhost:4521"),
        ("content-type", "application/json"),
    ];
    let (status, remote) = request(
        &app,
        Method::PUT,
        "/api/session-aliases/nodes/worker-a/codex/shared",
        &headers,
        r#"{"alias":"Remote"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(remote["alias"]["reference"]["sourceNodeId"], "worker-a");
    let (status, local) = request(
        &app,
        Method::PUT,
        "/api/session-aliases/codex/shared",
        &headers,
        r#"{"alias":"Local"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(local["alias"]["reference"].get("sourceNodeId").is_none());
    runtime.shutdown().await.unwrap();
}
#[tokio::test]
async fn api_auth_transport_and_write_boundaries() {
    let (app, runtime, _dir) = app().await;
    assert_eq!(
        request(&app, Method::GET, "/api/config", &[], "").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/config?access_token=secret",
            &[],
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/config?access_token=secret",
            &[("authorization", "Bearer wrong")],
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/config",
            &[("cookie", "codesesh_access_token=secret")],
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let auth = [("authorization", "Bearer secret")];
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/config",
            &[
                ("authorization", "Bearer secret"),
                ("origin", "http://evil.test")
            ],
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/config",
            &[
                ("authorization", "Bearer secret"),
                ("sec-fetch-site", "cross-site")
            ],
            ""
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, Method::PUT, "/api/bookmarks", &auth, "{}")
            .await
            .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/api/bookmarks?access_token=secret",
            &[("content-type", "application/json")],
            "{}"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let write = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/api/bookmarks",
            &write,
            &" ".repeat(1024 * 1024 + 1)
        )
        .await
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    runtime.shutdown().await.unwrap();
}
#[tokio::test]
async fn bookmarks_resolve_only_requested_source_qualified_sessions() {
    let (app, runtime, _dir) = app().await;
    runtime.hub_control(|cache| {
        for (node, id, title, publication) in [
            ("local", "shared", "Local title", None),
            ("worker-a", "shared", "Remote title", None),
            ("local", "pending", "Pending title", Some("staging")),
            ("local", "unrelated", "Unrelated title", None),
        ] {
            cache.connection().execute("INSERT INTO sessions(source_node_id,agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost,publication_id,head_meta_json)
                VALUES(?,'codex',?,?,'/fixture','path','/fixture','fixture',1,1,1,0,0,0,0,?,?)", (node,id,title,publication,if id == "unrelated" { "invalid-json" } else { "{}" }))?;
        }
        Ok(())
    }).await.unwrap();
    let write = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];
    for reference in [
        json!({"agentName":"codex","sessionId":"shared"}),
        json!({"sourceNodeId":"worker-a","agentName":"codex","sessionId":"shared"}),
        json!({"agentName":"codex","sessionId":"pending"}),
        json!({"agentName":"codex","sessionId":"missing"}),
    ] {
        assert_eq!(
            request(
                &app,
                Method::PUT,
                "/api/bookmarks",
                &write,
                &json!({"reference":reference}).to_string()
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    let (status, body) = request(&app, Method::GET, "/api/bookmarks", &write, "").await;
    assert_eq!(status, StatusCode::OK);
    let views = body["bookmarks"].as_array().unwrap();
    assert_eq!(views.len(), 4);
    for (node, title) in [("local", "Local title"), ("worker-a", "Remote title")] {
        let view = views
            .iter()
            .find(|view| {
                view["reference"]["sessionId"] == "shared"
                    && view["reference"]["sourceNodeId"]
                        .as_str()
                        .unwrap_or("local")
                        == node
            })
            .unwrap();
        assert_eq!(view["availability"], "available");
        assert_eq!(view["session"]["title"], title);
    }
    for id in ["pending", "missing"] {
        let view = views
            .iter()
            .find(|view| view["reference"]["sessionId"] == id)
            .unwrap();
        assert_eq!(view["availability"], "session-unavailable");
    }
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn worker_credentials_are_separate_and_compatibility_blocks_upload() {
    let (app, runtime, _dir) = app_mode(true).await;
    let admin = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];
    let (status, token) =
        request(&app, Method::POST, "/api/nodes/pairing-token", &admin, "{}").await;
    assert_eq!(status, StatusCode::OK);
    let hello = json!({"version":env!("CARGO_PKG_VERSION"),"protocolVersion":1,"payloadVersion":1,"streamId":uuid::Uuid::new_v4().to_string(),"queue":{"batches":0,"bytes":0,"oldestAt":null}});
    let pair = json!({"token":token["token"],"name":"Test worker","hello":hello});
    let (status, grant) = request(
        &app,
        Method::POST,
        "/api/worker/pair",
        &[("content-type", "application/json")],
        &pair.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{grant}");
    let credential = format!("Bearer {}", grant["credential"].as_str().unwrap());
    let headers = [
        ("authorization", credential.as_str()),
        (
            "x-codesesh-worker-instance",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        ("content-type", "application/json"),
    ];
    assert_eq!(
        request(&app, Method::GET, "/api/sessions", &headers, "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/worker/hello",
            &admin,
            &hello.to_string()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, result) = request(
        &app,
        Method::POST,
        "/api/worker/hello",
        &headers,
        &hello.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(result["error"].is_null());
    let mut newer = hello.clone();
    newer["version"] = json!("999.0.0");
    let (_, result) = request(
        &app,
        Method::POST,
        "/api/worker/hello",
        &headers,
        &newer.to_string(),
    )
    .await;
    assert_eq!(result["error"], "WORKER_TOO_NEW");
    let upload = json!({"epoch":grant["epoch"],"streamId":hello["streamId"],"sequence":1,"payloadVersion":1,"digest":"invalid","operation":{"type":"snapshot-chunk","transfer_id":uuid::Uuid::new_v4().to_string(),"index":0,"data":"eA=="}});
    let (status, result) = request(
        &app,
        Method::POST,
        "/api/worker/upload",
        &[
            ("authorization", credential.as_str()),
            (
                "x-codesesh-worker-instance",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ),
            ("content-type", "application/json"),
            ("x-codesesh-worker-version", "999.0.0"),
            ("x-codesesh-protocol-version", "1"),
        ],
        &upload.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(result["error"], "WORKER_TOO_NEW");
    assert_eq!(
        request(&app, Method::POST, "/api/worker/goodbye", &admin, "")
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let mut replacement = headers;
    replacement[1].1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    assert_eq!(
        request(&app, Method::POST, "/api/worker/goodbye", &replacement, "")
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    let mut conflict = Request::builder()
        .method(Method::POST)
        .uri("/api/worker/hello")
        .header("host", "localhost:4521");
    for (key, value) in replacement {
        conflict = conflict.header(key, value);
    }
    let conflict = app
        .clone()
        .oneshot(conflict.body(Body::from(hello.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(conflict.headers()["retry-after"], "2");
    assert_eq!(
        request(&app, Method::POST, "/api/worker/goodbye", &headers, "")
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/worker/hello",
            &replacement,
            &hello.to_string()
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, Method::POST, "/api/worker/goodbye", &headers, "")
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/worker/hello",
            &headers,
            &hello.to_string()
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let path = format!("/api/nodes/{}/revoke", grant["nodeId"].as_str().unwrap());
    assert_eq!(
        request(&app, Method::POST, &path, &admin, "{}").await.0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/api/worker/hello",
            &headers,
            &hello.to_string()
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn worker_authentication_interrupted_by_hub_shutdown_can_retry() {
    let (app, runtime, _dir) = app_mode(true).await;
    let stream = uuid::Uuid::new_v4();
    let credential = runtime
        .hub_control(move |cache| {
            let token = cache.create_pairing_token()?;
            Ok(cache
                .pair_worker(&token, "worker", "1.1.1", &stream.to_string())?
                .credential)
        })
        .await
        .unwrap();
    let bearer = format!("Bearer {credential}");
    let headers = [
        ("authorization", bearer.as_str()),
        (
            "x-codesesh-worker-instance",
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        ),
        ("content-type", "application/json"),
    ];
    let hello = json!({
        "version": env!("CARGO_PKG_VERSION"), "protocolVersion": 1, "payloadVersion": 1,
        "streamId": stream.to_string(), "queue": {"batches": 0, "bytes": 0, "oldestAt": null}
    })
    .to_string();
    let (release, held) = std::sync::mpsc::channel();
    // Hold the writer so the hello is accepted but loses its reply when shutdown runs.
    let (write, shutdown, (status, _), ()) = tokio::join!(
        biased;
        runtime.hub_control(move |_| Ok(held.recv()?)),
        runtime.shutdown(),
        request(&app, Method::POST, "/api/worker/hello", &headers, &hello),
        async { release.send(()).unwrap() },
    );
    write.unwrap();
    shutdown.unwrap();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn fingerprinted_assets_are_cached_and_compressed() {
    let Some((_, index)) = crate::assets::lookup("index.html") else {
        return;
    };
    let index = String::from_utf8_lossy(index);
    let script = index
        .split("src=\"")
        .filter_map(|part| part.split('"').next())
        .find(|path| path.starts_with("/assets/") && path.ends_with(".js"))
        .unwrap()
        .to_owned();
    let (app, runtime, _dir) = app_options(false, None).await;
    for (path, cache_control) in [
        (script.as_str(), Some("public, max-age=31536000, immutable")),
        ("/assets/missing.js", None),
        ("/", None),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::get(path)
                    .header("host", "localhost:4521")
                    .header("accept-encoding", "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response
                .headers()
                .get("cache-control")
                .map(|value| value.to_str().unwrap()),
            cache_control,
            "{path}"
        );
        assert_eq!(response.headers()["content-encoding"], "gzip", "{path}");
    }
    runtime.shutdown().await.unwrap();
}

fn codex_fixture_session(
    dir: &std::path::Path,
    id_suffix: &str,
    model: &str,
    input_tokens: u64,
    output_tokens: u64,
    base: i64,
    pricing: &codesesh_core::pricing::Pricing,
) -> codesesh_core::agents::ParsedSession {
    let source = dir.join(format!(
        "rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-{id_suffix}.jsonl"
    ));
    let lines = [
        serde_json::json!({
            "type": "session_meta",
            "timestamp": base,
            "payload": { "cwd": "/work", "model": model }
        }),
        serde_json::json!({
            "type": "response_item",
            "timestamp": base + 1000,
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "Compute pricing" }]
            }
        }),
        serde_json::json!({
            "type": "event_msg",
            "timestamp": base + 2000,
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens
                    },
                    "total_token_usage": {
                        "total_tokens": input_tokens + output_tokens,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens
                    }
                }
            }
        }),
        serde_json::json!({
            "type": "response_item",
            "timestamp": base + 3000,
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Done" }]
            }
        }),
    ];
    let content = lines
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<String>();
    std::fs::write(&source, content).unwrap();
    let detail = codesesh_core::agents::parse_codex(&source, &Default::default(), pricing)
        .unwrap()
        .expect("fixture session should parse");
    codesesh_core::agents::ParsedSession {
        head: detail.head.clone(),
        source,
        detail,
    }
}

async fn pair_test_worker(
    app: &Router,
    worker_dir: &std::path::Path,
    name: &str,
) -> (
    codesesh_core::sync::WorkerStore,
    codesesh_core::sync::PairingGrant,
) {
    let admin = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];
    let worker = codesesh_core::sync::WorkerStore::open(&worker_dir.join("worker.db")).unwrap();
    let (status, token) =
        request(app, Method::POST, "/api/nodes/pairing-token", &admin, "{}").await;
    assert_eq!(status, StatusCode::OK);
    let hello = json!({
        "version": env!("CARGO_PKG_VERSION"),
        "protocolVersion": 1,
        "payloadVersion": 1,
        "streamId": worker.stream_id().unwrap(),
        "queue": { "batches": 0, "bytes": 0, "oldestAt": null }
    });
    let pair = json!({ "token": token["token"], "name": name, "hello": hello });
    let (status, grant_json) = request(
        app,
        Method::POST,
        "/api/worker/pair",
        &[("content-type", "application/json")],
        &pair.to_string(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{grant_json}");
    let grant: codesesh_core::sync::PairingGrant = serde_json::from_value(grant_json).unwrap();
    (worker, grant)
}

async fn pricing_app(
    sessions: &[(&str, &str, u64, u64)],
    saved: Option<StateStore>,
    hub: bool,
) -> (
    Router,
    codesesh_core::runtime::Runtime,
    codesesh_core::pricing::PricingController,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let pricing = codesesh_core::pricing::PricingController::load(dir.path());
    let cache_path = dir.path().join("cache.db");
    if !sessions.is_empty() {
        let current_pricing = pricing.snapshot().unwrap().pricing;
        let now = chrono::Utc::now().timestamp_millis();
        let mut parsed = Vec::with_capacity(sessions.len());
        for (index, (id_suffix, model, input_tokens, output_tokens)) in sessions.iter().enumerate()
        {
            let base = now - ((index as i64) + 1) * 10_000;
            parsed.push(codex_fixture_session(
                dir.path(),
                id_suffix,
                model,
                *input_tokens,
                *output_tokens,
                base,
                &current_pricing,
            ));
        }
        let mut cache = codesesh_core::storage::Cache::open(Some(&cache_path)).unwrap();
        cache.publish(&mut parsed).unwrap();
    }
    let runtime = if hub {
        let runtime = codesesh_core::runtime::Runtime::start_hub(cache_path, vec![], 1)
            .await
            .unwrap();
        runtime
            .hub_control(|cache| cache.initialize_hub("fixture-hub"))
            .await
            .unwrap();
        runtime
    } else {
        codesesh_core::runtime::Runtime::start(cache_path, vec![], 1)
            .await
            .unwrap()
    };
    let options = Options {
        token: Some("secret".into()),
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
    };
    let mut state = State::new(runtime.clone(), pricing.clone(), saved, options);
    if hub {
        state = state.with_hub();
    }
    (router(Arc::new(state)), runtime, pricing, dir)
}

async fn wait_for_repricing(runtime: &codesesh_core::runtime::Runtime, generation: u64) {
    let mut statuses = runtime.statuses();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        statuses.wait_for(|status| {
            status.pricing_history.as_ref().is_some_and(|history| {
                history.generation == generation
                    && history.phase == codesesh_core::wire::PricingHistoryPhase::Current
            })
        }),
    )
    .await
    .expect("background pricing history reprice should complete")
    .unwrap();
}

#[tokio::test]
async fn pricing_routes_enforce_mode_storage_and_validation() {
    let auth = [("authorization", "Bearer secret")];
    let json_auth = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];

    let (hub_app, hub_runtime, hub_pricing, _hub_dir) =
        pricing_app(&[], Some(StateStore::memory().unwrap()), true).await;
    for (method, path, body) in [
        (Method::GET, "/api/pricing/overrides", ""),
        (Method::GET, "/api/pricing/unmatched", ""),
        (Method::GET, "/api/pricing/models", ""),
        (
            Method::PUT,
            "/api/pricing/overrides",
            r#"{"model":"acme/test","kind":"manual","rates":{"input":1.0,"output":2.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
        ),
        (
            Method::POST,
            "/api/pricing/overrides/acknowledge",
            r#"{"model":"gpt-5"}"#,
        ),
        (
            Method::POST,
            "/api/pricing/overrides/delete",
            r#"{"model":"acme/test"}"#,
        ),
    ] {
        let headers: &[(&str, &str)] = if method == Method::GET {
            &[]
        } else {
            &[("content-type", "application/json")]
        };
        let (status, _) = request(&hub_app, method, path, headers, body).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
    }

    for path in ["/api/pricing/overrides", "/api/pricing/unmatched"] {
        let (status, _) = request(&hub_app, Method::GET, path, &auth, "").await;
        assert_eq!(status, StatusCode::OK, "{path}");
    }
    let (status, hub_models) = request(
        &hub_app,
        Method::GET,
        "/api/pricing/models?q=gpt-5",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!hub_models["models"].as_array().unwrap().is_empty());

    let worker_a_dir = tempfile::tempdir().unwrap();
    let (mut worker_a, grant_a) = pair_test_worker(&hub_app, worker_a_dir.path(), "Worker A").await;
    let now = chrono::Utc::now().timestamp_millis();
    let mut batch_a = codesesh_core::runtime::ScanBatch {
        source_presence: None,
        sessions: vec![codex_fixture_session(
            worker_a_dir.path(),
            "000000000011",
            "acme/hub-worker-v1",
            1_000_000,
            500_000,
            now - 20_000,
            &codesesh_core::pricing::Pricing::bundled(),
        )],
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        completion: None,
        on_reject: None,
        pricing: None,
    };
    worker_a.save_batch("codex", &mut batch_a).unwrap();
    while let Some(pending) = worker_a.next_upload().unwrap() {
        let upload = codesesh_core::sync::Upload {
            epoch: grant_a.epoch.clone(),
            stream_id: worker_a.stream_id().unwrap(),
            sequence: pending.sequence,
            payload_version: pending.payload_version,
            digest: pending.digest,
            operation: pending.operation,
        };
        let worker_auth = format!("Bearer {}", grant_a.credential);
        let (status, receipt_json) = request(
            &hub_app,
            Method::POST,
            "/api/worker/upload",
            &[
                ("authorization", worker_auth.as_str()),
                (
                    "x-codesesh-worker-instance",
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                ),
                ("content-type", "application/json"),
                ("x-codesesh-worker-version", env!("CARGO_PKG_VERSION")),
                ("x-codesesh-protocol-version", "1"),
            ],
            &serde_json::to_string(&upload).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{receipt_json}");
        let receipt: codesesh_core::sync::Receipt = serde_json::from_value(receipt_json).unwrap();
        worker_a
            .acknowledge(&receipt.stream_id, receipt.sequence, &receipt.digest)
            .unwrap();
    }

    let (status, hub_unmatched) = request(
        &hub_app,
        Method::GET,
        "/api/pricing/unmatched?days=0",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        hub_unmatched["unmatchedModels"][0]["modelKey"],
        "acme/hub-worker-v1"
    );

    let stale_pricing = hub_pricing.snapshot().unwrap();
    let (status, put_resp) = request(
        &hub_app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"acme/hub-worker-v1","kind":"manual","rates":{"input":2.0,"output":10.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(put_resp["overrides"][0]["modelKey"], "acme/hub-worker-v1");
    assert_ne!(stale_pricing.generation(), hub_pricing.generation());
    let (status, hub_unmatched) = request(
        &hub_app,
        Method::GET,
        "/api/pricing/unmatched?days=0",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        hub_unmatched["unmatchedModels"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    wait_for_repricing(&hub_runtime, hub_pricing.generation()).await;

    let (status, sessions_json) =
        request(&hub_app, Method::GET, "/api/sessions?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        sessions_json["sessions"][0]["reference"]["sourceNodeId"],
        grant_a.node_id
    );
    assert!(
        (sessions_json["sessions"][0]["stats"]["total_cost"]
            .as_f64()
            .unwrap()
            - 7.0)
            .abs()
            < 1e-6
    );
    assert_eq!(
        sessions_json["sessions"][0]["stats"]["cost_source"],
        "estimated"
    );

    let worker_b_dir = tempfile::tempdir().unwrap();
    let (mut worker_b, grant_b) = pair_test_worker(&hub_app, worker_b_dir.path(), "Worker B").await;
    let mut batch_b = codesesh_core::runtime::ScanBatch {
        source_presence: None,
        sessions: vec![codex_fixture_session(
            worker_b_dir.path(),
            "000000000012",
            "acme/hub-worker-v1",
            2_000_000,
            0,
            now - 10_000,
            &codesesh_core::pricing::Pricing::bundled(),
        )],
        removed: Vec::new(),
        checkpoint: None,
        complete: true,
        completion: None,
        on_reject: None,
        pricing: None,
    };
    worker_b.save_batch("codex", &mut batch_b).unwrap();
    while let Some(pending) = worker_b.next_upload().unwrap() {
        let upload = codesesh_core::sync::Upload {
            epoch: grant_b.epoch.clone(),
            stream_id: worker_b.stream_id().unwrap(),
            sequence: pending.sequence,
            payload_version: pending.payload_version,
            digest: pending.digest,
            operation: pending.operation,
        };
        let receipt = hub_runtime
            .receive_upload(grant_b.credential.clone(), upload, stale_pricing.clone())
            .await
            .expect("stale pricing snapshot upload must not fail with generation conflict");
        worker_b
            .acknowledge(&receipt.stream_id, receipt.sequence, &receipt.digest)
            .unwrap();
    }

    let (status, dashboard) =
        request(&hub_app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!((dashboard["totals"]["cost"].as_f64().unwrap() - 11.0).abs() < 1e-6);

    let (status, _) = request(
        &hub_app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"acme/hub-worker-v1","kind":"manual","rates":{"input":3.0,"output":10.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    wait_for_repricing(&hub_runtime, hub_pricing.generation()).await;
    let (status, sessions_json) =
        request(&hub_app, Method::GET, "/api/sessions?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    let sessions = sessions_json["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    for (node_id, expected_cost) in [
        (grant_a.node_id.as_str(), 8.0),
        (grant_b.node_id.as_str(), 6.0),
    ] {
        let session = sessions
            .iter()
            .find(|entry| entry["reference"]["sourceNodeId"] == node_id)
            .expect("uploaded worker session present");
        assert!((session["stats"]["total_cost"].as_f64().unwrap() - expected_cost).abs() < 1e-6);
    }

    hub_runtime.shutdown().await.unwrap();

    let (no_saved_app, no_saved_runtime, _, _no_saved_dir) = pricing_app(&[], None, false).await;
    let (status, _) = request(
        &no_saved_app,
        Method::GET,
        "/api/pricing/overrides",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for (method, path, body) in [
        (
            Method::PUT,
            "/api/pricing/overrides",
            r#"{"model":"acme/test","kind":"manual","rates":{"input":1.0,"output":2.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
        ),
        (
            Method::POST,
            "/api/pricing/overrides/acknowledge",
            r#"{"model":"gpt-5"}"#,
        ),
        (
            Method::POST,
            "/api/pricing/overrides/delete",
            r#"{"model":"acme/test"}"#,
        ),
    ] {
        let (status, _) = request(&no_saved_app, method, path, &json_auth, body).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
    }
    no_saved_runtime.shutdown().await.unwrap();

    let (app, runtime, _, _dir) =
        pricing_app(&[], Some(StateStore::memory().unwrap()), false).await;
    let (status, _) = request(&app, Method::GET, "/api/pricing/models?limit=0", &auth, "").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, models) = request(
        &app,
        Method::GET,
        "/api/pricing/models?q=gpt-5&limit=500",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let model_entries = models["models"].as_array().unwrap();
    assert!(!model_entries.is_empty() && model_entries.len() <= 200);

    for invalid_payload in [
        r#"{"model":"   ","kind":"manual","rates":{"input":1.0,"output":2.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
        r#"{"model":"acme/test","kind":"remap","targetModel":"no-such-official-model"}"#,
        r#"{"model":"acme/test","kind":"remap","targetModel":"acme/test"}"#,
        r#"{"model":"acme/test","kind":"manual"}"#,
        r#"{"model":"acme/test","kind":"manual","rates":{"input":-0.1,"output":2.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
        r#"{"model":"acme/test","kind":"manual","rates":{"input":1000000.1,"output":2.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    ] {
        let (status, _) = request(
            &app,
            Method::PUT,
            "/api/pricing/overrides",
            &json_auth,
            invalid_payload,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{invalid_payload}");
    }

    let (status, _) = request(
        &app,
        Method::POST,
        "/api/pricing/overrides/acknowledge",
        &json_auth,
        r#"{"model":"acme/no-official"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = request(
        &app,
        Method::POST,
        "/api/pricing/overrides/acknowledge",
        &json_auth,
        r#"{"model":"gpt-5"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = request(
        &app,
        Method::POST,
        "/api/pricing/overrides/delete",
        &json_auth,
        r#"{"model":"acme/missing"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn pricing_override_lifecycle_reprices_dashboard_and_handles_official_release() {
    let auth = [("authorization", "Bearer secret")];
    let json_auth = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];
    let (app, runtime, pricing, _dir) = pricing_app(
        &[("000000000001", "acme/unmatched-v1", 1_000_000, 500_000)],
        Some(StateStore::memory().unwrap()),
        false,
    )
    .await;

    let (status, overrides) = request(&app, Method::GET, "/api/pricing/overrides", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(overrides["overrides"].as_array().unwrap().len(), 0);
    let (status, unmatched) = request(
        &app,
        Method::GET,
        "/api/pricing/unmatched?days=0",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let unmatched = unmatched["unmatchedModels"].as_array().unwrap();
    assert_eq!(unmatched.len(), 1);
    assert_eq!(unmatched[0]["modelKey"], "acme/unmatched-v1");
    assert_eq!(unmatched[0]["displayModel"], "acme/unmatched-v1");
    assert_eq!(unmatched[0]["sessionCount"], 1);
    assert_eq!(unmatched[0]["inputTokens"], 1_000_000.0);
    assert_eq!(unmatched[0]["outputTokens"], 500_000.0);

    let (status, dashboard) = request(&app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dashboard["totals"]["cost"], 0.0);

    let (status, zero_resp) = request(
        &app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"acme/unmatched-v1","kind":"manual","rates":{"input":0.0,"output":0.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(zero_resp["overrides"].as_array().unwrap().len(), 1);
    let (status, unmatched) = request(
        &app,
        Method::GET,
        "/api/pricing/unmatched?days=0",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(unmatched["unmatchedModels"].as_array().unwrap().len(), 0);
    wait_for_repricing(&runtime, pricing.generation()).await;
    let (status, sessions_json) =
        request(&app, Method::GET, "/api/sessions?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(sessions_json["sessions"][0]["stats"]["total_cost"], 0.0);
    assert_eq!(
        sessions_json["sessions"][0]["stats"]["cost_source"],
        "estimated"
    );

    let (status, _) = request(
        &app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"acme/unmatched-v1","kind":"manual","rates":{"input":2.0,"output":10.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    wait_for_repricing(&runtime, pricing.generation()).await;
    let (status, dashboard) = request(&app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!((dashboard["totals"]["cost"].as_f64().unwrap() - 7.0).abs() < 1e-6);

    let (status, models) = request(
        &app,
        Method::GET,
        "/api/pricing/models?q=gpt-5&limit=50",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let gpt5 = models["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["model"] == "gpt-5")
        .expect("gpt-5 bundled official rate")
        .clone();
    let expected_gpt5_cost = gpt5["rates"]["input"].as_f64().unwrap() * 1.0
        + gpt5["rates"]["output"].as_f64().unwrap() * 0.5;
    let (status, _) = request(
        &app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"acme/unmatched-v1","kind":"remap","targetModel":"gpt-5"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    wait_for_repricing(&runtime, pricing.generation()).await;
    let (status, dashboard) = request(&app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!((dashboard["totals"]["cost"].as_f64().unwrap() - expected_gpt5_cost).abs() < 1e-6);

    let (status, official_override) = request(
        &app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"gpt-5","kind":"manual","rates":{"input":3.0,"output":6.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let gpt5_entry = official_override["overrides"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["modelKey"] == "gpt-5")
        .unwrap();
    assert_eq!(gpt5_entry["officialPriceAvailable"], false);

    let (status, official_edit) = request(
        &app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"gpt-5","kind":"manual","rates":{"input":4.0,"output":8.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let gpt5_edited = official_edit["overrides"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["modelKey"] == "gpt-5")
        .unwrap();
    assert_eq!(gpt5_edited["officialPriceAvailable"], false);

    let (status, _) = request(
        &app,
        Method::POST,
        "/api/pricing/overrides/delete",
        &json_auth,
        r#"{"model":"gpt-5"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = request(
        &app,
        Method::PUT,
        "/api/pricing/overrides",
        &json_auth,
        r#"{"model":"acme/unmatched-v1","kind":"manual","rates":{"input":2.0,"output":10.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    wait_for_repricing(&runtime, pricing.generation()).await;

    assert!(
        pricing
            .stage_remote(&serde_json::json!({
                "openai": {
                    "models": {
                        "gpt-5": { "cost": { "input": 1.25, "output": 10.0 } },
                        "acme/unmatched-v1": { "cost": { "input": 5.0, "output": 20.0 } }
                    }
                }
            }))
            .unwrap()
    );
    pricing.publish_pending().unwrap();

    let (status, listed) = request(&app, Method::GET, "/api/pricing/overrides", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["overrides"][0]["officialPriceAvailable"], true);
    assert_eq!(listed["overrides"][0]["effectiveRates"]["input"], 2.0);
    assert_eq!(listed["overrides"][0]["effectiveRates"]["output"], 10.0);

    let (status, acked) = request(
        &app,
        Method::POST,
        "/api/pricing/overrides/acknowledge",
        &json_auth,
        r#"{"model":"acme/unmatched-v1"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(acked["overrides"][0]["officialPriceAvailable"], false);
    assert_eq!(acked["overrides"][0]["effectiveRates"]["input"], 2.0);
    let (status, dashboard) = request(&app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!((dashboard["totals"]["cost"].as_f64().unwrap() - 7.0).abs() < 1e-6);

    assert!(
        pricing
            .stage_remote(&serde_json::json!({
                "openai": {
                    "models": {
                        "gpt-5": { "cost": { "input": 1.25, "output": 10.0 } },
                        "acme/unmatched-v1": { "cost": { "input": 6.0, "output": 24.0 } }
                    }
                }
            }))
            .unwrap()
    );
    pricing.publish_pending().unwrap();

    let (status, deleted) = request(
        &app,
        Method::POST,
        "/api/pricing/overrides/delete",
        &json_auth,
        r#"{"model":"acme/unmatched-v1"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["overrides"].as_array().unwrap().len(), 0);
    let (status, unmatched) = request(
        &app,
        Method::GET,
        "/api/pricing/unmatched?days=0",
        &auth,
        "",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(unmatched["unmatchedModels"].as_array().unwrap().len(), 0);
    wait_for_repricing(&runtime, pricing.generation()).await;

    let (status, dashboard) = request(&app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!((dashboard["totals"]["cost"].as_f64().unwrap() - 18.0).abs() < 1e-6);

    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn pricing_override_save_and_delete_reprice_in_background_without_blocking_http() {
    let auth = [("authorization", "Bearer secret")];
    let json_auth = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];
    let (app, runtime, pricing, _dir) = pricing_app(
        &[("000000000021", "acme/bg-reprice-v1", 1_000_000, 500_000)],
        Some(StateStore::memory().unwrap()),
        false,
    )
    .await;

    let before_generation = pricing.generation();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let hold_runtime = runtime.clone();
    let hold_task = tokio::spawn(async move {
        hold_runtime
            .hub_control(move |_| {
                let _ = entered_tx.send(());
                release_rx.recv().map_err(Into::into)
            })
            .await
    });
    entered_rx.await.unwrap();

    let (status, saved) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        request(
            &app,
            Method::PUT,
            "/api/pricing/overrides",
            &json_auth,
            r#"{"model":"acme/bg-reprice-v1","kind":"manual","rates":{"input":2.0,"output":10.0,"cacheRead":0.0,"cacheWrite":0.0}}"#,
        ),
    )
    .await
    .expect("PUT /api/pricing/overrides must not block on runtime writer");
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["overrides"][0]["modelKey"], "acme/bg-reprice-v1");
    let saved_generation = pricing.generation();
    assert_ne!(saved_generation, before_generation);

    release_tx.send(()).unwrap();
    hold_task.await.unwrap().unwrap();
    wait_for_repricing(&runtime, saved_generation).await;
    let (status, dashboard) = request(&app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert!((dashboard["totals"]["cost"].as_f64().unwrap() - 7.0).abs() < 1e-6);

    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let hold_runtime = runtime.clone();
    let hold_task = tokio::spawn(async move {
        hold_runtime
            .hub_control(move |_| {
                let _ = entered_tx.send(());
                release_rx.recv().map_err(Into::into)
            })
            .await
    });
    entered_rx.await.unwrap();

    let (status, deleted) = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        request(
            &app,
            Method::POST,
            "/api/pricing/overrides/delete",
            &json_auth,
            r#"{"model":"acme/bg-reprice-v1"}"#,
        ),
    )
    .await
    .expect("POST /api/pricing/overrides/delete must not block on runtime writer");
    assert_eq!(status, StatusCode::OK);
    assert!(deleted["overrides"].as_array().unwrap().is_empty());
    let deleted_generation = pricing.generation();
    assert_ne!(deleted_generation, saved_generation);

    release_tx.send(()).unwrap();
    hold_task.await.unwrap().unwrap();
    wait_for_repricing(&runtime, deleted_generation).await;
    let (status, dashboard) = request(&app, Method::GET, "/api/dashboard?days=0", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(dashboard["totals"]["cost"], 0.0);

    runtime.shutdown().await.unwrap();
}
