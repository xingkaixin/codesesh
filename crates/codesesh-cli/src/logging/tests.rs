use super::*;
use serde_json::json;
use std::fs;

fn directory() -> PathBuf {
    let path = std::env::temp_dir().join(format!("codesesh-logging-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&path).unwrap();
    path
}
fn logger(path: &Path) -> AppLogger {
    AppLogger::new(LoggerOptions {
        log_dir: Some(path.into()),
        level: Some(Level::Debug),
        ..Default::default()
    })
    .unwrap()
}
fn records(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn redacts_secrets_fingerprints_private_values_and_preserves_trace() {
    let root = directory();
    let logger = logger(&root);
    let request_id = uuid::Uuid::new_v4().to_string();
    logger.with_context(LogContext{request_id:Some(request_id.clone()),..Default::default()}).info("server.request",&json!({
        "authorization":"Bearer secret-token","apiKey":"key-value","nested":{"refreshToken":"refresh-value"},
        "body":"source-body","messages":["source-transcript"],"source_path":"/personal/source/project.rs",
        "url":"https://someone:credential@example.com/private/path?access_token=secret-token",
        "error":"source-text in error","unknown":"arbitrary source text","method":"GET","duration_ms":12.5,
        "route":"/api?token=secret-token","level":"malicious override","stack":"Error: source-text\n at /frame (file.rs:1) Bearer secret-token"
    }));
    logger.flush().unwrap();
    let raw = fs::read_to_string(logger.path()).unwrap();
    let record = &records(logger.path())[0];
    for private in [
        "secret-token",
        "key-value",
        "refresh-value",
        "source-body",
        "source-transcript",
        "/personal/source/project.rs",
        "credential",
        "private/path",
        "source-text",
        "arbitrary source text",
        "malicious override",
    ] {
        assert!(!raw.contains(private), "leaked {private}: {raw}");
    }
    assert_eq!(record["authorization"], "[redacted]");
    assert_eq!(record["body"], "[omitted]");
    assert_eq!(record["url"], "https://example.com/");
    assert_eq!(record["method"], "GET");
    assert_eq!(record["duration_ms"], 12.5);
    assert_eq!(record["request_id"], request_id);
    assert_eq!(record["level"], "info");
    assert_eq!(record["schema_version"], 1);
    logger.info("client.search.done",&json!({"operation_id":"source-id","session":"raw-session-id","mode":"session","agent":"codex","results":3}));
    logger.shutdown().unwrap();
    let all = records(logger.path());
    assert!(
        all[1]["operation_id"]
            .as_str()
            .unwrap()
            .starts_with("identifier:")
    );
    assert!(
        all[1]["session"]
            .as_str()
            .unwrap()
            .starts_with("identifier:")
    );
    assert_eq!(all[1]["mode"], "session");
    assert_eq!(all[1]["agent"], "codex");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn flush_drains_clones_and_shutdown_rejects_future_records() {
    let root = directory();
    let logger = logger(&root);
    let clones = (0..4)
        .map(|worker| {
            let log = logger.clone();
            std::thread::spawn(move || {
                for index in 0..40 {
                    log.info("worker.progress", &json!({"worker":worker,"index":index}));
                }
            })
        })
        .collect::<Vec<_>>();
    for thread in clones {
        thread.join().unwrap();
    }
    logger.flush().unwrap();
    let all = records(logger.path());
    assert_eq!(all.len(), 160);
    for (index, record) in all.iter().enumerate() {
        assert_eq!(record["seq"], index + 1);
    }
    logger.shutdown().unwrap();
    logger.error("late.entry", &json!({}));
    logger.flush().unwrap();
    assert_eq!(records(logger.path()).len(), 160);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rotation_restricts_managed_logs_and_retains_foreign_active_files() {
    let root = directory();
    let foreign = root.join(format!(
        "codesesh-{}-{}-active.log",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::write(&foreign, "active-owner").unwrap();
    let unrelated = root.join("unrelated.log");
    fs::write(&unrelated, "leave alone").unwrap();
    let logger = AppLogger::new(LoggerOptions {
        log_dir: Some(root.clone()),
        level: Some(Level::Debug),
        max_file_bytes: Some(350),
        max_files: Some(3),
        max_directory_bytes: Some(2000),
        ..Default::default()
    })
    .unwrap();
    for index in 0..20 {
        logger.info("rotation.test", &json!({"index":index}));
    }
    logger.shutdown().unwrap();
    assert_eq!(fs::read_to_string(&foreign).unwrap(), "active-owner");
    assert_eq!(fs::read_to_string(&unrelated).unwrap(), "leave alone");
    let managed = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("codesesh-"))
        .collect::<Vec<_>>();
    assert!(managed.len() <= 3);
    assert_eq!(records(logger.path()).last().unwrap()["index"], 19);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for entry in managed {
            assert_eq!(
                entry.metadata().unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn oversized_records_and_queue_overflow_remain_bounded() {
    let root = directory();
    let logger = AppLogger::new(LoggerOptions {
        log_dir: Some(root.clone()),
        level: Some(Level::Debug),
        max_record_bytes: Some(512),
        max_queue_bytes: Some(128),
        ..Default::default()
    })
    .unwrap();
    logger.info(
        "oversized.record",
        &json!({"values":(0..100).collect::<Vec<_>>(),"route":"a".repeat(10000)}),
    );
    logger.flush().unwrap();
    let all = records(logger.path());
    assert_eq!(all.len(), 1);
    assert_eq!(all[0]["event"], "logger.records_dropped");
    assert_eq!(all[0]["info"], 1);
    for line in fs::read_to_string(logger.path()).unwrap().lines() {
        assert!(line.len() < 512)
    }
    logger.shutdown().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn flush_reports_storage_failure_without_panicking() {
    let root = directory();
    let blocked = root.join("file");
    fs::write(&blocked, "not a directory").unwrap();
    let logger = logger(&blocked);
    logger.error("storage.error", &json!({"error":"sensitive path"}));
    assert!(logger.flush().is_err());
    assert!(logger.shutdown().is_err());
    fs::remove_dir_all(root).unwrap();
}
