use super::{snippet, split_tokens, sql::Filters, to_fts_query};
use crate::contract::{SessionHead, SessionReference};
use anyhow::Result;
use regex::{Regex, RegexBuilder};
use rusqlite::{
    Connection,
    functions::{Context, FunctionFlags},
    params_from_iter,
    types::Value,
};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

static HAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Han}").unwrap());

pub(super) fn contains_han(text: &str) -> bool {
    HAN.is_match(text)
}

// unicode61 keeps continuous Han text in one token; one token per character makes
// substrings phrase-searchable.
pub(crate) fn index_text(text: &str) -> Cow<'_, str> {
    HAN.replace_all(text, " $0 ")
}

fn text<'a>(context: &'a Context<'_>) -> rusqlite::Result<&'a str> {
    context
        .get_raw(0)
        .as_str()
        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
}

fn phrase(literal: &str) -> String {
    format!("\"{}\"", index_text(literal).replace('"', "\"\""))
}

struct Term {
    hits: HashMap<SessionReference, Vec<i64>>,
    title: Title,
}

enum Title {
    Indexed(HashSet<i64>),
    // Per-character phrases also match Han text split by spaces or punctuation, so
    // the literal is confirmed while walking sessions in result order; only sessions
    // up to the limit read message text.
    Han(Regex),
}

struct Candidate {
    rowid: i64,
    reference: SessionReference,
    title: String,
}

pub(super) struct Statement {
    sql: String,
    params: Vec<Value>,
    pub any_message: String,
    terms: Vec<Term>,
    groups: Vec<Vec<usize>>,
}

pub(super) fn statement(
    connection: &Connection,
    query: &str,
    filters: Filters,
) -> Result<Option<Statement>> {
    let tokens = split_tokens(&to_fts_query(query));
    if tokens.is_empty() {
        return Ok(None);
    }
    let mut terms = Vec::new();
    let mut groups = Vec::new();
    let mut group = Vec::new();
    let mut alternatives = Vec::new();
    for token in tokens {
        if token == "OR" {
            groups.push(std::mem::take(&mut group));
            continue;
        }
        let literal = token[1..token.len() - 1].replace("\"\"", "\"");
        let message_phrase = phrase(&literal);
        group.push(terms.len());
        terms.push(Term {
            hits: hits(connection, &message_phrase)?,
            title: if contains_han(&literal) {
                Title::Han(
                    RegexBuilder::new(&regex::escape(&literal))
                        .case_insensitive(true)
                        .build()?,
                )
            } else {
                Title::Indexed(titles(connection, &token)?)
            },
        });
        alternatives.push(message_phrase);
    }
    groups.push(group);
    let title_terms = snippet::Terms::parse(query);
    connection.create_scalar_function(
        "codesesh_title_match",
        1,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        move |context| Ok(title_terms.matches(text(context)?)),
    )?;
    Ok(Some(Statement {
        sql: format!(
            "SELECT s.rowid,s.source_node_id,s.agent_name,s.session_id,s.title FROM sessions s WHERE s.publication_id IS NULL {} ORDER BY codesesh_title_match(s.title) DESC,s.activity_time DESC",
            filters.where_sql(),
        ),
        params: filters.params,
        any_message: alternatives.join(" OR "),
        terms,
        groups,
    }))
}

fn titles(connection: &Connection, query: &str) -> Result<HashSet<i64>> {
    let mut statement = connection
        .prepare_cached("SELECT rowid FROM session_title_fts WHERE session_title_fts MATCH ?")?;
    let rowids = statement
        .query_map([query], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rowids)
}

fn hits(connection: &Connection, phrase: &str) -> Result<HashMap<SessionReference, Vec<i64>>> {
    let mut statement = connection.prepare_cached(
        "SELECT m.rowid,m.source_node_id,m.agent_name,m.session_id FROM message_fts JOIN messages m ON m.rowid=message_fts.rowid WHERE message_fts MATCH ?",
    )?;
    let mut rows = statement.query([phrase])?;
    let mut hits: HashMap<SessionReference, Vec<i64>> = HashMap::new();
    while let Some(row) = rows.next()? {
        hits.entry(SessionReference {
            source_node_id: row.get(1)?,
            agent_name: row.get(2)?,
            session_id: row.get(3)?,
        })
        .or_default()
        .push(row.get(0)?);
    }
    Ok(hits)
}

impl Statement {
    pub fn rows(&self, connection: &Connection, limit: usize) -> Result<Vec<SessionHead>> {
        let mut statement = connection.prepare(&self.sql)?;
        let mut rows = statement.query(params_from_iter(&self.params))?;
        let mut head = connection.prepare_cached(&format!(
            "SELECT {} FROM sessions s WHERE s.rowid=?",
            super::reader::HEAD_COLUMNS
        ))?;
        let mut heads = Vec::new();
        while heads.len() < limit
            && let Some(row) = rows.next()?
        {
            let candidate = Candidate {
                rowid: row.get(0)?,
                reference: SessionReference {
                    source_node_id: row.get(1)?,
                    agent_name: row.get(2)?,
                    session_id: row.get(3)?,
                },
                title: row.get(4)?,
            };
            if self.accepts(connection, &candidate)? {
                heads.push(head.query_row([candidate.rowid], super::reader::head)?);
            }
        }
        Ok(heads)
    }

    fn accepts(&self, connection: &Connection, candidate: &Candidate) -> Result<bool> {
        'groups: for group in &self.groups {
            for &term in group {
                if !self.terms[term].matches(connection, candidate)? {
                    continue 'groups;
                }
            }
            return Ok(true);
        }
        Ok(false)
    }
}

impl Term {
    fn matches(&self, connection: &Connection, candidate: &Candidate) -> Result<bool> {
        let hits = self.hits.get(&candidate.reference);
        let pattern = match &self.title {
            Title::Indexed(titles) => {
                return Ok(hits.is_some() || titles.contains(&candidate.rowid));
            }
            Title::Han(pattern) => pattern,
        };
        if pattern.is_match(&candidate.title) {
            return Ok(true);
        }
        let mut content =
            connection.prepare_cached("SELECT content_text FROM messages WHERE rowid=?")?;
        for rowid in hits.into_iter().flatten() {
            if pattern.is_match(&content.query_row([rowid], |row| row.get::<_, String>(0))?) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
