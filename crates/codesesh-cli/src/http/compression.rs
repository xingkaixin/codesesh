use async_compression::{
    Level,
    tokio::bufread::{GzipEncoder, ZlibEncoder},
};
use axum::{
    body::{Body, HttpBody, to_bytes},
    extract::Request,
    http::{HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::Response,
};
use flate2::{
    Compression,
    write::{GzEncoder as SyncGzEncoder, ZlibEncoder as SyncZlibEncoder},
};
use futures_util::TryStreamExt;
use regex::Regex;
use std::{
    cell::RefCell,
    io::{self, Write},
    sync::LazyLock,
};
use tokio_util::io::{ReaderStream, StreamReader};

const MIN_COMPRESS_BYTES: usize = 512;
const IN_MEMORY_COMPRESS_LIMIT: usize = 8 * 1024 * 1024;
const ZSTD_DYNAMIC_LEVEL: i32 = 6;

thread_local! {
    static ZSTD_COMPRESSOR: RefCell<Option<zstd::bulk::Compressor<'static>>> = const { RefCell::new(None) };
}

static COMPRESSIBLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:text/(?:[^;\s]+)|application/(?:javascript|json|xml|xml-dtd|ecmascript|dart|msgpack|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|vnd\.msgpack|wasm|x-httpd-php|x-javascript|x-msgpack|x-ns-proxy-autoconfig|x-sh|x-tar|x-virtualbox-hdd|x-virtualbox-ova|x-virtualbox-ovf|x-virtualbox-vbox|x-virtualbox-vdi|x-virtualbox-vhd|x-virtualbox-vmdk|x-www-form-urlencoded)|font/(?:otf|ttf)|image/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message/rfc822|model/gltf-binary|x-shader/x-fragment|x-shader/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml|msgpack))(?:[;\s]|$)").unwrap()
});

/// Marks responses whose Content-Encoding, ETag, and Vary were already negotiated by the handler.
#[derive(Clone, Copy)]
pub(super) struct PreNegotiated;

pub async fn middleware(request: Request, next: Next) -> Response {
    let applies = request.method() != Method::HEAD;
    let accepted = request
        .headers()
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let mut response = next.run(request).await;
    if !applies || response.extensions().get::<PreNegotiated>().is_some() || !eligible(&response) {
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
    let exact_len = response
        .body()
        .size_hint()
        .exact()
        .map(|n| n as usize)
        .or_else(|| {
            response
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<usize>().ok())
        });
    let allow_zstd = exact_len.is_some_and(|len| len <= IN_MEMORY_COMPRESS_LIMIT);
    let Some(encoding) = accepted
        .as_deref()
        .and_then(|header| select_dynamic_encoding(header, allow_zstd))
    else {
        return response;
    };
    let (mut parts, body) = response.into_parts();
    weaken_etag(&mut parts.headers);
    if let Some(len) = exact_len
        && len <= IN_MEMORY_COMPRESS_LIMIT
    {
        let Ok(raw) = to_bytes(body, IN_MEMORY_COMPRESS_LIMIT).await else {
            return Response::from_parts(parts, Body::empty());
        };
        if raw.len() < MIN_COMPRESS_BYTES {
            parts
                .headers
                .insert(header::CONTENT_LENGTH, HeaderValue::from(raw.len()));
            return Response::from_parts(parts, Body::from(raw));
        }
        let compressed = match compress_slice(&raw, encoding) {
            Ok(bytes) if bytes.len() < raw.len() => Some(bytes),
            _ => None,
        };
        if let Some(bytes) = compressed {
            parts
                .headers
                .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
            parts
                .headers
                .insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
            return Response::from_parts(parts, Body::from(bytes));
        }
        parts
            .headers
            .insert(header::CONTENT_LENGTH, HeaderValue::from(raw.len()));
        return Response::from_parts(parts, Body::from(raw));
    }
    parts.headers.remove(header::CONTENT_LENGTH);
    parts
        .headers
        .insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
    let source = StreamReader::new(body.into_data_stream().map_err(io::Error::other));
    let body = match encoding {
        "gzip" => Body::from_stream(ReaderStream::new(GzipEncoder::with_quality(
            source,
            Level::Fastest,
        ))),
        "deflate" => Body::from_stream(ReaderStream::new(ZlibEncoder::with_quality(
            source,
            Level::Fastest,
        ))),
        _ => unreachable!(),
    };
    Response::from_parts(parts, body)
}

fn weaken_etag(headers: &mut axum::http::HeaderMap) {
    if let Some(etag) = headers.get(header::ETAG).and_then(|v| v.to_str().ok())
        && !etag.starts_with("W/")
        && let Ok(weak) = format!("W/{etag}").parse()
    {
        headers.insert(header::ETAG, weak);
    }
}

fn compress_slice(raw: &[u8], encoding: &str) -> io::Result<Vec<u8>> {
    match encoding {
        "zstd" => ZSTD_COMPRESSOR.with_borrow_mut(|slot| {
            let compressor = match slot {
                Some(compressor) => compressor,
                None => slot.insert(zstd::bulk::Compressor::new(ZSTD_DYNAMIC_LEVEL)?),
            };
            compressor.compress(raw)
        }),
        "gzip" => {
            let mut encoder =
                SyncGzEncoder::new(Vec::with_capacity(raw.len() / 3), Compression::fast());
            encoder.write_all(raw)?;
            encoder.finish()
        }
        "deflate" => {
            let mut encoder =
                SyncZlibEncoder::new(Vec::with_capacity(raw.len() / 3), Compression::fast());
            encoder.write_all(raw)?;
            encoder.finish()
        }
        _ => unreachable!(),
    }
}

fn eligible(response: &Response) -> bool {
    let headers = response.headers();
    if response.status() == StatusCode::PARTIAL_CONTENT
        || response.status() == StatusCode::NOT_MODIFIED
        || headers.contains_key(header::CONTENT_ENCODING)
        || headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .is_some_and(|size| size < MIN_COMPRESS_BYTES)
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
    let mime = content_type
        .trim_start()
        .split([';', ' ', '\t', '\r', '\n'])
        .next()
        .unwrap_or("");
    !mime.eq_ignore_ascii_case("text/event-stream") && COMPRESSIBLE.is_match(content_type)
}

pub(super) fn select_html_encoding(
    header: &str,
    has_zstd: bool,
    has_gz: bool,
) -> Option<&'static str> {
    let mut candidates = Vec::with_capacity(2);
    if has_zstd {
        candidates.push("zstd");
    }
    if has_gz {
        candidates.push("gzip");
    }
    if candidates.is_empty() {
        return None;
    }
    select_from(header, &candidates)
}

pub(super) fn select_static_encoding(
    header: &str,
    has_br: bool,
    has_gz: bool,
) -> Option<&'static str> {
    let mut candidates = Vec::with_capacity(2);
    if has_br {
        candidates.push("br");
    }
    if has_gz {
        candidates.push("gzip");
    }
    if candidates.is_empty() {
        return None;
    }
    select_from(header, &candidates)
}

fn select_dynamic_encoding(header: &str, allow_zstd: bool) -> Option<&'static str> {
    if allow_zstd {
        select_from(header, &["zstd", "gzip", "deflate"])
    } else {
        select_from(header, &["gzip", "deflate"])
    }
}

fn select_from(header: &str, supported: &[&'static str]) -> Option<&'static str> {
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
    for &encoding in supported {
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
