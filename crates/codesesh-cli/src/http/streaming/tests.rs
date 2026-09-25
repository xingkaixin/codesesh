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
