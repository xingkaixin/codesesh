use super::*;
use axum::{
    body::{Body, to_bytes},
    http::{Method, Request},
};
use tower::ServiceExt;

async fn app() -> (Router, codesesh_core::runtime::Runtime, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let runtime = codesesh_core::runtime::Runtime::start(dir.path().join("cache.db"), vec![], 1)
        .await
        .unwrap();
    let options = Options {
        token: "secret".into(),
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
    };
    (
        router(Arc::new(State::new(
            runtime.clone(),
            Some(StateStore::memory().unwrap()),
            options,
        ))),
        runtime,
        dir,
    )
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
        None,
        Options {
            token: "secret".into(),
            hostname: "127.0.0.1".into(),
            port: 4521,
            tls: false,
            trust_proxy: true,
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
