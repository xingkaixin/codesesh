use super::*;
use futures_util::StreamExt;
use serde::ser::SerializeSeq;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct TrackedMessages(Arc<AtomicUsize>);
impl Serialize for TrackedMessages {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(10_000))?;
        for index in 0..10_000 {
            self.0.fetch_add(1, Ordering::SeqCst);
            seq.serialize_element(&serde_json::json!({"id":index,"text":"中文".repeat(1024)}))?;
        }
        seq.end()
    }
}

#[tokio::test]
async fn serialization_is_lazy_bounded_and_releases_guard_on_disconnect() {
    let count = Arc::new(AtomicUsize::new(0));
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let permit = semaphore.clone().acquire_owned().await.unwrap();
    let response = json_with_guard(TrackedMessages(count.clone()), permit);
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert_eq!(semaphore.available_permits(), 0);
    let mut stream = response.into_body().into_data_stream();
    let first = stream.next().await.unwrap().unwrap();
    assert_eq!(first.len(), CHUNK_BYTES);
    assert!(count.load(Ordering::SeqCst) < 100);
    drop(stream);
    let released = tokio::time::timeout(std::time::Duration::from_secs(2), semaphore.acquire())
        .await
        .unwrap()
        .unwrap();
    assert!(count.load(Ordering::SeqCst) < 100);
    drop(released);
}

#[tokio::test]
async fn chunk_boundaries_preserve_unicode_json_and_completion_guard() {
    let value = serde_json::json!({"messages":[{"text":"中文😀".repeat(20_000)}],"fraction":1.25});
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let permit = semaphore.clone().acquire_owned().await.unwrap();
    let response = json_with_guard(value.clone(), permit);
    assert_eq!(
        response.headers()[header::CONTENT_TYPE],
        "application/json; charset=UTF-8"
    );
    assert!(!response.headers().contains_key(header::CONTENT_LENGTH));
    let mut stream = response.into_body().into_data_stream();
    let mut bytes = Vec::new();
    let mut chunks = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        assert!(chunk.len() <= CHUNK_BYTES);
        bytes.extend_from_slice(&chunk);
        chunks += 1;
    }
    assert!(chunks > 1);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        value
    );
    assert_eq!(semaphore.available_permits(), 1);
}

#[tokio::test]
async fn guard_lasts_until_body_completion_even_after_serialization_finishes() {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let permit = semaphore.clone().acquire_owned().await.unwrap();
    let mut stream = json_with_guard(serde_json::json!({"small":true}), permit)
        .into_body()
        .into_data_stream();
    assert!(stream.next().await.unwrap().is_ok());
    assert_eq!(semaphore.available_permits(), 0);
    assert!(stream.next().await.is_none());
    assert_eq!(semaphore.available_permits(), 1);
}

#[tokio::test]
async fn sqlite_detail_stream_preserves_alias_cursor_and_large_transcript() {
    use codesesh_core::{
        agents::codex::{self, ParsedSession},
        pricing::Pricing,
        storage::Cache,
    };
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("rollout-large.jsonl");
    std::fs::write(&source,concat!(
        "{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
        "{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Fixture 中文 🔎\"}]}}\n"
    )).unwrap();
    let mut data = codex::parse(&source, &Default::default(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    let message = data.messages[0].clone();
    data.messages = (0..300)
        .map(|index| {
            let mut message = message.clone();
            message.id = format!("m{index}");
            message.parts = vec![codesesh_core::contract::MessagePart::Text {
                text: "中文😀".repeat(512),
                time_created: Some(message.time_created),
            }];
            message
        })
        .collect();
    data.head.stats.message_count = 300;
    let reference = data.head.reference.clone();
    let path = root.path().join("cache.db");
    let mut cache = Cache::open(Some(&path)).unwrap();
    let mut sessions = [ParsedSession {
        head: data.head.clone(),
        detail: data,
        source,
    }];
    cache.publish(&mut sessions).unwrap();
    let mut expected = cache.detail(sessions[0].head.clone()).unwrap().unwrap();
    expected.head.display_title = Some("Local Alias".into());
    let cursor = expected.message_cursor.clone();
    let expected = serde_json::to_value(super::super::wire::detail(expected).unwrap()).unwrap();
    drop(cache);
    let runtime = codesesh_core::runtime::Runtime::start(path, vec![], 1)
        .await
        .unwrap();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let aliases = std::collections::HashMap::from([(reference.clone(), "Local Alias".into())]);
    let response = detail(
        runtime.clone(),
        reference.clone(),
        None,
        aliases,
        semaphore.clone().acquire_owned().await.unwrap(),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(semaphore.available_permits(), 0);
    let mut stream = response.into_body().into_data_stream();
    let mut bytes = Vec::new();
    let mut chunks = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        assert!(chunk.len() <= CHUNK_BYTES);
        bytes.extend_from_slice(&chunk);
        chunks += 1;
    }
    assert!(chunks > 10);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        expected
    );
    assert_eq!(semaphore.available_permits(), 1);
    let response = detail(
        runtime.clone(),
        reference,
        cursor,
        Default::default(),
        semaphore.clone().acquire_owned().await.unwrap(),
    )
    .await;
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let appended: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(appended["messages"], serde_json::json!([]));
    assert_eq!(appended["message_update"], "append");
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_detail_returns_retry_before_streaming_and_releases_permit() {
    let root = tempfile::tempdir().unwrap();
    let runtime = codesesh_core::runtime::Runtime::start(root.path().join("cache.db"), vec![], 1)
        .await
        .unwrap();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let reference = codesesh_core::contract::SessionReference {
        agent_name: "codex".into(),
        session_id: "missing".into(),
    };
    let response = detail(
        runtime.clone(),
        reference,
        None,
        Default::default(),
        semaphore.clone().acquire_owned().await.unwrap(),
    )
    .await;
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(response.headers()["retry-after"], "1");
    assert_eq!(semaphore.available_permits(), 1);
    runtime.shutdown().await.unwrap();
}
