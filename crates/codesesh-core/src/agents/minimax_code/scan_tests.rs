use super::*;
#[test]
fn turn_usage_attaches_to_last_answer_and_database_remains_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("v2/sqlite");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("runtime-state.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixture.sql")).unwrap();
    db.execute_batch(r#"
      INSERT INTO local_runtime_sessions (session_id,title) VALUES ('s','');
      INSERT INTO local_runtime_message_rows (session_id,msg_id,role,turn_id,source,created_at_ms,data_json) VALUES
      ('s','u','user','t','user',2500,'{"msg_id":"u","msg_content":"Inspect project"}'),
      ('s','a','assistant','t','user',2500,'{"msg_id":"a","msg_content":"Done","finish_reason":"stop"}'),
      ('s','compact','assistant','t','user',3500,'{"msg_id":"compact","kind":"compaction"}');
      INSERT INTO local_runtime_token_usage (session_id,turn_id,model,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES ('s','t','minimax/MiniMax-M3',100,20,5,40,10,0.025),('s','t','minimax/MiniMax-M3',50,10,0,0,0,0);
    "#).unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let parsed = scan(root.path(), &Pricing::bundled()).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), before);
    let detail = &parsed[0].detail;
    assert_eq!(detail.head.title, "Inspect project");
    assert_eq!(detail.head.stats.total_tokens, Some(235.0));
    assert_eq!(detail.head.stats.total_cost, 0.025);
    assert_eq!(
        detail.messages[1].tokens.as_ref().unwrap().input,
        Some(150.0)
    );
    assert!(detail.messages[2].tokens.is_none());
    assert_eq!(detail.head.time_updated, 3500.0);

    let db = Connection::open(root.path().join("v2/sqlite/runtime-state.sqlite")).unwrap();
    db.execute_batch("UPDATE local_runtime_token_usage SET cost_usd=NULL WHERE input_tokens=50")
        .unwrap();
    crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
    db.execute_batch("INSERT INTO local_runtime_sessions (session_id,title) VALUES ('bad','Malformed'); INSERT INTO local_runtime_message_rows (session_id,msg_id,role,data_json) VALUES ('bad','bad','assistant','{broken')").unwrap();
    let before = fingerprints(root.path()).unwrap();
    db.execute_batch("UPDATE local_runtime_sessions SET created_at_ms=1000.125 WHERE session_id='s'; UPDATE local_runtime_message_rows SET created_at_ms=2500.375,data_json=replace(data_json,'Done','Next') WHERE msg_id='a'; UPDATE local_runtime_token_usage SET ts=4000.875 WHERE session_id='s'").unwrap();
    let after = fingerprints(root.path()).unwrap();
    assert_eq!(before["bad"], after["bad"]);
    assert_ne!(before["s"], after["s"]);
    let (selected, page_fingerprints) = scan_page(
        root.path(),
        &Pricing::bundled(),
        &["s".into()].into_iter().collect(),
    )
    .unwrap();
    assert_eq!(selected.len(), 1);
    assert!(
        matches!(&selected[0].detail.messages[1].parts[0],MessagePart::Text{text,..} if text=="Next")
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
    assert_eq!(selected[0].detail.messages[1].time_created, 2500.375);
    assert_eq!(
        selected[0].detail.messages[1].time_completed,
        Some(2500.375)
    );
    assert!(scan(root.path(), &Pricing::bundled()).is_err());
    db.execute_batch("DELETE FROM local_runtime_sessions WHERE session_id='s'")
        .unwrap();
    assert!(!fingerprints(root.path()).unwrap().contains_key("s"));
}
