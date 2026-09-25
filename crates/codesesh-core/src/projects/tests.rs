use super::*;
use std::collections::HashMap;

#[derive(Default)]
struct Fs {
    files: HashMap<String, String>,
    remotes: HashMap<String, String>,
}
impl IdentityFs for Fs {
    fn exists(&self, path: &str) -> bool {
        self.files.contains_key(path)
    }
    fn read_text(&self, path: &str) -> Option<String> {
        self.files.get(path).cloned()
    }
    fn git(&self, args: &[&str], cwd: &str) -> Option<String> {
        if args[0] == "config" {
            self.remotes.get(cwd).cloned()
        } else {
            Some(".git".into())
        }
    }
}
#[test]
fn normalizes_remote_transports() {
    for value in [
        "git@GitHub.com:Acme/App.git",
        "https://user:pass@github.com/Acme/App.git?x=1",
        "ssh://git@github.com:22/Acme/App.git",
    ] {
        assert_eq!(
            normalize_git_remote(value).as_deref(),
            Some("github.com/acme/app")
        );
    }
    assert_eq!(normalize_git_remote("invalid"), None);
}
#[test]
fn resolves_cross_platform_paths_and_signatures() {
    for root in [
        "/repo",
        r"D:\repo",
        r"\\server\share\repo",
        "/Users/test/we\\ird/tool",
    ] {
        let mut fs = Fs::default();
        fs.files.insert(path::join(root, ".git"), String::new());
        fs.files.insert(
            path::join(root, "package.json"),
            r#"{"name":"nice-name"}"#.into(),
        );
        fs.remotes
            .insert(root.into(), "git@github.com:acme/app.git".into());
        let first = resolve_identity_projection(&path::join(root, "src"), &fs, "/Users/test", "v1");
        assert_eq!(first.identity.kind, "git_remote", "{root}");
        assert_eq!(first.identity.display_name, "nice-name");
        let revised = resolve_identity_projection(root, &fs, "/Users/test", "v2");
        assert_eq!(first.input_signature, revised.input_signature);
        fs.remotes
            .insert(root.into(), "git@github.com:acme/other.git".into());
        assert_ne!(
            first.input_signature,
            resolve_identity_projection(root, &fs, "/Users/test", "v1").input_signature
        );
    }
}
#[test]
fn resolves_loose_scratch_manifest_and_fallback() {
    let mut fs = Fs::default();
    for home in ["/Users/test", r"C:\Users\test"] {
        assert_eq!(
            resolve_identity_projection(home, &fs, home, "v1")
                .identity
                .kind,
            "loose"
        );
        let scratch = path::join(home, "Documents/Codex/day/chat");
        assert_eq!(
            resolve_identity_projection(&scratch, &fs, home, "v1")
                .identity
                .kind,
            "synthetic"
        );
        fs.files.insert(
            path::join(&scratch, "Cargo.toml"),
            "[package]\nname = \"real-project\"".into(),
        );
        let actual = resolve_identity_projection(&path::join(&scratch, "src"), &fs, home, "v1");
        assert_eq!(actual.identity.kind, "manifest_path");
        assert_eq!(actual.identity.display_name, "real-project");
    }
    assert_eq!(
        resolve_identity_projection("/somewhere/a/../b", &fs, "/home/me", "v1")
            .identity
            .key,
        "/somewhere/b"
    );
    assert_eq!(fallback_display_name("/"), "(root)");
    assert_eq!(
        normalize_project_scope_path(r"C:\workspace\app"),
        "C:/workspace/app"
    );
}
#[test]
fn real_git_worktree_shares_common_directory() {
    let temp = tempfile::tempdir().unwrap();
    let canonical = temp.path().canonicalize().unwrap();
    #[cfg(windows)]
    let canonical = {
        let path = canonical.to_str().unwrap();
        if let Some(path) = path.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{path}"))
        } else {
            std::path::PathBuf::from(path.strip_prefix(r"\\?\").unwrap_or(path))
        }
    };
    let root = canonical.join("repo");
    let worktree = canonical.join("other");
    std::fs::create_dir(&root).unwrap();
    let run = |args: &[&str]| {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .unwrap()
                .status
                .success()
        )
    };
    run(&["init"]);
    run(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "Initial",
    ]);
    run(&["worktree", "add", "-b", "other", worktree.to_str().unwrap()]);
    let first = resolve_identity_projection(root.to_str().unwrap(), &RealFs, "/unused-home", "v1");
    let other =
        resolve_identity_projection(worktree.to_str().unwrap(), &RealFs, "/unused-home", "v1");
    assert_eq!(first.identity.kind, "git_common_dir");
    assert_eq!(
        first.identity.key.replace('\\', "/"),
        other.identity.key.replace('\\', "/")
    );
}

fn session(id: &str, parent: Option<&str>, time: i64) -> crate::contract::SessionHead {
    let mut value = serde_json::json!({
        "reference": {"agentName":"codex","sessionId":id},
        "title":id,"directory":"/repo","project_identity":{"kind":"path","key":"/repo","displayName":"repo"},
        "time_created":time,"time_updated":time,
        "stats":{"message_count":1,"total_input_tokens":0,"total_output_tokens":0,"total_cost":0},
        "smart_tags":[]
    });
    if let Some(parent) = parent {
        value["parent_reference"] = serde_json::json!({"agentName":"codex","sessionId":parent});
    }
    serde_json::from_value(value).unwrap()
}
#[test]
fn groups_count_roots_orphans_and_cycles_but_not_mounted_children() {
    let sessions = vec![
        session("root", None, 100),
        session("child", Some("root"), 900),
        session("orphan", Some("gone"), 200),
        session("a", Some("b"), 300),
        session("b", Some("a"), 400),
    ];
    let groups = build_project_groups(&sessions);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].session_count, 4);
    assert_eq!(groups[0].last_activity, Some(400.0));
    assert_eq!(groups[0].sources, vec!["codex"]);
}
#[test]
fn scopes_match_identity_or_path_ancestors_with_boundaries() {
    let scope = create_project_scope_matcher_from_identity(
        "/home/user/project",
        identity("path", "/home/user/project", "project".into()),
    );
    let mut item = session("a", None, 100);
    for directory in ["/home/user/project", "/home/user/project/src", "/home/user"] {
        item.directory = directory.into();
        assert!(matches_project_scope(&item, &scope));
    }
    item.directory = "/home/user/projectile".into();
    assert!(!matches_project_scope(&item, &scope));
    item.directory.clear();
    item.project_identity = scope.identity.clone();
    assert!(matches_project_scope(&item, &scope));
    item.project_identity.kind = "manifest_path".into();
    assert!(!matches_project_scope(&item, &scope));
}
