use super::Runtime;
use anyhow::{Context, Result};
use notify::{EventKind, RecursiveMode, Watcher};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

impl Runtime {
    pub(super) fn watch_sources(&self) -> Result<(Duration, Duration)> {
        let started = Instant::now();
        let weak = Arc::downgrade(&self.inner);
        let (reconcile, mut changes) = watch::channel(0_u64);
        let reset_watches = Arc::new(AtomicBool::new(false));
        let reset_requested = reset_watches.clone();
        let created = Arc::new(std::sync::Mutex::new(Vec::<PathBuf>::new()));
        let created_by_events = created.clone();
        let handler = move |event: notify::Result<notify::Event>| {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            if inner.stopped.load(Ordering::Acquire) {
                return;
            }
            match event {
                Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
                    if matches!(event.kind, EventKind::Create(_))
                        && let Ok(mut created) = created_by_events.lock()
                    {
                        created.extend(event.paths.iter().cloned());
                    }
                    if matches!(
                        event.kind,
                        EventKind::Remove(
                            notify::event::RemoveKind::Folder | notify::event::RemoveKind::Any
                        ) | EventKind::Modify(notify::event::ModifyKind::Name(_))
                    ) {
                        reset_requested.store(true, Ordering::Release);
                    }
                    if !matches!(
                        event.kind,
                        EventKind::Modify(notify::event::ModifyKind::Data(_))
                    ) {
                        reconcile.send_modify(|revision| *revision = revision.wrapping_add(1));
                    }
                    for control in &inner.controls {
                        let paths: Vec<_> = event
                            .paths
                            .iter()
                            .map(|path| normalize_watch_path(path))
                            .filter_map(|path| {
                                if path
                                    .file_name()
                                    .is_some_and(|name| name.to_string_lossy().ends_with("-shm"))
                                {
                                    return None;
                                }
                                control.roots.iter().find_map(|root| {
                                    let canonical = normalize_watch_path(root);
                                    if ["-wal", "-journal"].iter().any(|suffix| {
                                        path.as_os_str()
                                            == format!("{}{suffix}", canonical.to_string_lossy())
                                                .as_str()
                                    }) {
                                        Some(path.clone())
                                    } else if let Ok(suffix) = path.strip_prefix(&canonical) {
                                        Some(root.join(suffix))
                                    } else if canonical.starts_with(&path) {
                                        Some(root.clone())
                                    } else {
                                        None
                                    }
                                })
                            })
                            .collect();
                        if !paths.is_empty() {
                            Self::invalidate(control, Some(paths), false);
                        }
                    }
                }
                Err(_) => {
                    reconcile.send_modify(|revision| *revision = revision.wrapping_add(1));
                    for control in &inner.controls {
                        Self::invalidate(control, None, false);
                    }
                }
                _ => (),
            }
        };
        let mut watcher = notify::recommended_watcher(handler.clone())?;
        let roots: Vec<_> = self
            .inner
            .controls
            .iter()
            .flat_map(|control| control.roots.clone())
            .collect();
        let mut watched = std::collections::BTreeMap::new();
        reconcile_watches(&mut watcher, &roots, &mut watched)?;
        let registration = started.elapsed();
        let started = Instant::now();
        #[cfg(target_os = "macos")]
        let mut observed = metadata_snapshot(&watched);
        #[cfg(target_os = "macos")]
        let mut ticks = 0_u32;
        let snapshot = started.elapsed();
        let mut polling = tokio::time::interval_at(
            tokio::time::Instant::now() + std::time::Duration::from_secs(2),
            std::time::Duration::from_secs(2),
        );
        polling.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut shutdown = self.inner.shutdown.subscribe();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    result = shutdown.changed() => if result.is_err() || *shutdown.borrow() { break; },
                    _ = polling.tick(), if cfg!(target_os = "macos") => {
                        #[cfg(target_os = "macos")]
                        {
                            let paths = watched.clone();
                            let mut known = std::mem::take(&mut observed);
                            let created = created.lock().map(|mut created| std::mem::take(&mut *created)).unwrap_or_default();
                            ticks = ticks.wrapping_add(1);
                            let full = ticks.is_multiple_of(FULL_POLL_TICKS) || known.is_empty();
                            if let Ok((known, events)) = tokio::task::spawn_blocking(move || {
                                let events = if full {
                                    let current = metadata_snapshot(&paths);
                                    let events = snapshot_changes(&known, &current);
                                    known = current;
                                    events
                                } else {
                                    refresh_recent(&mut known, created)
                                };
                                (known, events)
                            }).await {
                                for (kind, paths) in events {
                                    if !paths.is_empty() {
                                        handler(Ok(notify::Event { kind, paths, attrs: Default::default() }));
                                    }
                                }
                                observed = known;
                            }
                        }
                    },
                    result = changes.changed() => {
                        if result.is_err() { break; }
                        if reset_watches.swap(false, Ordering::AcqRel) {
                            for path in watched.keys() { let _ = watcher.unwatch(path); }
                            watched.clear();
                        }
                        let _ = reconcile_watches(&mut watcher, &roots, &mut watched);
                    }
                }
            }
        });
        Ok((registration, snapshot))
    }
}

fn existing_watch_root(path: &Path) -> Result<PathBuf> {
    let mut current = path;
    while !current.is_dir() {
        current = current.parent().context("no existing watch ancestor")?;
    }
    Ok(current.to_owned())
}

fn normalize_watch_path(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut suffix = Vec::new();
    loop {
        if let Ok(mut canonical) = existing.canonicalize() {
            for component in suffix.into_iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        if let Some(name) = existing.file_name() {
            suffix.push(name.to_owned());
        }
        let Some(parent) = existing.parent() else {
            return path.to_owned();
        };
        existing = parent;
    }
}

fn reconcile_watches(
    watcher: &mut notify::RecommendedWatcher,
    roots: &[PathBuf],
    watched: &mut std::collections::BTreeMap<PathBuf, RecursiveMode>,
) -> Result<()> {
    let mut desired = std::collections::BTreeMap::new();
    for root in roots {
        if root.is_dir() {
            desired.insert(normalize_watch_path(root), RecursiveMode::Recursive);
            if let Some(parent) = root.parent() {
                desired
                    .entry(normalize_watch_path(parent))
                    .or_insert(RecursiveMode::NonRecursive);
            }
        } else {
            desired
                .entry(normalize_watch_path(&existing_watch_root(root)?))
                .or_insert(RecursiveMode::NonRecursive);
        }
    }
    watched.retain(|path, mode| {
        if desired.get(path) == Some(mode) {
            true
        } else {
            let _ = watcher.unwatch(path);
            false
        }
    });
    for (path, mode) in desired {
        if let std::collections::btree_map::Entry::Vacant(entry) = watched.entry(path) {
            watcher
                .watch(entry.key(), mode)
                .with_context(|| format!("watch {}", entry.key().display()))?;
            entry.insert(mode);
        }
    }
    Ok(())
}

// FSEvents reports creates promptly but defers writes to open files until close, so live
// rollouts and WAL files are polled. Between full passes every minute, only files changed in the
// last few minutes and paths FSEvents just created are stat'ed.
#[cfg(target_os = "macos")]
const FULL_POLL_TICKS: u32 = 30;
#[cfg(target_os = "macos")]
const HOT_FILE_WINDOW: Duration = Duration::from_secs(10 * 60);

#[cfg(target_os = "macos")]
type PollEvents = Vec<(EventKind, Vec<PathBuf>)>;

// Retain nanoseconds so same-second WAL commits are visible.
#[cfg(target_os = "macos")]
#[derive(PartialEq)]
struct FileStamp {
    length: u64,
    modified: Option<std::time::SystemTime>,
    inode: u64,
    changed: (i64, i64),
}

#[cfg(target_os = "macos")]
fn metadata_snapshot(
    roots: &std::collections::BTreeMap<PathBuf, RecursiveMode>,
) -> std::collections::HashMap<PathBuf, FileStamp> {
    let mut snapshot = std::collections::HashMap::new();
    for (root, mode) in roots {
        let depth = if *mode == RecursiveMode::Recursive {
            usize::MAX
        } else {
            1
        };
        for entry in walkdir::WalkDir::new(root)
            .max_depth(depth)
            .into_iter()
            .filter_map(Result::ok)
        {
            if let Ok(metadata) = entry.metadata() {
                snapshot.insert(entry.into_path(), FileStamp::new(&metadata));
            }
        }
    }
    snapshot
}

#[cfg(target_os = "macos")]
impl FileStamp {
    fn new(metadata: &std::fs::Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;
        Self {
            length: metadata.len(),
            modified: metadata.modified().ok(),
            inode: metadata.ino(),
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        }
    }
}

#[cfg(target_os = "macos")]
fn snapshot_changes(
    previous: &std::collections::HashMap<PathBuf, FileStamp>,
    current: &std::collections::HashMap<PathBuf, FileStamp>,
) -> PollEvents {
    let created = current
        .keys()
        .filter(|path| !previous.contains_key(*path))
        .cloned()
        .collect();
    let removed = previous
        .keys()
        .filter(|path| !current.contains_key(*path))
        .cloned()
        .collect();
    let modified = current
        .iter()
        .filter(|(path, stamp)| previous.get(*path).is_some_and(|old| old != *stamp))
        .map(|(path, _)| path.clone())
        .collect();
    vec![
        (EventKind::Create(notify::event::CreateKind::Any), created),
        (EventKind::Remove(notify::event::RemoveKind::Any), removed),
        (
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            modified,
        ),
    ]
}

#[cfg(target_os = "macos")]
fn refresh_recent(
    known: &mut std::collections::HashMap<PathBuf, FileStamp>,
    created: Vec<PathBuf>,
) -> PollEvents {
    for path in created {
        if !known.contains_key(&path)
            && let Ok(metadata) = std::fs::symlink_metadata(&path)
        {
            known.insert(path, FileStamp::new(&metadata));
        }
    }
    let hot_since = std::time::SystemTime::now() - HOT_FILE_WINDOW;
    let mut modified = Vec::new();
    let mut removed = Vec::new();
    for (path, stamp) in known
        .iter_mut()
        .filter(|(_, stamp)| stamp.modified.is_some_and(|time| time >= hot_since))
    {
        match std::fs::symlink_metadata(path) {
            Ok(metadata) => {
                let current = FileStamp::new(&metadata);
                if current != *stamp {
                    *stamp = current;
                    modified.push(path.clone());
                }
            }
            Err(_) => removed.push(path.clone()),
        }
    }
    for path in &removed {
        known.remove(path);
    }
    vec![
        (EventKind::Remove(notify::event::RemoveKind::Any), removed),
        (
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            modified,
        ),
    ]
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn recent_polls_restat_new_and_recent_files_only() {
        let root = tempfile::tempdir().unwrap();
        let roots = std::collections::BTreeMap::from([(
            root.path().canonicalize().unwrap(),
            RecursiveMode::Recursive,
        )]);
        let cold = roots.keys().next().unwrap().join("cold.jsonl");
        let hot = cold.with_file_name("hot.jsonl");
        std::fs::write(&cold, "a").unwrap();
        std::fs::write(&hot, "a").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&cold)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - 2 * HOT_FILE_WINDOW)
            .unwrap();
        let mut known = metadata_snapshot(&roots);
        for path in [&cold, &hot] {
            std::fs::write(path, "ab").unwrap();
        }
        let added = cold.with_file_name("new.jsonl");
        std::fs::write(&added, "a").unwrap();
        let events = refresh_recent(&mut known, vec![added.clone()]);
        assert!(events[1].1.contains(&hot) && !events[1].1.contains(&cold));
        assert!(known.contains_key(&added));
        let full = metadata_snapshot(&roots);
        assert!(snapshot_changes(&known, &full)[2].1.contains(&cold));
    }
}
