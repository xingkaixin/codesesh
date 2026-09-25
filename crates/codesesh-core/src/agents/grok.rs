use super::codex::ParsedSession;
use crate::{contract::*, pricing::Pricing, projects::path_identity};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
};

mod helpers;
mod transcript;
use helpers::*;
use transcript::transcript;

pub fn scan(root: &Path, _pricing: &Pricing) -> anyhow::Result<Vec<ParsedSession>> {
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
        if let Some(session) = parse_source(path)? {
            results.push(session);
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

pub fn scan_paths(
    _root: &Path,
    _pricing: &Pricing,
    sources: &[PathBuf],
) -> anyhow::Result<Vec<ParsedSession>> {
    let mut results = Vec::new();
    for source in sources.iter().collect::<std::collections::BTreeSet<_>>() {
        if let Some(session) = parse_source(source)? {
            results.push(session);
        }
    }
    Ok(results)
}

fn parse_source(path: &Path) -> anyhow::Result<Option<ParsedSession>> {
    let summary: Value = match fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_str(&String::from_utf8_lossy(&b)).ok())
    {
        Some(v) => v,
        None => return Ok(None),
    };
    let Some(id) = string(&summary["info"]["id"]) else {
        return Ok(None);
    };
    let Some(directory) = string(&summary["info"]["cwd"]) else {
        return Ok(None);
    };
    let mtime = crate::time::file_mtime_ms(path)?;
    let created = iso(&summary["created_at"]).unwrap_or(mtime);
    let updated = iso(&summary["last_active_at"])
        .or_else(|| iso(&summary["updated_at"]))
        .unwrap_or(created);
    let updates = path.with_file_name("updates.jsonl");
    let records = if updates.exists() {
        String::from_utf8_lossy(&fs::read(updates)?)
            .lines()
            .filter_map(|s| serde_json::from_str::<Value>(s).ok())
            .filter(Value::is_object)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let messages = transcript(&records, &id, created, string(&summary["current_model_id"]));
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
    let mut cache_read = 0.0;
    let mut cache_create = 0.0;
    for v in &records {
        let Some(e) = unpack(v, created) else {
            continue;
        };
        if e.method != XAI || e.update["sessionUpdate"] != "turn_completed" {
            continue;
        }
        let Some(u) = usage(e.update) else { continue };
        stats.total_input_tokens = add(stats.total_input_tokens, u.tokens.input.unwrap_or(0.0));
        stats.total_output_tokens = add(stats.total_output_tokens, u.tokens.output.unwrap_or(0.0));
        stats.total_tokens = Some(add(stats.total_tokens.unwrap_or(0.0), u.total));
        cache_read = add(cache_read, u.tokens.cache_read.unwrap_or(0.0));
        cache_create = add(cache_create, u.tokens.cache_create.unwrap_or(0.0));
        stats.total_cost += u.cost.unwrap_or(0.0);
        unknown |= u.cost.is_none() && u.total > 0.0;
        for (m, n) in u.models {
            let total = models.entry(m).or_insert(0.0);
            *total = add(*total, n)
        }
    }
    stats.total_cache_read_tokens = positive(cache_read);
    stats.total_cache_create_tokens = positive(cache_create);
    stats.cost_source = (stats.total_cost > 0.0 && !unknown).then_some(CostSource::Recorded);
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
    let (project_identity, signature) = path_identity(&directory);
    let parent = string(&summary["parent_session_id"])
        .filter(|p| p != &id)
        .map(|session_id| SessionReference {
            agent_name: "grok".into(),
            session_id,
        });
    let head = SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            agent_name: "grok".into(),
            session_id: id,
        },
        title,
        directory,
        display_title: None,
        parent_reference: parent,
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats,
        model_usage: (!models.is_empty()).then_some(models),
        smart_tags: super::smart_tags::classify(&messages),
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
            detail_freshness: "fresh".into(),
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
    #[ignore = "invoked by grok/compare.mjs with an isolated fixture"]
    fn export_reference_fixture() {
        let root = std::env::var("GROK_COMPARE_ROOT").unwrap();
        let mut sessions = scan(Path::new(&root), &Pricing::bundled()).unwrap();
        let mut cache = crate::storage::Cache::open(None).unwrap();
        cache.publish(&mut sessions).unwrap();
        let output = sessions
            .into_iter()
            .map(|s| {
                let detail = cache.detail(s.head.clone()).unwrap().unwrap();
                json!({"head":s.head,"detail":detail})
            })
            .collect::<Vec<_>>();
        fs::write(
            Path::new(&root).join("rust.json"),
            serde_json::to_vec_pretty(&output).unwrap(),
        )
        .unwrap();
    }
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
    fn preserves_fractional_fallback_mtime_and_rejects_fractional_native_timestamps() {
        use std::time::{Duration, UNIX_EPOCH};
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("summary.json");
        fs::write(
            &source,
            json!({"info":{"id":"fractional","cwd":"/tmp/project"}}).to_string(),
        )
        .unwrap();
        let modified = UNIX_EPOCH + Duration::new(1_788_220_800, 125_125_000);
        fs::File::options()
            .write(true)
            .open(&source)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let record = json!({"timestamp":0.0005,"params":{"_meta":{"agentTimestampMs":12.125},"update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Fractional"}}}});
        fs::write(root.path().join("updates.jsonl"), record.to_string()).unwrap();
        let result = parse_source(&source).unwrap().unwrap();
        let expected = crate::time::file_mtime_ms(&source).unwrap();
        assert_ne!(expected.fract(), 0.0);
        assert_eq!(result.head.time_created, expected);
        assert_eq!(result.head.time_updated, expected);
        assert_eq!(result.detail.messages[0].time_created, expected);
        assert!(
            matches!(result.detail.messages[0].parts[0],MessagePart::Text{time_created:Some(t),..} if t == expected)
        );
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
        let messages = transcript(&records, "s", 0.0, None);
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
        let messages = transcript(&records, "s", 0.0, Some("grok".into()));
        assert_eq!(messages.len(), 1);
        let m = &messages[0];
        assert_eq!(m.parts.len(), 3);
        assert_eq!(m.cost, Some(0.001));
        assert!(matches!(&m.parts[0],MessagePart::Reasoning{text,..} if text=="Thinking"));
        assert!(
            matches!(&m.parts[1],MessagePart::Tool{state,..} if state.status=="error"&&state.error==Some(json!("failed")))
        );
        assert!(
            matches!(&m.parts[2],MessagePart::Plan{approval_status,..} if approval_status=="success")
        );
    }
}
