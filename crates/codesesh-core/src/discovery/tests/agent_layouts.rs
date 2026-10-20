use super::*;

#[test]
fn qoder_cn_reads_claude_layout_from_its_override_and_reports_deleted_subagents() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    let root = temporary.path().join("qcn");
    env.variables.insert(
        "QODERCN_CONFIG_DIR".into(),
        root.to_string_lossy().into_owned(),
    );
    assert_eq!(
        env.source("qoder").unwrap().scan_path,
        env.home.join(".qoder/projects")
    );
    let source = env.source("qoder-cn").unwrap();
    assert_eq!(source.scan_path, root.join("projects"));
    let id = "11111111-aaaa-4bbb-8ccc-000000000002";
    let session = source.scan_path.join(format!("-work-q/{id}.jsonl"));
    let child = source
        .scan_path
        .join(format!("-work-q/{id}/subagents/agent-a1.jsonl"));
    let write = |path: &Path, records: &[serde_json::Value]| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let lines: Vec<_> = records.iter().map(serde_json::Value::to_string).collect();
        std::fs::write(path, lines.join("\n")).unwrap();
    };
    write(
        &session,
        &[
            serde_json::json!({"type":"user","uuid":"u1","timestamp":"2026-09-27T09:00:00.000Z","cwd":"/work/q","sessionId":id,"message":{"role":"user","content":"Explain the cache"}}),
            serde_json::json!({"type":"assistant","uuid":"a1","timestamp":"2026-09-27T09:00:30.000Z","cwd":"/work/q","sessionId":id,"message":{"model":"glm-5","id":"m1","role":"assistant","content":[{"type":"tool_use","id":"call","name":"Task","input":{"description":"Inspect"}}],"usage":{"input_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":300,"output_tokens":25}}}),
            serde_json::json!({"type":"user","uuid":"u2","timestamp":"2026-09-27T09:00:40.000Z","cwd":"/work/q","sessionId":id,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call","content":"Done"}]}}),
        ],
    );
    write(
        &child,
        &[
            serde_json::json!({"isSidechain":true,"type":"assistant","uuid":"a2","timestamp":"2026-09-27T09:00:20.000Z","cwd":"/work/q","sessionId":id,"message":{"model":"glm-5","id":"m2","role":"assistant","content":[{"type":"text","text":"Inspected"}],"usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5}}}),
        ],
    );
    let db = temporary.path().join("cache.db");
    let mut scanner = AgentScanner::new(
        source.clone(),
        db.clone(),
        std::sync::Arc::new(Pricing::bundled()),
    );
    let mut batch = scanner.refresh(None).unwrap();
    let parent = batch
        .sessions
        .iter()
        .find(|s| s.head.reference.session_id == id)
        .unwrap();
    let reference = parent.head.reference.clone();
    assert_eq!(reference.agent_name, "qoder-cn");
    assert_eq!(parent.head.title, "Explain the cache");
    assert_eq!(parent.head.directory, "/work/q");
    assert_eq!(parent.head.stats.total_input_tokens, 340.0);
    assert_eq!(parent.head.stats.total_output_tokens, 25.0);
    let message = &parent.detail.messages[1];
    assert_eq!(message.agent.as_deref(), Some("qoder-cn"));
    let crate::model::MessagePart::Tool { state, .. } = &message.parts[0] else {
        panic!()
    };
    assert_eq!(state.status, "completed");
    let subagent = batch
        .sessions
        .iter()
        .find(|s| s.head.reference.session_id == "a1")
        .unwrap();
    assert_eq!(subagent.head.parent_reference.as_ref(), Some(&reference));
    assert_eq!(subagent.head.stats.total_output_tokens, 5.0);
    let removed = subagent.head.reference.clone();
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    cache.publish(&mut batch.sessions).unwrap();
    batch.on_reject.take();
    std::fs::remove_file(&child).unwrap();
    let deleted = scanner.refresh(Some(&[child])).unwrap();
    assert_eq!(deleted.removed, [removed]);
}

#[test]
fn omp_reads_xdg_sessions_with_nested_subagents_and_reports_deleted_advisors() {
    let temporary = tempfile::tempdir().unwrap();
    let mut env = environment(temporary.path());
    let default = env.home.join(".omp/agent/sessions");
    let xdg = temporary.path().join("xdg");
    env.variables
        .insert("XDG_DATA_HOME".into(), xdg.to_string_lossy().into_owned());
    assert_eq!(env.source("omp").unwrap().scan_path, default);
    std::fs::create_dir_all(xdg.join("omp")).unwrap();
    let source = env.source("omp").unwrap();
    assert_eq!(source.scan_path, xdg.join("omp/sessions"));
    let mut windows = env.clone();
    windows.platform = "win32".into();
    assert_eq!(windows.source("omp").unwrap().scan_path, default);
    let stem = "2026-09-28T08-00-00-000Z_019a0000-0000-7000-8000-00000000000a";
    let project = source.scan_path.join("--work-omp--");
    let main = project.join(format!("{stem}.jsonl"));
    let artifacts = project.join(stem);
    let explore = artifacts.join("0-Explore.jsonl");
    let find = artifacts.join("0-Explore/0-Find.jsonl");
    let advisor = artifacts.join("__advisor.jsonl");
    let write = |path: &Path, records: &[serde_json::Value]| {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let lines: Vec<_> = records.iter().map(serde_json::Value::to_string).collect();
        std::fs::write(path, lines.join("\n")).unwrap();
    };
    write(
        &main,
        &[
            serde_json::json!({"type":"title","v":1,"title":"Port the parser to omp","source":"auto"}),
            serde_json::json!({"type":"session","version":3,"id":"019a0000-0000-7000-8000-00000000000a","title":"Port the parser","timestamp":"2026-09-28T08:00:00.000Z","cwd":"/work/omp"}),
            serde_json::json!({"type":"message","id":"a1","parentId":null,"timestamp":"2026-09-28T08:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Port the parser"}]}}),
            serde_json::json!({"type":"message","id":"a2","parentId":"a1","timestamp":"2026-09-28T08:00:05.000Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"toolu_1","name":"task","arguments":{"agent":"explore"}}],"provider":"anthropic","model":"claude-opus-5-5","usage":{"input":100,"output":50,"cacheRead":1000,"cacheWrite":200,"totalTokens":1350,"cost":{"total":0}}}}),
            serde_json::json!({"type":"model_usage","id":"a3","parentId":"a2","timestamp":"2026-09-28T08:00:06.000Z","model":"claude-haiku-5","usage":{"input":20,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":25}}),
            serde_json::json!({"type":"message","id":"a4","parentId":"a2","timestamp":"2026-09-28T08:00:50.000Z","message":{"role":"toolResult","toolCallId":"toolu_1","toolName":"task","content":[{"type":"text","text":"done"}],"isError":false}}),
            serde_json::json!({"type":"message","id":"a5","parentId":"a4","timestamp":"2026-09-28T08:01:00.000Z","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"provider":"anthropic","model":"claude-opus-5-5","usage":{"input":10,"output":5,"cacheRead":500,"cacheWrite":0,"totalTokens":515,"cost":{"total":0}}}}),
            serde_json::json!({"type":"title_change","id":"a6","parentId":"a5","timestamp":"2026-09-28T08:01:10.000Z","title":"Port the parser to omp","previousTitle":"Port the parser"}),
        ],
    );
    let child = |path: &Path, id: &str, parent: &Path, text: &str| {
        write(
            path,
            &[
                serde_json::json!({"type":"session","version":3,"id":id,"timestamp":"2026-09-28T08:00:10.000Z","cwd":"/work/omp","parentSession":parent}),
                serde_json::json!({"type":"message","id":"b1","parentId":null,"timestamp":"2026-09-28T08:00:11.000Z","message":{"role":"user","content":[{"type":"text","text":text}]}}),
            ],
        )
    };
    child(
        &explore,
        "019a0000-0000-7000-8000-00000000001a",
        &main,
        "Find the parser",
    );
    child(
        &find,
        "019a0000-0000-7000-8000-00000000002a",
        &explore,
        "Grep for parse",
    );
    child(
        &advisor,
        "019a0000-0000-7000-8000-00000000003a",
        &main,
        "Review the plan",
    );
    std::fs::create_dir_all(artifacts.join("btw-history")).unwrap();
    std::fs::write(artifacts.join("btw-history/1790582450000.json"), "{}").unwrap();
    let db = temporary.path().join("cache.db");
    let mut scanner = AgentScanner::new(
        source.clone(),
        db.clone(),
        std::sync::Arc::new(Pricing::bundled()),
    );
    let mut batch = scanner.refresh(None).unwrap();
    assert_eq!(batch.sessions.len(), 4);
    let session = |id: &str| {
        batch
            .sessions
            .iter()
            .find(|s| {
                s.head.reference.session_id == format!("019a0000-0000-7000-8000-00000000{id}")
            })
            .unwrap()
    };
    let parent = session("000a");
    assert_eq!(parent.head.reference.agent_name, "omp");
    assert_eq!(parent.head.title, "Port the parser to omp");
    assert_eq!(parent.head.parent_reference, None);
    assert_eq!(parent.head.stats.total_input_tokens, 1810.0);
    assert_eq!(parent.head.stats.total_output_tokens, 55.0);
    let message = &parent.detail.messages[1];
    assert_eq!(message.agent.as_deref(), Some("omp"));
    let crate::model::MessagePart::Tool { state, .. } = &message.parts[0] else {
        panic!()
    };
    assert_eq!(state.status, "completed");
    let reference = |id: &str| Some(session(id).head.reference.clone());
    assert_eq!(session("001a").head.parent_reference, reference("000a"));
    assert_eq!(session("002a").head.parent_reference, reference("001a"));
    assert_eq!(session("003a").head.parent_reference, reference("000a"));
    let removed = session("003a").head.reference.clone();
    let mut cache = crate::storage::Cache::open(Some(&db)).unwrap();
    cache.publish(&mut batch.sessions).unwrap();
    batch.on_reject.take();
    std::fs::remove_file(&advisor).unwrap();
    let deleted = scanner.refresh(Some(&[advisor])).unwrap();
    assert_eq!(deleted.removed, [removed]);
}

#[test]
fn claude_workflow_agents_are_nested_under_their_session() {
    let temporary = tempfile::tempdir().unwrap();
    let source = AgentSource {
        agent: "claudecode".into(),
        data_root: temporary.path().to_owned(),
        scan_path: temporary.path().join("projects"),
    };
    let run = source
        .scan_path
        .join("project/parent/subagents/workflows/wf_run");
    std::fs::create_dir_all(&run).unwrap();
    let user = |text: &str| {
        serde_json::json!({"type":"user","message":{"role":"user","content":text}}).to_string()
    };
    std::fs::write(
        source.scan_path.join("project/parent.jsonl"),
        user("Parent"),
    )
    .unwrap();
    std::fs::write(run.join("agent-worker.jsonl"), user("Workflow step")).unwrap();
    std::fs::write(
        run.join("journal.jsonl"),
        serde_json::json!({"type":"started","key":"step","agentId":"worker"}).to_string(),
    )
    .unwrap();
    let pricing = std::sync::Arc::new(Pricing::bundled());
    let full = scan_source(&source, &pricing).unwrap().sessions;
    let mut scanner = AgentScanner::new(source, temporary.path().join("cache.db"), pricing);
    let mut paged = scanner.refresh(None).unwrap();
    for sessions in [&full, &paged.sessions] {
        let mut nested: Vec<_> = sessions
            .iter()
            .map(|s| {
                (
                    s.head.reference.session_id.as_str(),
                    s.head
                        .parent_reference
                        .as_ref()
                        .map(|r| r.session_id.as_str()),
                )
            })
            .collect();
        nested.sort();
        assert_eq!(nested, [("parent", None), ("worker", Some("parent"))]);
    }
    paged.on_reject.take();
}
