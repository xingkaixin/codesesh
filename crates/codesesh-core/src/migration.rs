mod database;
mod files;

use anyhow::{Context, Result, ensure};
use files::{Fingerprint, exists};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone)]
pub struct Progress {
    pub phase: &'static str,
    pub path: PathBuf,
    pub done: u64,
    pub total: Option<u64>,
}
impl Progress {
    fn new(phase: &'static str, path: &Path, done: u64, total: Option<u64>) -> Self {
        Self {
            phase,
            path: path.to_owned(),
            done,
            total,
        }
    }
}

pub struct Options {
    pub home: PathBuf,
    pub environment: BTreeMap<String, std::ffi::OsString>,
    pub state: bool,
    pub cache: bool,
    pub clear_cache: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Journal {
    version: u32,
    items: BTreeMap<PathBuf, Item>,
    logs_scanned: bool,
    #[serde(default)]
    directories: BTreeSet<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct Item {
    source: PathBuf,
    cleanup: Cleanup,
    fingerprints: Vec<Fingerprint>,
}
#[derive(Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Cleanup {
    Pending,
    Completed,
    Retained,
}

struct Candidate {
    source: PathBuf,
    target: PathBuf,
    database: bool,
}

pub fn run(
    options: Options,
    mut confirm: impl FnMut(&[PathBuf]) -> Result<()>,
    mut report: impl FnMut(Progress),
) -> Result<Vec<String>> {
    let root = crate::app_paths::root(&options.home);
    files::private_directory(&root)?;
    let lock_path = root.join("migration.lock");
    let lock = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    let started = Instant::now();
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                ensure!(
                    started.elapsed() < Duration::from_secs(10),
                    "Another CodeSesh process is migrating data; try again after it finishes"
                );
                report(Progress::new(
                    "Waiting for migration lock",
                    &lock_path,
                    0,
                    None,
                ));
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(std::fs::TryLockError::Error(e)) => return Err(e.into()),
        }
    }
    let record = root.join("migration-v1.json");
    let mut journal: Journal = if exists(&record)? {
        let journal: Journal = serde_json::from_slice(&fs::read(&record)?).with_context(|| {
            format!(
                "Invalid migration record {}; preserve it and repair it before retrying",
                record.display()
            )
        })?;
        ensure!(
            journal.version == 1,
            "Unsupported migration record version: {}",
            journal.version
        );
        journal
    } else {
        Journal {
            version: 1,
            ..Journal::default()
        }
    };
    let mut warnings = Vec::new();
    let old_cache = options.home.join(".cache/codesesh");
    let mut candidates = Vec::new();
    if options.cache || options.clear_cache {
        let source = old_cache.join("codesesh.db");
        let target = root.join("codesesh.db");
        if options.clear_cache && !journal.items.contains_key(&target) {
            if exists(&source)? {
                warnings.push(format!(
                    "Retained {}: --clear-cache skips importing the old cache; remove it manually",
                    source.display()
                ));
            }
            journal.items.insert(
                target,
                Item {
                    source,
                    cleanup: Cleanup::Retained,
                    fingerprints: vec![],
                },
            );
        } else {
            candidates.push(Candidate {
                source,
                target,
                database: true,
            });
        }
    }
    candidates.push(Candidate {
        source: old_cache.join("models-dev-pricing.json"),
        target: root.join("models-dev-pricing.json"),
        database: false,
    });
    let old_state = crate::app_paths::legacy_state(&options.home, std::env::consts::OS, |k| {
        options.environment.get(k).cloned()
    });
    if options.state
        && options
            .environment
            .get("CODESESH_STATE_DIR")
            .cloned()
            .is_none_or(|v| v.is_empty())
    {
        candidates.push(Candidate {
            source: old_state.join("state.db"),
            target: root.join("state.db"),
            database: true,
        });
    }
    let old_log_home = options
        .environment
        .get("HOME")
        .cloned()
        .or_else(|| options.environment.get("USERPROFILE").cloned())
        .map(PathBuf::from)
        .unwrap_or_else(|| options.home.clone());
    let old_logs = options
        .environment
        .get("XDG_CACHE_HOME")
        .cloned()
        .map(PathBuf::from)
        .unwrap_or_else(|| old_log_home.join(".cache"))
        .join("codesesh/logs");
    let scan_logs = !journal.logs_scanned
        && options
            .environment
            .get("CODESESH_LOG_DIR")
            .cloned()
            .is_none();
    if scan_logs && exists(&old_logs)? {
        ensure!(
            fs::symlink_metadata(&old_logs)?.is_dir(),
            "Legacy log directory is not a regular directory: {}",
            old_logs.display()
        );
        let managed = regex::Regex::new(
            r"^codesesh(?:-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?:active|emergency|\d+)|-\d+|-\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+|-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-\d+)?\.log$",
        )?;
        for entry in fs::read_dir(&old_logs)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && managed.is_match(&entry.file_name().to_string_lossy())
            {
                candidates.push(Candidate {
                    source: entry.path(),
                    target: root.join("logs").join(entry.file_name()),
                    database: false,
                });
            } else {
                warnings.push(format!(
                    "Retained {}: unrecognized file or directory",
                    entry.path().display()
                ));
            }
        }
    }
    let mut pending = Vec::new();
    for candidate in candidates {
        if journal.items.contains_key(&candidate.target) {
            continue;
        }
        let source_exists = exists(&candidate.source)?;
        if exists(&candidate.target)? || !source_exists {
            let cleanup = if source_exists {
                warnings.push(format!("Retained {}: destination {} already exists; review and remove the old file manually", candidate.source.display(), candidate.target.display()));
                Cleanup::Retained
            } else {
                Cleanup::Completed
            };
            journal.items.insert(
                candidate.target,
                Item {
                    source: candidate.source,
                    cleanup,
                    fingerprints: vec![],
                },
            );
        } else {
            pending.push(candidate);
        }
    }
    if !pending.is_empty() {
        confirm(&pending.iter().map(|c| c.source.clone()).collect::<Vec<_>>())?;
    }
    for candidate in pending {
        let result = migrate(&candidate, &mut report).with_context(|| {
            format!(
                "Migration failed for {}; source retained",
                candidate.source.display()
            )
        });
        let item = match result {
            Ok(fingerprints) => Item {
                source: candidate.source,
                cleanup: Cleanup::Pending,
                fingerprints,
            },
            Err(error)
                if candidate
                    .target
                    .file_name()
                    .is_some_and(|n| n == "state.db") =>
            {
                return Err(error);
            }
            Err(error) => {
                warnings.push(format!(
                    "Retained {}: {error:#}; using fresh data at the new location",
                    candidate.source.display()
                ));
                Item {
                    source: candidate.source,
                    cleanup: Cleanup::Retained,
                    fingerprints: vec![],
                }
            }
        };
        journal.items.insert(candidate.target, item);
        save(&record, &journal)?;
    }
    if scan_logs {
        journal.logs_scanned = true;
    }
    // Persist the cutover before deleting any source, including when no files needed copying.
    let serialized = serde_json::to_vec_pretty(&journal)?;
    if !exists(&record)? || fs::read(&record)? != serialized {
        save(&record, &journal)?;
    }
    let targets: Vec<_> = journal
        .items
        .iter()
        .filter(|(_, item)| item.cleanup == Cleanup::Pending)
        .map(|(p, _)| p.clone())
        .collect();
    let mut directories = journal.directories.clone();
    for target in targets {
        let item = journal.items.get_mut(&target).unwrap();
        if !exists(&target)? {
            warnings.push(format!(
                "Retained {}: destination {} is missing",
                item.source.display(),
                target.display()
            ));
            item.cleanup = Cleanup::Retained;
        } else {
            match cleanup(item, &mut report) {
                Ok(()) => {
                    item.cleanup = Cleanup::Completed;
                    if let Some(parent) = item.source.parent() {
                        directories.insert(parent.to_owned());
                    }
                }
                Err(error) => {
                    for fingerprint in &item.fingerprints {
                        if exists(&fingerprint.path).unwrap_or(true) {
                            warnings.push(format!(
                                "Retained {}: {error:#}",
                                fingerprint.path.display()
                            ));
                        }
                    }
                }
            }
        }
        journal.directories = directories.clone();
        save(&record, &journal)?;
    }
    if directories.contains(&old_logs)
        && let Some(parent) = old_logs.parent()
    {
        directories.insert(parent.to_owned());
    }
    journal.directories = directories.clone();
    if !directories.is_empty() {
        save(&record, &journal)?;
    }
    let mut directories: Vec<_> = directories.into_iter().collect();
    directories.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for directory in directories {
        if directory == root || !exists(&directory)? {
            journal.directories.remove(&directory);
            save(&record, &journal)?;
            continue;
        }
        report(Progress::new(
            "Cleaning directories",
            &directory,
            0,
            Some(1),
        ));
        if let Err(error) = fs::remove_dir(&directory) {
            warnings.push(format!(
                "Retained directory {}: {error}",
                directory.display()
            ));
            if let Ok(entries) = fs::read_dir(&directory) {
                journal.directories.remove(&directory);
                for entry in entries.flatten() {
                    warnings.push(format!("Remaining: {}", entry.path().display()));
                }
            }
        }
        if !exists(&directory)? {
            journal.directories.remove(&directory);
        }
        save(&record, &journal)?;
        report(Progress::new(
            "Cleaning directories",
            &directory,
            1,
            Some(1),
        ));
    }
    Ok(warnings)
}

fn save(path: &Path, journal: &Journal) -> Result<()> {
    let mut temp = files::temporary(path)?;
    temp.write_all(&serde_json::to_vec_pretty(journal)?)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    files::sync_directory(path.parent().unwrap())
}

fn migrate(candidate: &Candidate, report: &mut impl FnMut(Progress)) -> Result<Vec<Fingerprint>> {
    ensure!(
        fs::symlink_metadata(&candidate.source)?.is_file(),
        "Source is not a regular file"
    );
    files::private_directory(candidate.target.parent().unwrap())?;
    let before = files::fingerprints(&candidate.source, candidate.database, report)?;
    let temp = files::temporary(&candidate.target)?;
    if candidate.database {
        database::copy(&candidate.source, temp.path(), report)?;
    } else {
        files::copy(&candidate.source, temp.path(), report)?;
        if candidate
            .target
            .file_name()
            .is_some_and(|n| n == "models-dev-pricing.json")
        {
            let value: serde_json::Value = serde_json::from_slice(&fs::read(temp.path())?)?;
            ensure!(
                value.get("timestamp").is_some_and(|v| v.is_number())
                    && value.get("data").is_some_and(|v| v.is_object()),
                "Invalid pricing cache"
            );
        }
    }
    let after = files::fingerprints(&candidate.source, candidate.database, report)?;
    let stable = |items: &[Fingerprint]| {
        items
            .iter()
            .filter(|f| {
                let name = f.path.as_os_str().to_string_lossy();
                !(name.ends_with("-shm") || name.ends_with("-wal") && f.size == 0)
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    ensure!(
        stable(&before) == stable(&after),
        "Source changed during migration; stop the older CodeSesh instance and retry"
    );
    temp.as_file().sync_all()?;
    temp.persist_noclobber(&candidate.target)?;
    files::sync_directory(candidate.target.parent().unwrap())?;
    Ok(after)
}

fn cleanup(item: &mut Item, report: &mut impl FnMut(Progress)) -> Result<()> {
    let database = item.source.extension().is_some_and(|e| e == "db");
    let current = files::fingerprints(&item.source, database, report)?;
    if current.iter().any(|f| !item.fingerprints.contains(f)) {
        item.cleanup = Cleanup::Retained;
        anyhow::bail!("source changed after migration; review and remove it manually");
    }
    let total = current.len() as u64;
    let mut errors = Vec::new();
    // Remove the main database last so an interrupted cleanup cannot leave an orphaned WAL.
    for (index, fingerprint) in current.iter().rev().enumerate() {
        report(Progress::new(
            "Cleaning files",
            &fingerprint.path,
            index as u64,
            Some(total),
        ));
        if let Err(error) = fs::remove_file(&fingerprint.path) {
            errors.push(format!("{}: {error}", fingerprint.path.display()));
        }
        report(Progress::new(
            "Cleaning files",
            &fingerprint.path,
            index as u64 + 1,
            Some(total),
        ));
        if !errors.is_empty() && database {
            break;
        }
    }
    ensure!(errors.is_empty(), "{}", errors.join("\n"));
    Ok(())
}

#[cfg(test)]
mod tests;
