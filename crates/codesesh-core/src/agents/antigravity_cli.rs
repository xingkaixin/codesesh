use super::{ParsedSession, deepchat::common};
use crate::{model::*, pricing::Pricing};
use anyhow::{Context, Result};
use prost::Message as _;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};

mod proto;

pub fn scan(root: &Path, data_root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let mut paths = Vec::new();
    if root.try_exists()? {
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            let entry = entry?;
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|ext| ext == "db")
            {
                paths.push(entry.into_path());
            }
        }
    }
    scan_paths(data_root, pricing, &paths)
}

pub fn scan_paths(
    data_root: &Path,
    pricing: &Pricing,
    paths: &[PathBuf],
) -> Result<Vec<ParsedSession>> {
    let summary_path = data_root.join("conversation_summaries.db");
    let summaries = if summary_path.try_exists()? {
        let db = Connection::open_with_flags(summary_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        db.execute_batch("BEGIN")?;
        Some(db)
    } else {
        None
    };
    let mut sessions = Vec::new();
    for path in paths.iter().collect::<std::collections::BTreeSet<_>>() {
        if path.try_exists()?
            && let Some(session) = parse(path, summaries.as_ref(), pricing)?
        {
            sessions.push(session);
        }
    }
    Ok(sessions)
}

#[derive(Default)]
struct Summary {
    title: String,
    workspaces: String,
    modified: String,
    parent: String,
}

fn parse(
    path: &Path,
    summaries: Option<&Connection>,
    pricing: &Pricing,
) -> Result<Option<ParsedSession>> {
    let id = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let summary = summaries.map(|db| {
        db.query_row(
            "SELECT title,workspace_uris,last_modified_time,parent_conversation_id FROM conversation_summaries WHERE conversation_id=?1",
            [&id],
            |row| Ok(Summary { title: row.get(0)?, workspaces: row.get(1)?, modified: row.get(2)?, parent: row.get(3)? }),
        ).optional()
    }).transpose()?.flatten().unwrap_or_default();
    let directory = serde_json::from_str::<Vec<String>>(&summary.workspaces)
        .ok()
        .and_then(|paths| {
            paths
                .into_iter()
                .find_map(|path| url::Url::parse(&path).ok()?.to_file_path().ok())
        })
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let time = chrono::DateTime::parse_from_str(&summary.modified, "%Y-%m-%d %H:%M:%S%.f%:z")
        .ok()
        .map(|time| time.timestamp_millis() as f64)
        .unwrap_or(crate::time::file_mtime_ms(path)?);
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    let models = model_names(&db, path)?;
    let mut statement = db
        .prepare("SELECT idx,step_type,status,step_payload FROM steps ORDER BY idx")
        .with_context(|| format!("unsupported Antigravity CLI database {}", path.display()))?;
    let mut rows = statement.query([])?;
    let mut messages = Vec::new();
    let mut title = summary.title;
    let mut unsupported = 0;
    let mut stats = SessionStats::default();
    let mut model_usage = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut pending = Vec::new();
    while let Some(row) = rows.next()? {
        let index: i64 = row.get(0)?;
        let kind: i64 = row.get(1)?;
        let status: i64 = row.get(2)?;
        let payload: Option<Vec<u8>> = row.get(3)?;
        let Some(payload) = payload else {
            unsupported += 1;
            continue;
        };
        let step = proto::Step::decode(payload.as_slice()).with_context(|| {
            format!("invalid Antigravity CLI step {index} in {}", path.display())
        })?;
        let metadata = step.metadata.unwrap_or_default();
        let created = metadata
            .created
            .filter(|created| created.seconds > 0)
            .map(|created| created.seconds as f64 * 1000.0 + f64::from(created.nanos / 1_000_000))
            .unwrap_or(time);
        for usage in metadata
            .usage
            .into_iter()
            .chain(metadata.retries.into_iter().filter_map(|retry| retry.usage))
        {
            let Some(tokens) = tokens(&usage) else {
                continue;
            };
            let ids = [
                ("response", usage.response_id),
                ("provider", usage.provider_message_id),
                ("message", usage.message_id),
            ]
            .into_iter()
            .filter_map(|(kind, id)| Some(format!("{kind}:{}", id.filter(|id| !id.is_empty())?)));
            // Record every id without short-circuiting so later copies sharing any id are skipped.
            if !ids.fold(true, |fresh, id| seen.insert(id) && fresh) {
                continue;
            }
            let model = usage.model_id.and_then(|id| models.get(&id)).cloned();
            pending.push((index, created, model, tokens));
        }
        let part = match kind {
            14 => step
                .user
                .and_then(|user| {
                    user.text
                        .or_else(|| user.content.and_then(|value| value.text))
                })
                .filter(|text| !text.is_empty())
                .map(|text| (Role::User, common::text(text, None))),
            15 => step
                .assistant
                .and_then(|value| value.text)
                .filter(|text| !text.is_empty())
                .map(|text| (Role::Assistant, common::text(text, None))),
            23 => {
                if let Some(value) = step
                    .title
                    .and_then(|title| title.text)
                    .filter(|text| !text.is_empty())
                {
                    title = value;
                }
                continue;
            }
            _ => None,
        };
        let part = part.or_else(|| {
            let call = metadata.call?;
            let name = call
                .name
                .filter(|name| !name.is_empty())
                .or(call.secondary_name)?;
            let input = call
                .input
                .map(|input| serde_json::from_str(&input).unwrap_or(Value::String(input)));
            Some((
                Role::Assistant,
                MessagePart::Tool {
                    tool: name,
                    call_id: call.id,
                    title: None,
                    time_created: None,
                    state: Box::new(ToolState {
                        status: "unknown".into(),
                        input,
                        output: None,
                        error: None,
                        metadata: Some(
                            json!({"antigravity_step_type":kind,"antigravity_status":status}),
                        ),
                    }),
                },
            ))
        });
        if let Some((role, part)) = part {
            let mut message = common::message(format!("{id}:{index}"), role, created, vec![part]);
            if message.role == Role::Assistant {
                message.agent = Some("antigravity-cli".into());
                attach(
                    &mut message,
                    &mut pending,
                    pricing,
                    &mut stats,
                    &mut model_usage,
                );
            }
            messages.push(message);
        } else {
            unsupported += 1;
        }
    }
    if let Some(&(index, created, ..)) = pending.first() {
        let mut message = common::message(
            format!("{id}:{index}:usage"),
            Role::Assistant,
            created,
            Vec::new(),
        );
        message.agent = Some("antigravity-cli".into());
        attach(
            &mut message,
            &mut pending,
            pricing,
            &mut stats,
            &mut model_usage,
        );
        messages.push(message);
    }
    if messages.is_empty() && unsupported == 0 {
        return Ok(None);
    }
    let prompt = messages
        .iter()
        .find(|message| message.role == Role::User)
        .and_then(|message| message.parts.first())
        .and_then(|part| match part {
            MessagePart::Text { text, .. } => Some(text.as_str()),
            _ => None,
        });
    let title = common::title(&[Some(&title), prompt]);
    stats.message_count = messages.len();
    let times = messages.iter().map(|message| message.time_created);
    let created = times.clone().fold(time, f64::min);
    let updated = times.fold(time, f64::max);
    let mut session = common::finish(
        path,
        "antigravity-cli",
        id.clone(),
        title,
        directory,
        created,
        updated,
        (!summary.parent.is_empty() && summary.parent != id).then_some(summary.parent),
        stats,
        (!model_usage.is_empty()).then_some(model_usage),
        messages,
    );
    let notice = format!(
        "Partial Antigravity CLI import: {unsupported} unsupported steps. Tool outcomes are not decoded."
    );
    session.head.summary_files = Some(Value::String(notice));
    session.detail.head = session.head.clone();
    Ok(Some(session))
}

fn model_names(db: &Connection, path: &Path) -> Result<HashMap<u64, String>> {
    let mut statement = db
        .prepare("SELECT data FROM gen_metadata WHERE data IS NOT NULL")
        .with_context(|| format!("unsupported Antigravity CLI database {}", path.display()))?;
    let mut rows = statement.query([])?;
    let mut models = HashMap::new();
    while let Some(row) = rows.next()? {
        let data: Vec<u8> = row.get(0)?;
        let chat = proto::Generation::decode(data.as_slice())
            .with_context(|| {
                format!(
                    "invalid Antigravity CLI generation metadata in {}",
                    path.display()
                )
            })?
            .chat
            .unwrap_or_default();
        if let (Some(id), Some(model)) = (chat.model_id, chat.model.filter(|m| !m.is_empty())) {
            models.insert(id, model);
        }
    }
    Ok(models)
}

// The struct update keeps this literal compiling when MessageTokens gains fields.
#[allow(clippy::needless_update)]
fn tokens(usage: &proto::Usage) -> Option<MessageTokens> {
    let input = usage.input as f64 + usage.cache_read as f64 + usage.cache_create as f64;
    let output = usage
        .visible_output
        .max(usage.total_output.saturating_sub(usage.reasoning)) as f64;
    let reasoning = usage.reasoning as f64;
    (input + output + reasoning > 0.0).then_some(MessageTokens {
        input: Some(input),
        output: Some(output),
        reasoning: Some(reasoning),
        cache_read: Some(usage.cache_read as f64),
        cache_create: Some(usage.cache_create as f64),
        ..Default::default()
    })
}

fn attach(
    message: &mut Message,
    pending: &mut Vec<(i64, f64, Option<String>, MessageTokens)>,
    pricing: &Pricing,
    stats: &mut SessionStats,
    model_usage: &mut BTreeMap<String, f64>,
) {
    if pending.is_empty() {
        return;
    }
    let mut tokens = common::empty_tokens();
    let mut cost = 0.0;
    for (_, _, model, usage) in pending.drain(..) {
        let reasoning = usage.reasoning.unwrap_or(0.0);
        let total = usage.input.unwrap_or(0.0) + usage.output.unwrap_or(0.0) + reasoning;
        let estimate =
            pricing.estimate_tracked(model.as_deref(), &usage, 0.0, &mut message.cost_inputs);
        let source = estimate.map(|_| CostSource::Estimated);
        common::add_stats(
            stats,
            &usage,
            total,
            estimate.unwrap_or(0.0),
            source.clone(),
        );
        // Session output includes reasoning so total tokens reconcile as input + output.
        stats.total_output_tokens += reasoning;
        common::add_tokens(&mut tokens, &usage);
        cost += estimate.unwrap_or(0.0);
        message.cost_source = message.cost_source.take().or(source);
        if let Some(model) = model {
            *model_usage.entry(model.clone()).or_default() += total;
            message.model = Some(model);
        }
    }
    stats
        .cost_inputs
        .extend(message.cost_inputs.iter().cloned());
    message.tokens = Some(tokens);
    message.cost = Some(cost);
}

#[cfg(test)]
mod tests;
