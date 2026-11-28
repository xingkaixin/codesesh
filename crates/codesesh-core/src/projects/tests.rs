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
    let normalized = normalize_git_remote("git@GitHub.com:Acme/user@app:v1.git").unwrap();
    assert_eq!(normalized, "github.com/acme/user@app:v1");
    assert_eq!(normalize_git_remote(&normalized), Some(normalized));
    assert_eq!(normalize_git_remote("invalid"), None);
}

#[test]
fn resolves_recorded_git_remotes_conflicts_loose_and_retained_names() {
    let mut fs = Fs::default();
    let remote = vec!["git@github.com:xingkaixin/codesesh.git".into()];
    let w1 = resolve_identity_projection_with_context(
        "/Users/test/.t3/worktrees/codesesh/t3-1",
        &fs,
        "/Users/test",
        "v2",
        &remote,
        None,
    );
    let w2 = resolve_identity_projection_with_context(
        "/Users/test/.t3/worktrees/codesesh/t3-2",
        &fs,
        "/Users/test",
        "v2",
        &remote,
        None,
    );
    assert_eq!(w1.identity.kind, "git_remote");
    assert_eq!(w1.identity.key, "github.com/xingkaixin/codesesh");
    assert_eq!(w1.identity.display_name, "codesesh");
    assert_eq!(w1.identity, w2.identity);
    assert_eq!(w1.input_signature, w2.input_signature);

    // Loose directories keep loose even when recorded_git_remotes is present.
    let loose =
        resolve_identity_projection_with_context("/tmp", &fs, "/Users/test", "v2", &remote, None);
    assert_eq!(loose.identity.kind, "loose");

    // Existing directory with matching origin reads manifest; conflicting origin does not borrow it.
    let live = "/repo/worktree";
    fs.files.insert(live.into(), String::new());
    fs.files.insert(path::join(live, ".git"), String::new());
    fs.files.insert(
        path::join(live, "package.json"),
        r#"{"name":"codesesh-monorepo"}"#.into(),
    );
    fs.remotes
        .insert(live.into(), "git@github.com:xingkaixin/codesesh.git".into());
    let matched =
        resolve_identity_projection_with_context(live, &fs, "/Users/test", "v2", &remote, None);
    assert_eq!(matched.identity.display_name, "codesesh-monorepo");

    fs.remotes
        .insert(live.into(), "git@github.com:other/foreign.git".into());
    fs.files.insert(
        path::join(live, "package.json"),
        r#"{"name":"foreign-app"}"#.into(),
    );
    let conflicted =
        resolve_identity_projection_with_context(live, &fs, "/Users/test", "v2", &remote, None);
    assert_eq!(conflicted.identity.key, "github.com/xingkaixin/codesesh");
    assert_eq!(conflicted.identity.display_name, "codesesh");

    // Multiple distinct recorded remotes fall back to directory git origin instead of picking first.
    let multi = resolve_identity_projection_with_context(
        live,
        &fs,
        "/Users/test",
        "v2",
        &[
            "git@github.com:xingkaixin/codesesh.git".into(),
            "https://github.com/other/second.git".into(),
        ],
        None,
    );
    assert_eq!(multi.identity.key, "github.com/other/foreign");
    assert_eq!(multi.identity.display_name, "foreign-app");

    // Missing manifest retains previous non-fallback name; explicit tail-named manifest updates it.
    let retained = resolve_identity_projection_with_context(
        "/repo/deleted",
        &fs,
        "/Users/test",
        "v2",
        &remote,
        Some((&matched.identity, Some(&matched.input_signature))),
    );
    assert_eq!(retained.identity.display_name, "codesesh-monorepo");
    assert_eq!(retained.input_signature, matched.input_signature);

    fs.remotes
        .insert(live.into(), "git@github.com:xingkaixin/codesesh.git".into());
    fs.files.insert(
        path::join(live, "package.json"),
        r#"{"name":"codesesh"}"#.into(),
    );
    let renamed = resolve_identity_projection_with_context(
        live,
        &fs,
        "/Users/test",
        "v2",
        &remote,
        Some((&matched.identity, Some(&matched.input_signature))),
    );
    assert_eq!(renamed.identity.display_name, "codesesh");
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
    let first = resolve_identity_projection(
        root.to_str().unwrap(),
        &RealFs::default(),
        "/unused-home",
        "v1",
    );
    let other = resolve_identity_projection(
        worktree.to_str().unwrap(),
        &RealFs::default(),
        "/unused-home",
        "v1",
    );
    assert_eq!(first.identity.kind, "git_common_dir");
    assert_eq!(
        first.identity.key.replace('\\', "/"),
        other.identity.key.replace('\\', "/")
    );
}

#[test]
fn real_fs_direct_git_matches_git_cli_for_repos_worktrees_and_includes() {
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
    let worktree = canonical.join("wt");
    std::fs::create_dir(&root).unwrap();
    let git_output = |cwd: &std::path::Path, args: &[&str]| -> Option<String> {
        let output = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .unwrap();
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
    };
    let run = |args: &[&str]| {
        assert!(git_output(&root, args).is_some(), "git {args:?} failed");
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
    run(&["worktree", "add", "-b", "wt", worktree.to_str().unwrap()]);

    let fs = RealFs::default();
    let root_str = root.to_str().unwrap();
    let wt_str = worktree.to_str().unwrap();
    let resolve_common = |cwd: &str, raw: &str| -> String {
        let resolved = if raw.starts_with('/') || path::windows(raw) {
            path::normalize(raw)
        } else {
            path::join(cwd, raw)
        };
        resolved.replace('\\', "/")
    };

    // Repo and worktree without origin match git rev-parse --git-common-dir and return no origin.
    for dir in [&root, &worktree] {
        let dir_str = dir.to_str().unwrap();
        let expected_origin = git_output(dir, &["config", "--get", "remote.origin.url"]);
        let actual_origin = fs.git(&["config", "--get", "remote.origin.url"], dir_str);
        assert_eq!(actual_origin, expected_origin);
        assert_eq!(actual_origin, None);

        let expected_common = git_output(dir, &["rev-parse", "--git-common-dir"]).unwrap();
        let actual_common = fs.git(&["rev-parse", "--git-common-dir"], dir_str).unwrap();
        assert_eq!(
            resolve_common(dir_str, &actual_common),
            resolve_common(dir_str, &expected_common)
        );
    }

    // Multiple origin urls, comments, and quoted values match git config --get (last value wins).
    let config_path = root.join(".git/config");
    let base_config = std::fs::read_to_string(&config_path).unwrap();
    std::fs::write(
        &config_path,
        format!(
            "{base_config}\n[remote \"Origin\"]\n\turl = https://github.com/wrong/case.git\n[REMOTE \"origin\"]\n\turl = https://github.com/acme/first.git # trailing comment\n[remote \"origin\"]\n\tURL = \"https://github.com/acme/second#frag.git\" ; comment\n"
        ),
    )
    .unwrap();
    for dir in [&root, &worktree] {
        let dir_str = dir.to_str().unwrap();
        let expected = git_output(dir, &["config", "--get", "remote.origin.url"]);
        let actual = fs
            .git(&["config", "--get", "remote.origin.url"], dir_str)
            .map(|v| v.trim().to_owned());
        assert_eq!(actual, expected);
        assert_eq!(
            actual.as_deref(),
            Some("https://github.com/acme/second#frag.git")
        );
    }
    let root_id = resolve_identity_projection(root_str, &fs, "/unused-home", "v1");
    let wt_id = resolve_identity_projection(wt_str, &fs, "/unused-home", "v1");
    assert_eq!(root_id.identity.kind, "git_remote");
    assert_eq!(root_id.identity, wt_id.identity);

    // [include] triggers fallback to git CLI and still matches git output.
    let included = canonical.join("included.gitconfig");
    std::fs::write(
        &included,
        "[remote \"origin\"]\n\turl = git@github.com:acme/included.git\n",
    )
    .unwrap();
    let included_escaped = included.to_str().unwrap().replace('\\', "/");
    std::fs::write(
        &config_path,
        format!("{base_config}\n[include]\n\tpath = {included_escaped}\n"),
    )
    .unwrap();
    assert!(direct_git(&["config", "--get", "remote.origin.url"], root_str).is_none());
    for dir in [&root, &worktree] {
        let dir_str = dir.to_str().unwrap();
        let expected = git_output(dir, &["config", "--get", "remote.origin.url"]);
        let actual = fs
            .git(&["config", "--get", "remote.origin.url"], dir_str)
            .map(|v| v.trim().to_owned());
        assert_eq!(actual, expected);
        assert_eq!(actual.as_deref(), Some("git@github.com:acme/included.git"));
    }
}

fn session(id: &str, parent: Option<&str>, time: i64) -> crate::model::SessionHead {
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
fn groups_prefer_non_fallback_name_including_children_over_newer_tail_fallback() {
    let mut newer_fallback = session("newer", None, 900);
    newer_fallback.project_identity = identity(
        "git_remote",
        "github.com/xingkaixin/codesesh",
        "codesesh".into(),
    );
    let mut older_root = session("older", None, 100);
    older_root.project_identity = identity(
        "git_remote",
        "github.com/xingkaixin/codesesh",
        "codesesh".into(),
    );
    let mut child_named = session("child", Some("older"), 200);
    child_named.project_identity = identity(
        "git_remote",
        "github.com/xingkaixin/codesesh",
        "codesesh-monorepo".into(),
    );

    let groups = build_project_groups(&[newer_fallback, older_root, child_named]);
    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].display_name, "codesesh-monorepo");
    assert_eq!(groups[0].session_count, 2);
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
    let root = create_project_scope_matcher_from_identity("/", identity("path", "/", "/".into()));
    item.directory = "/home/user/project".into();
    assert!(matches_project_scope(&item, &root));
}
