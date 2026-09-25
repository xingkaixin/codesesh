use super::*;
#[test]
fn structured_blocks_override_stale_json_and_usage_is_counted_once() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("app_db");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("agent.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixture.sql")).unwrap();
    db.execute_batch(r#"
      INSERT INTO new_sessions (id,agent_id,title,project_dir) VALUES ('s','deepchat','Session','/work');
      INSERT INTO deepchat_sessions VALUES ('s','claude-sonnet-4-6','anthropic');
      INSERT INTO deepchat_messages (id,session_id,order_seq,role,content,metadata,created_at,updated_at) VALUES
        ('u','s',1,'user','{"text":"stale"}','{}',1000,3000),
        ('a','s',2,'assistant','[]','{"inputTokens":9999,"outputTokens":9999}',1000,3000);
      INSERT INTO deepchat_user_messages VALUES ('u','Read file');
      INSERT INTO deepchat_user_message_files VALUES ('u',0,'/work/input.txt','input.txt');
      INSERT INTO deepchat_assistant_blocks (message_id,block_index,block_type,status,text_content,updated_at) VALUES ('a',0,'reasoning_content','success','Inspect',3500),('a',2,'content','success','Done',4000);
      INSERT INTO deepchat_assistant_blocks (message_id,block_index,block_type,status,tool_call_id,tool_name,tool_params,tool_response,updated_at) VALUES ('a',1,'tool_call','success','call','read_file','{"path":"input.txt"}','body',3600);
      INSERT INTO deepchat_usage_stats VALUES ('answer','s','a','claude-sonnet-4-6','anthropic',1300,200,1500,200,100,3000,3000),('compaction','s',NULL,'claude-sonnet-4-6','anthropic',100,10,110,0,0,3500,9000);
    "#).unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let parsed = scan(root.path(), &Pricing::bundled()).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), before);
    let detail = &parsed[0].detail;
    assert_eq!(detail.head.time_updated, 4000.0);
    assert_eq!(detail.head.stats.total_input_tokens, 1400.0);
    assert_eq!(detail.head.stats.total_tokens, Some(1610.0));
    assert_eq!(detail.messages[0].parts.len(), 2);
    assert_eq!(detail.messages[1].parts.len(), 3);
    assert_eq!(
        detail.messages[1].tokens.as_ref().unwrap().input,
        Some(1300.0)
    );
    assert!(matches!(&detail.messages[0].parts[0],MessagePart::Text{text,..} if text=="Read file"));

    let before = fingerprints(root.path()).unwrap();
    let db = Connection::open(root.path().join("app_db/agent.db")).unwrap();
    db.execute_batch("UPDATE new_sessions SET created_at=1000.125 WHERE id='s'; UPDATE deepchat_messages SET created_at=1000.375,updated_at=3000.625 WHERE id='a'; UPDATE deepchat_assistant_blocks SET text_content='Next',updated_at=4000.875 WHERE message_id='a' AND block_index=2").unwrap();
    let after = fingerprints(root.path()).unwrap();
    assert_ne!(before["s"], after["s"]);
    let (selected, page_fingerprints) = scan_page(
        root.path(),
        &Pricing::bundled(),
        &["s".into()].into_iter().collect(),
    )
    .unwrap();
    assert!(
        matches!(&selected[0].detail.messages[1].parts[2],MessagePart::Text{text,..} if text=="Next")
    );
    assert!(
        enumerate_session_keys(root.path())
            .unwrap()
            .contains(&("s".into(), 4000.875))
    );
    assert_eq!(page_fingerprints.len(), 1);
    assert_eq!(page_fingerprints["s"], after["s"]);
    assert_eq!(selected[0].head.time_created, 1000.125);
    assert_eq!(selected[0].head.time_updated, 4000.875);
    assert_eq!(selected[0].detail.messages[1].time_created, 1000.375);
    assert_eq!(
        selected[0].detail.messages[1].time_completed,
        Some(3000.625)
    );
    db.execute_batch("DELETE FROM new_sessions WHERE id='s'")
        .unwrap();
    assert!(fingerprints(root.path()).unwrap().is_empty());
}
