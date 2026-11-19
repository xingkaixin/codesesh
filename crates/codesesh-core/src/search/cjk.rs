use super::{
    parser::{QueryTerm, parse_terms},
    reader::HEAD_COLUMNS,
    sql::{self, Filters},
};
use crate::model::SessionHead;
use anyhow::Result;
use regex::{Regex, RegexBuilder};
use rusqlite::{Connection, params_from_iter, types::Value};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

static HAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Han}").unwrap());

const CANDIDATE_CHUNK_SIZE: usize = 500;
const NON_HAN_HIT_CAP: usize = 2000;

pub(super) fn contains_han(text: &str) -> bool {
    !text.is_ascii() && HAN.is_match(text)
}

pub(super) fn is_han_char(ch: char) -> bool {
    if ch.is_ascii() {
        return false;
    }
    let mut buf = [0u8; 4];
    HAN.is_match(ch.encode_utf8(&mut buf))
}

pub(crate) fn is_camel_boundary(prev: u8, curr: u8, next: Option<u8>) -> bool {
    (prev.is_ascii_lowercase() && curr.is_ascii_uppercase())
        || (prev.is_ascii_digit() && curr.is_ascii_uppercase())
        || (prev.is_ascii_uppercase()
            && curr.is_ascii_uppercase()
            && next.is_some_and(|b| b.is_ascii_lowercase()))
}

// unicode61 keeps continuous Han text in one token; one token per character makes
// substrings phrase-searchable.
pub(crate) fn index_text(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        Cow::Borrowed(text)
    } else {
        HAN.replace_all(text, " $0 ")
    }
}

fn split_code_tokens(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut i = 0;
    let mut seen: Option<HashSet<String>> = None;
    let mut out = String::new();
    while i < bytes.len() {
        if !bytes[i].is_ascii_alphanumeric() {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_alphanumeric() {
            i += 1;
        }
        let run = &bytes[start..i];
        if run.len() < 2 {
            continue;
        }
        let mut part_start = 0;
        let mut has_split = false;
        for pos in 1..run.len() {
            let next = run.get(pos + 1).copied();
            if is_camel_boundary(run[pos - 1], run[pos], next) {
                has_split = true;
                push_code_token(&run[part_start..pos], &mut seen, &mut out);
                part_start = pos;
            }
        }
        if has_split {
            push_code_token(&run[part_start..], &mut seen, &mut out);
        }
    }
    out
}

fn push_code_token(slice: &[u8], seen: &mut Option<HashSet<String>>, out: &mut String) {
    let token = std::str::from_utf8(slice)
        .expect("ASCII alphanumeric slice is valid UTF-8")
        .to_ascii_lowercase();
    let set = seen.get_or_insert_with(HashSet::new);
    if set.insert(token.clone()) {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&token);
    }
}

pub(crate) fn index_parts(text: &str) -> (Cow<'_, str>, String) {
    (index_text(text), split_code_tokens(text))
}

fn fts_expr(term: &QueryTerm, primary_col: &str) -> String {
    let has_han = contains_han(&term.text);
    let indexed = index_text(&term.text);
    let escaped = indexed.replace('"', "\"\"");
    let prefix = !term.quoted
        && term
            .text
            .chars()
            .last()
            .is_some_and(|ch| ch.is_alphanumeric() && !is_han_char(ch));
    let phrase = if prefix {
        format!("\"{escaped}\"*")
    } else {
        format!("\"{escaped}\"")
    };
    let single_alnum_token =
        !term.quoted && !has_han && term.text.chars().all(char::is_alphanumeric);
    if single_alnum_token {
        phrase
    } else {
        format!("{primary_col}:{phrase}")
    }
}

pub(super) struct MatchedSession {
    pub session: SessionHead,
    pub title_match: bool,
    pub message_hits: Vec<(i64, i64)>,
}

struct TermData {
    title_hits: HashSet<i64>,
    // session_rowid -> Vec<(message_index, message_rowid)>
    message_hits: HashMap<i64, Vec<(i64, i64)>>,
    han_pattern: Option<Regex>,
}

impl TermData {
    fn is_empty(&self) -> bool {
        self.title_hits.is_empty() && self.message_hits.is_empty()
    }

    fn candidate_count(&self) -> usize {
        self.title_hits.len() + self.message_hits.len()
    }

    fn has_session(&self, session_rowid: i64) -> bool {
        self.title_hits.contains(&session_rowid) || self.message_hits.contains_key(&session_rowid)
    }

    fn matches_title(&self, session_rowid: i64, title: Option<&str>) -> bool {
        if !self.title_hits.contains(&session_rowid) {
            return false;
        }
        match &self.han_pattern {
            None => true,
            Some(pattern) => title.is_some_and(|t| pattern.is_match(t)),
        }
    }

    fn matches_session(
        &self,
        connection: &Connection,
        session_rowid: i64,
        cached_title: &mut Option<String>,
    ) -> Result<bool> {
        let Some(pattern) = &self.han_pattern else {
            return Ok(self.has_session(session_rowid));
        };
        if self.title_hits.contains(&session_rowid) {
            let title = match cached_title {
                Some(title) => title.as_str(),
                None => {
                    let loaded: String = connection
                        .prepare_cached("SELECT title FROM sessions WHERE rowid=?")?
                        .query_row([session_rowid], |row| row.get(0))?;
                    cached_title.insert(loaded).as_str()
                }
            };
            if pattern.is_match(title) {
                return Ok(true);
            }
        }
        if let Some(hits) = self.message_hits.get(&session_rowid) {
            let mut content =
                connection.prepare_cached("SELECT content_text FROM messages WHERE rowid=?")?;
            for &(_, msg_rowid) in hits {
                if pattern.is_match(&content.query_row([msg_rowid], |row| row.get::<_, String>(0))?)
                {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

struct RankedCandidate {
    rowid: i64,
    activity_time: f64,
    title_match: bool,
    title: Option<String>,
}

pub(super) fn search_candidates(
    connection: &Connection,
    query: &str,
    options: &super::SearchOptions,
    limit: usize,
) -> Result<Vec<MatchedSession>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let parsed_groups = parse_terms(query);
    if parsed_groups.is_empty() {
        return Ok(Vec::new());
    }
    let parts = sql::build_parts(options);
    if parts.impossible {
        return Ok(Vec::new());
    }
    if !parts.session_cheap.clauses.is_empty()
        && !any_visible_session(connection, &parts.session_cheap)?
    {
        return Ok(Vec::new());
    }

    let mut unique_terms: Vec<QueryTerm> = Vec::new();
    let mut term_index: HashMap<(String, bool), usize> = HashMap::new();
    let mut groups: Vec<Vec<usize>> = Vec::with_capacity(parsed_groups.len());
    for group in parsed_groups {
        let mut indices = Vec::with_capacity(group.len());
        for term in group {
            let key = (term.text.to_lowercase(), term.quoted);
            let idx = *term_index.entry(key).or_insert_with(|| {
                let idx = unique_terms.len();
                unique_terms.push(term);
                idx
            });
            if !indices.contains(&idx) {
                indices.push(idx);
            }
        }
        if !indices.is_empty() {
            groups.push(indices);
        }
    }

    let mut term_data: Vec<Option<TermData>> = (0..unique_terms.len()).map(|_| None).collect();
    for group in &groups {
        for &idx in group {
            if term_data[idx].is_none() {
                term_data[idx] = Some(fetch_term(
                    connection,
                    &unique_terms[idx],
                    &parts.session_cheap,
                    &parts.message_cheap,
                )?);
            }
            if term_data[idx].as_ref().is_some_and(TermData::is_empty) {
                break;
            }
        }
    }

    let mut candidate_rowids: HashSet<i64> = HashSet::new();
    let mut title_candidate_rowids: HashSet<i64> = HashSet::new();
    for group in &groups {
        if group
            .iter()
            .any(|&idx| term_data[idx].as_ref().is_none_or(TermData::is_empty))
        {
            continue;
        }
        let smallest = *group
            .iter()
            .min_by_key(|&&idx| term_data[idx].as_ref().unwrap().candidate_count())
            .unwrap();
        let pivot = term_data[smallest].as_ref().unwrap();
        let matches_group = |rowid: i64| {
            group
                .iter()
                .all(|&idx| idx == smallest || term_data[idx].as_ref().unwrap().has_session(rowid))
        };
        for &rowid in &pivot.title_hits {
            if matches_group(rowid) {
                candidate_rowids.insert(rowid);
            }
        }
        for &rowid in pivot.message_hits.keys() {
            if !pivot.title_hits.contains(&rowid) && matches_group(rowid) {
                candidate_rowids.insert(rowid);
            }
        }

        if group
            .iter()
            .all(|&idx| !term_data[idx].as_ref().unwrap().title_hits.is_empty())
        {
            let title_pivot = *group
                .iter()
                .min_by_key(|&&idx| term_data[idx].as_ref().unwrap().title_hits.len())
                .unwrap();
            for &rowid in &term_data[title_pivot].as_ref().unwrap().title_hits {
                if group.iter().all(|&idx| {
                    idx == title_pivot
                        || term_data[idx].as_ref().unwrap().title_hits.contains(&rowid)
                }) {
                    title_candidate_rowids.insert(rowid);
                }
            }
        }
    }

    if candidate_rowids.is_empty() {
        return Ok(Vec::new());
    }

    let any_han = term_data
        .iter()
        .flatten()
        .any(|data| data.han_pattern.is_some());

    let title_texts: HashMap<i64, String> = if any_han && !title_candidate_rowids.is_empty() {
        fetch_titles(connection, &title_candidate_rowids)?
    } else {
        HashMap::new()
    };

    let rowid_list: Vec<i64> = candidate_rowids.into_iter().collect();
    let mut ranked = Vec::with_capacity(rowid_list.len());
    for chunk in rowid_list.chunks(CANDIDATE_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let mut params: Vec<Value> = chunk.iter().copied().map(Value::Integer).collect();
        params.extend(parts.extra.params.iter().cloned());
        let sql = format!(
            "SELECT s.rowid,s.activity_time FROM sessions s WHERE s.rowid IN ({placeholders}) AND s.publication_id IS NULL {}",
            parts.extra.where_sql(),
        );
        let mut statement = connection.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(params))?;
        while let Some(row) = rows.next()? {
            let rowid: i64 = row.get(0)?;
            let activity_time: f64 = row.get(1)?;
            let title = title_texts.get(&rowid).cloned();
            let title_match = if !title_candidate_rowids.contains(&rowid) {
                false
            } else if !any_han {
                true
            } else {
                groups.iter().any(|group| {
                    group.iter().all(|&idx| {
                        term_data[idx]
                            .as_ref()
                            .is_some_and(|term| term.matches_title(rowid, title.as_deref()))
                    })
                })
            };
            ranked.push(RankedCandidate {
                rowid,
                activity_time,
                title_match,
                title,
            });
        }
    }

    ranked.sort_unstable_by(|a, b| {
        b.title_match
            .cmp(&a.title_match)
            .then_with(|| b.activity_time.total_cmp(&a.activity_time))
            .then_with(|| b.rowid.cmp(&a.rowid))
    });

    let mut head_stmt = connection.prepare_cached(&format!(
        "SELECT {HEAD_COLUMNS} FROM sessions s WHERE s.rowid=?"
    ))?;
    let mut results = Vec::with_capacity(limit.min(ranked.len()));
    for mut candidate in ranked {
        if results.len() >= limit {
            break;
        }
        if !candidate.title_match
            && any_han
            && !accepts_session(
                connection,
                candidate.rowid,
                &mut candidate.title,
                &term_data,
                &groups,
            )?
        {
            continue;
        }
        let session = head_stmt.query_row([candidate.rowid], super::reader::head)?;
        let message_hits = if candidate.title_match {
            Vec::new()
        } else {
            collect_session_message_hits(candidate.rowid, &term_data, &groups)
        };
        results.push(MatchedSession {
            session,
            title_match: candidate.title_match,
            message_hits,
        });
    }
    Ok(results)
}

fn any_visible_session(connection: &Connection, filters: &Filters) -> Result<bool> {
    let sql = format!(
        "SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.publication_id IS NULL {})",
        filters.where_sql()
    );
    let exists: i64 =
        connection.query_row(&sql, params_from_iter(&filters.params), |r| r.get(0))?;
    Ok(exists != 0)
}

fn fetch_titles(connection: &Connection, rowids: &HashSet<i64>) -> Result<HashMap<i64, String>> {
    let list: Vec<i64> = rowids.iter().copied().collect();
    let mut titles = HashMap::with_capacity(list.len());
    for chunk in list.chunks(CANDIDATE_CHUNK_SIZE) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let params: Vec<Value> = chunk.iter().copied().map(Value::Integer).collect();
        let sql = format!("SELECT rowid,title FROM sessions WHERE rowid IN ({placeholders})");
        let mut statement = connection.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(params))?;
        while let Some(row) = rows.next()? {
            titles.insert(row.get(0)?, row.get(1)?);
        }
    }
    Ok(titles)
}

fn fetch_term(
    connection: &Connection,
    term: &QueryTerm,
    session_cheap: &Filters,
    message_cheap: &Filters,
) -> Result<TermData> {
    let han_pattern = if contains_han(&term.text) {
        Some(
            RegexBuilder::new(&regex::escape(&term.text))
                .case_insensitive(true)
                .build()?,
        )
    } else {
        None
    };

    let title_query = fts_expr(term, "title");
    let title_hits = query_title_hits(connection, &title_query, session_cheap)?;

    let message_query = fts_expr(term, "content_text");
    let message_hits = query_message_hits(
        connection,
        &message_query,
        session_cheap,
        message_cheap,
        han_pattern.is_none(),
    )?;

    Ok(TermData {
        title_hits,
        message_hits,
        han_pattern,
    })
}

fn query_title_hits(
    connection: &Connection,
    fts_query: &str,
    session_cheap: &Filters,
) -> Result<HashSet<i64>> {
    // CROSS JOIN forces SQLite to drive from session_title_fts rather than scanning sessions.
    let sql = format!(
        "SELECT s.rowid FROM session_title_fts CROSS JOIN sessions s ON s.rowid=session_title_fts.rowid WHERE session_title_fts MATCH ? AND s.publication_id IS NULL {}",
        session_cheap.where_sql(),
    );
    let mut params = Vec::with_capacity(1 + session_cheap.params.len());
    params.push(Value::Text(fts_query.to_owned()));
    params.extend(session_cheap.params.iter().cloned());
    let mut statement = connection.prepare(&sql)?;
    let rowids = statement
        .query_map(params_from_iter(params), |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rowids)
}

fn query_message_hits(
    connection: &Connection,
    fts_query: &str,
    session_cheap: &Filters,
    message_cheap: &Filters,
    cap_hits: bool,
) -> Result<HashMap<i64, Vec<(i64, i64)>>> {
    // CROSS JOIN keeps message_fts as the outer loop so FTS5 MATCH runs once per term.
    let sql = format!(
        "SELECT m.rowid,m.message_index,s.rowid FROM message_fts CROSS JOIN messages m ON m.rowid=message_fts.rowid CROSS JOIN sessions s ON s.source_node_id=m.source_node_id AND s.agent_name=m.agent_name AND s.session_id=m.session_id WHERE message_fts MATCH ? AND s.publication_id IS NULL {}{}",
        message_cheap.where_sql(),
        session_cheap.where_sql(),
    );
    let mut params =
        Vec::with_capacity(1 + message_cheap.params.len() + session_cheap.params.len());
    params.push(Value::Text(fts_query.to_owned()));
    params.extend(message_cheap.params.iter().cloned());
    params.extend(session_cheap.params.iter().cloned());
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params_from_iter(params))?;
    let mut hits: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    while let Some(row) = rows.next()? {
        let msg_rowid: i64 = row.get(0)?;
        let msg_index: i64 = row.get(1)?;
        let session_rowid: i64 = row.get(2)?;
        let entry = hits.entry(session_rowid).or_default();
        entry.push((msg_index, msg_rowid));
        if cap_hits && entry.len() >= NON_HAN_HIT_CAP * 2 {
            entry.sort_unstable();
            entry.truncate(NON_HAN_HIT_CAP);
        }
    }
    Ok(hits)
}

fn accepts_session(
    connection: &Connection,
    session_rowid: i64,
    cached_title: &mut Option<String>,
    term_data: &[Option<TermData>],
    groups: &[Vec<usize>],
) -> Result<bool> {
    let mut verified: HashMap<usize, bool> = HashMap::new();
    'groups: for group in groups {
        for &idx in group {
            let matched = if let Some(&cached) = verified.get(&idx) {
                cached
            } else {
                let Some(term) = term_data[idx].as_ref() else {
                    continue 'groups;
                };
                let result = term.matches_session(connection, session_rowid, cached_title)?;
                verified.insert(idx, result);
                result
            };
            if !matched {
                continue 'groups;
            }
        }
        return Ok(true);
    }
    Ok(false)
}

fn collect_session_message_hits(
    session_rowid: i64,
    term_data: &[Option<TermData>],
    groups: &[Vec<usize>],
) -> Vec<(i64, i64)> {
    let mut full_match: HashSet<(i64, i64)> = HashSet::new();
    for group in groups {
        let lists: Option<Vec<&[(i64, i64)]>> = group
            .iter()
            .map(|&idx| {
                term_data[idx]
                    .as_ref()
                    .and_then(|t| t.message_hits.get(&session_rowid))
                    .map(Vec::as_slice)
            })
            .collect();
        let Some(lists) = lists else {
            continue;
        };
        if lists.len() == 1 {
            full_match.extend(lists[0].iter().copied());
            continue;
        }
        let (smallest_idx, _) = lists
            .iter()
            .enumerate()
            .min_by_key(|(_, list)| list.len())
            .unwrap();
        let other_sets: Vec<HashSet<(i64, i64)>> = lists
            .iter()
            .enumerate()
            .filter(|&(i, _)| i != smallest_idx)
            .map(|(_, list)| list.iter().copied().collect())
            .collect();
        for &item in lists[smallest_idx] {
            if other_sets.iter().all(|set| set.contains(&item)) {
                full_match.insert(item);
            }
        }
    }

    let mut primary: Vec<(i64, i64)> = full_match.iter().copied().collect();
    primary.sort_unstable();

    let mut fallback: Vec<(i64, i64)> = Vec::new();
    let mut seen = full_match;
    for term in term_data.iter().flatten() {
        if let Some(list) = term.message_hits.get(&session_rowid) {
            for &item in list {
                if seen.insert(item) {
                    fallback.push(item);
                }
            }
        }
    }
    fallback.sort_unstable();
    primary.extend(fallback);
    primary
}
