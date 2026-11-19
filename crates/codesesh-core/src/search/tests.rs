use super::*;
use rusqlite::params;

fn index(db: &Connection) {
    db.execute(
        "INSERT INTO message_fts(message_fts) VALUES('delete-all')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO session_title_fts(session_title_fts) VALUES('delete-all')",
        [],
    )
    .unwrap();
    let mut query = db
        .prepare("SELECT rowid,content_text FROM messages")
        .unwrap();
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for (rowid, text) in rows {
        let (indexed, code_tokens) = index_parts(&text);
        db.execute(
            "INSERT INTO message_fts(rowid,content_text,code_tokens) VALUES(?,?,?)",
            params![rowid, indexed, code_tokens],
        )
        .unwrap();
    }
    let mut titles = db.prepare("SELECT rowid,title FROM sessions").unwrap();
    let title_rows = titles
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    for (rowid, title) in title_rows {
        let (indexed, code_tokens) = index_parts(&title);
        db.execute(
            "INSERT INTO session_title_fts(rowid,title,code_tokens) VALUES(?,?,?)",
            params![rowid, indexed, code_tokens],
        )
        .unwrap();
    }
}

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
        db.execute("INSERT INTO session_documents(agent_name,session_id,title,content_hash,indexed_message_count,indexed_at) VALUES('codex',?,?,'',1,200)",params![id,title]).unwrap();
    }
    db.execute("INSERT INTO session_file_activity VALUES('local','codex','one','/work/app','src/Widget.ts','edit',2,200)",[]).unwrap();
    db.execute(
        "INSERT INTO message_tools VALUES('local','codex','one',0,'apply_patch')",
        [],
    )
    .unwrap();
    index(&db);
    db
}

#[test]
fn model_drilldown_uses_the_dashboards_window_and_entry_sessions() {
    let db = database();
    db.execute_batch(r#"
        UPDATE sessions SET total_input_tokens=3, model_usage_json='{"widget":3}';
        UPDATE sessions SET activity_time=500, time_updated=500 WHERE session_id='one';
        INSERT INTO session_cost_summary(agent_name,session_id,input_tokens,message_cost,untimed_message_cost)
            VALUES ('codex','two',3,0,0), ('codex','three',3,0,0);
        INSERT INTO session_usage_bucket VALUES
            (150,'local','codex','two','widget','',1,3,0,0,0,0,0),
            (50,'local','codex','three','widget','',1,3,0,0,0,0,0);
    "#).unwrap();
    let search = |from, to| {
        execute_with_snapshot(
            &db,
            "model:widget",
            &SearchOptions {
                from: Some(from),
                to: Some(to),
                ..Default::default()
            },
            &[],
        )
        .unwrap()
        .into_iter()
        .map(|hit| hit.reference.session_id)
        .collect::<Vec<_>>()
    };
    assert_eq!(search(140.0, 210.0), ["one"]);
    assert_eq!(search(40.0, 60.0), ["three"]);
    assert_eq!(search(490.0, 510.0), ["one"]);
    assert!(search(300.0, 400.0).is_empty());
    let tomorrow = chrono::Utc::now().timestamp_millis() + 86_400_000;
    db.execute(
        "UPDATE session_usage_bucket SET bucket_start=? WHERE session_id='three'",
        [tomorrow],
    )
    .unwrap();
    let all = execute_with_snapshot(&db, "model:widget", &SearchOptions::default(), &[]).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].reference.session_id, "one");
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
        db.execute("INSERT INTO session_documents(source_node_id,agent_name,session_id,title,content_hash,indexed_message_count,indexed_at) VALUES(?,'codex',?,?,'',1,200)", params![node,id,title]).unwrap();
    }
    index(&db);
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
    assert_eq!(ids("数据库 hell"), HashSet::from(["mixed".into()]));
    assert!(ids("数据库 \"hell\"").is_empty());
    assert!(ids("数据库 ello").is_empty());
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
    for cwd in ["cwd:/work", "cwd:/"] {
        assert_eq!(
            execute(&db, cwd, &SearchOptions::default()).unwrap().len(),
            3,
            "{cwd}"
        );
    }
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
fn file_filters_match_activity_on_the_same_node_only() {
    let db = database();
    db.execute("INSERT INTO sessions(source_node_id,agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost) SELECT 'remote',agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost FROM sessions WHERE session_id='three'",[]).unwrap();
    db.execute("INSERT INTO session_file_activity VALUES('remote','codex','three','/work/app','src/Gadget.ts','read',1,200)",[]).unwrap();
    for query in ["file:Gadget", "kind:read"] {
        let result = execute(&db, query, &SearchOptions::default()).unwrap();
        assert_eq!(
            result
                .iter()
                .map(|result| result.reference.source_node_id.as_str())
                .collect::<Vec<_>>(),
            ["remote"],
            "{query}"
        );
    }
}

#[test]
fn two_character_file_queries_skip_trigram_index() {
    let db = database();
    db.execute("INSERT INTO session_file_activity VALUES('local','codex','three','/work/app','src/😀a.ts','read',1,200)",[]).unwrap();
    let result = execute(&db, "file:😀a", &SearchOptions::default()).unwrap();
    assert_eq!(result.len(), 1);
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
    index(&db);
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
    index(&db);
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
    index(&db);
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
fn prefix_and_code_token_recall_preserve_exact_quotes_and_highlights() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../storage/schema.sql"))
        .unwrap();
    for (id, title, body, time) in [
        (
            "prefix",
            "Auth guide",
            "修复authentication后重试 setTtl",
            100,
        ),
        (
            "camel",
            "Refactor useAuth hook",
            "Inspect HTTPRequest and oauth2Token handlers",
            200,
        ),
        (
            "snake",
            "Token cleanup",
            "Rotate auth_token before expiry",
            300,
        ),
        (
            "phrase",
            "Prose",
            "Please use auth middleware carefully",
            400,
        ),
        (
            "spaced-cjk",
            "数 据 库",
            "这里有 数 据 库 但不是连续词",
            500,
        ),
    ] {
        db.execute(
            "INSERT INTO sessions(agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost) VALUES('codex',?,?,'/work','path','/work','work',10,?,?,1,0,0,0)",
            params![id, title, time, time],
        )
        .unwrap();
        db.execute(
            "INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES('codex',?,0,'m','user',10,'[]',?)",
            params![id, body],
        )
        .unwrap();
    }
    index(&db);

    let ids = |query| {
        execute(&db, query, &SearchOptions::default())
            .unwrap()
            .into_iter()
            .map(|r| r.reference.session_id)
            .collect::<HashSet<_>>()
    };

    // Unquoted prefix matches authentication; quoted exact does not.
    let prefix_results = execute(&db, "authenticat", &SearchOptions::default()).unwrap();
    assert_eq!(prefix_results.len(), 1);
    assert_eq!(prefix_results[0].reference.session_id, "prefix");
    assert_eq!(
        prefix_results[0].snippet_highlights,
        vec![HighlightRange { start: 2, end: 13 }]
    );
    assert!(ids("\"authenticat\"").is_empty());
    for (query, start, end) in [("\"authentication\"", 2, 16), ("tt", 23, 25)] {
        let hits = execute(&db, query, &SearchOptions::default()).unwrap();
        assert_eq!(hits[0].message_index, Some(0));
        assert_eq!(
            hits[0].snippet_highlights,
            vec![HighlightRange { start, end }]
        );
    }

    // Unquoted `auth` finds camelCase title (`useAuth`), snake_case (`auth_token`),
    // prefix (`authentication`), and standalone word (`use auth`).
    let auth_results = execute(&db, "auth", &SearchOptions::default()).unwrap();
    assert_eq!(
        auth_results
            .iter()
            .map(|r| r.reference.session_id.as_str())
            .collect::<HashSet<_>>(),
        HashSet::from(["prefix", "camel", "snake", "phrase"])
    );
    // Title matches (`camel` and `prefix`) rank ahead of body-only matches (`phrase`, `snake`).
    assert_eq!(auth_results[0].reference.session_id, "camel");
    assert_eq!(auth_results[0].match_type, "title");
    assert_eq!(
        auth_results[0].snippet_highlights,
        vec![HighlightRange { start: 12, end: 16 }]
    );
    assert_eq!(auth_results[1].reference.session_id, "prefix");
    assert_eq!(auth_results[1].match_type, "title");

    // Acronym & digit-to-upper splits work; lowercase full identifier matches camelCase.
    assert_eq!(ids("request"), HashSet::from(["camel".into()]));
    assert_eq!(
        ids("token"),
        HashSet::from(["camel".into(), "snake".into()])
    );
    assert_eq!(ids("useauth"), HashSet::from(["camel".into()]));
    assert_eq!(ids("auth_tok"), HashSet::from(["snake".into()]));

    // Quoted exact phrases stay exact: `"use auth"` does NOT match `useAuth`,
    // and `"useAuth"` does NOT match `use auth`.
    assert_eq!(ids("\"use auth\""), HashSet::from(["phrase".into()]));
    assert_eq!(ids("\"useAuth\""), HashSet::from(["camel".into()]));

    // Spaced Han characters must not match contiguous CJK query.
    assert!(ids("数据库").is_empty());
}

#[test]
fn or_precedence_and_large_snippet_window_preserve_semantics() {
    let terms = snippet::Terms::parse("alpha OR beta gamma");
    assert!(terms.matches("only alpha"));
    assert!(terms.matches("beta and gamma"));
    assert!(!terms.matches("only beta"));
    assert!(!terms.matches("only gamma"));

    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../storage/schema.sql"))
        .unwrap();
    let long_prefix = "🔎 filler ".repeat(15_000); // >150 KB with astral emoji
    let long_body = format!("{long_prefix}beta only here, later alpha target value end");
    for (id, title, body, time) in [
        ("only-beta", "beta only title", "beta only body", 500),
        ("alpha-body", "beta in title", &long_body, 100),
        ("beta-gamma", "beta gamma title", "unrelated", 50),
    ] {
        db.execute(
            "INSERT INTO sessions(agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost) VALUES('codex',?,?,'/work','path','/work','work',10,?,?,1,0,0,0)",
            params![id, title, time, time],
        )
        .unwrap();
        db.execute(
            "INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES('codex',?,0,'m','user',10,'[]',?)",
            params![id, body],
        )
        .unwrap();
    }
    index(&db);

    let results = execute(&db, "alpha OR beta gamma", &SearchOptions::default()).unwrap();
    // `only-beta` must NOT match; `beta-gamma` is a true title match and ranks first;
    // `alpha-body` must NOT be misclassified as a title match even though its title has `beta`.
    assert_eq!(results.len(), 2);
    assert_eq!(results[0].reference.session_id, "beta-gamma");
    assert_eq!(results[0].match_type, "title");
    assert_eq!(results[1].reference.session_id, "alpha-body");
    assert_eq!(results[1].match_type, "user_message");
    assert!(results[1].snippet.contains("alpha"));
    assert!(results[1].snippet.starts_with("… "));
    assert!(!results[1].snippet.contains('\u{FFFD}'));
    assert!(results[1].snippet.len() < 300);
}

#[test]
fn find_session_message_matches_isolates_reference_and_supports_ascii_and_cjk() {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../storage/schema.sql"))
        .unwrap();
    for (node, agent, id) in [
        ("local", "codex", "shared"),
        ("worker-a", "codex", "shared"),
        ("local", "claudecode", "shared"),
        ("local", "codex", "other"),
    ] {
        db.execute(
            "INSERT INTO sessions(source_node_id,agent_name,session_id,title,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost) VALUES(?,?,?,'title','/repo','path','/repo','repo',1,2,2,4,0,0,0)",
            params![node, agent, id],
        )
        .unwrap();
    }
    for (index, body) in [
        (0, "initial prompt without hit"),
        (1, "tool output with NeedleToken and 数据库连接"),
        (2, "middle message"),
        (3, "follow-up mentioning needletoken and 数据库"),
    ] {
        db.execute(
            "INSERT INTO messages(source_node_id,agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES('local','codex','shared',?,?,'assistant',1,json_array(json_object('type','text','text',?)), 'assistant text')",
            params![index, format!("m{index}"), body],
        )
        .unwrap();
    }
    for (node, agent, id) in [
        ("worker-a", "codex", "shared"),
        ("local", "claudecode", "shared"),
        ("local", "codex", "other"),
    ] {
        db.execute(
            "INSERT INTO messages(source_node_id,agent_name,session_id,message_index,message_id,role,time_created,parts_json,content_text) VALUES(?,?,?,0,'m0','assistant',1,json_array(json_object('type','text','text','NeedleToken 数据库连接')),'assistant text')",
            params![node, agent, id],
        )
        .unwrap();
    }

    let local_codex = SessionReference {
        source_node_id: "local".into(),
        agent_name: "codex".into(),
        session_id: "shared".into(),
    };
    let remote_codex = SessionReference {
        source_node_id: "worker-a".into(),
        agent_name: "codex".into(),
        session_id: "shared".into(),
    };

    assert!(
        find_session_message_matches(&db, &local_codex, "text")
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        find_session_message_matches(&db, &local_codex, "needletoken").unwrap(),
        vec![1, 3]
    );
    assert_eq!(
        find_session_message_matches(&db, &local_codex, "数据库").unwrap(),
        vec![1, 3]
    );
    assert_eq!(
        find_session_message_matches(&db, &local_codex, "数据库连接").unwrap(),
        vec![1]
    );
    assert_eq!(
        find_session_message_matches(&db, &local_codex, "needletoken 数据库连接").unwrap(),
        vec![1]
    );
    assert_eq!(
        find_session_message_matches(&db, &local_codex, "   ").unwrap(),
        Vec::<usize>::new()
    );
    assert_eq!(
        find_session_message_matches(&db, &remote_codex, "needletoken").unwrap(),
        vec![0]
    );
}
