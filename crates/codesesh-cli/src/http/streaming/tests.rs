use super::*;
use futures_util::StreamExt;
use std::sync::Arc;

#[tokio::test]
async fn sqlite_detail_stream_preserves_alias_cursor_and_large_transcript() {
    use codesesh_core::{
        agents::{ParsedSession, parse_codex},
        pricing::Pricing,
        storage::Cache,
    };
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("rollout-large.jsonl");
    std::fs::write(&source,concat!(
        "{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
        "{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Fixture 中文 🔎\"}]}}\n"
    )).unwrap();
    let mut data = parse_codex(&source, &Default::default(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    let mut message = data.messages[0].clone();
    message.model = Some("claude-sonnet-4-6".into());
    message.tokens = Some(
        serde_json::from_value(
            serde_json::json!({"input":1000,"output":200,"cache_read":400,"cache_create":100}),
        )
        .unwrap(),
    );
    Pricing::bundled().apply_message_cost(&mut message);
    data.messages = (0..300)
        .map(|index| {
            let mut message = message.clone();
            message.id = format!("m{index}");
            message.parts = vec![codesesh_core::model::MessagePart::Text {
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
    for message in &mut expected.messages {
        message.cost_breakdown = Pricing::bundled().message_cost_breakdown(message);
        assert!(message.cost_breakdown.is_some());
    }
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
        codesesh_core::pricing::Pricing::bundled(),
        reference.clone(),
        None,
        None,
        aliases.clone(),
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
    let mut paged_messages = Vec::new();
    let mut page_cursor = None;
    while paged_messages.len() < 300 {
        let response = detail(
            runtime.clone(),
            codesesh_core::pricing::Pricing::bundled(),
            reference.clone(),
            page_cursor,
            Some(64),
            aliases.clone(),
            semaphore.clone().acquire_owned().await.unwrap(),
        )
        .await;
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page["message_total"].as_f64(), Some(300.0));
        assert_eq!(page["display_title"], "Local Alias");
        assert_eq!(
            page["message_update"],
            if paged_messages.is_empty() {
                "reset"
            } else {
                "append"
            }
        );
        let messages = page["messages"].as_array().unwrap();
        assert!(!messages.is_empty() && messages.len() <= 64);
        paged_messages.extend(messages.iter().cloned());
        page_cursor = Some(page["message_cursor"].as_str().unwrap().to_owned());
    }
    assert_eq!(
        serde_json::Value::Array(paged_messages),
        expected["messages"]
    );
    assert_eq!(page_cursor, cursor);
    let response = detail(
        runtime.clone(),
        codesesh_core::pricing::Pricing::bundled(),
        reference,
        cursor,
        None,
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
async fn slow_detail_stream_does_not_hold_sqlite_reader_across_backpressure() {
    use codesesh_core::{
        agents::{ParsedSession, parse_codex},
        pricing::Pricing,
        storage::Cache,
    };
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("rollout-slow.jsonl");
    std::fs::write(&source, concat!(
        "{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
        "{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Slow client\"}]}}\n"
    )).unwrap();
    let mut data = parse_codex(&source, &Default::default(), &Pricing::bundled())
        .unwrap()
        .unwrap();
    let base = data.messages[0].clone();
    data.messages = (0..300)
        .map(|index| {
            let mut message = base.clone();
            message.id = format!("m{index}");
            message.parts = vec![codesesh_core::model::MessagePart::Text {
                text: "chunk-payload-".repeat(256),
                time_created: Some(message.time_created),
            }];
            message
        })
        .collect();
    data.head.stats.message_count = 300;
    let reference = data.head.reference.clone();
    let path = root.path().join("cache.db");
    let mut cache = Cache::open(Some(&path)).unwrap();
    cache
        .publish(&mut [ParsedSession {
            head: data.head.clone(),
            detail: data,
            source,
        }])
        .unwrap();
    drop(cache);

    // Single SQLite reader slot: if streaming held the reader across backpressure,
    // concurrent runtime.read() calls would block until the client resumed reading.
    let runtime = codesesh_core::runtime::Runtime::start(path, vec![], 1)
        .await
        .unwrap();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
    let response = detail(
        runtime.clone(),
        codesesh_core::pricing::Pricing::bundled(),
        reference,
        None,
        None,
        Default::default(),
        semaphore.clone().acquire_owned().await.unwrap(),
    )
    .await;
    assert_eq!(response.status(), axum::http::StatusCode::OK);

    // Pause before draining the response stream; another SQLite reader must proceed immediately.
    let count = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        runtime.read(|conn| {
            Ok(conn.query_row("SELECT count(*) FROM sessions", [], |row| {
                row.get::<_, i64>(0)
            })?)
        }),
    )
    .await
    .expect("reader must not be blocked by paused detail stream")
    .unwrap();
    assert_eq!(count, 1);

    // Resuming and draining still yields valid complete JSON.
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(parsed["messages"].as_array().unwrap().len(), 300);
    runtime.shutdown().await.unwrap();
}
