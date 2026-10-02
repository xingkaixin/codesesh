use super::{snippet, split_tokens, sql::Filters, to_fts_query};
use anyhow::Result;
use regex::{Regex, RegexBuilder};
use rusqlite::{
    Connection,
    functions::{Context, FunctionFlags},
};
use std::sync::LazyLock;

pub(super) fn contains_han(text: &str) -> bool {
    static HAN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Han}").unwrap());
    HAN.is_match(text)
}

fn text<'a>(context: &'a Context<'_>) -> rusqlite::Result<&'a str> {
    context
        .get_raw(0)
        .as_str()
        .map_err(|error| rusqlite::Error::UserFunctionError(Box::new(error)))
}

pub(super) fn statement(
    connection: &Connection,
    query: &str,
    filters: &mut Filters,
) -> Result<String> {
    let mut conditions = Vec::new();
    let mut patterns = Vec::new();
    let mut conjunction = false;
    for token in split_tokens(&to_fts_query(query)) {
        if token == "OR" {
            conditions.push("OR".to_owned());
            conjunction = false;
            continue;
        }
        if conjunction {
            conditions.push("AND".into());
        }
        if contains_han(&token) {
            // unicode61 keeps continuous Han text in one token, hiding inner substrings.
            let literal = token[1..token.len() - 1].replace("\"\"", "\"");
            let index = patterns.len();
            patterns.push(
                RegexBuilder::new(&regex::escape(&literal))
                    .case_insensitive(true)
                    .build()?,
            );
            conditions.push(format!("(codesesh_cjk_matches(d.title,{index}) OR codesesh_cjk_matches(d.content_text,{index}))"));
        } else {
            conditions.push("d.id IN (SELECT rowid FROM session_documents_fts WHERE session_documents_fts MATCH ?)".into());
            filters.params.push(token.into());
        }
        conjunction = true;
    }
    let flags = FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC;
    connection.create_scalar_function("codesesh_cjk_matches", 2, flags, move |context| {
        let index = context.get::<i64>(1)? as usize;
        Ok(patterns[index].is_match(text(context)?))
    })?;
    let terms = snippet::Terms::parse(query);
    let title_terms = terms.clone();
    connection.create_scalar_function("codesesh_cjk_title_match", 1, flags, move |context| {
        Ok(title_terms.matches(text(context)?))
    })?;
    connection.create_scalar_function("codesesh_cjk_snippet", 1, flags, move |context| {
        Ok(snippet::build(text(context)?, &terms).0)
    })?;
    Ok(format!(
        "SELECT s.*, CASE WHEN codesesh_cjk_title_match(s.title) THEN '' ELSE codesesh_cjk_snippet(d.content_text) END AS snippet FROM sessions s JOIN session_documents d ON d.source_node_id=s.source_node_id AND d.agent_name=s.agent_name AND d.session_id=s.session_id WHERE s.publication_id IS NULL {} AND ({}) ORDER BY codesesh_cjk_title_match(s.title) DESC,s.activity_time DESC LIMIT ?",
        filters.where_sql(),
        conditions.join(" "),
    ))
}
