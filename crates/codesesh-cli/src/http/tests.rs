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
async fn state_payload_and_query_errors_match_contract() {
    let (app, runtime, _dir) = app().await;
    let write = [
        ("authorization", "Bearer secret"),
        ("content-type", "application/json"),
    ];
    let auth = [("authorization", "Bearer secret")];
    let (status, body) = request(
        &app,
        Method::PUT,
        "/api/bookmarks",
        &write,
        r#"{"reference":{"agentName":" CoDeX ","sessionId":"opaque/id"}}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bookmark"]["reference"]["agentName"], "codex");
    let (status, body) = request(&app, Method::GET, "/api/bookmarks", &auth, "").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["bookmarks"][0]["availability"], "session-unavailable");
    assert_eq!(
        request(
            &app,
            Method::PUT,
            "/api/session-aliases/codex/opaque",
            &write,
            r#"{"alias":" "}"#
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, Method::GET, "/api/sessions?limit=0", &auth, "")
            .await
            .1,
        json!({"error":"limit must be a positive integer"})
    );
    assert_eq!(
        request(&app, Method::GET, "/api/sessions?from=invalid", &auth, "")
            .await
            .1,
        json!({"error":"from must be a valid date"})
    );
    assert_eq!(
        request(&app, Method::GET, "/api/sessions?cursor=broken", &auth, "")
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/sessions/no-such-agent/missing",
            &auth,
            ""
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/search?agent=no-such-agent",
            &auth,
            ""
        )
        .await
        .1,
        json!({"results":[]})
    );
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn sse_budget_is_released_when_response_is_dropped() {
    let (app, runtime, _dir) = app().await;
    let mut streams = Vec::new();
    for _ in 0..32 {
        let request = Request::builder()
            .uri("/api/events")
            .header("host", "localhost:4521")
            .header("authorization", "Bearer secret")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        streams.push(response);
    }
    assert_eq!(
        request(
            &app,
            Method::GET,
            "/api/events",
            &[("authorization", "Bearer secret")],
            ""
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
    streams.pop();
    let req = Request::builder()
        .uri("/api/events")
        .header("host", "localhost:4521")
        .header("authorization", "Bearer secret")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(req).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    drop(streams);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn remote_proxy_accepts_public_authority_but_requires_https() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Runtime::start(dir.path().join("cache.db"), vec![], 1)
        .await
        .unwrap();
    let app = router(Arc::new(State::new(
        runtime.clone(),
        codesesh_core::pricing::PricingController::load(dir.path()),
        None,
        Options {
            token: Some("secret".into()),
            hostname: "127.0.0.1".into(),
            port: 4521,
            tls: false,
            trust_proxy: true,
            public_origin: Some("https://codesesh.example.com".into()),
            loopback_authority: false,
            default_from: None,
            default_to: None,
            default_days: None,
            enabled_agents: vec!["codex".into()],
            cwd: None,
        },
    )));
    for (protocol, status) in [("https", StatusCode::OK), ("http", StatusCode::FORBIDDEN)] {
        let request = Request::builder()
            .uri("/api/agents")
            .header("host", "codesesh.example.com")
            .header("x-forwarded-proto", protocol)
            .header("authorization", "Bearer secret")
            .body(Body::empty())
            .unwrap();
        assert_eq!(app.clone().oneshot(request).await.unwrap().status(), status);
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
async fn session_message_limit_rejects_zero_oversized_and_invalid_pages() {
    let (app, runtime, _dir) = app().await;
    for limit in ["0", "201", "-1", "no", ""] {
        let (status, body) = request(
            &app,
            Method::GET,
            &format!("/api/sessions/codex/session?messageLimit={limit}"),
            &[("authorization", "Bearer secret")],
            "",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "messageLimit must be between 1 and 200");
    }
    runtime.shutdown().await.unwrap();
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
