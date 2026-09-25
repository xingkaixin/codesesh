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
                    | "path"
                    | "project"
                    | "projectKey"
                    | "projectKind"
                    | "q"
                    | "sessionId"
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
    if let Some(logger) = crate::logging::current() {
        logger.with_context(context).info("http.request",&serde_json::json!({"method":method,"route":route,"query_keys":keys,"status":response.status().as_u16(),"duration_ms":started.elapsed().as_millis()}));
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
    if token.is_empty() || !bool::from(token.as_bytes().ct_eq(state.options.token.as_bytes())) {
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
    let request_origin = format!(
        "{}://{host}",
        if state.options.tls { "https" } else { "http" }
    );
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

pub async fn static_file(request: Request) -> Response {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return (StatusCode::NOT_FOUND, "404 Not Found").into_response();
    }
    let path = request.uri().path();
    if let Some((mime, bytes)) = crate::assets::spa(path) {
        return ([(header::CONTENT_TYPE, mime)], bytes).into_response();
    }
    (StatusCode::NOT_FOUND, "404 Not Found").into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
