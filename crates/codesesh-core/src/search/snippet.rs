use super::HighlightRange;
use super::cjk::{contains_han, is_camel_boundary, is_han_char};
use super::parser::{QueryTerm, parse_terms};
use regex::{Match, Regex, RegexBuilder};
use std::collections::HashMap;

#[derive(Clone)]
struct TermMatcher {
    quoted: bool,
    has_han: bool,
    starts_alnum: bool,
    ends_alnum: bool,
    pattern: Regex,
}

impl TermMatcher {
    fn new(term: &QueryTerm) -> Option<Self> {
        let pattern = RegexBuilder::new(&regex::escape(&term.text))
            .case_insensitive(true)
            .unicode(!term.text.is_ascii())
            .build()
            .ok()?;
        let has_han = contains_han(&term.text);
        let starts_alnum = term.text.chars().next().is_some_and(char::is_alphanumeric);
        let ends_alnum = term.text.chars().last().is_some_and(char::is_alphanumeric);
        Some(Self {
            quoted: term.quoted,
            has_han,
            starts_alnum,
            ends_alnum,
            pattern,
        })
    }

    fn accepts_match(&self, text: &str, hit: Match<'_>) -> bool {
        if self.has_han {
            return true;
        }
        if self.starts_alnum
            && let Some(prev) = text[..hit.start()].chars().next_back()
            && prev.is_alphanumeric()
            && !is_han_char(prev)
        {
            if self.quoted {
                return false;
            }
            let mut rest = text[hit.start()..].chars();
            let curr = rest.next();
            let next = rest.next();
            let camel = prev.is_ascii()
                && curr.is_some_and(|c| c.is_ascii())
                && is_camel_boundary(
                    prev as u8,
                    curr.unwrap() as u8,
                    next.filter(|c| c.is_ascii()).map(|c| c as u8),
                );
            if !camel {
                return false;
            }
        }
        if self.quoted
            && self.ends_alnum
            && let Some(next) = text[hit.end()..].chars().next()
            && next.is_alphanumeric()
            && !is_han_char(next)
        {
            return false;
        }
        true
    }

    fn matches_in<'a>(&self, text: &'a str) -> impl Iterator<Item = Match<'a>> {
        let mut offset = 0;
        std::iter::from_fn(move || {
            loop {
                let hit = self.pattern.find_at(text, offset)?;
                if self.accepts_match(text, hit) {
                    offset = hit.end();
                    return Some(hit);
                }
                offset = hit.start() + hit.as_str().chars().next()?.len_utf8();
            }
        })
    }

    fn is_match(&self, text: &str) -> bool {
        self.matches_in(text).next().is_some()
    }
}

#[derive(Clone)]
pub struct Terms {
    matchers: Vec<TermMatcher>,
    groups: Vec<Vec<usize>>,
}

impl Terms {
    pub fn parse(query: &str) -> Self {
        let mut matchers = Vec::new();
        let mut seen: HashMap<(String, bool), usize> = HashMap::new();
        let mut groups = Vec::new();
        for parsed_group in parse_terms(query) {
            let mut group = Vec::with_capacity(parsed_group.len());
            for term in parsed_group {
                let key = (term.text.to_lowercase(), term.quoted);
                if let Some(&idx) = seen.get(&key) {
                    group.push(idx);
                } else if let Some(matcher) = TermMatcher::new(&term) {
                    let idx = matchers.len();
                    matchers.push(matcher);
                    seen.insert(key, idx);
                    group.push(idx);
                }
            }
            if !group.is_empty() {
                groups.push(group);
            }
        }
        Self { matchers, groups }
    }

    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    #[cfg(test)]
    pub fn matches(&self, text: &str) -> bool {
        if self.groups.is_empty() {
            return true;
        }
        self.satisfied_match(text).is_some()
    }

    pub(crate) fn satisfied_match<'a>(&self, text: &'a str) -> Option<Match<'a>> {
        for group in &self.groups {
            let mut earliest: Option<Match<'a>> = None;
            let mut all_matched = true;
            for &idx in group {
                match self.matchers[idx].matches_in(text).next() {
                    Some(hit) => {
                        if earliest.is_none_or(|best| hit.start() < best.start()) {
                            earliest = Some(hit);
                        }
                    }
                    None => {
                        all_matched = false;
                        break;
                    }
                }
            }
            if all_matched && earliest.is_some() {
                return earliest;
            }
        }
        None
    }

    pub fn matched_indices<'a>(&'a self, text: &'a str) -> impl Iterator<Item = usize> + 'a {
        self.matchers
            .iter()
            .enumerate()
            .filter(move |(_, matcher)| matcher.is_match(text))
            .map(|(idx, _)| idx)
    }

    fn first_match<'a>(&self, text: &'a str) -> Option<Match<'a>> {
        self.satisfied_match(text).or_else(|| {
            self.matchers
                .iter()
                .filter_map(|matcher| matcher.matches_in(text).next())
                .min_by_key(|hit| hit.start())
        })
    }
}

pub fn highlights(text: &str, terms: &Terms) -> Vec<HighlightRange> {
    let mut ranges = Vec::new();
    for matcher in &terms.matchers {
        for hit in matcher.matches_in(text) {
            ranges.push(HighlightRange {
                start: text[..hit.start()].encode_utf16().count(),
                end: text[..hit.end()].encode_utf16().count(),
            });
        }
    }
    ranges.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<HighlightRange> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut().filter(|last| range.start <= last.end) {
            last.end = last.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn slice_utf16_prefix(text: &str, max_units: usize) -> &str {
    let mut units = 0;
    for (idx, ch) in text.char_indices() {
        let len = ch.len_utf16();
        if units + len > max_units {
            return &text[..idx];
        }
        units += len;
    }
    text
}

fn window_start(text: &str, match_start: usize, max_units: usize) -> usize {
    let mut units = 0;
    let mut start = match_start;
    for (idx, ch) in text[..match_start].char_indices().rev() {
        let len = ch.len_utf16();
        if units + len > max_units {
            break;
        }
        units += len;
        start = idx;
    }
    start
}

fn window_end(text: &str, match_end: usize, max_units: usize) -> usize {
    let mut units = 0;
    let mut end = match_end;
    for (offset, ch) in text[match_end..].char_indices() {
        let len = ch.len_utf16();
        if units + len > max_units {
            break;
        }
        units += len;
        end = match_end + offset + ch.len_utf8();
    }
    end
}

pub(crate) fn build_around(
    text: &str,
    hit: Match<'_>,
    terms: &Terms,
) -> (String, Vec<HighlightRange>) {
    let start = window_start(text, hit.start(), 80);
    let end = window_end(text, hit.end(), 80);
    let snippet = format!(
        "{}{}{}",
        if start > 0 { "… " } else { "" },
        &text[start..end],
        if end < text.len() { " …" } else { "" }
    );
    let ranges = highlights(&snippet, terms);
    (snippet, ranges)
}

pub fn build(text: &str, terms: &Terms) -> (String, Vec<HighlightRange>) {
    if terms.is_empty() {
        return (slice_utf16_prefix(text, 180).to_owned(), Vec::new());
    }
    let Some(hit) = terms.first_match(text) else {
        let slice = slice_utf16_prefix(text, 80);
        let snippet = if slice.len() < text.len() {
            format!("{slice} …")
        } else {
            slice.to_owned()
        };
        let ranges = highlights(&snippet, terms);
        return (snippet, ranges);
    };
    build_around(text, hit, terms)
}
