use super::{State, error};
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State as AxumState},
    http::{Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::sync::Arc;
use subtle::ConstantTimeEq;

pub async fn guard(
    AxumState(state): AxumState<Arc<State>>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = std::time::Instant::now();
    let request_id = uuid::Uuid::new_v4().to_string();
    let operation_id = request
        .headers()
        .get("x-codesesh-operation-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.len() == 36 && uuid::Uuid::parse_str(v).is_ok())
        .map(str::to_owned);
    let context = if request.uri().path() == "/api/events" {
        crate::logging::LogContext::default()
    } else {
        crate::logging::LogContext {
            request_id: Some(request_id.clone()),
            operation_id,
            publication_id: None,
        }
    };
    let method = request.method().to_string();
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_else(|| "<unmatched>".into());
    let mut keys: Vec<_> = super::params::Params::new(request.uri().query())
        .pairs
        .into_iter()
        .map(|(key, _)| key)
        .filter(|k| {
            matches!(
                k.as_str(),
                "agent"
                    | "costMax"
                    | "costMin"
                    | "cursor"
                    | "cwd"
                    | "days"
                    | "fileActivity"
                    | "from"
                    | "kind"
                    | "limit"
                    | "messageCursor"
                    | "messageLimit"
                    | "path"
                    | "project"
                    | "projectKey"
                    | "projectKind"
                    | "q"
                    | "sessionId"
                    | "sourceNodeId"
                    | "tag"
                    | "to"
                    | "tool"
            )
        })
        .collect();
    keys.sort();
    keys.dedup();
    request.extensions_mut().insert(context.clone());
    let mut response = authorize(&state, request, next).await;
    let duration_ms = started.elapsed().as_millis();
    if let Some(logger) = crate::logging::current() {
        let keep_info = response.extensions().get::<KeepInfoLog>().is_some();
        let level = request_log_level(&route, response.status(), duration_ms, keep_info);
        logger.with_context(context).emit(
            level,
            "http.request",
            &serde_json::json!({
                "method": method,
                "route": route,
                "query_keys": keys,
                "status": response.status().as_u16(),
                "duration_ms": duration_ms,
            }),
        );
    }
    let headers = response.headers_mut();
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        (
            "content-security-policy",
            "default-src 'self';base-uri 'none';connect-src 'self';font-src 'self' data:;form-action 'self';frame-ancestors 'none';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' 'unsafe-inline'",
        ),
    ] {
        headers.insert(name, value.parse().unwrap());
    }
    headers.insert("x-codesesh-request-id", request_id.parse().unwrap());
    response
}

async fn authorize(state: &State, request: Request, next: Next) -> Response {
    if let Err((status, message)) = validate(state, &request) {
        return error(status, message);
    }
    if !request.uri().path().starts_with("/api/") {
        return next.run(request).await;
    }
    let (parts, body) = request.into_parts();
    let Ok(bytes) = to_bytes(body, 1024 * 1024).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large");
    };
    next.run(Request::from_parts(parts, Body::from(bytes)))
        .await
}

fn validate(state: &State, request: &Request) -> Result<(), (StatusCode, &'static str)> {
    let text = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let host = text("host").unwrap_or("");
    if state.options.loopback_authority
        && !valid_authority(
            request.headers().get_all(header::HOST).iter().count(),
            host,
            &state.options.hostname,
            state.options.port,
        )
    {
        return Err((StatusCode::FORBIDDEN, "Loopback request authority rejected"));
    }
    if !request.uri().path().starts_with("/api/") {
        return Ok(());
    }
    if state.options.trust_proxy
        && text("x-forwarded-proto")
            .and_then(|v| v.split(',').next())
            .map(|v| v.trim().to_lowercase())
            .as_deref()
            != Some("https")
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Requests must arrive over TLS through the trusted proxy",
        ));
    }
    let worker_route = matches!(
        request.uri().path(),
        "/api/worker/pair"
            | "/api/worker/hello"
            | "/api/worker/upload"
            | "/api/worker/recover"
            | "/api/worker/goodbye"
    );
    if worker_route && !state.hub_enabled {
        return Err((StatusCode::NOT_FOUND, "Hub mode is not enabled"));
    }
    let bearer = text("authorization")
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty());
    let query = super::params::Params::new(request.uri().query());
    let token = bearer
        .or_else(|| {
            (request.method() == Method::GET)
                .then(|| query.get("access_token"))
                .flatten()
        })
        .unwrap_or("");
    if !worker_route
        && let Some(expected) = &state.options.token
        && (token.is_empty() || !bool::from(token.as_bytes().ct_eq(expected.as_bytes())))
    {
        return Err((StatusCode::UNAUTHORIZED, "API access token required"));
    }
    if matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH
    ) && text("content-type")
        .and_then(|v| v.split(';').next())
        .map(|v| v.trim().to_lowercase())
        .as_deref()
        != Some("application/json")
    {
        return Err((
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Write requests require application/json",
        ));
    }
    let request_origin = state.options.public_origin.clone().unwrap_or_else(|| {
        format!(
            "{}://{host}",
            if state.options.tls { "https" } else { "http" }
        )
    });
    let fetch_ok =
        text("sec-fetch-site").is_none_or(|v| v.is_empty() || matches!(v, "same-origin" | "none"));
    let origin_ok = text("origin").is_none_or(|v| {
        v.is_empty()
            || url::Url::parse(v)
                .ok()
                .zip(url::Url::parse(&request_origin).ok())
                .is_some_and(|(a, b)| a.origin() == b.origin())
    });
    if !fetch_ok || !origin_ok {
        return Err((StatusCode::FORBIDDEN, "Cross-origin API request rejected"));
    }
    Ok(())
}

fn valid_authority(count: usize, host: &str, listener: &str, port: u16) -> bool {
    if count != 1 || host.trim() != host {
        return false;
    }
    let Some((name, raw_port)) = host.rsplit_once(':') else {
        return false;
    };
    if raw_port.is_empty()
        || raw_port.len() > 5
        || !raw_port.bytes().all(|b| b.is_ascii_digit())
        || raw_port.parse::<u16>().ok() != Some(port)
        || port == 0
    {
        return false;
    }
    if name.contains(':') && !(name.starts_with('[') && name.ends_with(']')) {
        return false;
    }
    let Ok(parsed) = url::Url::parse(&format!("http://{host}")) else {
        return false;
    };
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return false;
    }
    let Some(name) = parsed.host_str() else {
        return false;
    };
    let name = name.trim_matches(['[', ']']);
    let listener = url::Url::parse(&format!("http://{listener}"))
        .ok()
        .and_then(|v| v.host_str().map(|h| h.trim_matches(['[', ']']).to_owned()));
    matches!(name, "localhost" | "127.0.0.1" | "::1") || listener.as_deref() == Some(name)
}

pub struct PrebuiltHtml {
    raw: Vec<u8>,
    zstd: Option<Vec<u8>>,
    gz: Option<Vec<u8>>,
    etag_raw: String,
    etag_zstd: String,
    etag_gz: String,
}

fn html_escape_attr(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() + 16);
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn build_bootstrapped_html(
    options: &super::Options,
    hub_enabled: bool,
) -> Option<PrebuiltHtml> {
    // Only embed AppConfig into unauthenticated HTML; auth-protected servers keep /api/config gated.
    if options.token.is_some() {
        return None;
    }
    let ((mime, asset), _) = crate::assets::spa_entry("/")?;
    if mime != "text/html; charset=utf-8" {
        return None;
    }
    let html = std::str::from_utf8(asset.raw).ok()?;
    let head_end = html.find("</head>")?;
    let config = codesesh_core::wire::AppConfig {
        hub_enabled: hub_enabled.then_some(true),
        public_hub_url: hub_enabled.then(|| options.public_origin.clone()).flatten(),
        window: codesesh_core::wire::SessionWindow {
            from: options.default_from,
            to: options.default_to,
            days: options.default_days.map(f64::from),
        },
    };
    let json = serde_json::to_string(&config).ok()?;
    let meta = format!(
        "<meta name=\"codesesh-config\" content=\"{}\" />",
        html_escape_attr(&json)
    );
    let mut injected = String::with_capacity(html.len() + meta.len());
    injected.push_str(&html[..head_end]);
    injected.push_str(&meta);
    injected.push_str(&html[head_end..]);
    let raw = injected.into_bytes();
    let zstd = zstd::bulk::compress(&raw, 6)
        .ok()
        .filter(|b| b.len() < raw.len());
    let gz = {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(
            Vec::with_capacity(raw.len() / 2),
            flate2::Compression::best(),
        );
        encoder
            .write_all(&raw)
            .ok()
            .and_then(|()| encoder.finish().ok())
            .filter(|b| b.len() < raw.len())
    };
    let mut hash: u128 = 0x6c62272e07bb0142_62b821756295c58d;
    for &b in &raw {
        hash ^= u128::from(b);
        hash = hash.wrapping_mul(0x0000000001000000_000000000000013b);
    }
    let etag_raw = format!("\"{hash:032x}\"");
    let etag_zstd = format!("\"{hash:032x}-zstd\"");
    let etag_gz = format!("\"{hash:032x}-gz\"");
    Some(PrebuiltHtml {
        raw,
        zstd,
        gz,
        etag_raw,
        etag_zstd,
        etag_gz,
    })
}

pub async fn static_file(AxumState(state): AxumState<Arc<State>>, request: Request) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return (StatusCode::NOT_FOUND, "404 Not Found").into_response();
    }
    let path = request.uri().path();
    let is_head = *request.method() == Method::HEAD;
    let accept_encoding = request
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok());
    // Vite fingerprints every file under /assets/; the SPA fallback for a missing name must stay uncached.
    if path.starts_with("/assets/")
        && let Some((mime, asset)) = crate::assets::lookup_entry(path)
    {
        return static_response(
            &request,
            mime,
            asset,
            Some("public, max-age=31536000, immutable"),
            accept_encoding,
            is_head,
        );
    }
    if let Some(((mime, asset), is_exact_non_html)) = crate::assets::spa_entry(path) {
        if !is_exact_non_html
            && mime == "text/html; charset=utf-8"
            && let Some(html) = state.index_html.as_ref()
        {
            return prebuilt_html_response(&request, html, accept_encoding, is_head);
        }
        let cache_control = is_exact_non_html.then_some("public, max-age=3600");
        return static_response(
            &request,
            mime,
            asset,
            cache_control,
            accept_encoding,
            is_head,
        );
    }
    (StatusCode::NOT_FOUND, "404 Not Found").into_response()
}

fn mark_pre_negotiated(mut response: Response) -> Response {
    response
        .extensions_mut()
        .insert(super::compression::PreNegotiated);
    response
}

fn prebuilt_html_response(
    request: &Request,
    html: &PrebuiltHtml,
    accept_encoding: Option<&str>,
    is_head: bool,
) -> Response {
    let has_variants = html.zstd.is_some() || html.gz.is_some();
    let chosen = accept_encoding.and_then(|header| {
        super::compression::select_html_encoding(header, html.zstd.is_some(), html.gz.is_some())
    });
    let (encoding, bytes, etag): (Option<&'static str>, &[u8], &str) = match chosen {
        Some("zstd") => (Some("zstd"), html.zstd.as_deref().unwrap(), &html.etag_zstd),
        Some("gzip") => (Some("gzip"), html.gz.as_deref().unwrap(), &html.etag_gz),
        _ => (None, &html.raw, &html.etag_raw),
    };
    if super::etag::matches_if_none_match(request.headers(), etag) {
        let mut builder = Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag);
        if has_variants {
            builder = builder.header(header::VARY, "Accept-Encoding");
        }
        return mark_pre_negotiated(builder.body(Body::empty()).unwrap());
    }
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::ETAG, etag);
    if has_variants {
        builder = builder.header(header::VARY, "Accept-Encoding");
    }
    if let Some(encoding) = encoding {
        builder = builder.header(header::CONTENT_ENCODING, encoding);
    }
    let body = if is_head {
        Body::empty()
    } else {
        Body::from(bytes.to_vec())
    };
    mark_pre_negotiated(builder.body(body).unwrap())
}

fn static_response(
    request: &Request,
    mime: &'static str,
    asset: &'static crate::assets::EmbeddedAsset,
    cache_control: Option<&'static str>,
    accept_encoding: Option<&str>,
    is_head: bool,
) -> Response {
    let has_variants = asset.br.is_some() || asset.gz.is_some();
    let chosen = accept_encoding.and_then(|header| {
        super::compression::select_static_encoding(header, asset.br.is_some(), asset.gz.is_some())
    });
    let (encoding, bytes, etag) = match chosen {
        Some("br") => (Some("br"), asset.br.unwrap(), asset.etag_br),
        Some("gzip") => (Some("gzip"), asset.gz.unwrap(), asset.etag_gz),
        _ => (None, asset.raw, asset.etag),
    };
    if super::etag::matches_if_none_match(request.headers(), etag) {
        let mut builder = Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag);
        if has_variants {
            builder = builder.header(header::VARY, "Accept-Encoding");
        }
        if let Some(cc) = cache_control {
            builder = builder.header(header::CACHE_CONTROL, cc);
        }
        return mark_pre_negotiated(builder.body(Body::empty()).unwrap());
    }
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::ETAG, etag);
    if has_variants {
        builder = builder.header(header::VARY, "Accept-Encoding");
    }
    if let Some(encoding) = encoding {
        builder = builder.header(header::CONTENT_ENCODING, encoding);
    }
    if let Some(cc) = cache_control {
        builder = builder.header(header::CACHE_CONTROL, cc);
    }
    let body = if is_head {
        Body::empty()
    } else {
        Body::from(bytes)
    };
    mark_pre_negotiated(builder.body(body).unwrap())
}

const WORKER_FAST_REQUEST_THRESHOLD_MS: u128 = 200;

/// Marks a 2xx worker response (e.g. version-incompatibility `hello`) to stay at `info`.
#[derive(Clone, Copy)]
pub(super) struct KeepInfoLog;

fn request_log_level(
    route: &str,
    status: StatusCode,
    duration_ms: u128,
    keep_info: bool,
) -> crate::logging::Level {
    if !keep_info
        && matches!(route, "/api/worker/hello" | "/api/worker/upload")
        && status.is_success()
        && duration_ms < WORKER_FAST_REQUEST_THRESHOLD_MS
    {
        crate::logging::Level::Debug
    } else {
        crate::logging::Level::Info
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::Level;

    #[test]
    fn loopback_authority_rejects_port_and_host_smuggling() {
        assert!(valid_authority(1, "localhost:4521", "127.0.0.1", 4521));
        assert!(valid_authority(1, "[::1]:4521", "127.0.0.1", 4521));
        for host in [
            "localhost",
            "localhost:80",
            "evil.test:4521",
            "localhost@evil.test:4521",
            "localhost:4521 ",
            "localhost/path:4521",
        ] {
            assert!(!valid_authority(1, host, "127.0.0.1", 4521), "{host}");
        }
        assert!(!valid_authority(2, "localhost:4521", "127.0.0.1", 4521));
    }

    #[test]
    fn worker_routine_fast_success_requests_log_at_debug() {
        for (route, status, duration_ms, keep_info, expected) in [
            ("/api/worker/hello", StatusCode::OK, 0, false, Level::Debug),
            (
                "/api/worker/hello",
                StatusCode::OK,
                199,
                false,
                Level::Debug,
            ),
            ("/api/worker/hello", StatusCode::OK, 5, true, Level::Info),
            (
                "/api/worker/upload",
                StatusCode::OK,
                15,
                false,
                Level::Debug,
            ),
            (
                "/api/worker/upload",
                StatusCode::NO_CONTENT,
                50,
                false,
                Level::Debug,
            ),
            ("/api/worker/hello", StatusCode::OK, 200, false, Level::Info),
            (
                "/api/worker/upload",
                StatusCode::OK,
                350,
                false,
                Level::Info,
            ),
            (
                "/api/worker/hello",
                StatusCode::UNAUTHORIZED,
                5,
                false,
                Level::Info,
            ),
            (
                "/api/worker/upload",
                StatusCode::CONFLICT,
                5,
                false,
                Level::Info,
            ),
            (
                "/api/worker/upload",
                StatusCode::INTERNAL_SERVER_ERROR,
                5,
                false,
                Level::Info,
            ),
            ("/api/worker/pair", StatusCode::OK, 5, false, Level::Info),
            ("/api/worker/recover", StatusCode::OK, 5, false, Level::Info),
            ("/api/worker/goodbye", StatusCode::OK, 5, false, Level::Info),
            ("/api/sessions", StatusCode::OK, 5, false, Level::Info),
            ("/api/status", StatusCode::OK, 5, false, Level::Info),
        ] {
            assert_eq!(
                request_log_level(route, status, duration_ms, keep_info),
                expected,
                "{route} {status} {duration_ms}ms keep_info={keep_info}"
            );
        }
    }
}
