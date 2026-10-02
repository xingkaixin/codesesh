use super::*;
use rusqlite::params;

fn database() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../storage/schema.sql"))
        .unwrap();
    for (id, title, body, cost, parent) in [
        (
            "one",
            "🔎 Fix widget",
            "🔎 中文 hello Rust world",
            1.0,
            None,
        ),
        ("two", "Hello world", "unrelated text", 2.0, Some("one")),
        ("three", "Something else", "Rust shared hello", 3.0, None),
    ] {
        db.execute("INSERT INTO sessions(agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost,smart_tags_json,parent_agent_name,parent_session_id) VALUES('codex',?,?,'/work/app','path','/work/app','app',100,200,200,1,0,0,?,'[\"bugfix\"]',?,?)",params![id,title,cost,parent.map(|_|"codex"),parent]).unwrap();
        db.execute("INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES('codex',?,0,'m','user',100,'[]',?)",params![id,body]).unwrap();
        db.execute("INSERT INTO session_documents(agent_name,session_id,title,content_text,content_hash,indexed_message_count,indexed_at) VALUES('codex',?,?,?,'',1,200)",params![id,title,body]).unwrap();
    }
    db.execute("INSERT INTO session_file_activity VALUES('local','codex','one','/work/app','src/Widget.ts','edit',2,200)",[]).unwrap();
    db.execute(
        "INSERT INTO message_tools VALUES('local','codex','one',0,'apply_patch')",
        [],
    )
    .unwrap();
    db
}

#[test]
fn qualifiers_merge_and_fts_escaping() {
    let parsed = parse_query(
        "agent:CODEX project:\"code sesh\" projectkind:git_remote tag:bugfix tool:apply_patch file:\"src/App File.tsx\" cost:>1 needle",
    );
    assert_eq!(parsed.text, "needle");
    assert_eq!(parsed.filters.agent.as_deref(), Some("codex"));
    assert_eq!(parsed.filters.project.as_deref(), Some("code sesh"));
    assert_eq!(parsed.filters.file.as_deref(), Some("src/App File.tsx"));
    assert!(parsed.filters.cost_min_exclusive);
    let later = parse_query("cost:>1 cost:<5 cost:2..3");
    assert_eq!(later.filters.cost_min, Some(2.0));
    assert!(!later.filters.cost_min_exclusive);
    let unknown = parse_query("tag:invalid projectkind:wrong cost:nope needle");
    assert_eq!(unknown.text, "tag:invalid projectkind:wrong needle");
    assert!(unknown.has_qualifiers);
    assert_eq!(
        to_fts_query("OR foo OR OR bar OR baz OR"),
        "\"foo\" \"bar\" OR \"baz\""
    );
    assert_eq!(
        to_fts_query("\"hello world\" title:foo"),
        "\"hello world\" \"title:foo\""
    );
}

#[test]
fn ranked_fts_and_utf16_message_highlights() {
    let db = database();
    let results = execute(&db, "hello", &SearchOptions::default()).unwrap();
    assert_eq!(results[0].reference.session_id, "two");
    assert_eq!(results[0].match_type, "title");
    assert_eq!(results[0].message_index, None);
    let one = results
        .iter()
        .find(|r| r.reference.session_id == "one")
        .unwrap();
    assert_eq!(one.match_type, "user_message");
    assert_eq!(one.message_index, Some(0));
    assert_eq!(one.snippet, "🔎 中文 hello Rust world");
    assert_eq!(
        one.snippet_highlights,
        vec![HighlightRange { start: 6, end: 11 }]
    );
    assert_eq!(
        execute(&db, "\"hello Rust\"", &SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
    assert!(
        execute(&db, "hello absent", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        execute(&db, "hello OR absent", &SearchOptions::default())
            .unwrap()
            .len(),
        3
    );
}

fn chinese_database() -> Connection {
    let db = database();
    for (node, id, title, body, time) in [
        (
            "local",
            "han-body",
            "Fix timeout 𠮷野",
            "🔎 修复数据库连接超时问题，检查HTTP请求和缓存。",
            100,
        ),
        ("local", "han-title", "数据库连接修复", "other", 10),
        ("local", "unordered", "Other", "数库据连接", 400),
        ("worker-a", "han-body", "Remote", "远端数据库连接", 300),
        (
            "local",
            "mixed",
            "Mixed",
            "修复数据库 hello timeout HTTP请求",
            200,
        ),
    ] {
        db.execute("INSERT INTO sessions(source_node_id,agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost) VALUES(?,'codex',?,?,'/chinese','path','/chinese','chinese',10,?,?,1,0,0,0)", params![node,id,title,time,time]).unwrap();
        db.execute("INSERT INTO messages(source_node_id,agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES(?,'codex',?,0,'m','user',10,'[]',?)", params![node,id,body]).unwrap();
        db.execute("INSERT INTO session_documents(source_node_id,agent_name,session_id,title,content_text,content_hash,indexed_message_count,indexed_at) VALUES(?,'codex',?,?,?,'',1,200)", params![node,id,title,body]).unwrap();
    }
    db
}

#[test]
fn chinese_substrings_match_continuous_text_and_preserve_utf16_highlights() {
    let db = chinese_database();
    for query in ["库", "连接", "数据库", "数据库连接", "\"数据库连接\""] {
        let results = execute(&db, query, &SearchOptions::default()).unwrap();
        assert!(
            results
                .iter()
                .any(|r| r.reference.session_id == "han-body"
                    && r.reference.source_node_id == "local"),
            "{query}"
        );
    }
    let results = execute(&db, "数据库", &SearchOptions::default()).unwrap();
    assert_eq!(results.len(), 4);
    assert_eq!(results[0].reference.session_id, "han-title");
    let body = results
        .iter()
        .find(|r| r.reference.session_id == "han-body" && r.reference.source_node_id == "local")
        .unwrap();
    assert_eq!(body.match_type, "user_message");
    assert_eq!(body.message_index, Some(0));
    assert_eq!(
        body.snippet,
        "🔎 修复数据库连接超时问题，检查HTTP请求和缓存。"
    );
    assert_eq!(
        body.snippet_highlights,
        vec![HighlightRange { start: 5, end: 8 }]
    );
    assert!(
        !results
            .iter()
            .any(|r| r.reference.session_id == "unordered")
    );
    assert_eq!(
        execute(&db, "http请求", &SearchOptions::default())
            .unwrap()
            .len(),
        2
    );
    assert!(
        execute(&db, "数据库不存在", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert!(
        execute(&db, "数据库%", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    let astral = execute(&db, "𠮷野", &SearchOptions::default()).unwrap();
    assert_eq!(astral.len(), 1);
    assert_eq!(astral[0].match_type, "title");
    assert_eq!(
        astral[0].snippet_highlights,
        vec![HighlightRange { start: 12, end: 15 }]
    );
}

#[test]
fn mixed_chinese_queries_preserve_boolean_precedence_and_filters() {
    let db = chinese_database();
    let ids = |query| {
        execute(&db, query, &SearchOptions::default())
            .unwrap()
            .into_iter()
            .map(|r| r.reference.session_id)
            .collect::<HashSet<_>>()
    };
    assert_eq!(ids("数据库 hello"), HashSet::from(["mixed".into()]));
    assert!(ids("数据库 hell").is_empty());
    assert_eq!(
        ids("数据库 hello OR 缓存"),
        HashSet::from(["mixed".into(), "han-body".into()])
    );
    assert_eq!(
        ids("缓存 OR \"Rust world\""),
        HashSet::from(["han-body".into(), "one".into()])
    );
    assert_eq!(
        ids("OR 数据库 OR OR hello OR 缓存 OR"),
        HashSet::from(["mixed".into(), "han-body".into()])
    );
    assert_eq!(ids("\"数据库 hello\""), HashSet::from(["mixed".into()]));
    let results = execute(
        &db,
        "数据库",
        &SearchOptions {
            project_kind: Some("path".into()),
            project_key: Some("/chinese".into()),
            from: Some(50.0),
            to: Some(150.0),
            limit: Some(1),
            query_scope: Some(QueryScope {
                source_node_id: Some("local".into()),
                agents: vec!["codex".into()],
                project_scope: None,
            }),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].reference.session_id, "han-body");
    assert_eq!(results[0].reference.source_node_id, "local");
    db.execute("UPDATE sessions SET publication_id='staged' WHERE source_node_id='local' AND session_id='han-body'", []).unwrap();
    assert!(ids("缓存").is_empty());
}

#[test]
fn filters_include_descendant_cost_tools_files_and_scope() {
    let db = database();
    let result = execute(
        &db,
        "cost:3 tool:apply_patch tag:bugfix file:Widget",
        &SearchOptions::default(),
    )
    .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].reference.session_id, "one");
    assert_eq!(result[0].snippet, "edit src/Widget.ts · 2 events");
    assert_eq!(
        result[0].snippet_highlights,
        vec![HighlightRange { start: 9, end: 15 }]
    );
    assert!(
        execute(&db, "cost:>3", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert!(
        execute(&db, "file:Widget unrelated", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        execute(&db, "file:Widget hello", &SearchOptions::default()).unwrap()[0].match_type,
        "file_path"
    );
    assert!(
        execute(&db, "projectkind:path", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        execute(&db, "cwd:/work", &SearchOptions::default())
            .unwrap()
            .len(),
        3
    );
    assert!(
        execute(&db, "cwd:/other", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert!(
        execute(&db, "agent:unknown", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert!(
        execute(
            &db,
            "",
            &SearchOptions {
                limit: Some(0),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty()
    );
    db.execute(
        "UPDATE sessions SET publication_id='staged' WHERE session_id='two'",
        [],
    )
    .unwrap();
    assert_eq!(
        execute(&db, "cost:1 tool:apply_patch", &SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn highlights_merge_overlaps_and_preserve_astral_offsets() {
    let ranges = snippet::highlights("🔎 foobar", &snippet::Terms::parse("foo foobar foo"));
    assert_eq!(ranges, vec![HighlightRange { start: 3, end: 9 }]);
    let text = format!("{}needle{}", "a".repeat(100), "z".repeat(100));
    let (text, ranges) = snippet::build(&text, &snippet::Terms::parse("needle"));
    assert!(text.starts_with("… "));
    assert!(text.ends_with(" …"));
    assert_eq!(ranges, vec![HighlightRange { start: 82, end: 88 }]);
}

#[test]
fn snapshot_recent_preserves_order_and_parent_context() {
    let db = database();
    let mut snapshot: Vec<_> = search_sessions(&db, "", &SearchOptions::default())
        .unwrap()
        .into_iter()
        .map(|r| r.session)
        .collect();
    snapshot.reverse();
    let parent = snapshot
        .iter()
        .find(|s| s.reference.session_id == "one")
        .unwrap()
        .reference
        .clone();
    snapshot
        .iter_mut()
        .find(|s| s.reference.session_id == "two")
        .unwrap()
        .parent_reference = Some(parent);
    let recent =
        execute_with_snapshot(&db, "agent:codex", &SearchOptions::default(), &snapshot).unwrap();
    assert_eq!(
        recent.iter().map(|r| &r.reference).collect::<Vec<_>>(),
        snapshot.iter().map(|s| &s.reference).collect::<Vec<_>>()
    );
    assert!(
        recent
            .iter()
            .find(|r| r.reference.session_id == "two")
            .unwrap()
            .session
            .parent_reference
            .is_some()
    );
    let expensive =
        execute_with_snapshot(&db, "cost:>=3", &SearchOptions::default(), &snapshot).unwrap();
    assert_eq!(expensive.len(), 2);
    assert!(expensive.iter().any(|r| r.reference.session_id == "one"));
    let explicit = execute_with_snapshot(
        &db,
        "cost:>100",
        &SearchOptions {
            cost_min: Some(3.0),
            ..Default::default()
        },
        &snapshot,
    )
    .unwrap();
    assert_eq!(explicit.len(), 2);
    let filtered = filter_candidates(
        &db,
        recent,
        "tool:apply_patch",
        &SearchOptions::default(),
        &snapshot,
    )
    .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].reference.session_id, "one");
}

#[test]
fn pending_publications_and_query_scope_do_not_leak_into_search() {
    let db = database();
    db.execute(
        "UPDATE sessions SET publication_id='staged' WHERE session_id='one'",
        [],
    )
    .unwrap();
    assert!(
        execute(&db, "file:Widget", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        execute(&db, "hello", &SearchOptions::default())
            .unwrap()
            .len(),
        2
    );
    assert!(
        execute(
            &db,
            "hello",
            &SearchOptions {
                query_scope: Some(QueryScope {
                    source_node_id: None,
                    agents: vec!["pi".into()],
                    project_scope: None
                }),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty()
    );
    assert!(
        execute(
            &db,
            "hello",
            &SearchOptions {
                from: Some(201.0),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        execute(
            &db,
            "hello",
            &SearchOptions {
                to: Some(200.0),
                ..Default::default()
            }
        )
        .unwrap()
        .len(),
        2
    );
}

#[test]
fn file_activity_uses_event_time_and_orders_before_limit() {
    let db = database();
    db.execute("INSERT INTO session_file_activity VALUES('local','codex','three','/work/app','src/Other.ts','read',3,250)",[]).unwrap();
    let rows = list_file_activity(
        &db,
        &FileActivityOptions {
            from: Some(220.0),
            limit: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].activity.reference.session_id, "three");
    assert_eq!(rows[0].activity.latest_time, 250.0);
    assert_eq!(
        serde_json::to_value(&rows[0]).unwrap()["projectIdentityKey"],
        "/work/app"
    );
    let rows = list_file_activity(
        &db,
        &FileActivityOptions {
            path: Some("Widget".into()),
            kind: Some("edit".into()),
            project_kind: Some("path".into()),
            project_key: Some("/work/app".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].activity.path, "src/Widget.ts");
    assert!(
        list_file_activity(
            &db,
            &FileActivityOptions {
                session_id: Some("two".into()),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn fractional_times_survive_reads_and_window_boundaries() {
    let db = database();
    db.execute("UPDATE sessions SET time_created=100.125,time_updated=200.75,activity_time=200.75,smart_tags_source_updated_at=200.625 WHERE session_id='one'",[]).unwrap();
    db.execute(
        "UPDATE session_file_activity SET latest_time=200.5 WHERE session_id='one'",
        [],
    )
    .unwrap();
    let options = SearchOptions {
        agent: Some("codex".into()),
        from: Some(200.0),
        to: Some(201.0),
        ..Default::default()
    };
    let results = execute(&db, "tool:apply_patch hello", &options).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].session.time_created, 100.125);
    assert_eq!(results[0].session.time_updated, 200.75);
    assert_eq!(
        results[0].session.smart_tags_source_updated_at,
        Some(200.625)
    );
    let snapshot = vec![results[0].session.clone()];
    assert_eq!(
        execute_with_snapshot(&db, "", &options, &snapshot)
            .unwrap()
            .len(),
        1
    );
    let fractional = SearchOptions {
        from: Some(200.625),
        to: Some(200.875),
        ..options.clone()
    };
    assert_eq!(
        execute(&db, "tool:apply_patch hello", &fractional)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        execute_with_snapshot(&db, "", &fractional, &snapshot)
            .unwrap()
            .len(),
        1
    );
    let fractional_excluded = SearchOptions {
        to: Some(200.5),
        ..options.clone()
    };
    assert!(
        execute(&db, "tool:apply_patch hello", &fractional_excluded)
            .unwrap()
            .is_empty()
    );
    assert!(
        execute_with_snapshot(&db, "", &fractional_excluded, &snapshot)
            .unwrap()
            .is_empty()
    );
    let bounded = SearchOptions {
        to: Some(200.0),
        ..options
    };
    assert!(
        execute(&db, "tool:apply_patch hello", &bounded)
            .unwrap()
            .is_empty()
    );
    assert!(
        execute_with_snapshot(&db, "", &bounded, &snapshot)
            .unwrap()
            .is_empty()
    );
    let activity = list_file_activity(
        &db,
        &FileActivityOptions {
            from: Some(200.0),
            to: Some(201.0),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(activity[0].activity.latest_time, 200.5);
    assert!(
        list_file_activity(
            &db,
            &FileActivityOptions {
                to: Some(200.0),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn search_targets_the_first_matching_message_in_source_order() {
    let db = database();
    db.execute(
        "UPDATE messages SET content_text='unrelated' WHERE session_id='one'",
        [],
    )
    .unwrap();
    for (index, role, text) in [
        (1, "assistant", "unrelated"),
        (2, "tool", "hello output"),
        (3, "user", "hello again"),
    ] {
        db.execute("INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES('codex','one',?,'m',?,100,'[]',?)", params![index,role,text]).unwrap();
    }
    let results = execute(&db, "hello", &SearchOptions::default()).unwrap();
    let one = results
        .iter()
        .find(|r| r.reference.session_id == "one")
        .unwrap();
    assert_eq!(one.message_index, Some(2));
    assert_eq!(one.match_type, "tool_output");
    assert_eq!(one.snippet, "hello output");
    assert!(
        execute(&db, "", &SearchOptions::default())
            .unwrap()
            .iter()
            .all(|r| r.message_index.is_none())
    );
    assert!(
        execute(&db, "file:Widget", &SearchOptions::default())
            .unwrap()
            .iter()
            .all(|r| r.message_index.is_none())
    );
}

#[test]
fn cross_message_fallbacks_preserve_text_highlights_and_source_identity() {
    let db = chinese_database();
    let body = "alpha 数据库\nomega 连接";
    db.execute("UPDATE messages SET content_text='alpha 数据库' WHERE source_node_id='local' AND session_id='han-body'", []).unwrap();
    db.execute("INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES('codex','han-body',1,'m','tool',100,'[]','omega 连接')", []).unwrap();
    db.execute("UPDATE session_documents SET content_text=? WHERE source_node_id='local' AND session_id='han-body'", [body]).unwrap();
    for (query, highlights) in [
        (
            "alpha omega",
            vec![
                HighlightRange { start: 0, end: 5 },
                HighlightRange { start: 10, end: 15 },
            ],
        ),
        (
            "数据库 连接",
            vec![
                HighlightRange { start: 6, end: 9 },
                HighlightRange { start: 16, end: 18 },
            ],
        ),
    ] {
        let results = execute(&db, query, &SearchOptions::default()).unwrap();
        let local = results
            .iter()
            .find(|r| r.reference.session_id == "han-body" && r.reference.source_node_id == "local")
            .unwrap();
        assert_eq!(local.snippet, body);
        assert_eq!(local.snippet_highlights, highlights);
        assert_eq!(local.message_index, None);
        assert_eq!(local.match_type, "assistant_reply");
        if query == "数据库 连接" {
            let remote = results
                .iter()
                .find(|r| r.reference.source_node_id == "worker-a")
                .unwrap();
            assert_eq!(remote.snippet, "远端数据库连接");
            assert_eq!(remote.message_index, Some(0));
        }
    }
    db.execute("UPDATE messages SET content_text='alpha omega 数据库连接' WHERE source_node_id='local' AND session_id='han-body' AND message_index=1", []).unwrap();
    db.execute("UPDATE session_documents SET content_text='alpha 数据库\nalpha omega 数据库连接' WHERE source_node_id='local' AND session_id='han-body'", []).unwrap();
    for query in ["alpha omega", "数据库 连接"] {
        let results = execute(&db, query, &SearchOptions::default()).unwrap();
        let local = results
            .iter()
            .find(|r| r.reference.session_id == "han-body" && r.reference.source_node_id == "local")
            .unwrap();
        assert_eq!(local.message_index, Some(1));
        assert_eq!(local.match_type, "tool_output");
        assert_eq!(local.snippet, "alpha omega 数据库连接");
    }
}

#[test]
fn fts_only_matches_keep_body_and_empty_body_fallbacks() {
    let db = database();
    db.execute(
        "UPDATE sessions SET title='CAFÉ' WHERE session_id='one'",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE session_documents SET title='CAFÉ' WHERE session_id='one'",
        [],
    )
    .unwrap();
    let results = execute(&db, "cafe", &SearchOptions::default()).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].snippet, "🔎 中文 hello Rust world");
    assert_eq!(results[0].message_index, None);
    assert!(results[0].snippet_highlights.is_empty());
    db.execute(
        "UPDATE session_documents SET content_text='' WHERE session_id='one'",
        [],
    )
    .unwrap();
    let results = execute(&db, "cafe", &SearchOptions::default()).unwrap();
    assert_eq!(results[0].snippet, "CAFÉ");
    assert_eq!(results[0].message_index, None);
}
