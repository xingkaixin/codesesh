use std::{
    fs,
    path::Path,
    process::{Command, Output, Stdio},
};

fn cli(home: &Path, args: &[&str]) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_codesesh"));
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("CODESESH_") {
            command.env_remove(key);
        }
    }
    command
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("CODEX_HOME", home.join("codex"))
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn old_price(home: &Path) {
    let directory = home.join(".cache/codesesh");
    fs::create_dir_all(&directory).unwrap();
    fs::write(
        directory.join("models-dev-pricing.json"),
        r#"{"timestamp":1,"data":{}}"#,
    )
    .unwrap();
}

#[test]
fn noninteractive_migration_requires_confirmation_and_preserves_json() {
    let home = tempfile::tempdir().unwrap();
    old_price(home.path());
    let args = ["--json", "--agent", "codex", "--days", "0"];
    let refused = cli(home.path(), &args);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("--migrate-data"));
    assert!(
        home.path()
            .join(".cache/codesesh/models-dev-pricing.json")
            .exists()
    );
    assert!(!home.path().join(".codesesh/logs").exists());
    let migrated = cli(
        home.path(),
        &[
            "--json",
            "--agent",
            "codex",
            "--days",
            "0",
            "--migrate-data",
        ],
    );
    assert!(
        migrated.status.success(),
        "{}",
        String::from_utf8_lossy(&migrated.stderr)
    );
    serde_json::from_slice::<serde_json::Value>(&migrated.stdout).unwrap();
    assert!(!home.path().join(".cache/codesesh").exists());
    let restarted = cli(home.path(), &args);
    assert!(restarted.status.success());
    assert!(!String::from_utf8_lossy(&restarted.stderr).contains("Migrating"));
}

#[test]
fn help_does_not_create_data_directory() {
    let home = tempfile::tempdir().unwrap();
    assert!(cli(home.path(), &["--help"]).status.success());
    assert!(!home.path().join(".codesesh").exists());
}

#[test]
fn concurrent_new_processes_share_the_migration_lock() {
    let home = tempfile::tempdir().unwrap();
    old_price(home.path());
    std::thread::scope(|scope| {
        let run = || {
            cli(
                home.path(),
                &["--json", "--agent", "codex", "--no-cache", "--migrate-data"],
            )
        };
        let first = scope.spawn(run);
        let second = scope.spawn(run);
        for output in [first.join().unwrap(), second.join().unwrap()] {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap();
        }
    });
}

#[test]
fn hub_and_worker_require_legacy_migration_before_role_startup() {
    for role in ["hub", "worker"] {
        let home = tempfile::tempdir().unwrap();
        old_price(home.path());
        let args = if role == "hub" {
            vec![role, "--no-open"]
        } else {
            vec![role, "--hub", "http://127.0.0.1:1"]
        };
        let result = cli(home.path(), &args);
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("--migrate-data"));
        assert!(!home.path().join(".codesesh/worker.db").exists());
        assert!(!home.path().join(".codesesh/hub-identity").exists());
        assert!(
            home.path()
                .join(".cache/codesesh/models-dev-pricing.json")
                .exists()
        );
    }
}
