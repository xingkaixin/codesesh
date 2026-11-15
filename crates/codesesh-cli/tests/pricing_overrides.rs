use serde_json::Value;
use std::{
    net::TcpListener,
    path::Path,
    process::{Child, Command, Stdio},
    time::Duration,
};

struct ServerGuard {
    child: Child,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

fn base_command(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_codesesh"));
    for (key, _) in std::env::vars_os() {
        let text = key.to_string_lossy();
        if text.starts_with("CODESESH_") {
            command.env_remove(&key);
        }
    }
    command
        .env_remove("CODEX_HOME")
        .env("HOME", home)
        .env("USERPROFILE", home);
    command
}

fn spawn_server(home: &Path, args: &[&str]) -> (ServerGuard, String) {
    let port = free_port();
    let port_text = port.to_string();
    let mut command = base_command(home);
    command
        .args(args)
        .args(["--host", "127.0.0.1", "--port", &port_text, "--no-open"])
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command.spawn().unwrap();
    (ServerGuard { child }, format!("http://127.0.0.1:{port}"))
}

async fn wait_for_json(client: &reqwest::Client, url: &str) -> Value {
    for _ in 0..100 {
        if let Ok(response) = client.get(url).send().await
            && response.status().is_success()
            && let Ok(body) = response.json::<Value>().await
        {
            return body;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {url}");
}

async fn wait_for_status(client: &reqwest::Client, url: &str) -> reqwest::StatusCode {
    for _ in 0..100 {
        if let Ok(response) = client.get(url).send().await {
            return response.status();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {url}");
}

fn write_codex_fixture(home: &Path, model: &str, input_tokens: u64, output_tokens: u64) {
    let dir = home.join(".codex/sessions/2026/01/01");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-000000000001.jsonl");
    let now = chrono::Utc::now().timestamp_millis();
    let lines = [
        serde_json::json!({
            "type": "session_meta",
            "timestamp": now - 5_000,
            "payload": { "cwd": home, "model": model }
        }),
        serde_json::json!({
            "type": "response_item",
            "timestamp": now - 4_000,
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "Compute usage" }]
            }
        }),
        serde_json::json!({
            "type": "event_msg",
            "timestamp": now - 3_000,
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens
                    },
                    "total_token_usage": {
                        "total_tokens": input_tokens + output_tokens,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens
                    }
                }
            }
        }),
        serde_json::json!({
            "type": "response_item",
            "timestamp": now - 2_000,
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Done" }]
            }
        }),
    ];
    let content = lines
        .iter()
        .map(|line| format!("{line}\n"))
        .collect::<String>();
    std::fs::write(path, content).unwrap();
}

#[tokio::test]
async fn cli_persists_overrides_across_clear_cache_json_and_blocks_hub() {
    let home = tempfile::tempdir().unwrap();
    write_codex_fixture(home.path(), "acme/cli-persist-v1", 1_000_000, 500_000);
    let client = reqwest::Client::new();

    let (first_server, origin) = spawn_server(home.path(), &["--agent", "codex", "--days", "0"]);
    let mut overview = Value::Null;
    for _ in 0..100 {
        let body = wait_for_json(&client, &format!("{origin}/api/pricing/overview?days=0")).await;
        if !body["unmatchedModels"].as_array().unwrap().is_empty() {
            overview = body;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        overview["unmatchedModels"][0]["modelKey"],
        "acme/cli-persist-v1"
    );

    let put_response = client
        .put(format!("{origin}/api/pricing/overrides?days=0"))
        .json(&serde_json::json!({
            "model": "acme/cli-persist-v1",
            "kind": "manual",
            "rates": { "input": 2.0, "output": 10.0, "cacheRead": 0.0, "cacheWrite": 0.0 }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(put_response.status(), reqwest::StatusCode::OK);
    let dashboard = wait_for_json(&client, &format!("{origin}/api/dashboard?days=0")).await;
    assert!((dashboard["totals"]["cost"].as_f64().unwrap() - 7.0).abs() < 1e-6);
    drop(first_server);

    let (restarted_server, restarted_origin) = spawn_server(
        home.path(),
        &["--clear-cache", "--agent", "codex", "--days", "0"],
    );
    let mut rebuilt_dashboard = Value::Null;
    for _ in 0..100 {
        let body =
            wait_for_json(&client, &format!("{restarted_origin}/api/dashboard?days=0")).await;
        if body["totals"]["sessions"] == 1 {
            rebuilt_dashboard = body;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!((rebuilt_dashboard["totals"]["cost"].as_f64().unwrap() - 7.0).abs() < 1e-6);
    let rebuilt_overview = wait_for_json(
        &client,
        &format!("{restarted_origin}/api/pricing/overview?days=0"),
    )
    .await;
    assert!(
        rebuilt_overview["unmatchedModels"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(rebuilt_overview["overrides"].as_array().unwrap().len(), 1);
    drop(restarted_server);

    let output = base_command(home.path())
        .args(["--json", "--agent", "codex", "--days", "0"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json_report: Value = serde_json::from_slice(&output.stdout).unwrap();
    let total_cost = json_report["sessions"][0]["stats"]["total_cost"]
        .as_f64()
        .unwrap();
    assert!((total_cost - 7.0).abs() < 1e-6);

    let hub_home = tempfile::tempdir().unwrap();
    let (hub_server, hub_origin) = spawn_server(hub_home.path(), &["hub"]);
    assert_eq!(
        wait_for_status(&client, &format!("{hub_origin}/api/pricing/overview")).await,
        reqwest::StatusCode::NOT_FOUND
    );
    drop(hub_server);
}
