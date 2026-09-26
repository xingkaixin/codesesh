use super::*;
#[test]
fn topic_active_branch_omits_deleted_and_alternative_messages() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("Data");
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("cherrystudio.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(include_str!("fixture.sql")).unwrap();
    db.execute_batch(r#"
    INSERT INTO topic (id,name,active_node_id) VALUES ('topic','Review','b'),('deleted','Gone','z');
    UPDATE topic SET deleted_at=1 WHERE id='deleted';
    INSERT INTO message (id,topic_id,parent_id,role,data,stats,created_at,updated_at) VALUES
      ('a','topic',NULL,'user','{"parts":[{"type":"text","text":"Review code"}]}',NULL,1000,1000),
      ('b','topic','a','assistant','{"parts":[{"type":"text","text":"<system-reminder>hidden</system-reminder>Done"}]}','{"inputTokens":12,"outputTokens":3,"costs":[{"currency":"USD","amount":0.1}]}',2000,2000),
      ('c','topic','a','assistant','{"parts":[{"type":"text","text":"Alternative"}]}',NULL,3000,3000),
      ('z','deleted',NULL,'user','{"parts":[{"type":"text","text":"Hidden"}]}',NULL,1000,1000);
    "#).unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    let parsed = scan(root.path(), &Pricing::bundled()).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), before);
    assert_eq!(parsed.len(), 1);
    let detail = &parsed[0].detail;
    assert_eq!(detail.head.reference.session_id, "topic:topic");
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.head.stats.total_cost, 0.1);
    assert!(matches!(&detail.messages[1].parts[0],MessagePart::Text{text,..} if text=="Done"));
    assert_eq!(detail.head.stats.total_tokens, Some(15.0));

    let db = Connection::open(root.path().join("Data/cherrystudio.sqlite")).unwrap();
    db.execute_batch(r#"UPDATE message SET model_id='openai::gpt-4o',stats='{"inputTokens":12,"outputTokens":3,"outputTokenDetails":{"reasoningTokens":2}}' WHERE id='b'"#).unwrap();
    crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
    db.execute_batch("INSERT INTO agent_session (id,name) VALUES ('bad','Malformed'); INSERT INTO agent_session_message (id,session_id,role,data) VALUES ('bad','bad','assistant','{broken')").unwrap();
    let before = fingerprints(root.path()).unwrap();
    db.execute_batch("UPDATE topic SET created_at=1000.125,last_activity_at=4000.875 WHERE id='topic'; UPDATE message SET created_at=2000.375,updated_at=2000.625,data=replace(data,'Done','Next') WHERE id='b'")
        .unwrap();
    let after = fingerprints(root.path()).unwrap();
    assert_eq!(before["agent:bad"], after["agent:bad"]);
    assert_ne!(before["topic:topic"], after["topic:topic"]);
    let (selected, page_fingerprints) = scan_page(
        root.path(),
        &Pricing::bundled(),
        &["topic:topic".into()].into_iter().collect(),
    )
    .unwrap();
    assert_eq!(selected.len(), 1);
    assert!(
        matches!(&selected[0].detail.messages[1].parts[0],MessagePart::Text{text,..} if text=="Next")
    );
    assert!(
        enumerate_session_keys(root.path())
            .unwrap()
            .contains(&("topic:topic".into(), 4000.875))
    );
    assert_eq!(page_fingerprints.len(), 1);
    assert_eq!(page_fingerprints["topic:topic"], after["topic:topic"]);
    assert_eq!(selected[0].head.time_created, 1000.125);
    assert_eq!(selected[0].head.time_updated, 4000.875);
    assert_eq!(selected[0].detail.messages[1].time_created, 2000.375);
    assert_eq!(
        selected[0].detail.messages[1].time_completed,
        Some(2000.625)
    );
    assert!(scan(root.path(), &Pricing::bundled()).is_err());
    db.execute_batch("DELETE FROM topic WHERE id='topic'")
        .unwrap();
    assert!(
        !fingerprints(root.path())
            .unwrap()
            .contains_key("topic:topic")
    );
}
