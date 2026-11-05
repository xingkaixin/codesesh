use super::*;
use crate::{agents::codex, pricing::Pricing};
use std::{collections::HashMap, fs, path::Path};

fn write_source(path: &Path, text: &str) {
    fs::write(path, format!("{{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"/fixture\"}}}}\n{{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"text\":{}}}]}}}}\n", serde_json::to_string(text).unwrap())).unwrap();
}

fn batch(path: &Path) -> Result<ScanBatch> {
    let parsed = codex::parse(path, &HashMap::new(), &Pricing::bundled())?.unwrap();
    Ok(ScanBatch {
        source_presence: None,
        sessions: vec![ParsedSession {
            source: path.to_owned(),
            head: parsed.head.clone(),
            detail: parsed,
        }],
        removed: vec![],
        checkpoint: None,
        complete: true,
        on_reject: None,
        pricing: None,
    })
}

async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !predicate() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn notify_rewrite_failure_delete_and_restore_publish_durable_snapshots() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir(&root).unwrap();
    let path = root.join("rollout-fixture.jsonl");
    write_source(&path, "before");
    let fail = Arc::new(AtomicBool::new(false));
    let saw_incremental = Arc::new(AtomicBool::new(false));
    let scan_path = path.clone();
    let scan_fail = fail.clone();
    let incremental = saw_incremental.clone();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![root],
        scan: Arc::new(move |request| {
            if request.changed_paths.is_some() {
                incremental.store(true, Ordering::Release);
            }
            if scan_fail.load(Ordering::Acquire) {
                bail!("injected source failure");
            }
            if scan_path.exists() {
                batch(&scan_path)
            } else {
                Ok(ScanBatch {
                    source_presence: None,
                    sessions: vec![],
                    removed: vec![SessionReference {
                        source_node_id: crate::model::local_source_node_id(),
                        agent_name: "codex".into(),
                        session_id: "rollout-fixture".into(),
                    }],
                    checkpoint: None,
                    complete: true,
                    on_reject: None,
                    pricing: None,
                })
            }
        }),
        release_idle: None,
    };
    let database = temporary.path().join("cache.db");
    let runtime = Runtime::start(database.clone(), vec![source], 2)
        .await
        .unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    assert_eq!(runtime.snapshot()[0].title, "before");
    let mut events = runtime.subscribe();
    write_source(&path, "after rewrite");
    until(|| {
        runtime
            .snapshot()
            .first()
            .is_some_and(|head| head.title == "after rewrite")
    })
    .await;
    assert!(saw_incremental.load(Ordering::Acquire));
    while let Ok(event) = events.try_recv() {
        if let Event::Sessions { changed, .. } = event {
            let expected = changed[0].title.clone();
            let actual: String = runtime
                .read(|connection| {
                    Ok(connection.query_row("SELECT title FROM sessions", [], |row| row.get(0))?)
                })
                .await
                .unwrap();
            assert_eq!(actual, expected);
        }
    }
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{{\"timestamp\":\"2026-09-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"text\":\"appended response\"}}]}}}}").unwrap();
    }
    until(|| runtime.snapshot()[0].stats.message_count == 2).await;
    fail.store(true, Ordering::Release);
    runtime.refresh("codex").unwrap();
    until(|| {
        runtime.status().agent_statuses["codex"].status == crate::wire::AgentScanPhase::Failed
    })
    .await;
    assert_eq!(runtime.snapshot()[0].title, "after rewrite");
    runtime.shutdown().await.unwrap();
    let restored = Runtime::start(database.clone(), vec![], 1).await.unwrap();
    assert_eq!(restored.snapshot()[0].title, "after rewrite");
    restored.shutdown().await.unwrap();
    fail.store(false, Ordering::Release);
    let scan_path = path.clone();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![path.parent().unwrap().to_owned()],
        scan: Arc::new(move |_| {
            if scan_path.exists() {
                batch(&scan_path)
            } else {
                Ok(ScanBatch {
                    source_presence: None,
                    sessions: vec![],
                    removed: vec![SessionReference {
                        source_node_id: crate::model::local_source_node_id(),
                        agent_name: "codex".into(),
                        session_id: "rollout-fixture".into(),
                    }],
                    checkpoint: None,
                    complete: true,
                    on_reject: None,
                    pricing: None,
                })
            }
        }),
        release_idle: None,
    };
    let runtime = Runtime::start(database, vec![source], 1).await.unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    fs::remove_file(path).unwrap();
    until(|| runtime.snapshot().is_empty()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_transaction_never_publishes_and_retries_from_last_good_state() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("rollout-fixture.jsonl");
    write_source(&path, "fixture");
    let database = temporary.path().join("cache.db");
    let cache = crate::storage::Cache::open(Some(&database)).unwrap();
    cache.connection().execute_batch("CREATE TRIGGER reject_write BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END").unwrap();
    drop(cache);
    let rejected = Arc::new(AtomicBool::new(false));
    let scan_rejected = rejected.clone();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![],
        scan: Arc::new(move |_| {
            let mut value = batch(&path)?;
            let rejected = scan_rejected.clone();
            value.on_reject = Some(Box::new(move || {
                rejected.store(true, Ordering::Release);
            }));
            Ok(value)
        }),
        release_idle: None,
    };
    let runtime = Runtime::start(database.clone(), vec![source], 1)
        .await
        .unwrap();
    let mut events = runtime.subscribe();
    until(|| {
        runtime.status().agent_statuses["codex"].status == crate::wire::AgentScanPhase::Failed
    })
    .await;
    assert!(runtime.snapshot().is_empty());
    assert!(rejected.load(Ordering::Acquire));
    while let Ok(event) = events.try_recv() {
        assert!(!matches!(event, Event::Sessions { .. }));
    }
    let count: i64 = runtime
        .read(|connection| {
            Ok(connection.query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))?)
        })
        .await
        .unwrap();
    assert_eq!(count, 0);
    Connection::open(database)
        .unwrap()
        .execute_batch("DROP TRIGGER reject_write")
        .unwrap();
    runtime.refresh("codex").unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    assert_eq!(runtime.snapshot().len(), 1);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn backfill_resumes_a_durable_checkpoint_after_restart() {
    let temporary = tempfile::tempdir().unwrap();
    let first = temporary.path().join("rollout-first.jsonl");
    let second = temporary.path().join("rollout-second.jsonl");
    write_source(&first, "first");
    write_source(&second, "second");
    let database = temporary.path().join("cache.db");
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![],
        scan: Arc::new(move |request| {
            if request.checkpoint.is_some() {
                bail!("interrupted historical source");
            }
            let mut value = batch(&first)?;
            value.checkpoint = Some(serde_json::json!({"next":1}));
            value.complete = false;
            Ok(value)
        }),
        release_idle: None,
    };
    let runtime = Runtime::start(database.clone(), vec![source], 1)
        .await
        .unwrap();
    until(|| {
        runtime.status().agent_statuses["codex"].status == crate::wire::AgentScanPhase::Failed
    })
    .await;
    assert_eq!(runtime.snapshot().len(), 1);
    runtime.shutdown().await.unwrap();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![],
        scan: Arc::new(move |request| {
            assert_eq!(request.checkpoint, Some(serde_json::json!({"next":1})));
            batch(&second)
        }),
        release_idle: None,
    };
    let runtime = Runtime::start(database, vec![source], 1).await.unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    assert_eq!(runtime.snapshot().len(), 2);
    let count: i64 = runtime
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT count(*) FROM cache_meta WHERE key='rust_sync_checkpoint:codex'",
                [],
                |row| row.get(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(count, 0);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn removed_root_keeps_last_good_data_and_is_watched_after_recreation() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("source");
    fs::create_dir(&root).unwrap();
    let path = root.join("rollout-fixture.jsonl");
    write_source(&path, "before");
    let source_path = path.clone();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![root.clone()],
        scan: Arc::new(move |_| batch(&source_path)),
        release_idle: None,
    };
    let runtime = Runtime::start(temporary.path().join("cache.db"), vec![source], 1)
        .await
        .unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    fs::remove_dir_all(&root).unwrap();
    until(|| {
        runtime.status().agent_statuses["codex"].status == crate::wire::AgentScanPhase::Failed
    })
    .await;
    assert_eq!(runtime.snapshot()[0].title, "before");
    fs::create_dir(&root).unwrap();
    write_source(&path, "recreated");
    until(|| runtime.snapshot()[0].title == "recreated").await;
    write_source(&path, "rewritten after recreation");
    until(|| runtime.snapshot()[0].title == "rewritten after recreation").await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_wal_commits_are_observed_while_writer_stays_open() {
    let temporary = tempfile::tempdir().unwrap();
    let database = temporary.path().join("source.sqlite");
    let connection = Connection::open(&database).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE current_title(title TEXT); INSERT INTO current_title VALUES('before');").unwrap();
    let transcript = temporary.path().join("rollout-fixture.jsonl");
    write_source(&transcript, "fixture");
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![database.clone()],
        scan: Arc::new(move |_| {
            let connection =
                Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let title: String =
                connection.query_row("SELECT title FROM current_title", [], |row| row.get(0))?;
            let mut batch = batch(&transcript)?;
            batch.sessions[0].head.title = title.clone();
            batch.sessions[0].detail.head.title = title;
            Ok(batch)
        }),
        release_idle: None,
    };
    let runtime = Runtime::start(temporary.path().join("cache.db"), vec![source], 1)
        .await
        .unwrap();
    until(|| {
        runtime
            .snapshot()
            .first()
            .is_some_and(|head| head.title == "before")
    })
    .await;
    for title in ["first WAL commit", "second WAL commit"] {
        connection
            .execute("UPDATE current_title SET title=?1", [title])
            .unwrap();
        until(|| runtime.snapshot()[0].title == title).await;
    }
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn collection_status_distinguishes_absent_empty_and_disappeared_sources() {
    use crate::discovery::{AgentScanner, SourcePresence};
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("sessions");
    fs::create_dir(&root).unwrap();
    let database = temporary.path().join("cache.db");
    let source = crate::discovery::AgentSource {
        agent: "codex".into(),
        data_root: temporary.path().into(),
        scan_path: root.clone(),
    };
    let runtime = Runtime::start(
        database.clone(),
        vec![
            AgentScanner::new(source, database, Arc::new(Pricing::bundled())).into_runtime_source(),
        ],
        1,
    )
    .await
    .unwrap();
    until(|| runtime.status().sources["codex"].presence == SourcePresence::NotFound).await;
    assert!(runtime.snapshot().is_empty());
    let file = root.join("rollout-empty.jsonl");
    fs::write(&file, "").unwrap();
    runtime.refresh("codex").unwrap();
    until(|| runtime.status().sources["codex"].presence == SourcePresence::Available).await;
    assert!(runtime.snapshot().is_empty());
    fs::remove_file(file).unwrap();
    runtime.refresh("codex").unwrap();
    until(|| runtime.status().sources["codex"].presence == SourcePresence::Missing).await;
    runtime.shutdown().await.unwrap();
}
