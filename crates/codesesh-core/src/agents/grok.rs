use super::jsonl::CachedSources;
use super::{ParsedSession, claudecode::common::InvalidSession, tool_calls};
use crate::{model::*, pricing::Pricing, projects::path_identity};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

mod helpers;
mod transcript;
use helpers::*;
use transcript::transcript;

#[cfg(test)]
pub fn scan(root: &Path, pricing: &Pricing) -> anyhow::Result<Vec<ParsedSession>> {
    scan_cached(root, pricing, &CachedSources::default())
}

pub(super) fn scan_cached(
    root: &Path,
    pricing: &Pricing,
    cached_sources: &CachedSources<'_>,
) -> anyhow::Result<Vec<ParsedSession>> {
    let sessions = root.join("sessions");
    let base = if sessions.is_dir() {
        sessions.as_path()
    } else {
        root
    };
    let mut results = Vec::new();
    if !base.exists() {
        return Ok(results);
    }
    for entry in walkdir::WalkDir::new(base) {
        let entry = entry?;
        if !entry.file_type().is_file() || entry.file_name() != "summary.json" {
            continue;
        }
        let path = entry.path();
        let cached = cached_sources.paths.contains(path);
        match parse_source(path, pricing, |id| {
            cached_sources.reject_invalid(id, cached)
        }) {
            Ok(Some(session)) => results.push(session),
            Ok(None) if cached => return Err(InvalidSession("incomplete Grok session").into()),
            Ok(None) => {}
            Err(error) if !cached && error.is::<InvalidSession>() => {}
            Err(error) => return Err(error),
        }
    }
    results.sort_by(|a, b| {
        b.detail
            .head
            .time_updated
            .total_cmp(&a.detail.head.time_updated)
            .then_with(|| {
                a.detail
                    .head
                    .reference
                    .session_id
                    .cmp(&b.detail.head.reference.session_id)
            })
    });
    Ok(results)
}

#[cfg(test)]
pub fn scan_paths(
    _root: &Path,
    pricing: &Pricing,
    sources: &[PathBuf],
) -> anyhow::Result<Vec<ParsedSession>> {
    let mut results = Vec::new();
    for source in sources.iter().collect::<std::collections::BTreeSet<_>>() {
        match parse_source(source, pricing, |_| false) {
            Ok(Some(session)) => results.push(session),
            Ok(None) => {}
            Err(error) if error.is::<InvalidSession>() => {}
            Err(error) => return Err(error),
        }
    }
    Ok(results)
}

pub fn scan_changed(
    root: &Path,
    pricing: &Pricing,
    changed_paths: &[PathBuf],
    previous: &[crate::agents::SessionRecord],
) -> anyhow::Result<super::ScanDelta> {
    let sessions = root.join("sessions");
    let base = if sessions.is_dir() {
        sessions.as_path()
    } else {
        root
    };
    let mut sources = std::collections::BTreeSet::new();
    for path in changed_paths {
        for session in previous {
            if path.starts_with(session.source.parent().unwrap_or(&session.source))
                || session.source.starts_with(path)
            {
                sources.insert(session.source.clone());
            }
        }
        let walk_target = if base.starts_with(path) {
            base.exists().then_some(base)
        } else if path.is_dir() {
            Some(path.as_path())
        } else {
            None
        };
        if let Some(dir) = walk_target {
            for entry in walkdir::WalkDir::new(dir) {
                let entry = entry?;
                if entry.file_type().is_file() && entry.file_name() == "summary.json" {
                    sources.insert(entry.into_path());
                }
            }
        } else if let Some(parent) = path.parent() {
            let source = parent.join("summary.json");
            if source.try_exists()? || path.file_name().is_some_and(|name| name == "summary.json") {
                sources.insert(source);
            }
        }
    }
    let mut upserts = Vec::new();
    let mut removed = Vec::new();
    for source in sources {
        let old: Vec<_> = previous
            .iter()
            .filter(|session| session.source == source)
            .collect();
        let parsed = match parse_source(&source, pricing, |_| !old.is_empty()) {
            Ok(Some(session)) => Some(session),
            Ok(None) => {
                if !old.is_empty() && source.try_exists()? {
                    return Err(InvalidSession("incomplete Grok session").into());
                }
                None
            }
            Err(error) if error.is::<InvalidSession>() && old.is_empty() => None,
            Err(error) => return Err(error),
        };
        for old in old {
            if parsed
                .as_ref()
                .is_none_or(|session| session.head.reference != old.head.reference)
            {
                removed.push(old.head.reference.clone());
            }
        }
        if let Some(session) = parsed {
            upserts.push(session);
        }
    }
    Ok(super::ScanDelta {
        upserts,
        removed,
        complete: false,
    })
}

fn parse_source(
    path: &Path,
    pricing: &Pricing,
    reject_invalid: impl Fn(&str) -> bool,
) -> anyhow::Result<Option<ParsedSession>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let summary: Value =
        serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|error| {
            anyhow::Error::new(error).context(InvalidSession("malformed Grok summary.json"))
        })?;
    let Some(id) = string(&summary["info"]["id"]) else {
        return Err(InvalidSession("missing Grok session id").into());
    };
    let Some(directory) = string(&summary["info"]["cwd"]) else {
        return Err(InvalidSession("missing Grok session cwd").into());
    };
    let mtime = crate::time::file_mtime_ms(path)?;
    let created = iso(&summary["created_at"]).unwrap_or(mtime);
    let updated = iso(&summary["last_active_at"])
        .or_else(|| iso(&summary["updated_at"]))
        .unwrap_or(created);
    let updates = path.with_file_name("updates.jsonl");
    let records = super::jsonl::records(&updates, || reject_invalid(&id))?
        .filter(|record| record.as_ref().map_or(true, Value::is_object))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let messages = transcript(
        &records,
        &id,
        created,
        string(&summary["current_model_id"]),
        pricing,
    );
    let message_count = head_message_count(&records, created);
    if message_count == 0 {
        return Ok(None);
    }
    let mut stats = SessionStats {
        message_count,
        total_tokens: Some(0.0),
        ..Default::default()
    };
    let mut models = BTreeMap::new();
    let mut unknown = false;
    let mut estimated = false;
    let mut cache_read = 0.0;
    let mut cache_create = 0.0;
    for v in &records {
        let Some(e) = unpack(v, created) else {
            continue;
        };
        if e.method != XAI || e.update["sessionUpdate"] != "turn_completed" {
            continue;
        }
        let Some(u) = usage(e.update, pricing) else {
            continue;
        };
        stats.total_input_tokens = add(stats.total_input_tokens, u.tokens.input.unwrap_or(0.0));
        stats.total_output_tokens = add(stats.total_output_tokens, u.tokens.output.unwrap_or(0.0));
        stats.total_tokens = Some(add(stats.total_tokens.unwrap_or(0.0), u.total));
        cache_read = add(cache_read, u.tokens.cache_read.unwrap_or(0.0));
        cache_create = add(cache_create, u.tokens.cache_create.unwrap_or(0.0));
        stats.total_cost += u.cost.unwrap_or(0.0);
        unknown |= u.cost.is_none() && u.total > 0.0;
        estimated |= u.cost_source == Some(CostSource::Estimated);
        stats.cost_inputs.extend(u.cost_inputs);
        for (m, n) in u.models {
            let total = models.entry(m).or_insert(0.0);
            *total = add(*total, n)
        }
    }
    stats.total_cache_read_tokens = positive(cache_read);
    stats.total_cache_create_tokens = positive(cache_create);
    stats.cost_source =
        ((stats.total_cost > 0.0 || estimated) && !unknown).then_some(if estimated {
            CostSource::Estimated
        } else {
            CostSource::Recorded
        });
    let first = canonical(&records, created)
        .into_iter()
        .filter_map(|index| unpack(&records[index], created))
        .filter(|e| {
            e.method != XAI
                && e.update["sessionUpdate"] == "user_message_chunk"
                && e.update["_meta"]["hostTurn"] != true
        })
        .find_map(|e| match part(&e.update["content"], e.time) {
            Some(MessagePart::Text { text, .. }) => title(&text),
            _ => None,
        });
    let title = string(&summary["generated_title"])
        .or_else(|| string(&summary["session_summary"]))
        .and_then(|s| title(&s))
        .or(first)
        .or_else(|| {
            Path::new(&directory)
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(title)
        })
        .unwrap_or("Untitled Session".into());
    let recorded_git_remotes = summary["git_remotes"]
        .as_array()
        .map(|remotes| {
            remotes
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let (project_identity, signature) = path_identity(&directory);
    let parent = string(&summary["parent_session_id"])
        .filter(|p| p != &id)
        .map(|session_id| SessionReference {
            source_node_id: crate::model::local_source_node_id(),
            agent_name: "grok".into(),
            session_id,
        });
    let head = SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            source_node_id: crate::model::local_source_node_id(),
            agent_name: "grok".into(),
            session_id: id,
        },
        title,
        directory,
        display_title: None,
        parent_reference: parent,
        project_identity,
        recorded_git_remotes,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats,
        model_usage: (!models.is_empty()).then_some(models),
        smart_tags: Vec::new(),
        smart_tags_source_updated_at: Some(updated),
        smart_tags_classifier_revision: Some("smart-tags-v1".into()),
    };
    let file_activity = super::file_activity::summarize(&head, &messages);
    let mut detail_head = head.clone();
    detail_head.stats.message_count = messages.len();
    Ok(Some(ParsedSession {
        head: head.clone(),
        source: path.into(),
        detail: SessionDetail {
            head: detail_head,
            messages,
            detail_freshness: crate::model::DetailFreshness::Fresh,
            message_cursor: None,
            message_update: None,
            file_activity,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_sources_do_not_parse_unrelated_logs() {
        let root = tempfile::tempdir().unwrap();
        let selected = root.path().join("selected");
        let unrelated = root.path().join("unrelated");
        for directory in [&selected, &unrelated] {
            fs::create_dir_all(directory).unwrap();
            fs::write(directory.join("summary.json"),json!({"info":{"id":directory.file_name().unwrap().to_str().unwrap(),"cwd":"/tmp/project"},"created_at":"2026-09-01T00:00:00Z"}).to_string()).unwrap();
        }
        fs::write(
            selected.join("updates.jsonl"),
            update(
                1,
                "p",
                "user_message_chunk",
                json!({"content":{"type":"text","text":"First"}}),
            )
            .to_string(),
        )
        .unwrap();
        fs::create_dir(unrelated.join("updates.jsonl")).unwrap();
        let pricing = Pricing::bundled();
        let source = selected.join("summary.json");
        let first = scan_paths(root.path(), &pricing, &[source.clone(), source.clone()]).unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].head.title, "First");
        fs::write(
            selected.join("updates.jsonl"),
            update(
                2,
                "p",
                "user_message_chunk",
                json!({"content":{"type":"text","text":"Changed"}}),
            )
            .to_string(),
        )
        .unwrap();
        let changed = scan_paths(root.path(), &pricing, std::slice::from_ref(&source)).unwrap();
        assert_eq!(changed[0].head.title, "Changed");
        fs::remove_file(source.clone()).unwrap();
        assert!(
            scan_paths(root.path(), &pricing, &[source])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn estimates_turns_without_recorded_ticks() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("sessions/project/s");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("summary.json"),
            json!({"info":{"id":"s","cwd":"/tmp/project"},"created_at":"2026-09-01T00:00:00Z"})
                .to_string(),
        )
        .unwrap();
        let usage = json!({"inputTokens":1000,"outputTokens":50,"cachedReadTokens":400,"reasoningTokens":20,"totalTokens":1050});
        let mut turn = usage.clone();
        turn["modelUsage"] = json!({"grok-test": usage});
        let records = [
            update(
                1,
                "p",
                "user_message_chunk",
                json!({"content":{"type":"text","text":"Hi"}}),
            ),
            update(
                2,
                "p",
                "agent_message_chunk",
                json!({"content":{"type":"text","text":"Hello"}}),
            ),
            update(3, "p", "turn_completed", json!({"usage": turn})),
        ];
        fs::write(
            dir.join("updates.jsonl"),
            records.map(|r| r.to_string()).join("\n"),
        )
        .unwrap();
        let home = tempfile::tempdir().unwrap();
        let controller = crate::pricing::PricingController::load(home.path());
        controller
            .stage_remote(&json!({"xai":{"models":{"grok-test":{"cost":{"input":2,"output":6,"cache_read":0.5}}}}}))
            .unwrap();
        controller.publish_pending().unwrap();
        let pricing = controller.snapshot().unwrap().pricing;
        let expected = pricing
            .estimate(
                Some("grok-test"),
                &MessageTokens {
                    input: Some(1000.0),
                    output: Some(50.0),
                    cache_read: Some(400.0),
                    ..Default::default()
                },
                0.0,
            )
            .unwrap();
        let session = &scan(root.path(), &pricing).unwrap()[0];
        let answer = &session.detail.messages[1];
        assert_eq!(
            (answer.cost, answer.cost_source.clone()),
            (Some(expected), Some(CostSource::Estimated))
        );
        assert_eq!(
            (
                session.head.stats.total_cost,
                session.head.stats.cost_source.clone()
            ),
            (expected, Some(CostSource::Estimated))
        );
        crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
    }

    fn update(time: i64, prompt: &str, kind: &str, fields: Value) -> Value {
        let mut u = fields;
        u["sessionUpdate"] = kind.into();
        json!({"method":if matches!(kind,"rewind_marker"|"turn_completed"){XAI}else{"session/update"},"params":{"update":u,"_meta":{"agentTimestampMs":time,"promptId":prompt,"eventId":format!("event-{time}")}}})
    }
    #[test]
    fn rewinds_remove_discarded_messages() {
        let records = vec![
            update(
                1,
                "p0",
                "user_message_chunk",
                json!({"content":{"type":"text","text":"Keep"},"_meta":{"promptIndex":0}}),
            ),
            update(
                2,
                "p0",
                "agent_message_chunk",
                json!({"content":{"type":"text","text":"Answer"}}),
            ),
            update(
                3,
                "p1",
                "user_message_chunk",
                json!({"content":{"type":"text","text":"Discard"},"_meta":{"promptIndex":1}}),
            ),
            update(
                4,
                "p1",
                "agent_message_chunk",
                json!({"content":{"type":"text","text":"Discard answer"}}),
            ),
            update(5, "p1", "rewind_marker", json!({"target_prompt_index":1})),
            update(
                6,
                "p2",
                "user_message_chunk",
                json!({"content":{"type":"text","text":"Replace"},"_meta":{"promptIndex":1}}),
            ),
        ];
        let messages = transcript(&records, "s", 0.0, None, &Pricing::bundled());
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2].id, "event-6");
        assert!(matches!(&messages[2].parts[0],MessagePart::Text{text,..} if text=="Replace"));
    }
    #[test]
    fn groups_streams_resolves_tools_and_replaces_plan() {
        let records = vec![
            update(
                1,
                "p",
                "agent_thought_chunk",
                json!({"content":{"type":"text","text":"Think"}}),
            ),
            update(
                2,
                "p",
                "agent_thought_chunk",
                json!({"content":{"type":"text","text":"ing"}}),
            ),
            update(
                3,
                "p",
                "tool_call",
                json!({"toolCallId":"c","title":"read_file","rawInput":{"path":"README.md"}}),
            ),
            update(
                4,
                "p",
                "tool_call_update",
                json!({"toolCallId":"c","status":"failed","content":[{"type":"content","content":{"type":"text","text":"failed"}}]}),
            ),
            update(
                4,
                "p",
                "tool_call_update",
                json!({"toolCallId":"c","status":"in_progress"}),
            ),
            update(
                5,
                "p",
                "plan",
                json!({"entries":[{"content":"Read","status":"pending"}]}),
            ),
            update(
                6,
                "p",
                "plan",
                json!({"entries":[{"content":"Read","status":"completed"}]}),
            ),
            update(
                7,
                "p",
                "turn_completed",
                json!({"usage":{"inputTokens":10,"outputTokens":2,"costUsdTicks":10000000}}),
            ),
        ];
        let messages = transcript(&records, "s", 0.0, Some("grok".into()), &Pricing::bundled());
        assert_eq!(messages.len(), 1);
        let m = &messages[0];
        assert_eq!(m.parts.len(), 3);
        assert_eq!(m.cost, Some(0.001));
        assert!(matches!(&m.parts[0],MessagePart::Reasoning{text,..} if text=="Thinking"));
        assert!(
            matches!(&m.parts[1],MessagePart::Tool{state,..} if state.status==crate::model::ToolPartStatus::Error&&state.error==Some(json!("failed")))
        );
        assert!(
            matches!(&m.parts[2],MessagePart::Plan{approval_status,..} if *approval_status==crate::model::PlanApprovalStatus::Pending)
        );
    }

    #[test]
    fn extracts_git_remotes_from_summary_json() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("sessions/g1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("summary.json"),
            json!({
                "info": {"id": "g1", "cwd": "/deleted/worktree"},
                "git_remotes": [
                    "git@github.com:xingkaixin/codesesh.git",
                    "https://github.com/other/repo.git"
                ],
                "created_at": "2026-09-01T00:00:00Z"
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            dir.join("updates.jsonl"),
            update(
                1,
                "p",
                "user_message_chunk",
                json!({"content": {"type": "text", "text": "Check remote"}}),
            )
            .to_string(),
        )
        .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            sessions[0].head.recorded_git_remotes,
            vec![
                "git@github.com:xingkaixin/codesesh.git",
                "https://github.com/other/repo.git"
            ]
        );
    }

    #[test]
    fn corrupt_or_in_flight_cached_session_errors_instead_of_removing() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("sessions/g1");
        fs::create_dir_all(&dir).unwrap();
        let summary_path = dir.join("summary.json");
        let updates_path = dir.join("updates.jsonl");
        let summary =
            json!({"info":{"id":"g1","cwd":"/tmp/project"},"created_at":"2026-09-01T00:00:00Z"})
                .to_string();
        let updates = update(
            1,
            "p",
            "user_message_chunk",
            json!({"content":{"type":"text","text":"Keep cached"}}),
        )
        .to_string();
        fs::write(&summary_path, &summary).unwrap();
        fs::write(&updates_path, &updates).unwrap();

        let pricing = Pricing::bundled();
        let previous: Vec<_> = scan(root.path(), &pricing)
            .unwrap()
            .iter()
            .map(crate::agents::SessionRecord::from)
            .collect();
        assert_eq!(previous.len(), 1);

        fs::write(&summary_path, "{\"info\":").unwrap();
        assert!(
            scan_changed(
                root.path(),
                &pricing,
                std::slice::from_ref(&summary_path),
                &previous
            )
            .is_err()
        );

        fs::write(&summary_path, &summary).unwrap();
        fs::write(&updates_path, format!("{updates}\n{{broken\n")).unwrap();
        assert!(
            scan_changed(
                root.path(),
                &pricing,
                std::slice::from_ref(&updates_path),
                &previous
            )
            .is_err()
        );

        fs::remove_file(&summary_path).unwrap();
        let deleted = scan_changed(root.path(), &pricing, &[summary_path], &previous).unwrap();
        assert!(deleted.upserts.is_empty());
        assert_eq!(deleted.removed, vec![previous[0].head.reference.clone()]);
    }
}
