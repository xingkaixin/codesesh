use crate::{
    contract::{SessionHead, SessionReference},
    public_contract::{
        AvailableBookmarkReason, AvailableBookmarkView, BookmarkView, UnavailableBookmarkReason,
        UnavailableBookmarkView, head,
    },
    state::{BookmarkRecord, normalize_reference, reference_key},
};
use anyhow::{Result, bail};
use std::collections::{HashMap, HashSet};

pub fn materialize_bookmarks(
    bookmarks: &[BookmarkRecord],
    live: &HashMap<String, SessionHead>,
    known_agents: &HashSet<String>,
    resolve_cached: impl FnOnce(&[SessionReference]) -> Result<Vec<(SessionReference, SessionHead)>>,
) -> Result<Vec<BookmarkView>> {
    let mut missing = Vec::new();
    let mut missing_keys = HashSet::new();
    for b in bookmarks {
        let key = reference_key(&b.reference);
        if !live.contains_key(&key) && missing_keys.insert(key) {
            missing.push(normalize_reference(&b.reference));
        }
    }
    let mut cached = HashMap::new();
    if !missing.is_empty() {
        for (reference, session) in resolve_cached(&missing)? {
            let key = reference_key(&reference);
            if missing_keys.contains(&key) && !cached.contains_key(&key) {
                validate(&reference, &session)?;
                cached.insert(key, session);
            }
        }
    }
    let mut views = Vec::with_capacity(bookmarks.len());
    for b in bookmarks {
        let bookmark = BookmarkRecord {
            reference: normalize_reference(&b.reference),
            bookmarked_at: b.bookmarked_at,
        };
        let key = reference_key(&bookmark.reference);
        let bookmarked_at = bookmark.bookmarked_at;
        let (time, view) = if let Some(session) = live.get(&key).or_else(|| cached.get(&key)) {
            validate(&bookmark.reference, session)?;
            let view = AvailableBookmarkView {
                availability: AvailableBookmarkReason::Available,
                bookmark,
                session: head(session.clone())?,
            };
            (
                session.time_updated,
                BookmarkView::Available(Box::new(view)),
            )
        } else {
            let availability = if known_agents.contains(&bookmark.reference.agent_name) {
                UnavailableBookmarkReason::SessionUnavailable
            } else {
                UnavailableBookmarkReason::AgentUnavailable
            };
            let view = UnavailableBookmarkView {
                availability,
                bookmark,
                display_title: None,
            };
            (bookmarked_at, BookmarkView::Unavailable(view))
        };
        views.push((time, bookmarked_at, key, view));
    }
    views.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| crate::locale::compare(&a.2, &b.2))
    });
    Ok(views.into_iter().map(|(.., view)| view).collect())
}

fn validate(reference: &SessionReference, session: &SessionHead) -> Result<()> {
    if session.reference != normalize_reference(reference) {
        bail!("Session reference does not match expected session");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_missing_bookmarks_once_and_preserves_availability() {
        let reference = |id: &str, agent: &str| SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
            agent_name: agent.into(),
            session_id: id.into(),
        };
        let records = vec![
            BookmarkRecord {
                reference: reference("old", "codex"),
                bookmarked_at: 1.0,
            },
            BookmarkRecord {
                reference: reference("gone", "codex"),
                bookmarked_at: 3.0,
            },
            BookmarkRecord {
                reference: reference("gone", "removed"),
                bookmarked_at: 2.0,
            },
        ];
        let cached: SessionHead = serde_json::from_value(json!({
            "reference":{"agentName":"codex","sessionId":"old"},
            "title":"Cached title","directory":"/workspace","time_created":1,"time_updated":8,
            "project_identity":{"key":"/workspace","kind":"path","displayName":"workspace"},
            "stats":{"message_count":1,"total_input_tokens":2,"total_output_tokens":3,"total_cost":0},
            "smart_tags":[]
        })).unwrap();
        let views = materialize_bookmarks(
            &records,
            &HashMap::new(),
            &HashSet::from(["codex".into()]),
            |missing| {
                assert_eq!(missing.len(), 3);
                Ok(vec![(reference("old", "codex"), cached)])
            },
        )
        .unwrap();
        let json = serde_json::to_value(views).unwrap();
        assert_eq!(json[0]["availability"], "available");
        assert_eq!(json[1]["availability"], "session-unavailable");
        assert_eq!(json[2]["availability"], "agent-unavailable");
        assert_eq!(json[0]["reference"]["sessionId"], "old");
    }
}
