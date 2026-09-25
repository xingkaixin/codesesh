mod groups;
mod path;
mod scope;

pub use groups::{ProjectGroup, build_project_groups};
pub use path::fallback_display_name;
pub use scope::*;

use crate::contract::ProjectIdentity;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    process::{Command, Stdio},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

pub const PROJECT_IDENTITY_RESOLVER_REVISION: &str = "project-identity-v2";
pub const IDENTITY_CACHE_MAX_ENTRIES: usize = 512;
const MANIFESTS: [&str; 7] = [
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "Gemfile",
    "pom.xml",
    "build.gradle",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdentityProjection {
    pub identity: ProjectIdentity,
    pub resolver_revision: String,
    pub input_signature: String,
}

pub trait IdentityFs {
    fn exists(&self, path: &str) -> bool;
    fn read_text(&self, path: &str) -> Option<String>;
    fn git(&self, args: &[&str], cwd: &str) -> Option<String>;
}

pub struct RealFs;
impl IdentityFs for RealFs {
    fn exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }
    fn read_text(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
    fn git(&self, args: &[&str], cwd: &str) -> Option<String> {
        let mut child = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return status
                        .success()
                        .then(|| {
                            child
                                .wait_with_output()
                                .ok()
                                .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
                        })
                        .flatten();
                }
                Ok(None) if started.elapsed() < Duration::from_secs(1) => {
                    std::thread::sleep(Duration::from_millis(5))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
    }
}

struct CacheEntry {
    directory: String,
    projection: ProjectIdentityProjection,
    time: Instant,
}
static CACHE: Mutex<VecDeque<CacheEntry>> = Mutex::new(VecDeque::new());

pub fn clear_identity_cache() {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
}
pub fn normalize_project_directory(directory: &str) -> String {
    path::normalize(directory)
}
pub fn get_project_identity_key(identity: &ProjectIdentity) -> String {
    format!("{}:{}", identity.kind, identity.key)
}
pub fn matches_project_identity(identity: &ProjectIdentity, expected: &ProjectIdentity) -> bool {
    identity.kind == expected.kind && identity.key == expected.key
}
pub fn is_project_identity_kind(kind: &str) -> bool {
    matches!(
        kind,
        "git_remote" | "git_common_dir" | "manifest_path" | "synthetic" | "path" | "loose"
    )
}
pub fn get_project_agent_key(key: &str, agent: &str) -> String {
    format!("{key}\0{}", agent.to_lowercase())
}

pub fn normalize_git_remote(input: &str) -> Option<String> {
    static SCHEME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z\d+.-]*://").unwrap());
    static SSH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^@]+@([^:]+):(.+)$").unwrap());
    let raw = input.trim();
    let value = if SCHEME.is_match(raw) {
        let parsed = url::Url::parse(raw).ok()?;
        format!("{}{}", parsed.host_str().unwrap_or(""), parsed.path())
    } else if let Some(captures) = SSH.captures(raw) {
        format!("{}/{}", &captures[1], &captures[2])
    } else {
        raw.into()
    };
    let value = value.strip_suffix(".git").unwrap_or(&value);
    value.contains('/').then(|| value.to_lowercase())
}

fn projection(
    identity: ProjectIdentity,
    revision: &str,
    inputs: &[&str],
) -> ProjectIdentityProjection {
    ProjectIdentityProjection {
        identity,
        resolver_revision: revision.into(),
        input_signature: format!("{:x}", Sha256::digest(serde_json::to_vec(inputs).unwrap())),
    }
}
fn identity(kind: &str, key: &str, display_name: String) -> ProjectIdentity {
    ProjectIdentity {
        kind: kind.into(),
        key: key.into(),
        display_name,
    }
}
pub fn path_identity(directory: &str) -> (ProjectIdentity, String) {
    let result = projection(
        identity("path", directory, fallback_display_name(directory)),
        PROJECT_IDENTITY_RESOLVER_REVISION,
        &["path", directory],
    );
    (result.identity, result.input_signature)
}

pub fn compute_identity(directory: &str) -> ProjectIdentity {
    compute_identity_projection(directory).identity
}
pub fn compute_identity_projection(directory: &str) -> ProjectIdentityProjection {
    let key = path::normalize(directory);
    {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(index) = cache.iter().position(|entry| entry.directory == key) {
            let entry = cache.remove(index).unwrap();
            if entry.time.elapsed() < Duration::from_secs(600) {
                let result = entry.projection.clone();
                cache.push_back(entry);
                return result;
            }
        }
    }
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE")
    } else {
        std::env::var("HOME")
    }
    .unwrap_or_default();
    let result = resolve_identity_projection(
        directory,
        &RealFs,
        &home,
        PROJECT_IDENTITY_RESOLVER_REVISION,
    );
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache.push_back(CacheEntry {
        directory: key,
        projection: result.clone(),
        time: Instant::now(),
    });
    while cache.len() > IDENTITY_CACHE_MAX_ENTRIES {
        cache.pop_front();
    }
    result
}

pub fn resolve_identity_projection(
    directory: &str,
    fs: &impl IdentityFs,
    home: &str,
    revision: &str,
) -> ProjectIdentityProjection {
    let loose = || identity("loose", "loose", "Loose".into());
    if directory.is_empty() {
        return projection(loose(), revision, &["loose", "missing"]);
    }
    let absolute = path::normalize(directory);
    let same_style = path::windows(&absolute) == path::windows(home);
    let home = if same_style {
        path::normalize(home)
    } else {
        home.into()
    };
    if absolute == home
        || matches!(absolute.as_str(), "/tmp" | "/private/tmp")
        || (same_style
            && ["Desktop", "Downloads", "Documents"]
                .iter()
                .any(|name| absolute == path::join(&home, name)))
    {
        return projection(loose(), revision, &["loose", &absolute]);
    }
    if let Some(root) = find_ancestor(&absolute, fs, &[".git"]) {
        if let Some(remote) = fs
            .git(&["config", "--get", "remote.origin.url"], &root)
            .and_then(|value| normalize_git_remote(&value))
        {
            let display = display_name("git_remote", &remote, Some(&root), fs);
            return projection(
                identity("git_remote", &remote, display.clone()),
                revision,
                &["git_remote", &root, &remote, &display],
            );
        }
        if let Some(common) = fs
            .git(&["rev-parse", "--git-common-dir"], &root)
            .filter(|value| !value.trim().is_empty())
        {
            let common = common.trim();
            let key = if common.starts_with('/') || path::windows(common) {
                common.into()
            } else {
                path::join(&root, common)
            };
            let display = display_name("git_common_dir", &key, Some(&root), fs);
            return projection(
                identity("git_common_dir", &key, display.clone()),
                revision,
                &["git_common_dir", &root, &key, &display],
            );
        }
    }
    if let Some(root) = find_ancestor(&absolute, fs, &MANIFESTS) {
        let display = display_name("manifest_path", &root, None, fs);
        return projection(
            identity("manifest_path", &root, display.clone()),
            revision,
            &["manifest_path", &root, &display],
        );
    }
    let scratch = path::join(&home, "Documents/Codex");
    if same_style
        && absolute.starts_with(&format!(
            "{scratch}{}",
            if path::windows(&scratch) { "\\" } else { "/" }
        ))
    {
        return projection(
            identity("synthetic", "codex:scratch", "Chats".into()),
            revision,
            &["synthetic", "codex:scratch"],
        );
    }
    projection(
        identity("path", &absolute, fallback_display_name(&absolute)),
        revision,
        &["path", &absolute],
    )
}

fn find_ancestor(start: &str, fs: &impl IdentityFs, names: &[&str]) -> Option<String> {
    let mut current = start.to_owned();
    loop {
        if names
            .iter()
            .any(|name| fs.exists(&path::join(&current, name)))
        {
            return Some(current);
        }
        let parent = path::parent(&current);
        if parent == current {
            return None;
        }
        current = parent;
    }
}
fn display_name(kind: &str, key: &str, root: Option<&str>, fs: &impl IdentityFs) -> String {
    static JSON_NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""name"\s*:\s*"([^"]+)""#).unwrap());
    static TOML_NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?m)^\s*name\s*=\s*"([^"]+)""#).unwrap());
    if let Some(dir) = root.or_else(|| (kind == "manifest_path").then_some(key)) {
        for manifest in &MANIFESTS[..3] {
            let file = path::join(dir, manifest);
            if !fs.exists(&file) {
                continue;
            }
            if let Some(text) = fs.read_text(&file)
                && let Some(captures) = JSON_NAME
                    .captures(&text)
                    .or_else(|| TOML_NAME.captures(&text))
            {
                return captures[1].into();
            }
        }
    }
    if kind == "git_remote" {
        key.rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(key)
            .into()
    } else {
        fallback_display_name(root.unwrap_or(key))
    }
}

#[cfg(test)]
mod tests;
