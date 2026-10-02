use super::*;
use crate::storage::{Cache, tests::source};

fn page(
    cache: &Cache,
    head: SessionHead,
    encoded: Option<&str>,
    limit: usize,
) -> (SessionDetail, usize) {
    let mut messages = Vec::new();
    let (mut detail, total) =
        visit_detail_message_page(cache.connection(), head, encoded, Some(limit), |message| {
            messages.push(message);
            Ok(())
        })
        .unwrap()
        .unwrap();
    detail.messages = messages;
    (detail, total)
}

#[test]
fn pages_preserve_order_and_reset_on_rewrite_or_a_different_source() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "paged");
    let message = session.detail.messages[0].clone();
    session.detail.messages = (0..5)
        .map(|index| Message {
            id: format!("m{index}"),
            ..message.clone()
        })
        .collect();
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let full = detail(cache.connection(), session.head.clone())
        .unwrap()
        .unwrap();
    let (first, total) = page(&cache, session.head.clone(), None, 2);
    assert_eq!(total, 5);
    assert_eq!(first.messages, full.messages[..2]);
    assert_eq!(first.message_update.as_deref(), Some("reset"));
    let (second, _) = page(
        &cache,
        session.head.clone(),
        first.message_cursor.as_deref(),
        2,
    );
    assert_eq!(second.messages, full.messages[2..4]);
    assert_eq!(second.message_update.as_deref(), Some("append"));
    let (last, _) = page(
        &cache,
        session.head.clone(),
        second.message_cursor.as_deref(),
        2,
    );
    assert_eq!(last.messages, full.messages[4..]);
    assert_eq!(last.message_cursor, full.message_cursor);
    let (unchanged, _) = page(
        &cache,
        session.head.clone(),
        last.message_cursor.as_deref(),
        2,
    );
    assert!(unchanged.messages.is_empty());

    let mut remote = session.clone();
    remote.head.reference.source_node_id = "other-machine".into();
    remote.detail.head.reference = remote.head.reference.clone();
    cache.publish(std::slice::from_mut(&mut remote)).unwrap();
    let (isolated, _) = page(&cache, remote.head, first.message_cursor.as_deref(), 2);
    assert_eq!(isolated.message_update.as_deref(), Some("reset"));
    assert_eq!(isolated.messages, first.messages);

    session.detail.messages[0].id = "rewritten".into();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    let (reset, _) = page(&cache, session.head, first.message_cursor.as_deref(), 2);
    assert_eq!(reset.message_update.as_deref(), Some("reset"));
    assert_eq!(reset.messages.len(), 2);
    assert_eq!(reset.messages[0].id, "rewritten");
}

#[test]
fn page_byte_budget_stops_before_deserializing_the_next_message() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "large-page");
    session.detail.messages[0].parts = vec![MessagePart::Text {
        text: "x".repeat(600 * 1024),
        time_created: None,
    }];
    session
        .detail
        .messages
        .push(session.detail.messages[0].clone());
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    cache
        .connection()
        .execute(
            "UPDATE messages SET parts_json='invalid' WHERE message_index=1",
            [],
        )
        .unwrap();
    let (first, total) = page(&cache, session.head.clone(), None, 200);
    assert_eq!(first.messages.len(), 1);
    assert_eq!(total, 2);
    assert_eq!(
        parse_cursor(first.message_cursor.as_deref().unwrap())
            .unwrap()
            .0,
        1
    );
    assert!(detail(cache.connection(), session.head).is_err());
}

#[test]
fn legacy_rows_without_chain_digests_return_a_complete_transcript() {
    let root = tempfile::tempdir().unwrap();
    let mut session = source(root.path(), "legacy-page");
    session
        .detail
        .messages
        .push(session.detail.messages[0].clone());
    let mut cache = Cache::open(None).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    cache
        .connection()
        .execute("UPDATE messages SET content_chain_digest=NULL", [])
        .unwrap();
    let (first, total) = page(&cache, session.head, None, 1);
    assert_eq!(first.messages.len(), total);
    assert_eq!(total, 2);
}
