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
    let mut process = Process(
        command(home)
            .args([
                "hub",
                "--no-open",
                "--port",
                &port.to_string(),
                "--agent",
                "codex",
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
        let result: Value = client
            .get(url.join("api/sessions?days=0").unwrap())
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        if result["sessions"]
            .as_array()
            .is_some_and(|sessions| sessions.len() == count)
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "Expected {count} sessions: {result}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
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
    wait_for_sessions(&client, &restarted, &new_token, 2).await;
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
}
