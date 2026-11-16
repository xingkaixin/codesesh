mod groups;
mod path;
mod scope;

pub(crate) use groups::preferred_project_display_names;
pub use groups::{ProjectGroup, build_project_groups};
pub(crate) use path::fallback_display_name;
pub use scope::*;

use crate::model::ProjectIdentity;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    collections::VecDeque,
    process::{Command, Stdio},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

pub(crate) const PROJECT_IDENTITY_RESOLVER_REVISION: &str = "project-identity-v2";
pub(crate) const IDENTITY_CACHE_MAX_ENTRIES: usize = 512;
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
pub(crate) struct ProjectIdentityProjection {
    pub identity: ProjectIdentity,
    pub resolver_revision: String,
    pub input_signature: String,
}

pub(crate) trait IdentityFs {
    fn exists(&self, path: &str) -> bool;
    fn read_text(&self, path: &str) -> Option<String>;
    fn git(&self, args: &[&str], cwd: &str) -> Option<String>;
    fn timed_out(&self) -> bool {
        false
    }
}

#[derive(Default)]
pub(crate) struct RealFs {
    timed_out: Cell<bool>,
}
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
                    self.timed_out.set(true);
                    return None;
                }
            }
        }
    }
    fn timed_out(&self) -> bool {
        self.timed_out.get()
    }
}

#[derive(Clone)]
struct DirectoryProbe {
    exists: bool,
    timed_out: bool,
    git_origin: Option<String>,
    git_manifest_name: Option<String>,
    default: ProjectIdentityProjection,
    default_has_manifest: bool,
}

struct CacheEntry {
    directory: String,
    probe: DirectoryProbe,
    time: Instant,
}
static CACHE: Mutex<VecDeque<CacheEntry>> = Mutex::new(VecDeque::new());

#[cfg(test)]
pub(crate) fn clear_identity_cache() {
    CACHE.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

pub(crate) fn normalize_project_directory(directory: &str) -> String {
    path::normalize(directory)
}
pub(crate) fn get_project_identity_key(identity: &ProjectIdentity) -> String {
    format!("{}:{}", identity.kind, identity.key)
}
pub(crate) fn matches_project_identity(
    identity: &ProjectIdentity,
    expected: &ProjectIdentity,
) -> bool {
    identity.kind == expected.kind && identity.key == expected.key
}

pub(crate) fn normalize_git_remote(input: &str) -> Option<String> {
    static SCHEME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z\d+.-]*://").unwrap());
    static SSH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[^@/]+@([^:]+):(.+)$").unwrap());
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

pub(crate) fn normalize_git_remotes(inputs: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for input in inputs {
        if let Some(remote) = normalize_git_remote(input)
            && !normalized.contains(&remote)
        {
            normalized.push(remote);
        }
    }
    normalized
}

fn projection(
    identity: ProjectIdentity,
    revision: &str,
    inputs: &[&str],
) -> ProjectIdentityProjection {
    ProjectIdentityProjection {
        identity,
        resolver_revision: revision.into(),
        input_signature: crate::hash::hex(&Sha256::digest(serde_json::to_vec(inputs).unwrap())),
    }
}
fn identity(kind: &str, key: &str, display_name: String) -> ProjectIdentity {
    ProjectIdentity {
        kind: kind.into(),
        key: key.into(),
        display_name,
    }
}
fn remote_tail(remote: &str) -> String {
    remote
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(remote)
        .into()
}
pub(crate) fn path_identity(directory: &str) -> (ProjectIdentity, String) {
    let result = projection(
        identity("path", directory, fallback_display_name(directory)),
        PROJECT_IDENTITY_RESOLVER_REVISION,
        &["path", directory],
    );
    (result.identity, result.input_signature)
}

pub(crate) fn compute_identity(directory: &str) -> ProjectIdentity {
    compute_identity_projection(directory).identity
}
pub(crate) fn compute_identity_projection(directory: &str) -> ProjectIdentityProjection {
    compute_identity_projection_with_context(directory, &[], None)
}
pub(crate) fn compute_identity_projection_with_context(
    directory: &str,
    recorded_git_remotes: &[String],
    previous: Option<(&ProjectIdentity, Option<&str>)>,
) -> ProjectIdentityProjection {
    let key = path::normalize(directory);
    let mut cached_probe = None;
    let probe = {
        let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(index) = cache.iter().position(|entry| entry.directory == key) {
            let entry = cache.remove(index).unwrap();
            if entry.time.elapsed() < Duration::from_secs(600) {
                let probe = entry.probe.clone();
                cache.push_back(entry);
                Some(probe)
            } else {
                cached_probe = Some(entry.probe);
                None
            }
        } else {
            None
        }
    };
    let probe = match probe {
        Some(probe) => probe,
        None => {
            let home = if cfg!(windows) {
                std::env::var("USERPROFILE")
            } else {
                std::env::var("HOME")
            }
            .unwrap_or_default();
            let fs = RealFs::default();
            let probed = probe_directory(directory, &fs, &home, PROJECT_IDENTITY_RESOLVER_REVISION);
            // A timed-out git lookup is no evidence of a new identity; switching would re-parse the whole project.
            let probe = match cached_probe {
                Some(previous) if fs.timed_out.get() => previous,
                _ => probed,
            };
            let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            cache.push_back(CacheEntry {
                directory: key,
                probe: probe.clone(),
                time: Instant::now(),
            });
            while cache.len() > IDENTITY_CACHE_MAX_ENTRIES {
                cache.pop_front();
            }
            probe
        }
    };
    apply_identity_context(
        &probe,
        recorded_git_remotes,
        previous,
        PROJECT_IDENTITY_RESOLVER_REVISION,
    )
}

#[cfg(test)]
pub(crate) fn resolve_identity_projection(
    directory: &str,
    fs: &impl IdentityFs,
    home: &str,
    revision: &str,
) -> ProjectIdentityProjection {
    resolve_identity_projection_with_context(directory, fs, home, revision, &[], None)
}

#[cfg(test)]
pub(crate) fn resolve_identity_projection_with_context(
    directory: &str,
    fs: &impl IdentityFs,
    home: &str,
    revision: &str,
    recorded_git_remotes: &[String],
    previous: Option<(&ProjectIdentity, Option<&str>)>,
) -> ProjectIdentityProjection {
    let probe = probe_directory(directory, fs, home, revision);
    apply_identity_context(&probe, recorded_git_remotes, previous, revision)
}

fn probe_directory(
    directory: &str,
    fs: &impl IdentityFs,
    home: &str,
    revision: &str,
) -> DirectoryProbe {
    let loose = || identity("loose", "loose", "Loose".into());
    if directory.is_empty() {
        return DirectoryProbe {
            exists: false,
            timed_out: false,
            git_origin: None,
            git_manifest_name: None,
            default: projection(loose(), revision, &["loose", "missing"]),
            default_has_manifest: false,
        };
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
        return DirectoryProbe {
            exists: fs.exists(&absolute),
            timed_out: false,
            git_origin: None,
            git_manifest_name: None,
            default: projection(loose(), revision, &["loose", &absolute]),
            default_has_manifest: false,
        };
    }
    let exists = fs.exists(&absolute);
    if let Some(root) = find_ancestor(&absolute, fs, &[".git"]) {
        let git_origin = fs
            .git(&["config", "--get", "remote.origin.url"], &root)
            .and_then(|value| normalize_git_remote(&value));
        let git_manifest_name = manifest_name(&root, fs);
        if let Some(remote) = &git_origin {
            let display = git_manifest_name
                .clone()
                .unwrap_or_else(|| remote_tail(remote));
            return DirectoryProbe {
                exists,
                timed_out: fs.timed_out(),
                git_origin: Some(remote.clone()),
                git_manifest_name: git_manifest_name.clone(),
                default: projection(
                    identity("git_remote", remote, display.clone()),
                    revision,
                    &["git_remote", &root, remote, &display],
                ),
                default_has_manifest: git_manifest_name.is_some(),
            };
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
            let display = git_manifest_name
                .clone()
                .unwrap_or_else(|| fallback_display_name(&root));
            return DirectoryProbe {
                exists,
                timed_out: fs.timed_out(),
                git_origin: None,
                git_manifest_name: git_manifest_name.clone(),
                default: projection(
                    identity("git_common_dir", &key, display.clone()),
                    revision,
                    &["git_common_dir", &root, &key, &display],
                ),
                default_has_manifest: git_manifest_name.is_some(),
            };
        }
    }
    if let Some(root) = find_ancestor(&absolute, fs, &MANIFESTS) {
        let manifest = manifest_name(&root, fs);
        let display = manifest
            .clone()
            .unwrap_or_else(|| fallback_display_name(&root));
        return DirectoryProbe {
            exists,
            timed_out: fs.timed_out(),
            git_origin: None,
            git_manifest_name: None,
            default: projection(
                identity("manifest_path", &root, display.clone()),
                revision,
                &["manifest_path", &root, &display],
            ),
            default_has_manifest: manifest.is_some(),
        };
    }
    let scratch = path::join(&home, "Documents/Codex");
    if same_style
        && absolute.starts_with(&format!(
            "{scratch}{}",
            if path::windows(&scratch) { "\\" } else { "/" }
        ))
    {
        return DirectoryProbe {
            exists,
            timed_out: fs.timed_out(),
            git_origin: None,
            git_manifest_name: None,
            default: projection(
                identity("synthetic", "codex:scratch", "Chats".into()),
                revision,
                &["synthetic", "codex:scratch"],
            ),
            default_has_manifest: false,
        };
    }
    DirectoryProbe {
        exists,
        timed_out: fs.timed_out(),
        git_origin: None,
        git_manifest_name: None,
        default: projection(
            identity("path", &absolute, fallback_display_name(&absolute)),
            revision,
            &["path", &absolute],
        ),
        default_has_manifest: false,
    }
}

fn apply_identity_context(
    probe: &DirectoryProbe,
    recorded_git_remotes: &[String],
    previous: Option<(&ProjectIdentity, Option<&str>)>,
    revision: &str,
) -> ProjectIdentityProjection {
    if probe.default.identity.kind == "loose" {
        return probe.default.clone();
    }
    let remotes = normalize_git_remotes(recorded_git_remotes);
    if remotes.len() == 1 {
        let remote = &remotes[0];
        let display = if probe.git_origin.as_deref() == Some(remote.as_str())
            && let Some(manifest) = &probe.git_manifest_name
        {
            manifest.clone()
        } else if let Some((prev, _)) = previous
            && prev.kind == "git_remote"
            && prev.key == *remote
            && !prev.display_name.is_empty()
        {
            prev.display_name.clone()
        } else {
            remote_tail(remote)
        };
        // Omit worktree root so deleting a worktree does not alter input_signature.
        return projection(
            identity("git_remote", remote, display.clone()),
            revision,
            &["recorded_git_remote", remote, &display],
        );
    }
    if probe.default.identity.kind == "path"
        && (!probe.exists || probe.timed_out)
        && let Some((prev, prev_sig)) = previous
        && matches!(prev.kind.as_str(), "git_remote" | "git_common_dir")
    {
        return match prev_sig {
            Some(signature) => ProjectIdentityProjection {
                identity: prev.clone(),
                resolver_revision: revision.into(),
                input_signature: signature.to_owned(),
            },
            None => projection(
                prev.clone(),
                revision,
                &["retained", &prev.kind, &prev.key, &prev.display_name],
            ),
        };
    }
    retain_display_name(
        probe.default.clone(),
        probe.default_has_manifest,
        previous,
        revision,
    )
}

fn retain_display_name(
    default: ProjectIdentityProjection,
    has_manifest: bool,
    previous: Option<(&ProjectIdentity, Option<&str>)>,
    revision: &str,
) -> ProjectIdentityProjection {
    let Some((prev, _)) = previous else {
        return default;
    };
    if has_manifest
        || prev.kind != default.identity.kind
        || prev.key != default.identity.key
        || prev.display_name.is_empty()
        || prev.display_name == default.identity.display_name
    {
        return default;
    }
    let mut identity = default.identity;
    identity.display_name = prev.display_name.clone();
    let kind = identity.kind.clone();
    let key = identity.key.clone();
    let display = identity.display_name.clone();
    projection(
        identity,
        revision,
        &["retained_name", &kind, &key, &display],
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

fn manifest_name(dir: &str, fs: &impl IdentityFs) -> Option<String> {
    static JSON_NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""name"\s*:\s*"([^"]+)""#).unwrap());
    static TOML_NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?m)^\s*name\s*=\s*"([^"]+)""#).unwrap());
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
            return Some(captures[1].into());
        }
    }
    None
}

#[cfg(test)]
mod tests;
