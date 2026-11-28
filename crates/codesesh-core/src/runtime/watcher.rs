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

pub type WatchCallback = dyn Fn(usize, Option<Vec<PathBuf>>) + Send + Sync;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct WatchRoot {
    pub path: PathBuf,
    pub recursive: bool,
}

impl WatchRoot {
    pub fn recursive(path: PathBuf) -> Self {
        Self {
            path,
            recursive: true,
        }
    }

    pub fn shallow(path: PathBuf) -> Self {
        Self {
            path,
            recursive: false,
        }
    }
}

#[derive(Clone)]
pub enum WatchRoots {
    Static(Vec<WatchRoot>),
    Dynamic(Arc<dyn Fn() -> Vec<WatchRoot> + Send + Sync>),
}

impl WatchRoots {
    pub fn resolve(&self) -> Vec<WatchRoot> {
        match self {
            Self::Static(roots) => roots.clone(),
            Self::Dynamic(resolver) => resolver(),
        }
    }

    fn is_dynamic(&self) -> bool {
        matches!(self, Self::Dynamic(_))
    }
}

impl Default for WatchRoots {
    fn default() -> Self {
        Self::Static(Vec::new())
    }
}

impl From<Vec<PathBuf>> for WatchRoots {
    fn from(paths: Vec<PathBuf>) -> Self {
        Self::Static(paths.into_iter().map(WatchRoot::recursive).collect())
    }
}

impl Runtime {
    pub(super) fn watch_sources(&self) -> Result<(Duration, Duration)> {
        let weak = Arc::downgrade(&self.inner);
        watch_paths(
            self.inner
                .controls
                .iter()
                .map(|control| control.roots.clone())
                .collect(),
            Arc::new(move |index, paths| {
                if let Some(inner) = weak.upgrade()
                    && !inner.stopped.load(Ordering::Acquire)
                {
                    Self::invalidate(&inner.controls[index], paths, false);
                }
            }),
            self.inner.shutdown.subscribe(),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedWatchRoot {
    root: WatchRoot,
    canonical: PathBuf,
}

impl NormalizedWatchRoot {
    fn new(root: WatchRoot) -> Self {
        let canonical = normalize_watch_path(&root.path);
        Self { root, canonical }
    }
}

fn normalize_watch_roots(roots: Vec<WatchRoot>) -> Vec<NormalizedWatchRoot> {
    roots.into_iter().map(NormalizedWatchRoot::new).collect()
}

/// Reports changes under each source's roots as `(source index, paths)`; `None` asks for a full scan.
pub fn watch_paths(
    sources: Vec<WatchRoots>,
    on_change: Arc<WatchCallback>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<(Duration, Duration)> {
    let started = Instant::now();
    let initial_sources: Vec<Vec<NormalizedWatchRoot>> = sources
        .iter()
        .map(|source| normalize_watch_roots(source.resolve()))
        .collect();
    let initial_roots: Vec<NormalizedWatchRoot> =
        initial_sources.iter().flatten().cloned().collect();
    let shared_sources = Arc::new(std::sync::Mutex::new(Arc::new(initial_sources)));
    let handler_sources = shared_sources.clone();
    let (reconcile, mut changes) = watch::channel(0_u64);
    let reset_watches = Arc::new(AtomicBool::new(false));
    let reset_requested = reset_watches.clone();
    #[cfg(target_os = "macos")]
    let created = Arc::new(std::sync::Mutex::new(Vec::<PathBuf>::new()));
    #[cfg(target_os = "macos")]
    let created_by_events = created.clone();
    let dispatch_change = on_change.clone();
    let handler = move |event: notify::Result<notify::Event>| match event {
        Ok(event) if !matches!(event.kind, EventKind::Access(_)) => {
            let rescan = event.need_rescan();
            let non_shm: Vec<PathBuf> = event
                .paths
                .iter()
                .filter(|path| !is_shm(path))
                .cloned()
                .collect();
            if !rescan && !event.paths.is_empty() && non_shm.is_empty() {
                return;
            }
            let normalized_paths: Vec<PathBuf> = non_shm
                .iter()
                .map(|path| normalize_watch_path(path))
                .collect();
            #[cfg(target_os = "macos")]
            if !normalized_paths.is_empty() {
                let track_all = matches!(event.kind, EventKind::Create(_));
                let track_sidecars = matches!(event.kind, EventKind::Modify(_) | EventKind::Any);
                if (track_all
                    || (track_sidecars
                        && normalized_paths.iter().any(|path| is_sqlite_sidecar(path))))
                    && let Ok(mut created) = created_by_events.lock()
                {
                    if track_all {
                        created.extend(normalized_paths.iter().cloned());
                    } else {
                        created.extend(
                            normalized_paths
                                .iter()
                                .filter(|path| is_sqlite_sidecar(path))
                                .cloned(),
                        );
                    }
                }
            }
            let current = handler_sources
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let reset = needs_watch_reset(&current, &event, &normalized_paths);
            if reset {
                reset_requested.store(true, Ordering::Release);
            }
            if reset || needs_reconcile(&current, &event, &normalized_paths) {
                reconcile.send_modify(|revision| *revision = revision.wrapping_add(1));
            }
            dispatch_normalized(
                &current,
                &event,
                &normalized_paths,
                dispatch_change.as_ref(),
            );
        }
        Err(_) => {
            reconcile.send_modify(|revision| *revision = revision.wrapping_add(1));
            let count = handler_sources
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len();
            for index in 0..count {
                dispatch_change(index, None);
            }
        }
        _ => (),
    };
    let mut watcher = notify::recommended_watcher(handler.clone())?;
    let mut watched = std::collections::BTreeMap::new();
    reconcile_watches(&mut watcher, &initial_roots, &mut watched)?;
    let registration = started.elapsed();
    let started = Instant::now();
    #[cfg(target_os = "macos")]
    let mut observed = metadata_snapshot(&watched);
    #[cfg(target_os = "macos")]
    let mut ticks = 0_u32;
    #[cfg(target_os = "macos")]
    let mut force_full_poll = false;
    let snapshot = started.elapsed();
    let mut polling = tokio::time::interval_at(
        tokio::time::Instant::now() + std::time::Duration::from_secs(2),
        std::time::Duration::from_secs(2),
    );
    polling.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
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
                        let full = std::mem::take(&mut force_full_poll)
                            || ticks.is_multiple_of(FULL_POLL_TICKS)
                            || known.is_empty();
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
                    let mut changed_sources = Vec::new();
                    let mut updated_sources = false;
                    let mut current = (**shared_sources
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()))
                        .clone();
                    for (index, source) in sources.iter().enumerate() {
                        if source.is_dynamic() {
                            let next = normalize_watch_roots(source.resolve());
                            let roots_changed = current[index].len() != next.len()
                                || current[index]
                                    .iter()
                                    .zip(&next)
                                    .any(|(old, new)| old.root != new.root);
                            if roots_changed {
                                changed_sources.push(index);
                            }
                            if next != current[index] {
                                current[index] = next;
                                updated_sources = true;
                            }
                        } else {
                            for entry in &mut current[index] {
                                let canonical = normalize_watch_path(&entry.root.path);
                                if canonical != entry.canonical {
                                    entry.canonical = canonical;
                                    updated_sources = true;
                                }
                            }
                        }
                    }
                    if updated_sources {
                        *shared_sources
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Arc::new(current.clone());
                    }
                    if !changed_sources.is_empty() {
                        #[cfg(target_os = "macos")]
                        {
                            force_full_poll = true;
                        }
                    }
                    if reset_watches.swap(false, Ordering::AcqRel) {
                        for path in watched.keys() { let _ = watcher.unwatch(path); }
                        watched.clear();
                    }
                    let roots: Vec<NormalizedWatchRoot> = current.into_iter().flatten().collect();
                    let _ = reconcile_watches(&mut watcher, &roots, &mut watched);
                    for index in changed_sources {
                        on_change(index, None);
                    }
                }
            }
        }
    });
    Ok((registration, snapshot))
}

fn needs_watch_reset(
    sources: &[Vec<NormalizedWatchRoot>],
    event: &notify::Event,
    normalized_paths: &[PathBuf],
) -> bool {
    if !matches!(
        event.kind,
        EventKind::Remove(notify::event::RemoveKind::Folder | notify::event::RemoveKind::Any)
            | EventKind::Modify(notify::event::ModifyKind::Name(_))
    ) {
        return false;
    }
    if event.paths.is_empty() {
        return true;
    }
    if normalized_paths.is_empty() {
        return false;
    }
    let folder_removed = matches!(
        event.kind,
        EventKind::Remove(notify::event::RemoveKind::Folder)
    );
    normalized_paths.iter().any(|path| {
        let is_dir = folder_removed || path.is_dir();
        sources.iter().flatten().any(|entry| {
            let root = &entry.root;
            let canonical = &entry.canonical;
            canonical.starts_with(path)
                || (!root.recursive
                    && path
                        .strip_prefix(canonical)
                        .is_ok_and(|suffix| suffix.components().count() <= 1))
                || (is_dir && root.recursive && path.starts_with(canonical))
        })
    })
}

fn needs_reconcile(
    sources: &[Vec<NormalizedWatchRoot>],
    event: &notify::Event,
    normalized_paths: &[PathBuf],
) -> bool {
    if event.need_rescan() {
        return true;
    }
    if is_data_or_metadata_modify(event.kind) {
        return false;
    }
    if event.paths.is_empty() {
        return true;
    }
    if normalized_paths.is_empty() {
        return false;
    }
    normalized_paths.iter().any(|path| {
        sources.iter().flatten().any(|entry| {
            let root = &entry.root;
            let canonical = &entry.canonical;
            canonical.starts_with(path)
                || (!root.recursive
                    && path
                        .strip_prefix(canonical)
                        .is_ok_and(|suffix| suffix.components().count() <= 1))
        })
    })
}

fn is_shm(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().ends_with("-shm"))
}

fn is_data_or_metadata_modify(kind: EventKind) -> bool {
    matches!(
        kind,
        EventKind::Modify(
            notify::event::ModifyKind::Data(_) | notify::event::ModifyKind::Metadata(_)
        )
    )
}

#[cfg(test)]
fn normalize_watch_sources(sources: &[Vec<WatchRoot>]) -> Vec<Vec<NormalizedWatchRoot>> {
    sources
        .iter()
        .map(|roots| normalize_watch_roots(roots.clone()))
        .collect()
}

#[cfg(test)]
fn dispatch(
    sources: &[Vec<WatchRoot>],
    event: &notify::Event,
    on_change: &(impl Fn(usize, Option<Vec<PathBuf>>) + ?Sized),
) {
    let normalized_sources = normalize_watch_sources(sources);
    let normalized_paths: Vec<PathBuf> = event
        .paths
        .iter()
        .filter(|path| !is_shm(path))
        .map(|path| normalize_watch_path(path))
        .collect();
    dispatch_normalized(&normalized_sources, event, &normalized_paths, on_change);
}

fn dispatch_normalized(
    sources: &[Vec<NormalizedWatchRoot>],
    event: &notify::Event,
    normalized_paths: &[PathBuf],
    on_change: &(impl Fn(usize, Option<Vec<PathBuf>>) + ?Sized),
) {
    // Dropped events (inotify overflow, FSEvents MustScanSubDirs) arrive as a rescan flag.
    let rescan = event.need_rescan();
    // Directory mtime/metadata updates (on watch roots, direct children, or ancestors) do not
    // carry content changes; create/remove/rename events still flow through.
    let skip_dirs = is_data_or_metadata_modify(event.kind);
    let filtered: Vec<PathBuf> = if skip_dirs {
        normalized_paths
            .iter()
            .filter(|path| {
                !std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_dir())
            })
            .cloned()
            .collect()
    } else {
        normalized_paths.to_vec()
    };
    if !rescan && filtered.is_empty() {
        return;
    }
    for (index, roots) in sources.iter().enumerate() {
        let paths = source_paths(roots, event.kind, &filtered);
        if rescan && (event.paths.is_empty() || !paths.is_empty()) {
            on_change(index, None);
        } else if !paths.is_empty() {
            on_change(index, Some(paths));
        }
    }
}

fn source_paths(
    roots: &[NormalizedWatchRoot],
    kind: EventKind,
    normalized_paths: &[PathBuf],
) -> Vec<PathBuf> {
    if normalized_paths.is_empty() {
        return Vec::new();
    }
    let ancestor_change = !is_data_or_metadata_modify(kind);
    normalized_paths
        .iter()
        .filter_map(|path| {
            roots.iter().find_map(|entry| {
                let root = &entry.root;
                let canonical = &entry.canonical;
                if ["-wal", "-journal"].iter().any(|suffix| {
                    path.as_os_str() == format!("{}{suffix}", canonical.to_string_lossy()).as_str()
                }) {
                    Some(path.clone())
                } else if let Ok(suffix) = path.strip_prefix(canonical) {
                    if root.recursive || suffix.components().count() <= 1 {
                        Some(root.path.join(suffix))
                    } else {
                        None
                    }
                } else if ancestor_change && canonical.starts_with(path) {
                    Some(root.path.clone())
                } else {
                    None
                }
            })
        })
        .collect()
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
    roots: &[NormalizedWatchRoot],
    watched: &mut std::collections::BTreeMap<PathBuf, RecursiveMode>,
) -> Result<()> {
    let mut desired = std::collections::BTreeMap::new();
    for entry in roots {
        let root = &entry.root;
        if root.path.is_dir() {
            if root.recursive {
                desired.insert(entry.canonical.clone(), RecursiveMode::Recursive);
            } else {
                desired
                    .entry(entry.canonical.clone())
                    .or_insert(RecursiveMode::NonRecursive);
            }
            if let Some(parent) = root.path.parent() {
                desired
                    .entry(normalize_watch_path(parent))
                    .or_insert(RecursiveMode::NonRecursive);
            }
        } else {
            desired
                .entry(normalize_watch_path(&existing_watch_root(&root.path)?))
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
// rollouts and SQLite database/WAL files are polled. Between full passes every 10 minutes,
// only recently modified files, tracked SQLite files, and newly created paths are stat'ed.
#[cfg(target_os = "macos")]
const FULL_POLL_TICKS: u32 = 300;
#[cfg(target_os = "macos")]
const HOT_FILE_WINDOW: Duration = Duration::from_secs(10 * 60);

#[cfg(target_os = "macos")]
fn is_sqlite_sidecar(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        name.ends_with("-wal") || name.ends_with("-journal")
    })
}

#[cfg(target_os = "macos")]
fn is_tracked_sqlite_file(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        name.ends_with(".db")
            || name.ends_with(".sqlite")
            || name.ends_with(".vscdb")
            || name.ends_with("-wal")
            || name.ends_with("-journal")
    })
}

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
    is_dir: bool,
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
            if is_shm(entry.path()) {
                continue;
            }
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
            is_dir: metadata.is_dir(),
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
        .filter(|(path, stamp)| {
            previous
                .get(*path)
                .is_some_and(|old| !(stamp.is_dir && old.is_dir) && old != *stamp)
        })
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
    for (path, stamp) in known.iter_mut().filter(|(path, stamp)| {
        !stamp.is_dir
            && (is_tracked_sqlite_file(path)
                || stamp.modified.is_some_and(|time| time >= hot_since))
    }) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_events_request_full_scans() {
        let root = tempfile::tempdir().unwrap();
        let sources = vec![
            vec![WatchRoot::recursive(root.path().join("first"))],
            vec![WatchRoot::recursive(root.path().join("second"))],
        ];
        let calls = std::sync::Mutex::new(Vec::new());
        let record = |index, paths: Option<Vec<PathBuf>>| {
            calls.lock().unwrap().push((index, paths.is_none()));
        };
        let changed = root.path().join("second/session.jsonl");
        let take = |event: &notify::Event| {
            dispatch(&sources, event, &record);
            std::mem::take(&mut *calls.lock().unwrap())
        };
        let modified = notify::Event::new(EventKind::Any).add_path(changed.clone());
        assert_eq!(take(&modified), [(1, false)]);
        let dropped = modified.set_flag(notify::event::Flag::Rescan);
        assert_eq!(take(&dropped), [(1, true)]);
        let overflow = notify::Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert_eq!(take(&overflow), [(0, true), (1, true)]);
    }

    #[test]
    fn file_renames_and_journal_removals_do_not_reset_all_watches() {
        let temp = tempfile::tempdir().unwrap();
        let sessions = temp.path().join("sessions");
        let db = temp.path().join("globalStorage/state.vscdb");
        let sibling_dir = temp.path().join("globalStorage/brain");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&sibling_dir).unwrap();
        let transcript = sessions.join("session.jsonl");
        let tmp_file = sessions.join("session.jsonl.tmp");
        std::fs::write(&transcript, "{}\n").unwrap();
        let subdir = sessions.join("nested");
        std::fs::create_dir(&subdir).unwrap();
        let sources = normalize_watch_sources(&[vec![
            WatchRoot::recursive(sessions.clone()),
            WatchRoot::recursive(db.clone()),
        ]]);
        let normalize = |event: &notify::Event| -> Vec<PathBuf> {
            event
                .paths
                .iter()
                .filter(|path| !is_shm(path))
                .map(|path| normalize_watch_path(path))
                .collect()
        };

        let atomic_rename = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Both,
        )))
        .add_path(tmp_file)
        .add_path(transcript);
        assert!(!needs_watch_reset(
            &sources,
            &atomic_rename,
            &normalize(&atomic_rename)
        ));

        let journal_removed = notify::Event::new(EventKind::Remove(notify::event::RemoveKind::Any))
            .add_path(PathBuf::from(format!("{}-journal", db.display())));
        assert!(!needs_watch_reset(
            &sources,
            &journal_removed,
            &normalize(&journal_removed)
        ));

        // Renaming or removing an unrelated sibling directory or -shm file must not reset or reconcile.
        let sibling_renamed = notify::Event::new(EventKind::Modify(
            notify::event::ModifyKind::Name(notify::event::RenameMode::To),
        ))
        .add_path(sibling_dir.clone());
        let sibling_norm = normalize(&sibling_renamed);
        assert!(!needs_watch_reset(
            &sources,
            &sibling_renamed,
            &sibling_norm
        ));
        assert!(!needs_reconcile(&sources, &sibling_renamed, &sibling_norm));

        let shm_created = notify::Event::new(EventKind::Create(notify::event::CreateKind::File))
            .add_path(PathBuf::from(format!("{}-shm", db.display())));
        let shm_norm = normalize(&shm_created);
        assert!(!needs_watch_reset(&sources, &shm_created, &shm_norm));
        assert!(!needs_reconcile(&sources, &shm_created, &shm_norm));

        let dir_rename = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::To,
        )))
        .add_path(subdir);
        assert!(needs_watch_reset(
            &sources,
            &dir_rename,
            &normalize(&dir_rename)
        ));

        let root_removed = notify::Event::new(EventKind::Remove(notify::event::RemoveKind::Any))
            .add_path(sessions);
        assert!(needs_watch_reset(
            &sources,
            &root_removed,
            &normalize(&root_removed)
        ));

        let ancestor_renamed = notify::Event::new(EventKind::Modify(
            notify::event::ModifyKind::Name(notify::event::RenameMode::Any),
        ))
        .add_path(db.parent().unwrap().to_path_buf());
        assert!(needs_watch_reset(
            &sources,
            &ancestor_renamed,
            &normalize(&ancestor_renamed)
        ));
    }

    #[test]
    fn shallow_roots_ignore_nested_siblings_and_ancestor_data_writes() {
        let temp = tempfile::tempdir().unwrap();
        let profiles = temp.path().join("profiles");
        let profile = profiles.join("account-a");
        let acp = profile.join("antigravity-acp");
        let conversations = acp.join("conversations");
        let brain_output = acp.join("brain/session/output.txt");
        let log_file = acp.join("log/acp-server.log");
        let session_wal = conversations.join("s1.db-wal");
        let summary_wal = acp.join("conversation_summaries.db-wal");
        std::fs::create_dir_all(&conversations).unwrap();
        std::fs::create_dir_all(brain_output.parent().unwrap()).unwrap();
        std::fs::create_dir_all(log_file.parent().unwrap()).unwrap();
        std::fs::write(&brain_output, "noise").unwrap();
        std::fs::write(&log_file, "log").unwrap();
        std::fs::write(&session_wal, "wal").unwrap();
        std::fs::write(&summary_wal, "summary").unwrap();

        let sources = vec![vec![
            WatchRoot::shallow(profiles.clone()),
            WatchRoot::recursive(conversations.clone()),
            WatchRoot::recursive(acp.join("conversation_summaries.db")),
            WatchRoot::recursive(acp.join("history.jsonl")),
        ]];
        let calls = std::sync::Mutex::new(Vec::<Option<Vec<PathBuf>>>::new());
        let record = |_: usize, paths: Option<Vec<PathBuf>>| {
            calls.lock().unwrap().push(paths);
        };
        let take = |event: &notify::Event| {
            dispatch(&sources, event, &record);
            std::mem::take(&mut *calls.lock().unwrap())
        };

        // Unrelated nested files and directory mtime/metadata updates (including watch roots
        // and direct shallow children) must never dispatch.
        for kind in [
            EventKind::Modify(notify::event::ModifyKind::Data(
                notify::event::DataChange::Any,
            )),
            EventKind::Modify(notify::event::ModifyKind::Metadata(
                notify::event::MetadataKind::WriteTime,
            )),
        ] {
            assert!(
                take(
                    &notify::Event::new(kind)
                        .add_path(brain_output.clone())
                        .add_path(log_file.clone())
                        .add_path(acp.join("jetbox_summaries_proto.pb"))
                        .add_path(acp.clone())
                        .add_path(profile.clone())
                        .add_path(profiles.clone())
                        .add_path(conversations.clone())
                )
                .is_empty()
            );
        }

        // Creating a new direct child profile triggers reconciliation and dispatch.
        let new_profile = profiles.join("account-b");
        assert_eq!(
            take(
                &notify::Event::new(EventKind::Create(notify::event::CreateKind::Folder))
                    .add_path(new_profile.clone())
            ),
            vec![Some(vec![new_profile])]
        );

        // Removing an ancestor directory still dispatches the affected child roots.
        assert!(
            !take(
                &notify::Event::new(EventKind::Remove(notify::event::RemoveKind::Folder))
                    .add_path(acp.clone())
            )
            .is_empty()
        );

        // Session WAL and summary WAL dispatch targeted paths.
        assert_eq!(
            take(
                &notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Any,
                )))
                .add_path(session_wal.clone())
            ),
            vec![Some(vec![session_wal])]
        );
        assert_eq!(
            take(
                &notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Data(
                    notify::event::DataChange::Any,
                )))
                .add_path(summary_wal.clone())
            ),
            vec![Some(vec![normalize_watch_path(&summary_wal)])]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_snapshot_skips_shm_and_suppresses_directory_data_modifications() {
        let temp = tempfile::tempdir().unwrap();
        let profiles = temp.path().join("profiles");
        let acp = profiles.join("account-a/antigravity-acp");
        let conversations = acp.join("conversations");
        let brain = acp.join("brain/steps/0");
        std::fs::create_dir_all(&conversations).unwrap();
        std::fs::create_dir_all(&brain).unwrap();
        let db = conversations.join("s1.db");
        let shm = conversations.join("s1.db-shm");
        let brain_file = brain.join("output.txt");
        std::fs::write(&db, "v1").unwrap();
        std::fs::write(&shm, "shm").unwrap();
        std::fs::write(&brain_file, "noise").unwrap();

        let mut watched = std::collections::BTreeMap::new();
        watched.insert(normalize_watch_path(&profiles), RecursiveMode::NonRecursive);
        watched.insert(normalize_watch_path(&acp), RecursiveMode::NonRecursive);
        watched.insert(
            normalize_watch_path(&conversations),
            RecursiveMode::Recursive,
        );

        let mut before = metadata_snapshot(&watched);
        assert!(before.contains_key(&normalize_watch_path(&db)));
        assert!(!before.contains_key(&normalize_watch_path(&shm)));
        assert!(!before.contains_key(&normalize_watch_path(&brain_file)));

        // Touching a directory mtime via an ignored sibling file must not emit Modify(Data) for the dir.
        std::fs::write(conversations.join("tmp.db-shm"), "shm").unwrap();
        let after = metadata_snapshot(&watched);
        let events = snapshot_changes(&before, &after);
        let modified: Vec<_> = events
            .iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();
        assert!(!modified.contains(&&normalize_watch_path(&conversations)));

        // Updating a real file still triggers Modify(Data) via refresh_recent.
        std::fs::write(&db, "v2-longer").unwrap();
        let recent = refresh_recent(&mut before, Vec::new());
        let recent_modified: Vec<_> = recent
            .iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();
        assert_eq!(recent_modified, vec![&normalize_watch_path(&db)]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_refresh_recent_polls_cold_sqlite_files_while_skipping_cold_jsonl() {
        let temp = tempfile::tempdir().unwrap();
        let db = temp.path().join("session.db");
        let sqlite = temp.path().join("state.sqlite");
        let vscdb = temp.path().join("workspace.vscdb");
        let wal = temp.path().join("session.db-wal");
        let journal = temp.path().join("state.sqlite-journal");
        let cold_jsonl = temp.path().join("cold.jsonl");

        let cold_time = std::time::SystemTime::now() - HOT_FILE_WINDOW - Duration::from_secs(60);
        for path in [&db, &sqlite, &vscdb, &wal, &journal, &cold_jsonl] {
            std::fs::write(path, "v1").unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(cold_time)
                .unwrap();
        }

        let mut watched = std::collections::BTreeMap::new();
        watched.insert(normalize_watch_path(temp.path()), RecursiveMode::Recursive);
        let mut known = metadata_snapshot(&watched);

        for path in [&db, &sqlite, &vscdb, &wal, &journal, &cold_jsonl] {
            std::fs::write(path, "v2-updated").unwrap();
        }

        let events = refresh_recent(&mut known, Vec::new());
        let modified: std::collections::BTreeSet<PathBuf> = events
            .into_iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();

        for expected in [&db, &sqlite, &vscdb, &wal, &journal] {
            assert!(
                modified.contains(&normalize_watch_path(expected)),
                "expected cold SQLite file {} to be polled",
                expected.display()
            );
        }
        assert!(
            !modified.contains(&normalize_watch_path(&cold_jsonl)),
            "cold jsonl should be skipped between full polls"
        );

        // Newly created -wal sidecars fed via `created` are tracked and polled on later writes.
        let new_wal = temp.path().join("workspace.vscdb-wal");
        std::fs::write(&new_wal, "wal-v1").unwrap();
        let canonical_new_wal = normalize_watch_path(&new_wal);
        let _ = refresh_recent(&mut known, vec![canonical_new_wal.clone()]);
        assert!(known.contains_key(&canonical_new_wal));
        std::fs::write(&new_wal, "wal-v2-longer").unwrap();
        let events = refresh_recent(&mut known, Vec::new());
        let modified: Vec<PathBuf> = events
            .into_iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();
        assert_eq!(modified, vec![canonical_new_wal]);
    }

    #[tokio::test]
    async fn dynamic_watch_roots_discover_new_profiles_without_watching_siblings() {
        let temp = tempfile::tempdir().unwrap();
        let env = crate::discovery::PathEnvironment {
            home: temp.path().to_path_buf(),
            cwd: temp.path().to_path_buf(),
            platform: "darwin".into(),
            variables: std::collections::HashMap::new(),
        };
        let antigravity = env.source("antigravity-cli").unwrap();
        let profiles = antigravity.antigravity_profiles.clone().unwrap();
        std::fs::create_dir_all(&profiles).unwrap();
        let codex_sessions = temp.path().join("codex-sessions");
        std::fs::create_dir_all(&codex_sessions).unwrap();
        std::fs::write(codex_sessions.join("existing.jsonl"), "{}\n").unwrap();

        let events = Arc::new(std::sync::Mutex::new(
            Vec::<(usize, Option<Vec<PathBuf>>)>::new(),
        ));
        let recorded = events.clone();
        let (stop, shutdown) = watch::channel(false);
        watch_paths(
            vec![
                antigravity.watch_spec(),
                WatchRoots::from(vec![codex_sessions.clone()]),
            ],
            Arc::new(move |index, paths| {
                recorded.lock().unwrap().push((index, paths));
            }),
            shutdown,
        )
        .unwrap();

        let new_acp = profiles.join("account-new/antigravity-acp");
        let new_conversations = new_acp.join("conversations");
        let new_brain = new_acp.join("brain/session");
        std::fs::create_dir_all(&new_conversations).unwrap();
        std::fs::create_dir_all(&new_brain).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|(index, paths)| *index == 0 && paths.is_none())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            events
                .lock()
                .unwrap()
                .iter()
                .any(|(index, paths)| *index == 0 && paths.is_none()),
            "expected dynamic profile creation to reconcile and request a full refresh"
        );
        events.lock().unwrap().clear();

        // Writes under brain/ must not trigger any events, while a .db write under conversations/ must.
        std::fs::write(new_brain.join("output.txt"), "unrelated").unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(
            events.lock().unwrap().is_empty(),
            "unexpected events for brain/: {:?}",
            *events.lock().unwrap()
        );

        let session_db = new_conversations.join("live.db");
        std::fs::write(&session_db, "sqlite").unwrap();
        let canonical_db = normalize_watch_path(&session_db);
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let saw_db = events.lock().unwrap().iter().any(|(index, entry)| {
                *index == 0
                    && entry.as_ref().is_some_and(|paths| {
                        paths
                            .iter()
                            .any(|path| normalize_watch_path(path) == canonical_db)
                    })
            });
            if saw_db {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            events.lock().unwrap().iter().any(|(index, entry)| {
                *index == 0
                    && entry.as_ref().is_some_and(|paths| {
                        paths
                            .iter()
                            .any(|path| normalize_watch_path(path) == canonical_db)
                    })
            }),
            "expected newly discovered profile conversations/ write to dispatch: {:?}",
            *events.lock().unwrap()
        );
        #[cfg(target_os = "macos")]
        tokio::time::sleep(Duration::from_millis(2200)).await;
        assert!(
            events.lock().unwrap().iter().all(|(index, _)| *index == 0),
            "profile change must not emit spurious events for untouched sibling sources: {:?}",
            *events.lock().unwrap()
        );
        let _ = stop.send(true);
    }
}
