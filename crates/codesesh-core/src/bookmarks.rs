use crate::{
    contract::{SessionHead, SessionReference},
    state::{BookmarkRecord, normalize_reference, reference_key},
};
use anyhow::{Result, bail};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use ts_rs::TS;

#[derive(Clone, Debug, Serialize, TS)]
#[serde(tag = "availability", rename_all = "kebab-case")]
pub enum BookmarkView {
    Available {
        #[serde(flatten)]
        bookmark: BookmarkRecord,
        session: Box<SessionHead>,
    },
    SessionUnavailable {
        #[serde(flatten)]
        bookmark: BookmarkRecord,
    },
    AgentUnavailable {
        #[serde(flatten)]
        bookmark: BookmarkRecord,
    },
}

impl BookmarkView {
    pub fn bookmark(&self) -> &BookmarkRecord {
        match self {
            Self::Available { bookmark, .. }
            | Self::SessionUnavailable { bookmark }
            | Self::AgentUnavailable { bookmark } => bookmark,
        }
    }
    fn time(&self) -> f64 {
        match self {
            Self::Available { session, .. } => session.time_updated,
            _ => self.bookmark().bookmarked_at,
        }
    }
}

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
        if let Some(session) = live.get(&key).or_else(|| cached.get(&key)) {
            validate(&bookmark.reference, session)?;
            views.push(BookmarkView::Available {
                bookmark,
                session: Box::new(session.clone().public()),
            });
        } else if known_agents.contains(&bookmark.reference.agent_name) {
            views.push(BookmarkView::SessionUnavailable { bookmark });
        } else {
            views.push(BookmarkView::AgentUnavailable { bookmark });
        }
    }
    views.sort_by(|a, b| {
        b.time()
            .total_cmp(&a.time())
            .then_with(|| {
                b.bookmark()
                    .bookmarked_at
                    .total_cmp(&a.bookmark().bookmarked_at)
            })
            .then_with(|| {
                crate::locale::compare(
                    &reference_key(&a.bookmark().reference),
                    &reference_key(&b.bookmark().reference),
                )
            })
    });
    Ok(views)
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
