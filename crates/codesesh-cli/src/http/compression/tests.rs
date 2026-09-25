use super::*;
use axum::{Router, body::to_bytes, routing::get};
use std::io::Read;
use tower::ServiceExt;

async fn request(
    accept: Option<&str>,
    method: Method,
    headers: &[(&str, &str)],
    status: StatusCode,
) -> Response {
    let mut extra = axum::http::HeaderMap::new();
    for (key, value) in headers {
        extra.insert(
            header::HeaderName::from_bytes(key.as_bytes()).unwrap(),
            value.parse().unwrap(),
        );
    }
    let app = Router::new()
        .route(
            "/api/data",
            get(move || {
                let extra = extra.clone();
                async move {
                    let mut response = Response::builder()
                        .status(status)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(format!(
                            "{{\"message\":\"{}\"}}",
                            "中文abcdef".repeat(2000)
                        )))
                        .unwrap();
                    response.headers_mut().extend(extra);
                    response
                }
            }),
        )
        .layer(axum::middleware::from_fn(middleware));
    let mut request = Request::builder().uri("/api/data").method(method);
    if let Some(accept) = accept {
        request = request.header(header::ACCEPT_ENCODING, accept);
    }
    app.oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn gzip_and_deflate_streams_preserve_json_and_weaken_etags() {
    for encoding in ["gzip", "deflate"] {
        let response = request(
            Some(encoding),
            Method::GET,
            &[("etag", "\"known\""), ("content-length", "28014")],
            StatusCode::OK,
        )
        .await;
        assert_eq!(response.headers()[header::CONTENT_ENCODING], encoding);
        assert_eq!(response.headers()[header::VARY], "Accept-Encoding");
        assert_eq!(response.headers()[header::ETAG], "W/\"known\"");
        assert!(!response.headers().contains_key(header::CONTENT_LENGTH));
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let mut decoded = String::new();
        if encoding == "gzip" {
            flate2::read::GzDecoder::new(bytes.as_ref())
                .read_to_string(&mut decoded)
                .unwrap();
        } else {
            flate2::read::ZlibDecoder::new(bytes.as_ref())
                .read_to_string(&mut decoded)
                .unwrap();
        }
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&decoded).unwrap()["message"],
            "中文abcdef".repeat(2000)
        );
    }
}

#[test]
fn negotiation_matches_hono_candidate_priority_and_q_values() {
    for (accept, expected) in [
        ("gzip", Some("gzip")),
        ("br", None),
        ("identity", None),
        ("", None),
        ("deflate,gzip", Some("gzip")),
        ("gzip;q=0.2,deflate;q=0.9", Some("deflate")),
        ("gzip;q=0,*;q=1", Some("deflate")),
        ("*;q=0", None),
        ("gzip;q=0,deflate;q=0", None),
        ("GZIP;Q=0.5", Some("gzip")),
        ("gzip;q=0,gzip;q=0.8", Some("gzip")),
        ("gzip;q=\"0.3\",deflate;q=0.2", Some("gzip")),
        ("gzip;q=NaN", None),
        ("gzip;q=invalid", Some("gzip")),
        ("gzip;q=0.1,identity;q=1", Some("gzip")),
    ] {
        assert_eq!(select_encoding(accept), expected, "{accept}");
    }
}

#[tokio::test]
async fn identity_head_sse_and_transform_guards_preserve_responses() {
    for accept in [
        None,
        Some("identity"),
        Some("br"),
        Some("gzip;q=0,deflate;q=0"),
    ] {
        let response = request(accept, Method::GET, &[], StatusCode::OK).await;
        assert!(!response.headers().contains_key(header::CONTENT_ENCODING));
        assert_eq!(response.headers()[header::VARY], "Accept-Encoding");
    }
    for (method, headers, status) in [
        (Method::HEAD, vec![], StatusCode::OK),
        (
            Method::GET,
            vec![("content-type", "text/event-stream; charset=utf-8")],
            StatusCode::OK,
        ),
        (
            Method::GET,
            vec![("content-length", "1023")],
            StatusCode::OK,
        ),
        (
            Method::GET,
            vec![("cache-control", "private, NO-TRANSFORM")],
            StatusCode::OK,
        ),
        (
            Method::GET,
            vec![("content-encoding", "identity")],
            StatusCode::OK,
        ),
        (
            Method::GET,
            vec![("transfer-encoding", "chunked")],
            StatusCode::OK,
        ),
        (Method::GET, vec![], StatusCode::PARTIAL_CONTENT),
    ] {
        let response = request(Some("gzip"), method.clone(), &headers, status).await;
        assert_ne!(
            response
                .headers()
                .get(header::CONTENT_ENCODING)
                .and_then(|v| v.to_str().ok()),
            Some("gzip")
        );
        assert!(!response.headers().contains_key(header::VARY));
        if method == Method::HEAD {
            assert!(
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
    }
    let response = request(
        Some("gzip"),
        Method::GET,
        &[("content-length", "1024"), ("vary", "Origin")],
        StatusCode::OK,
    )
    .await;
    assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
    assert_eq!(response.headers()[header::VARY], "Origin, Accept-Encoding");
}
