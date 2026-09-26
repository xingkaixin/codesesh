use super::*;
use crate::{agents::codex, pricing::Pricing};
use std::{collections::HashMap, fs, path::Path, sync::atomic::AtomicUsize};

fn write_source(path: &Path, text: &str) {
    fs::write(path, format!("{{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"/fixture\"}}}}\n{{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"text\":{}}}]}}}}\n", serde_json::to_string(text).unwrap())).unwrap();
}

fn batch(path: &Path) -> Result<ScanBatch> {
    let parsed = codex::parse(path, &HashMap::new(), &Pricing::bundled())?.unwrap();
    Ok(ScanBatch {
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
                    sessions: vec![],
                    removed: vec![SessionReference {
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
    until(|| runtime.status().agent_statuses["codex"].status == "failed").await;
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
                    sessions: vec![],
                    removed: vec![SessionReference {
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
    };
    let runtime = Runtime::start(database, vec![source], 1).await.unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    fs::remove_file(path).unwrap();
    until(|| runtime.snapshot().is_empty()).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_scan_is_rejected_before_publication() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("rollout-fixture.jsonl");
    write_source(&path, "fixture");
    let calls = Arc::new(AtomicUsize::new(0));
    let proceed = Arc::new(AtomicBool::new(false));
    let rejected = Arc::new(AtomicUsize::new(0));
    let scan_calls = calls.clone();
    let scan_proceed = proceed.clone();
    let scan_rejected = rejected.clone();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![],
        scan: Arc::new(move |_| {
            let call = scan_calls.fetch_add(1, Ordering::AcqRel);
            if call == 0 {
                while !scan_proceed.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            let rejected = scan_rejected.clone();
            let mut result = batch(&path)?;
            result.on_reject = Some(Box::new(move || {
                rejected.fetch_add(1, Ordering::AcqRel);
            }));
            Ok(result)
        }),
    };
    let runtime = Runtime::start(temporary.path().join("cache.db"), vec![source], 1)
        .await
        .unwrap();
    until(|| calls.load(Ordering::Acquire) == 1).await;
    runtime.refresh("codex").unwrap();
    proceed.store(true, Ordering::Release);
    until(|| runtime.status().completed_agents.len() == 1).await;
    assert_eq!(rejected.load(Ordering::Acquire), 1);
    assert_eq!(calls.load(Ordering::Acquire), 2);
    assert_eq!(runtime.snapshot().len(), 1);
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
    };
    let runtime = Runtime::start(database.clone(), vec![source], 1)
        .await
        .unwrap();
    let mut events = runtime.subscribe();
    until(|| runtime.status().agent_statuses["codex"].status == "failed").await;
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
    };
    let runtime = Runtime::start(database.clone(), vec![source], 1)
        .await
        .unwrap();
    until(|| runtime.status().agent_statuses["codex"].status == "failed").await;
    assert_eq!(runtime.snapshot().len(), 1);
    runtime.shutdown().await.unwrap();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![],
        scan: Arc::new(move |request| {
            assert_eq!(request.checkpoint, Some(serde_json::json!({"next":1})));
            batch(&second)
        }),
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
    };
    let runtime = Runtime::start(temporary.path().join("cache.db"), vec![source], 1)
        .await
        .unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    fs::remove_dir_all(&root).unwrap();
    until(|| runtime.status().agent_statuses["codex"].status == "failed").await;
    assert_eq!(runtime.snapshot()[0].title, "before");
    fs::create_dir(&root).unwrap();
    write_source(&path, "recreated");
    until(|| runtime.snapshot()[0].title == "recreated").await;
    write_source(&path, "rewritten after recreation");
    until(|| runtime.snapshot()[0].title == "rewritten after recreation").await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn database_read_queue_is_bounded() {
    let temporary = tempfile::tempdir().unwrap();
    let runtime = Runtime::start(temporary.path().join("cache.db"), vec![], 1)
        .await
        .unwrap();
    let release = Arc::new(AtomicBool::new(false));
    let started = Arc::new(AtomicBool::new(false));
    let reader = runtime.clone();
    let ready = started.clone();
    let unblock = release.clone();
    let running = tokio::spawn(async move {
        reader
            .read(move |_| {
                ready.store(true, Ordering::Release);
                while !unblock.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(())
            })
            .await
    });
    until(|| started.load(Ordering::Acquire)).await;
    let mut waiting = Vec::new();
    for _ in 0..64 {
        let reader = runtime.clone();
        waiting.push(tokio::spawn(async move { reader.read(|_| Ok(())).await }));
    }
    until(|| runtime.inner.read_queue.available_permits() == 0).await;
    let error = runtime.read(|_| Ok(())).await.unwrap_err();
    assert!(error.is::<ReadBusy>());
    release.store(true, Ordering::Release);
    running.await.unwrap().unwrap();
    for task in waiting {
        task.await.unwrap().unwrap();
    }
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn query_heads_and_facts_share_a_transaction_while_writer_commits() {
    let temporary = tempfile::tempdir().unwrap();
    let source_path = temporary.path().join("rollout-fixture.jsonl");
    write_source(&source_path, "before commit");
    let path = source_path.clone();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![],
        scan: Arc::new(move |_| batch(&path)),
    };
    let runtime = Runtime::start(temporary.path().join("cache.db"), vec![source], 2)
        .await
        .unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    let reader = runtime.clone();
    let (heads_ready, ready) = oneshot::channel();
    let (release, committed) = oneshot::channel();
    let query = tokio::spawn(async move {
        reader
            .read_snapshot(move |connection, heads| {
                let head = &heads[0];
                let _ = heads_ready.send(());
                committed.blocking_recv()?;
                let title: String =
                    connection.query_row("SELECT title FROM sessions", [], |row| row.get(0))?;
                let messages: i64 =
                    connection.query_row("SELECT count(*) FROM messages", [], |row| row.get(0))?;
                Ok((
                    head.title.clone(),
                    head.stats.message_count,
                    title,
                    messages,
                ))
            })
            .await
    });
    ready.await.unwrap();
    write_source(&source_path, "after commit");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(&source_path)
            .unwrap();
        writeln!(file, "{{\"timestamp\":\"2026-09-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"text\":\"new fact\"}}]}}}}").unwrap();
    }
    runtime.refresh("codex").unwrap();
    until(|| runtime.snapshot()[0].title == "after commit").await;
    assert_eq!(runtime.snapshot()[0].stats.message_count, 2);
    release.send(()).unwrap();
    let (head_title, head_count, fact_title, fact_count) = query.await.unwrap().unwrap();
    assert_eq!(head_title, "before commit");
    assert_eq!(fact_title, head_title);
    assert_eq!(head_count, 1);
    assert_eq!(fact_count, 1);
    let next_title = runtime
        .read_snapshot(|connection, heads| {
            let title: String =
                connection.query_row("SELECT title FROM sessions", [], |row| row.get(0))?;
            assert_eq!(heads[0].title, title);
            Ok(title)
        })
        .await
        .unwrap();
    assert_eq!(next_title, "after commit");
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn failed_read_releases_snapshot_before_connection_reuse() {
    let temporary = tempfile::tempdir().unwrap();
    let database = temporary.path().join("cache.db");
    let runtime = Runtime::start(database.clone(), vec![], 1).await.unwrap();
    let writer = Connection::open(database).unwrap();
    writer
        .execute(
            "INSERT INTO cache_meta(key,value) VALUES('pool-test','before')",
            [],
        )
        .unwrap();
    let failed = runtime
        .read::<()>(|connection| {
            let value: String = connection.query_row(
                "SELECT value FROM cache_meta WHERE key='pool-test'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(value, "before");
            bail!("injected read failure");
        })
        .await
        .unwrap_err();
    assert_eq!(failed.to_string(), "injected read failure");
    {
        let idle = runtime.inner.idle_readers.lock().unwrap();
        assert_eq!(idle.len(), 1);
        assert!(idle[0].is_autocommit());
    }
    writer
        .execute(
            "UPDATE cache_meta SET value='after' WHERE key='pool-test'",
            [],
        )
        .unwrap();
    let checkpoint_busy: i64 = writer
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| row.get(0))
        .unwrap();
    assert_eq!(checkpoint_busy, 0);
    let value = runtime
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT value FROM cache_meta WHERE key='pool-test'",
                [],
                |row| row.get::<_, String>(0),
            )?)
        })
        .await
        .unwrap();
    assert_eq!(value, "after");
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
async fn prefetched_batch_is_discarded_when_publication_is_locked() {
    let root = tempfile::tempdir().unwrap();
    let db = root.path().join("cache.db");
    drop(crate::storage::Cache::open(Some(&db)).unwrap());
    let blocker = Arc::new(Mutex::new(Connection::open(&db).unwrap()));
    let first = root.path().join("rollout-first.jsonl");
    let second = root.path().join("rollout-second.jsonl");
    write_source(&first, "First");
    write_source(&second, "Second");
    let calls = Arc::new(AtomicUsize::new(0));
    let rejected = Arc::new(AtomicUsize::new(0));
    let scan_calls = calls.clone();
    let scan_rejected = rejected.clone();
    let scan_blocker = blocker.clone();
    let runtime = Runtime::start(
        db.clone(),
        vec![AgentSource {
            name: "codex".into(),
            roots: vec![],
            scan: Arc::new(move |request| {
                let index = scan_calls.fetch_add(1, Ordering::SeqCst);
                if index == 0 {
                    scan_blocker
                        .lock()
                        .unwrap()
                        .execute_batch("BEGIN IMMEDIATE")?;
                } else {
                    assert_eq!(index, 1);
                    assert_eq!(request.checkpoint, Some(serde_json::json!({"offset":1})));
                }
                let mut result = batch(if index == 0 { &first } else { &second })?;
                result.complete = index == 1;
                result.checkpoint = (index == 0).then(|| serde_json::json!({"offset":1}));
                let rejected = scan_rejected.clone();
                result.on_reject = Some(Box::new(move || {
                    rejected.fetch_add(1, Ordering::SeqCst);
                }));
                Ok(result)
            }),
        }],
        2,
    )
    .await
    .unwrap();
    until(|| calls.load(Ordering::SeqCst) == 2).await;
    assert!(runtime.snapshot().is_empty());
    until(|| rejected.load(Ordering::SeqCst) == 2).await;
    blocker.lock().unwrap().execute_batch("COMMIT").unwrap();
    assert!(runtime.snapshot().is_empty());
    let count: i64 = blocker
        .lock()
        .unwrap()
        .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn backfill_reports_durable_progress_and_clears_it_on_completion() {
    let temporary = tempfile::tempdir().unwrap();
    let finish = Arc::new(AtomicBool::new(false));
    let gate = finish.clone();
    let source = AgentSource {
        name: "codex".into(),
        roots: vec![],
        scan: Arc::new(move |request| {
            let complete = request.checkpoint.is_some();
            if complete {
                while !gate.load(Ordering::Acquire) {
                    request.cancellation.check()?;
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
            Ok(ScanBatch {
                sessions: vec![],
                removed: vec![],
                checkpoint: (!complete).then(|| serde_json::json!({"offset":32,"total":100})),
                complete,
                on_reject: None,
                pricing: None,
            })
        }),
    };
    let runtime = Runtime::start(temporary.path().join("cache.db"), vec![source], 1)
        .await
        .unwrap();
    until(|| runtime.status().backfill.progress.is_some()).await;
    let status = runtime.status();
    assert_eq!(status.backfill.current_agent.as_deref(), Some("codex"));
    let progress = status.backfill.progress.as_ref().unwrap();
    assert_eq!((progress.processed, progress.total), (32, 100));
    finish.store(true, Ordering::Release);
    until(|| !runtime.status().active).await;
    assert!(!runtime.status().backfill.active);
    assert!(runtime.status().backfill.progress.is_none());
    runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn pricing_refresh_publishes_cached_costs_without_rewriting_messages() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("pi");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("session.jsonl"), [
        serde_json::json!({"type":"session","cwd":"/fixture","timestamp":1000}),
        serde_json::json!({"type":"message","id":"u","message":{"role":"user","content":"Pricing fixture"}}),
        serde_json::json!({"type":"message","id":"a","parentId":"u","message":{"role":"assistant","model":"runtime-cost-model","usage":{"input":1000000},"content":[{"type":"text","text":"Body remains unchanged"}]}}),
    ].iter().map(serde_json::Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
    let controller = crate::pricing::PricingController::load(temporary.path());
    let database = temporary.path().join("cache.db");
    let source = crate::discovery::AgentSource {
        agent: "pi".into(),
        data_root: root.clone(),
        scan_path: root,
    };
    let scanner = crate::discovery::AgentScanner::with_pricing_controller(
        source,
        database.clone(),
        controller.clone(),
    )
    .unwrap();
    let runtime = Runtime::start(database.clone(), vec![scanner.into_runtime_source()], 1)
        .await
        .unwrap();
    until(|| runtime.status().completed_agents.len() == 1).await;
    let cache = crate::storage::Cache::open(Some(&database)).unwrap();
    cache.connection().execute_batch("CREATE TRIGGER reject_pricing_rescan BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'pricing rescanned messages'); END").unwrap();
    let mut events = runtime.subscribe();
    controller.stage_remote(&serde_json::json!({"openai":{"models":{"runtime-cost-model":{"cost":{"input":12,"output":8}}}}})).unwrap();
    controller.publish_pending().unwrap();
    runtime.refresh("pi").unwrap();
    until(|| runtime.snapshot()[0].stats.total_cost == 12.0).await;
    assert!(!runtime.status().backfill.active);
    let mut cost_event = false;
    while let Ok(event) = events.try_recv() {
        if let Event::Sessions { changed, .. } = event {
            cost_event |= changed.iter().any(|head| head.stats.total_cost == 12.0);
        }
    }
    assert!(cost_event);
    runtime.shutdown().await.unwrap();
}
