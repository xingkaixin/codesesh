use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Serialize;
use std::collections::VecDeque;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaginationError {
    InvalidCursor,
    StaleSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T, V> {
    pub items: Vec<T>,
    pub view: V,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

#[derive(Serialize)]
struct Cursor {
    version: u8,
    snapshot: String,
    offset: u64,
}

struct Snapshot<T, V> {
    id: String,
    query: Vec<(String, String)>,
    expires: i64,
    items: Vec<T>,
    view: V,
}

pub struct SnapshotPaginator<T, V> {
    snapshots: VecDeque<Snapshot<T, V>>,
}

impl<T, V> Default for SnapshotPaginator<T, V> {
    fn default() -> Self {
        Self {
            snapshots: VecDeque::new(),
        }
    }
}

impl<T: Clone, V: Clone> SnapshotPaginator<T, V> {
    pub fn paginate(
        &mut self,
        now: i64,
        query: &[(String, String)],
        cursor: Option<&str>,
        limit: usize,
        load: impl FnOnce() -> (Vec<T>, V),
    ) -> Result<Page<T, V>, PaginationError> {
        if limit == 0 {
            return Err(PaginationError::InvalidCursor);
        }
        self.snapshots.retain(|s| s.expires > now);
        let mut query: Vec<_> = query
            .iter()
            .filter(|(key, _)| key != "cursor" && key != "limit")
            .cloned()
            .collect();
        query.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
        let cursor = cursor.filter(|c| !c.is_empty());
        let (snapshot, offset, retain);
        let fresh;
        if let Some(encoded) = cursor {
            if encoded.len() > 512
                || !encoded
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(PaginationError::InvalidCursor);
            }
            let bytes = URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| PaginationError::InvalidCursor)?;
            let decoded: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| PaginationError::InvalidCursor)?;
            let number = decoded["offset"]
                .as_f64()
                .ok_or(PaginationError::InvalidCursor)?;
            let snapshot_id = decoded["snapshot"]
                .as_str()
                .ok_or(PaginationError::InvalidCursor)?;
            if decoded["version"].as_f64() != Some(1.0)
                || number <= 0.0
                || number > 9_007_199_254_740_991.0
                || number.fract() != 0.0
            {
                return Err(PaginationError::InvalidCursor);
            }
            snapshot = self
                .snapshots
                .iter()
                .find(|s| s.id == snapshot_id)
                .ok_or(PaginationError::StaleSnapshot)?;
            if snapshot.query != query || number >= snapshot.items.len() as f64 {
                return Err(PaginationError::InvalidCursor);
            }
            offset = number as usize;
            retain = false;
        } else {
            let (items, view) = load();
            fresh = Snapshot {
                id: uuid::Uuid::new_v4().to_string(),
                query,
                expires: now.saturating_add(60_000),
                items,
                view,
            };
            snapshot = &fresh;
            offset = 0;
            retain = true;
        }
        let end = offset.saturating_add(limit).min(snapshot.items.len());
        let next_cursor = (end < snapshot.items.len()).then(|| {
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&Cursor {
                    version: 1,
                    snapshot: snapshot.id.clone(),
                    offset: end as u64,
                })
                .expect("serializable cursor"),
            )
        });
        let page = Page {
            items: snapshot.items[offset..end].to_vec(),
            view: snapshot.view.clone(),
            next_cursor,
        };
        if retain && page.next_cursor.is_some() {
            let retained = Snapshot {
                id: snapshot.id.clone(),
                query: snapshot.query.clone(),
                expires: snapshot.expires,
                items: snapshot.items.clone(),
                view: snapshot.view.clone(),
            };
            if self.snapshots.len() >= 32 {
                self.snapshots.pop_front();
            }
            self.snapshots.push_back(retained);
        }
        Ok(page)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retained_page_survives_mutation_and_rejects_changed_query() {
        let mut paginator = SnapshotPaginator::default();
        let query = vec![("agent".into(), "codex".into())];
        let first = paginator
            .paginate(0, &query, None, 1, || (vec![1, 2, 3], "old"))
            .unwrap();
        let cursor = first.next_cursor.unwrap();
        let second = paginator
            .paginate(10, &query, Some(&cursor), 1, || (vec![99], "new"))
            .unwrap();
        assert_eq!(second.items, vec![2]);
        assert_eq!(second.view, "old");
        assert_eq!(
            paginator
                .paginate(10, &[], Some(&cursor), 1, || (vec![], "new"))
                .unwrap_err(),
            PaginationError::InvalidCursor
        );
        assert_eq!(
            paginator
                .paginate(60_000, &query, Some(&cursor), 1, || (vec![], "new"))
                .unwrap_err(),
            PaginationError::StaleSnapshot
        );
    }
}
