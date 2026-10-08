use super::{snippet, split_tokens, sql::Filters, to_fts_query};
use anyhow::Result;
use regex::{Regex, RegexBuilder};
use rusqlite::{
    Connection,
    functions::{Context, FunctionFlags},
};
use std::{borrow::Cow, sync::LazyLock};

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

pub(super) struct Statement {
    pub sql: String,
    pub any_message: String,
}

pub(super) fn statement(
    connection: &Connection,
    query: &str,
    filters: &mut Filters,
) -> Result<Option<Statement>> {
    let tokens = split_tokens(&to_fts_query(query));
    if tokens.is_empty() {
        return Ok(None);
    }
    let messages = "(s.source_node_id,s.agent_name,s.session_id) IN (SELECT m.source_node_id,m.agent_name,m.session_id FROM message_fts JOIN messages m ON m.rowid=message_fts.rowid WHERE message_fts MATCH ?";
    let mut conditions = Vec::new();
    let mut alternatives = Vec::new();
    let mut patterns = Vec::new();
    let mut conjunction = false;
    for token in tokens {
        if token == "OR" {
            conditions.push("OR".to_owned());
            conjunction = false;
            continue;
        }
        if conjunction {
            conditions.push("AND".into());
        }
        let literal = token[1..token.len() - 1].replace("\"\"", "\"");
        let message_phrase = phrase(&literal);
        alternatives.push(message_phrase.clone());
        if contains_han(&literal) {
            let index = patterns.len();
            patterns.push(
                RegexBuilder::new(&regex::escape(&literal))
                    .case_insensitive(true)
                    .build()?,
            );
            conditions.push(format!(
                "(codesesh_text_matches(s.title,{index}) OR {messages} AND codesesh_text_matches(m.content_text,{index})))"
            ));
        } else {
            conditions.push(format!(
                "(s.rowid IN (SELECT rowid FROM session_title_fts WHERE session_title_fts MATCH ?) OR {messages}))"
            ));
            filters.params.push(token.into());
        }
        filters.params.push(message_phrase.into());
        conjunction = true;
    }
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    connection.create_scalar_function("codesesh_text_matches", 2, flags, move |context| {
        let index = context.get::<i64>(1)? as usize;
        Ok(patterns[index].is_match(text(context)?))
    })?;
    let terms = snippet::Terms::parse(query);
    connection.create_scalar_function("codesesh_title_match", 1, flags, move |context| {
        Ok(terms.matches(text(context)?))
    })?;
    Ok(Some(Statement {
        sql: format!(
            "SELECT {} FROM sessions s WHERE s.publication_id IS NULL {} AND ({}) ORDER BY codesesh_title_match(s.title) DESC,s.activity_time DESC LIMIT ?",
            super::reader::HEAD_COLUMNS,
            filters.where_sql(),
            conditions.join(" "),
        ),
        any_message: alternatives.join(" OR "),
    }))
}
