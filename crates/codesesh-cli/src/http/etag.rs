use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
};
use codesesh_core::model::SessionReference;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fmt::Write};

pub fn weak_etag(key: &serde_json::Value) -> String {
    let bytes = serde_json::to_vec(key).expect("serializable ETag key");
    let digest = Sha256::digest(bytes);
    let mut tag = String::with_capacity(3 + 32 + 1);
    tag.push_str("W/\"");
    for byte in &digest[..16] {
        let _ = write!(&mut tag, "{byte:02x}");
    }
    tag.push('"');
    tag
}

pub fn aliases_fingerprint(aliases: &HashMap<SessionReference, String>) -> String {
    if aliases.is_empty() {
        return String::new();
    }
    let mut entries: Vec<_> = aliases
        .iter()
        .map(|(reference, alias)| {
            (
                reference.source_node_id.as_str(),
                reference.agent_name.as_str(),
                reference.session_id.as_str(),
                alias.as_str(),
            )
        })
        .collect();
    entries.sort_unstable();
    let mut hasher = Sha256::new();
    for (node, agent, id, alias) in entries {
        for part in [node, agent, id, alias] {
            hasher.update((part.len() as u64).to_le_bytes());
            hasher.update(part.as_bytes());
        }
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

pub fn matches_if_none_match(headers: &HeaderMap, etag: &str) -> bool {
    let target = strip_weak(etag);
    headers
        .get_all(header::IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|header| {
            let trimmed = header.trim();
            if trimmed == "*" {
                return true;
            }
            split_entity_tags(trimmed).any(|candidate| strip_weak(candidate) == target)
        })
}

pub fn not_modified(etag: &str) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::NOT_MODIFIED)
        .body(Body::empty())
        .expect("304 response");
    apply_headers(&mut response, etag);
    response
}

pub fn apply_headers(response: &mut Response, etag: &str) {
    if let Ok(value) = HeaderValue::from_str(etag) {
        response.headers_mut().insert(header::ETAG, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
}

fn strip_weak(tag: &str) -> &str {
    let trimmed = tag.trim();
    trimmed.strip_prefix("W/").unwrap_or(trimmed)
}

fn split_entity_tags(value: &str) -> impl Iterator<Item = &str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (index, ch) in value.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                let slice = value[start..index].trim();
                if !slice.is_empty() {
                    parts.push(slice);
                }
                start = index + 1;
            }
            _ => {}
        }
    }
    let tail = value[start..].trim();
    if !tail.is_empty() {
        parts.push(tail);
    }
    parts.into_iter()
}
