use async_compression::tokio::bufread::{GzipEncoder, ZlibEncoder};
use axum::{
    body::Body,
    extract::Request,
    http::{Method, StatusCode, header},
    middleware::Next,
    response::Response,
};
use futures_util::TryStreamExt;
use regex::Regex;
use std::{io, sync::LazyLock};
use tokio_util::io::{ReaderStream, StreamReader};

static COMPRESSIBLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:text/(?:[^;\s]+)|application/(?:javascript|json|xml|xml-dtd|ecmascript|dart|msgpack|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|vnd\.msgpack|wasm|x-httpd-php|x-javascript|x-msgpack|x-ns-proxy-autoconfig|x-sh|x-tar|x-virtualbox-hdd|x-virtualbox-ova|x-virtualbox-ovf|x-virtualbox-vbox|x-virtualbox-vdi|x-virtualbox-vhd|x-virtualbox-vmdk|x-www-form-urlencoded)|font/(?:otf|ttf)|image/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message/rfc822|model/gltf-binary|x-shader/x-fragment|x-shader/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml|msgpack))(?:[;\s]|$)").unwrap()
});

pub async fn middleware(request: Request, next: Next) -> Response {
    let applies = request.uri().path().starts_with("/api/") && request.method() != Method::HEAD;
    let accepted = request
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut response = next.run(request).await;
    if !applies || !eligible(&response) {
        return response;
    }
    let current = response
        .headers()
        .get(header::VARY)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if current != "*"
        && !current
            .split(',')
            .any(|value| value.trim().eq_ignore_ascii_case("accept-encoding"))
    {
        let vary = if current.is_empty() {
            "Accept-Encoding".to_owned()
        } else {
            format!("{current}, Accept-Encoding")
        };
        if let Ok(vary) = vary.parse() {
            response.headers_mut().insert(header::VARY, vary);
        }
    }
    let Some(encoding) = accepted.as_deref().and_then(select_encoding) else {
        return response;
    };
    let (mut parts, body) = response.into_parts();
    parts.headers.remove(header::CONTENT_LENGTH);
    parts
        .headers
        .insert(header::CONTENT_ENCODING, encoding.parse().unwrap());
    if let Some(etag) = parts
        .headers
        .get(header::ETAG)
        .and_then(|v| v.to_str().ok())
        && !etag.starts_with("W/")
        && let Ok(weak) = format!("W/{etag}").parse()
    {
        parts.headers.insert(header::ETAG, weak);
    }
    let source = StreamReader::new(body.into_data_stream().map_err(io::Error::other));
    let body = match encoding {
        "gzip" => Body::from_stream(ReaderStream::new(GzipEncoder::new(source))),
        "deflate" => Body::from_stream(ReaderStream::new(ZlibEncoder::new(source))),
        _ => unreachable!(),
    };
    Response::from_parts(parts, body)
}

fn eligible(response: &Response) -> bool {
    let headers = response.headers();
    if response.status() == StatusCode::PARTIAL_CONTENT
        || headers.contains_key(header::CONTENT_ENCODING)
        || headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok())
            .is_some_and(|size| size < 1024.)
        || headers
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(',')
                    .any(|v| v.trim().eq_ignore_ascii_case("no-transform"))
            })
    {
        return false;
    }
    let Some(content_type) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let mime = content_type.split(';').next().unwrap_or("").trim();
    !mime.eq_ignore_ascii_case("text/event-stream") && COMPRESSIBLE.is_match(content_type)
}

fn select_encoding(header: &str) -> Option<&'static str> {
    let mut accepts = split_quoted(header, ',')
        .into_iter()
        .filter_map(|value| {
            let fields = split_quoted(value, ';');
            let name = fields.first()?.trim();
            if name.is_empty() {
                return None;
            }
            let mut lower = None;
            let mut upper = None;
            for field in &fields[1..] {
                let Some((key, value)) = field.split_once('=') else {
                    continue;
                };
                let mut value = value.trim();
                if value.starts_with('"') {
                    let Some(quoted) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"'))
                    else {
                        continue;
                    };
                    value = quoted;
                }
                if value.is_empty() {
                    continue;
                }
                match key.trim() {
                    "q" => lower = Some(value),
                    "Q" => upper = Some(value),
                    _ => {}
                }
            }
            let q = match lower.or(upper) {
                Some("NaN") => 0.,
                Some(value) => value
                    .parse::<f64>()
                    .ok()
                    .filter(|v| !v.is_nan())
                    .unwrap_or(1.)
                    .clamp(0., 1.),
                None => 1.,
            };
            Some((name, q))
        })
        .collect::<Vec<_>>();
    accepts.sort_by(|a, b| b.1.total_cmp(&a.1));
    let wildcard = accepts
        .iter()
        .find(|(name, _)| *name == "*")
        .map(|(_, q)| *q)
        .unwrap_or(0.);
    let mut best = None;
    for encoding in ["gzip", "deflate"] {
        let q = accepts
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(encoding))
            .map(|(_, q)| *q)
            .unwrap_or(wildcard);
        if q == 1. {
            return Some(encoding);
        }
        if q > 0. && best.is_none_or(|(_, quality)| q > quality) {
            best = Some((encoding, q));
        }
    }
    best.map(|(encoding, _)| encoding)
}

fn split_quoted(value: &str, delimiter: char) -> Vec<&str> {
    let mut start = 0;
    let mut quoted = false;
    let mut escaped = false;
    let mut result = Vec::new();
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quoted && character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if !quoted && character == delimiter {
            result.push(&value[start..index]);
            start = index + 1;
        }
    }
    result.push(&value[start..]);
    result
}

#[cfg(test)]
mod tests;
