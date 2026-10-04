use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::post};
use codesesh_core::sync::{Receipt, Upload, WorkerHello, WorkerStore};
use serde_json::json;
use std::{
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Default)]
struct Requests {
    hello_attempts: Vec<Instant>,
    uploads: Vec<(Instant, i64)>,
    heartbeats: Vec<usize>,
    confirmed: i64,
    goodbye: bool,
}

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[tokio::test]
async fn worker_drains_in_order_with_retry_heartbeat_and_shutdown() {
    let requests = Arc::new(Mutex::new(Requests::default()));
    let app = Router::new()
        .route("/api/worker/pair", post(|| async {
            Json(json!({"nodeId":"worker","credential":"fixture","hubId":"fixture-hub","epoch":"fixture-epoch"}))
        }))
        .route("/api/worker/hello", post(|State(requests): State<Arc<Mutex<Requests>>>, Json(_hello): Json<WorkerHello>| async move {
            let mut requests = requests.lock().unwrap();
            requests.hello_attempts.push(Instant::now());
            if requests.hello_attempts.len() == 1 {
                return (StatusCode::CONFLICT, [("retry-after", "2")], Json(json!({"error":"WORKER_INSTANCE_CONFLICT"}))).into_response();
            }
            let uploads = requests.uploads.len();
            requests.heartbeats.push(uploads);
            Json(json!({
                "hubId":"fixture-hub","epoch":"fixture-epoch","version":env!("CARGO_PKG_VERSION"),
                "minimumWorkerVersion":"1.1.1","protocolVersion":1,"payloadVersion":1,
                "error":null,"confirmedSequence":requests.confirmed,"heartbeatSeconds":5,
                "maxInFlight":1,"rescan":null
            })).into_response()
        }))
        .route("/api/worker/upload", post(|State(requests): State<Arc<Mutex<Requests>>>, Json(upload): Json<Upload>| async move {
            let first = {
                let mut requests = requests.lock().unwrap();
                requests.uploads.push((Instant::now(), upload.sequence));
                requests.uploads.len() == 1
            };
            if first {
                return (StatusCode::TOO_MANY_REQUESTS, [("retry-after", "1")]).into_response();
            }
            // Keep uploads in flight long enough for a heartbeat while the queue is still nonempty.
            tokio::time::sleep(Duration::from_millis(20)).await;
            requests.lock().unwrap().confirmed = upload.sequence;
            Json(Receipt {
                epoch: upload.epoch,
                stream_id: upload.stream_id,
                sequence: upload.sequence,
                digest: upload.digest,
                changed: None,
            }).into_response()
        }))
        .route("/api/worker/goodbye", post(|State(requests): State<Arc<Mutex<Requests>>>| async move {
            requests.lock().unwrap().goodbye = true;
            StatusCode::NO_CONTENT
        }))
        .with_state(requests.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = tempfile::tempdir().unwrap();
    let sources = home.path().join(".codex/sessions");
    std::fs::create_dir_all(&sources).unwrap();
    for index in 0..320 {
        let id = format!("session-{index}");
        let content = format!(
            "{}\n{}\n",
            json!({"timestamp":"2026-09-01T10:00:00Z","type":"session_meta","payload":{"id":id,"cwd":"/fixture"}}),
            json!({"timestamp":"2026-09-01T10:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"Retain this queued message"}]}})
        );
        std::fs::write(sources.join(format!("rollout-{id}.jsonl")), content).unwrap();
    }
    let mut command = Command::new(env!("CARGO_BIN_EXE_codesesh"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("CODESESH_") {
            command.env_remove(key);
        }
    }
    let log = home.path().join("worker.log");
    let mut worker = Process(
        command
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("CODEX_HOME", home.path().join(".codex"))
            .args([
                "worker",
                "--hub",
                &url,
                "--agent",
                "codex",
                "--pair-token",
                "fixture",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(&log).unwrap())
            .spawn()
            .unwrap(),
    );
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if requests.lock().unwrap().heartbeats.len() >= 2 {
            break;
        }
        assert!(
            worker.0.try_wait().unwrap().is_none(),
            "{}",
            std::fs::read_to_string(&log).unwrap()
        );
        assert!(
            Instant::now() < deadline,
            "Worker did not heartbeat while uploading"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    {
        let requests = requests.lock().unwrap();
        assert!(
            requests.hello_attempts[1].duration_since(requests.hello_attempts[0])
                >= Duration::from_secs(2)
        );
        assert!(requests.uploads.len() > 2);
        assert_eq!(requests.uploads[0].1, 1);
        assert_eq!(requests.uploads[1].1, 1);
        assert!(
            requests.uploads[1].0.duration_since(requests.uploads[0].0) >= Duration::from_secs(1)
        );
        for (index, (_, sequence)) in requests.uploads[1..].iter().enumerate() {
            assert_eq!(*sequence, index as i64 + 1);
        }
        assert!(requests.heartbeats[1] > requests.heartbeats[0]);
    }
    let store = WorkerStore::open(&home.path().join(".codesesh/worker.db")).unwrap();
    assert!(store.queue_status().unwrap().batches > 0);
    drop(store);
    #[cfg(unix)]
    {
        assert!(
            Command::new("kill")
                .args(["-TERM", &worker.0.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = worker.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Worker did not stop with uploads pending"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(requests.lock().unwrap().goodbye);
        let store = WorkerStore::open(&home.path().join(".codesesh/worker.db")).unwrap();
        assert!(store.queue_status().unwrap().batches > 0);
    }
    drop(worker);
    server.abort();
}
