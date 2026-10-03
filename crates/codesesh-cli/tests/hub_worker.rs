use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn command(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_codesesh"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("CODESESH_") {
            command.env_remove(key);
        }
    }
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("CODEX_HOME", home.join(".codex"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(home.join("process.log"))
                .unwrap(),
        ));
    command
}
fn hub(home: &Path, port: u16) -> (Process, url::Url, String) {
    server(home, port, true)
}
fn server(home: &Path, port: u16, hub_mode: bool) -> (Process, url::Url, String) {
    let mut cmd = command(home);
    if hub_mode {
        cmd.arg("hub");
    }
    let mut process = Process(
        cmd.args([
            "--auth",
            "--no-open",
            "--port",
            &port.to_string(),
            "--days",
            "0",
        ])
        .spawn()
        .unwrap(),
    );
    let stdout = process.0.stdout.take().unwrap();
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.starts_with("http") {
                let _ = send.send(line);
                break;
            }
        }
    });
    let line = receive
        .recv_timeout(Duration::from_secs(15))
        .unwrap_or_else(|error| {
            panic!(
                "Hub startup {error}: {}",
                std::fs::read_to_string(home.join("process.log")).unwrap()
            )
        });
    let mut url = url::Url::parse(&line).unwrap();
    let token = url
        .query_pairs()
        .find(|(key, _)| key == "access_token")
        .unwrap()
        .1
        .into_owned();
    url.set_query(None);
    (process, url, token)
}
fn source(home: &Path, id: &str, text: &str) {
    let root = home.join(".codex/sessions");
    std::fs::create_dir_all(&root).unwrap();
    let content = format!(
        "{}\n{}\n",
        json!({"timestamp":"2026-09-01T10:00:00Z","type":"session_meta","payload":{"id":id,"cwd":"/fixture"}}),
        json!({"timestamp":"2026-09-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"text":text}]}})
    );
    std::fs::write(root.join(format!("rollout-{id}.jsonl")), content).unwrap();
}
async fn wait_for_sessions(client: &reqwest::Client, url: &url::Url, token: &str, count: usize) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let result = async {
            client
                .get(url.join("api/sessions?days=0").unwrap())
                .bearer_auth(token)
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        }
        .await;
        if result.as_ref().is_ok_and(|value| {
            value["sessions"]
                .as_array()
                .is_some_and(|sessions| sessions.len() == count)
        }) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Expected {count} sessions: {result:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test]
async fn worker_recovers_when_a_persisted_recovery_epoch_is_stale() {
    use codesesh_core::{
        agents::ParsedSession, pricing::Pricing, runtime::ScanBatch, storage::Cache,
        sync::WorkerStore,
    };

    let hub_home = tempfile::tempdir().unwrap();
    let worker_home = tempfile::tempdir().unwrap();
    let hub_root = hub_home.path().join(".codesesh");
    let mut cache = Cache::open(Some(&hub_root.join("codesesh.db"))).unwrap();
    let hub_id = uuid::Uuid::new_v4().to_string();
    cache.initialize_hub(&hub_id).unwrap();
    std::fs::write(hub_root.join("hub-identity"), hub_id).unwrap();
    let worker_path = worker_home.path().join(".codesesh/worker.db");
    let mut store = WorkerStore::open(&worker_path).unwrap();
    let pair_token = cache.create_pairing_token().unwrap();
    let grant = cache
        .pair_worker(
            &pair_token,
            "Interrupted Worker",
            env!("CARGO_PKG_VERSION"),
            &store.stream_id().unwrap(),
        )
        .unwrap();
    source(
        worker_home.path(),
        "queued",
        "Content retained only in the queue",
    );
    let file = worker_home
        .path()
        .join(".codex/sessions/rollout-queued.jsonl");
    let detail =
        codesesh_core::agents::codex::parse(&file, &Default::default(), &Pricing::bundled())
            .unwrap()
            .unwrap();
    store
        .save_batch(
            "codex",
            &mut ScanBatch {
                sessions: vec![ParsedSession {
                    head: detail.head.clone(),
                    detail,
                    source: file.clone(),
                }],
                removed: Vec::new(),
                checkpoint: None,
                complete: true,
                on_reject: None,
                pricing: None,
            },
        )
        .unwrap();
    std::fs::remove_file(file).unwrap();
    store.prepare_recovery("stale-epoch").unwrap();
    drop(cache);
    let (_server, url, token) = hub(hub_home.path(), 0);
    store.bind(url.as_str(), &grant).unwrap();
    drop(store);
    let _worker = Process(
        command(worker_home.path())
            .args(["worker", "--hub", url.as_str(), "--agent", "codex"])
            .spawn()
            .unwrap(),
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    wait_for_sessions(&client, &url, &token, 1).await;
    let store = WorkerStore::open(&worker_path).unwrap();
    assert!(store.recovery().unwrap().is_none());
    assert_eq!(store.binding().unwrap().unwrap().1.epoch, grant.epoch);
}

#[tokio::test]
async fn real_worker_uploads_and_recovers_after_hub_restart() {
    let hub_home = tempfile::tempdir().unwrap();
    let worker_home = tempfile::tempdir().unwrap();
    source(worker_home.path(), "first", "First remote session");
    let (server, url, token) = hub(hub_home.path(), 0);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let pair: Value = client
        .post(url.join("api/nodes/pairing-token").unwrap())
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let _worker = Process(
        command(worker_home.path())
            .args([
                "worker",
                "--hub",
                url.as_str(),
                "--agent",
                "codex",
                "--pair-token",
                pair["token"].as_str().unwrap(),
            ])
            .spawn()
            .unwrap(),
    );
    wait_for_sessions(&client, &url, &token, 1).await;
    #[cfg(unix)]
    let _worker = {
        let mut worker = _worker;
        assert!(
            Command::new("kill")
                .args(["-TERM", &worker.0.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = worker.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "Worker did not exit gracefully"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        source(
            worker_home.path(),
            "after-restart",
            "Collected after graceful restart",
        );
        let restarted = Process(
            command(worker_home.path())
                .args(["worker", "--hub", url.as_str(), "--agent", "codex"])
                .spawn()
                .unwrap(),
        );
        let synced = tokio::time::timeout(
            Duration::from_secs(20),
            wait_for_sessions(&client, &url, &token, 2),
        )
        .await;
        assert!(
            synced.is_ok(),
            "Worker restart failed: {}",
            std::fs::read_to_string(worker_home.path().join("process.log")).unwrap()
        );
        restarted
    };
    drop(server);
    source(worker_home.path(), "second", "Collected during outage");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let store =
            codesesh_core::sync::WorkerStore::open(&worker_home.path().join(".codesesh/worker.db"))
                .unwrap();
        if store.queue_status().unwrap().batches > 0 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Worker did not retain offline content"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let (_server, restarted, new_token) = hub(hub_home.path(), url.port().unwrap());
    wait_for_sessions(
        &client,
        &restarted,
        &new_token,
        if cfg!(unix) { 3 } else { 2 },
    )
    .await;
    let nodes: Value = client
        .get(restarted.join("api/nodes").unwrap())
        .bearer_auth(new_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 1);
    assert!(worker_home.path().join(".codesesh/worker.db").exists());
    assert!(!worker_home.path().join(".codesesh/codesesh.db").exists());
    let original_node = nodes["nodes"][0]["id"].clone();
    drop(_server);
    for suffix in ["", "-wal", "-shm"] {
        let path = hub_home
            .path()
            .join(format!(".codesesh/codesesh.db{suffix}"));
        if path.exists() {
            std::fs::remove_file(path).unwrap();
        }
    }
    let (_rebuilt, rebuilt_url, rebuilt_token) = hub(hub_home.path(), url.port().unwrap());
    wait_for_sessions(
        &client,
        &rebuilt_url,
        &rebuilt_token,
        if cfg!(unix) { 3 } else { 2 },
    )
    .await;
    let nodes: Value = client
        .get(rebuilt_url.join("api/nodes").unwrap())
        .bearer_auth(&rebuilt_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(nodes["nodes"][0]["id"], original_node);
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn worker_imports_archived_history_without_deleting_standalone_data() {
    let hub_home = tempfile::tempdir().unwrap();
    let worker_home = tempfile::tempdir().unwrap();
    source(
        worker_home.path(),
        "archived",
        "Archived content without source logs",
    );
    let file = worker_home
        .path()
        .join(".codex/sessions/rollout-archived.jsonl");
    let detail = codesesh_core::agents::codex::parse(
        &file,
        &Default::default(),
        &codesesh_core::pricing::Pricing::bundled(),
    )
    .unwrap()
    .unwrap();
    let mut session = codesesh_core::agents::ParsedSession {
        head: detail.head.clone(),
        detail,
        source: file.clone(),
    };
    let cache_path = worker_home.path().join(".codesesh/codesesh.db");
    let mut cache = codesesh_core::storage::Cache::open(Some(&cache_path)).unwrap();
    cache.publish(std::slice::from_mut(&mut session)).unwrap();
    drop(cache);
    std::fs::remove_file(file).unwrap();
    let (_server, url, token) = hub(hub_home.path(), 0);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let pair: Value = client
        .post(url.join("api/nodes/pairing-token").unwrap())
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let _worker = Process(
        command(worker_home.path())
            .args([
                "worker",
                "--hub",
                url.as_str(),
                "--agent",
                "codex",
                "--history",
                "import",
                "--pair-token",
                pair["token"].as_str().unwrap(),
            ])
            .spawn()
            .unwrap(),
    );
    wait_for_sessions(&client, &url, &token, 1).await;
    let preserved = codesesh_core::storage::Cache::open(Some(&cache_path)).unwrap();
    assert_eq!(preserved.snapshot().unwrap().len(), 1);
    assert_eq!(
        preserved.snapshot().unwrap()[0].reference.source_node_id,
        "local"
    );
    let other_home = tempfile::tempdir().unwrap();
    source(other_home.path(), "archived", "Other archived conversation");
    let pair: Value = client
        .post(url.join("api/nodes/pairing-token").unwrap())
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let _other = Process(
        command(other_home.path())
            .args([
                "worker",
                "--hub",
                url.as_str(),
                "--agent",
                "codex",
                "--pair-token",
                pair["token"].as_str().unwrap(),
            ])
            .spawn()
            .unwrap(),
    );
    wait_for_sessions(&client, &url, &token, 2).await;
    let nodes: Value = client
        .get(url.join("api/nodes").unwrap())
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 2);
    for node in nodes["nodes"].as_array().unwrap() {
        let id = node["id"].as_str().unwrap();
        let sessions: Value = client
            .get(
                url.join(&format!("api/sessions?days=0&sourceNodeId={id}"))
                    .unwrap(),
            )
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(sessions["sessions"][0]["reference"]["sourceNodeId"], id);
        let search: Value = client
            .get(
                url.join(&format!("api/search?q=archived&days=0&sourceNodeId={id}"))
                    .unwrap(),
            )
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(search["results"].as_array().unwrap().len(), 1, "{search}");
        let dashboard: Value = client
            .get(
                url.join(&format!("api/dashboard?days=0&sourceNodeId={id}"))
                    .unwrap(),
            )
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(dashboard["totals"]["sessions"], 1, "{dashboard}");
    }
}

#[tokio::test]
async fn modes_are_exclusive_and_standalone_reuses_its_local_worker_identity() {
    let home = tempfile::tempdir().unwrap();
    source(home.path(), "same", "Local Worker history");
    let (hub, url, token) = server(home.path(), 0, true);
    let client = reqwest::Client::new();
    let pair: Value = client
        .post(url.join("api/nodes/pairing-token").unwrap())
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let worker = Process(
        command(home.path())
            .args([
                "worker",
                "--hub",
                url.as_str(),
                "--pair-token",
                pair["token"].as_str().unwrap(),
                "--history",
                "ignore",
                "--agent",
                "codex",
            ])
            .spawn()
            .unwrap(),
    );
    wait_for_sessions(&client, &url, &token, 1).await;
    let before: Value = client
        .get(url.join("api/sessions?days=0").unwrap())
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let reference = before["sessions"][0]["reference"].clone();
    assert!(reference["sourceNodeId"].is_null() || reference["sourceNodeId"] == "local");
    let blocked = command(home.path())
        .stderr(Stdio::piped())
        .args(["--json", "--days", "0"])
        .output()
        .unwrap();
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("Hub or Worker is running"));
    drop(worker);
    drop(hub);
    let (standalone, url, token) = server(home.path(), 0, false);
    wait_for_sessions(&client, &url, &token, 1).await;
    let after: Value = client
        .get(url.join("api/sessions?days=0").unwrap())
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["sessions"][0]["reference"], reference);
    for args in [
        vec!["hub", "--no-open"],
        vec!["worker", "--hub", url.as_str()],
    ] {
        let blocked = command(home.path())
            .stderr(Stdio::piped())
            .args(args)
            .output()
            .unwrap();
        assert!(!blocked.status.success());
        assert!(
            String::from_utf8_lossy(&blocked.stderr).contains("Standalone CodeSesh is running")
        );
    }
    drop(standalone);
    let json = command(home.path())
        .args(["--json", "--agent", "codex", "--days", "0"])
        .output()
        .unwrap();
    assert!(
        json.status.success(),
        "{}",
        String::from_utf8_lossy(&json.stderr)
    );
    let after: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(after["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(after["sessions"][0]["reference"], reference);
}

#[tokio::test]
async fn standalone_history_is_continued_by_a_separate_local_worker() {
    let home = tempfile::tempdir().unwrap();
    source(home.path(), "same", "Original local conversation");
    let client = reqwest::Client::new();
    let (standalone, url, token) = server(home.path(), 0, false);
    wait_for_sessions(&client, &url, &token, 1).await;
    client
        .put(url.join("api/bookmarks").unwrap())
        .bearer_auth(&token)
        .json(&json!({"reference":{"agentName":"codex","sessionId":"rollout-same"}}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    client
        .put(url.join("api/session-aliases/codex/rollout-same").unwrap())
        .bearer_auth(&token)
        .json(&json!({"alias":"Keep my title"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    drop(standalone);
    let (_hub, url, token) = server(home.path(), 0, true);
    source(home.path(), "new", "Created after Hub started");
    tokio::time::sleep(Duration::from_millis(750)).await;
    wait_for_sessions(&client, &url, &token, 1).await;
    let pair: Value = client
        .post(url.join("api/nodes/pairing-token").unwrap())
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let _worker = Process(
        command(home.path())
            .args([
                "worker",
                "--hub",
                url.as_str(),
                "--pair-token",
                pair["token"].as_str().unwrap(),
                "--agent",
                "codex",
            ])
            .spawn()
            .unwrap(),
    );
    wait_for_sessions(&client, &url, &token, 2).await;
    let nodes: Value = client
        .get(url.join("api/nodes").unwrap())
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(nodes["local"].is_null());
    assert_eq!(nodes["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(nodes["nodes"][0]["id"], "local");
    let sessions: Value = client
        .get(url.join("api/sessions?days=0").unwrap())
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let original = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|head| head["reference"]["sessionId"] == "rollout-same")
        .unwrap_or_else(|| panic!("Missing original: {sessions}"));
    assert_eq!(original["display_title"], "Keep my title");
    let bookmarks: Value = client
        .get(url.join("api/bookmarks").unwrap())
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bookmarks["bookmarks"].as_array().unwrap().len(), 1);
    assert_eq!(
        bookmarks["bookmarks"][0]["reference"]["sessionId"],
        "rollout-same"
    );
    source(
        home.path(),
        "same",
        "Original conversation with changed content",
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        let found: Value = client
            .get(url.join("api/search?q=changed&days=0").unwrap())
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if found["results"]
            .as_array()
            .is_some_and(|results| results.len() == 1)
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Updated local content was not received: {found}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    wait_for_sessions(&client, &url, &token, 2).await;
}
