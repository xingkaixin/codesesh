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
    pub(crate) poll_sqlite: bool,
}

impl WatchRoot {
    pub fn recursive(path: PathBuf) -> Self {
        Self {
            path,
            recursive: true,
            poll_sqlite: false,
        }
    }

    pub fn shallow(path: PathBuf) -> Self {
        Self {
            path,
            recursive: false,
            poll_sqlite: false,
        }
    }

    pub(crate) fn with_sqlite_polling(mut self) -> Self {
        self.poll_sqlite = true;
        self
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
    literal: PathBuf,
    symlink_ancestors: Vec<PathBuf>,
}

impl NormalizedWatchRoot {
    fn new(root: WatchRoot) -> Self {
        let canonical = normalize_watch_path(&root.path);
        let literal = normalize_link_path(&root.path);
        let mut symlink_ancestors = Vec::new();
        let mut ancestor = root.path.parent();
        while let Some(path) = ancestor {
            if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
                symlink_ancestors.push(normalize_link_path(path));
            }
            ancestor = path.parent();
        }
        Self {
            root,
            canonical,
            literal,
            symlink_ancestors,
        }
    }

    fn matches_structural_path(&self, normalized: &Path, literal: &Path) -> bool {
        self.canonical.starts_with(normalized)
            || self.literal.starts_with(literal)
            || self
                .symlink_ancestors
                .iter()
                .any(|ancestor| ancestor == literal)
            || (!self.root.recursive
                && (normalized
                    .strip_prefix(&self.canonical)
                    .is_ok_and(|suffix| suffix.components().count() <= 1)
                    || literal
                        .strip_prefix(&self.literal)
                        .is_ok_and(|suffix| suffix.components().count() <= 1)))
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
    #[cfg(target_os = "macos")]
    let mut poll_scope = poll_scope_for_sources(&initial_sources);
    let shared_sources = Arc::new(std::sync::Mutex::new(Arc::new(initial_sources)));
    let handler_sources = shared_sources.clone();
    let (reconcile, mut changes) = watch::channel(0_u64);
    let reset_watches = Arc::new(AtomicBool::new(false));
    let reset_requested = reset_watches.clone();
    #[cfg(target_os = "macos")]
    let touched = Arc::new(std::sync::Mutex::new(
        std::collections::HashSet::<PathBuf>::new(),
    ));
    #[cfg(target_os = "macos")]
    let touched_by_events = touched.clone();
    let dispatch_change = on_change.clone();
    let handle_event = move |event: notify::Result<notify::Event>, from_poll: bool| match event {
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
            if !from_poll
                && !normalized_paths.is_empty()
                && matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any
                )
                && let Ok(mut touched) = touched_by_events.lock()
            {
                // Native FSEvents wake cold files so subsequent open-handle appends enter fast polling.
                touched.extend(normalized_paths.iter().cloned());
            }
            #[cfg(not(target_os = "macos"))]
            let _ = from_poll;
            let current = handler_sources
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let literal_paths = (!is_data_or_metadata_modify(event.kind)).then(|| {
                non_shm
                    .iter()
                    .map(|path| normalize_link_path(path))
                    .collect::<Vec<_>>()
            });
            let literal_slice = literal_paths.as_deref().unwrap_or(&[]);
            let reset = needs_watch_reset(&current, &event, &normalized_paths, literal_slice);
            if reset {
                reset_requested.store(true, Ordering::Release);
            }
            if reset || needs_reconcile(&current, &event, &normalized_paths, literal_slice) {
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
    let native_handler = handle_event.clone();
    let mut watcher = notify::recommended_watcher(move |event| native_handler(event, false))?;
    let mut watched = std::collections::BTreeMap::new();
    let _ = reconcile_watches(&mut watcher, &initial_roots, &mut watched, true)?;
    let registration = started.elapsed();
    let started = Instant::now();
    #[cfg(target_os = "macos")]
    let mut poll_roots = required_watch_targets(&initial_roots);
    #[cfg(target_os = "macos")]
    let mut observed = metadata_snapshot(&poll_roots);
    #[cfg(target_os = "macos")]
    let mut ticks = 0_u32;
    #[cfg(target_os = "macos")]
    let mut force_full_poll = false;
    #[cfg(target_os = "macos")]
    let mut reconcile_pending = false;
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
                        if reconcile_pending {
                            let current = (**shared_sources
                                .lock()
                                .unwrap_or_else(|poisoned| poisoned.into_inner()))
                                .clone();
                            let roots: Vec<NormalizedWatchRoot> =
                                current.iter().flatten().cloned().collect();
                            let retry_handler = handle_event.clone();
                            if let Ok(mut rebuilt) =
                                notify::recommended_watcher(move |event| retry_handler(event, false))
                            {
                                let mut rebuilt_watched = std::collections::BTreeMap::new();
                                if reconcile_watches(&mut rebuilt, &roots, &mut rebuilt_watched, false)
                                    .is_ok()
                                {
                                    watcher = rebuilt;
                                    watched = rebuilt_watched;
                                    reconcile_pending = false;
                                    force_full_poll = true;
                                }
                            }
                        }
                        let paths = poll_roots.clone();
                        let mut known = std::mem::take(&mut observed);
                        let touched = touched.lock().map(|mut touched| std::mem::take(&mut *touched)).unwrap_or_default();
                        let poll_targets = poll_scope.clone();
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
                                refresh_recent(&mut known, touched, &poll_targets)
                            };
                            (known, events)
                        }).await {
                            for (kind, paths) in events {
                                if !paths.is_empty() {
                                    handle_event(Ok(notify::Event { kind, paths, attrs: Default::default() }), true);
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
                            if next != current[index] {
                                changed_sources.push(index);
                                current[index] = next;
                                updated_sources = true;
                            }
                        } else {
                            let mut target_changed = false;
                            for entry in &mut current[index] {
                                let next = NormalizedWatchRoot::new(entry.root.clone());
                                if next != *entry {
                                    if next.canonical != entry.canonical {
                                        target_changed = true;
                                    }
                                    *entry = next;
                                    updated_sources = true;
                                }
                            }
                            if target_changed {
                                changed_sources.push(index);
                            }
                        }
                    }
                    if updated_sources {
                        *shared_sources
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Arc::new(current.clone());
                    }
                    let did_reset = reset_watches.swap(false, Ordering::AcqRel);
                    if did_reset {
                        for path in watched.keys() { let _ = watcher.unwatch(path); }
                        watched.clear();
                    }
                    let roots: Vec<NormalizedWatchRoot> = current.iter().flatten().cloned().collect();
                    let expanded = match reconcile_watches(&mut watcher, &roots, &mut watched, true) {
                        Ok(expanded) => {
                            #[cfg(target_os = "macos")]
                            {
                                reconcile_pending = false;
                            }
                            expanded
                        }
                        Err(_) => {
                            // Only swap in a rebuilt watcher if required watches succeed, so an
                            // exhausted Linux inotify quota never drops existing watches.
                            let retry_handler = handle_event.clone();
                            let recovered = notify::recommended_watcher(move |event| {
                                retry_handler(event, false)
                            })
                            .ok()
                            .and_then(|mut rebuilt| {
                                let mut rebuilt_watched = std::collections::BTreeMap::new();
                                reconcile_watches(&mut rebuilt, &roots, &mut rebuilt_watched, false)
                                    .ok()
                                    .map(|_| (rebuilt, rebuilt_watched))
                            });
                            if let Some((rebuilt, rebuilt_watched)) = recovered {
                                watcher = rebuilt;
                                watched = rebuilt_watched;
                                #[cfg(target_os = "macos")]
                                {
                                    reconcile_pending = false;
                                }
                            } else {
                                #[cfg(target_os = "macos")]
                                {
                                    reconcile_pending = true;
                                }
                            }
                            true
                        }
                    };
                    #[cfg(target_os = "macos")]
                    {
                        poll_roots = required_watch_targets(&roots);
                        if updated_sources || expanded {
                            poll_scope = poll_scope_for_sources(&current);
                        }
                        if !changed_sources.is_empty() || expanded || did_reset {
                            force_full_poll = true;
                        }
                    }
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
    literal_paths: &[PathBuf],
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
    normalized_paths
        .iter()
        .zip(literal_paths)
        .any(|(path, literal)| {
            let is_dir = folder_removed || path.is_dir();
            sources.iter().flatten().any(|entry| {
                entry.matches_structural_path(path, literal)
                    || (is_dir && entry.root.recursive && path.starts_with(&entry.canonical))
            })
        })
}

fn needs_reconcile(
    sources: &[Vec<NormalizedWatchRoot>],
    event: &notify::Event,
    normalized_paths: &[PathBuf],
    literal_paths: &[PathBuf],
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
    normalized_paths
        .iter()
        .zip(literal_paths)
        .any(|(path, literal)| {
            sources
                .iter()
                .flatten()
                .any(|entry| entry.matches_structural_path(path, literal))
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

fn normalize_link_path(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => normalize_watch_path(parent).join(name),
        _ => normalize_watch_path(path),
    }
}

#[cfg(target_os = "macos")]
fn required_watch_targets(
    roots: &[NormalizedWatchRoot],
) -> std::collections::BTreeMap<PathBuf, RecursiveMode> {
    let mut required = std::collections::BTreeMap::new();
    for entry in roots {
        let root = &entry.root;
        if root.path.is_dir() {
            if root.recursive {
                required.insert(entry.canonical.clone(), RecursiveMode::Recursive);
            } else {
                required
                    .entry(entry.canonical.clone())
                    .or_insert(RecursiveMode::NonRecursive);
            }
            if let Some(parent) = root.path.parent() {
                required
                    .entry(normalize_watch_path(parent))
                    .or_insert(RecursiveMode::NonRecursive);
            }
        } else if let Ok(existing) = existing_watch_root(&root.path) {
            required
                .entry(normalize_watch_path(&existing))
                .or_insert(RecursiveMode::NonRecursive);
        }
    }
    required
}

fn reconcile_watches(
    watcher: &mut notify::RecommendedWatcher,
    roots: &[NormalizedWatchRoot],
    watched: &mut std::collections::BTreeMap<PathBuf, RecursiveMode>,
    include_optional: bool,
) -> Result<bool> {
    let mut required = std::collections::BTreeMap::new();
    let mut optional = std::collections::BTreeSet::new();
    for entry in roots {
        let root = &entry.root;
        if root.path.is_dir() {
            if root.recursive {
                required.insert(entry.canonical.clone(), RecursiveMode::Recursive);
            } else {
                required
                    .entry(entry.canonical.clone())
                    .or_insert(RecursiveMode::NonRecursive);
            }
            if let Some(parent) = root.path.parent() {
                required
                    .entry(normalize_watch_path(parent))
                    .or_insert(RecursiveMode::NonRecursive);
            }
        } else {
            required
                .entry(normalize_watch_path(&existing_watch_root(&root.path)?))
                .or_insert(RecursiveMode::NonRecursive);
        }
        // Best-effort watch on parents of symlinked ancestors (e.g. CODEX_HOME symlink) so
        // retargeting reconciles without failing startup when a traverse-only parent returns EACCES.
        if include_optional {
            for ancestor in &entry.symlink_ancestors {
                if let Some(parent) = ancestor.parent()
                    && parent.parent().is_some()
                {
                    optional.insert(normalize_watch_path(parent));
                }
            }
        }
    }
    optional.retain(|path| !required.contains_key(path));
    watched.retain(|path, mode| {
        let keep = required.get(path) == Some(mode)
            || (optional.contains(path) && *mode == RecursiveMode::NonRecursive);
        if keep {
            true
        } else {
            let _ = watcher.unwatch(path);
            false
        }
    });
    let mut expanded = false;
    for (path, mode) in required {
        if let std::collections::btree_map::Entry::Vacant(entry) = watched.entry(path) {
            watcher
                .watch(entry.key(), mode)
                .with_context(|| format!("watch {}", entry.key().display()))?;
            entry.insert(mode);
            expanded = true;
        }
    }
    for path in optional {
        if let std::collections::btree_map::Entry::Vacant(entry) = watched.entry(path) {
            // Skip unreadable/vanished ancestor-symlink parents before touching the watcher so
            // traverse-only dirs do not fail startup, while still propagating backend failures.
            if std::fs::read_dir(entry.key()).is_err() {
                continue;
            }
            match watcher.watch(entry.key(), RecursiveMode::NonRecursive) {
                Ok(()) => {
                    entry.insert(RecursiveMode::NonRecursive);
                    expanded = true;
                }
                #[cfg(not(target_os = "macos"))]
                Err(_) => {}
                #[cfg(target_os = "macos")]
                Err(error) => {
                    return Err(error).with_context(|| format!("watch {}", entry.key().display()));
                }
            }
        }
    }
    Ok(expanded)
}

// FSEvents reports creates promptly but defers writes to open files until close, so live
// rollouts and explicit database/file watch roots are polled. Between full passes every 10
// minutes, only recently modified files, explicit file roots (and SQLite sidecars), and
// natively touched paths are stat'ed.
#[cfg(target_os = "macos")]
const FULL_POLL_TICKS: u32 = 300;
#[cfg(target_os = "macos")]
const HOT_FILE_WINDOW: Duration = Duration::from_secs(10 * 60);

#[cfg(target_os = "macos")]
#[derive(Clone, Default)]
struct PollScope {
    exact_files: std::collections::HashSet<PathBuf>,
    sqlite_dirs: Vec<PathBuf>,
}

#[cfg(target_os = "macos")]
impl PollScope {
    fn includes(&self, path: &Path) -> bool {
        self.exact_files.contains(path)
            || (is_sqlite_dir_file(path)
                && self.sqlite_dirs.iter().any(|dir| path.starts_with(dir)))
    }
}

#[cfg(target_os = "macos")]
fn poll_scope_for_sources(sources: &[Vec<NormalizedWatchRoot>]) -> PollScope {
    let mut scope = PollScope::default();
    for entry in sources.iter().flatten() {
        if entry.root.poll_sqlite {
            scope.sqlite_dirs.push(entry.canonical.clone());
        } else if !entry.canonical.is_dir() {
            scope.exact_files.insert(entry.canonical.clone());
            for suffix in ["-wal", "-journal"] {
                let mut sidecar = entry.canonical.as_os_str().to_os_string();
                sidecar.push(suffix);
                scope.exact_files.insert(PathBuf::from(sidecar));
            }
        }
    }
    scope
}

#[cfg(target_os = "macos")]
fn is_sqlite_dir_file(path: &Path) -> bool {
    path.file_name().is_some_and(|name| {
        let name = name.to_string_lossy();
        name.ends_with(".db")
            || name.ends_with(".db-wal")
            || name.ends_with(".db-journal")
            || name.ends_with(".vscdb")
            || name.ends_with(".vscdb-wal")
            || name.ends_with(".vscdb-journal")
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
    touched: std::collections::HashSet<PathBuf>,
    poll_scope: &PollScope,
) -> PollEvents {
    for path in &touched {
        if !known.contains_key(path)
            && let Ok(metadata) = std::fs::symlink_metadata(path)
        {
            known.insert(path.clone(), FileStamp::new(&metadata));
        }
    }
    let mut created = Vec::new();
    for path in &poll_scope.exact_files {
        if !known.contains_key(path)
            && let Ok(metadata) = std::fs::symlink_metadata(path)
            && !metadata.is_dir()
        {
            known.insert(path.clone(), FileStamp::new(&metadata));
            created.push(path.clone());
        }
    }
    let hot_since = std::time::SystemTime::now() - HOT_FILE_WINDOW;
    let mut modified = Vec::new();
    let mut removed = Vec::new();
    for (path, stamp) in known.iter_mut().filter(|(path, stamp)| {
        !stamp.is_dir
            && (poll_scope.includes(path)
                || touched.contains(*path)
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
        let normalize = |event: &notify::Event| -> (Vec<PathBuf>, Vec<PathBuf>) {
            let non_shm: Vec<PathBuf> = event
                .paths
                .iter()
                .filter(|path| !is_shm(path))
                .cloned()
                .collect();
            let normalized = non_shm
                .iter()
                .map(|path| normalize_watch_path(path))
                .collect();
            let literal = non_shm
                .iter()
                .map(|path| normalize_link_path(path))
                .collect();
            (normalized, literal)
        };

        let atomic_rename = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::Both,
        )))
        .add_path(tmp_file)
        .add_path(transcript);
        let (norm, lit) = normalize(&atomic_rename);
        assert!(!needs_watch_reset(&sources, &atomic_rename, &norm, &lit));

        let journal_removed = notify::Event::new(EventKind::Remove(notify::event::RemoveKind::Any))
            .add_path(PathBuf::from(format!("{}-journal", db.display())));
        let (norm, lit) = normalize(&journal_removed);
        assert!(!needs_watch_reset(&sources, &journal_removed, &norm, &lit));

        // Renaming or removing an unrelated sibling directory or -shm file must not reset or reconcile.
        let sibling_renamed = notify::Event::new(EventKind::Modify(
            notify::event::ModifyKind::Name(notify::event::RenameMode::To),
        ))
        .add_path(sibling_dir.clone());
        let (sibling_norm, sibling_lit) = normalize(&sibling_renamed);
        assert!(!needs_watch_reset(
            &sources,
            &sibling_renamed,
            &sibling_norm,
            &sibling_lit
        ));
        assert!(!needs_reconcile(
            &sources,
            &sibling_renamed,
            &sibling_norm,
            &sibling_lit
        ));

        let shm_created = notify::Event::new(EventKind::Create(notify::event::CreateKind::File))
            .add_path(PathBuf::from(format!("{}-shm", db.display())));
        let (shm_norm, shm_lit) = normalize(&shm_created);
        assert!(!needs_watch_reset(
            &sources,
            &shm_created,
            &shm_norm,
            &shm_lit
        ));
        assert!(!needs_reconcile(
            &sources,
            &shm_created,
            &shm_norm,
            &shm_lit
        ));

        let dir_rename = notify::Event::new(EventKind::Modify(notify::event::ModifyKind::Name(
            notify::event::RenameMode::To,
        )))
        .add_path(subdir);
        let (norm, lit) = normalize(&dir_rename);
        assert!(needs_watch_reset(&sources, &dir_rename, &norm, &lit));

        let root_removed = notify::Event::new(EventKind::Remove(notify::event::RemoveKind::Any))
            .add_path(sessions);
        let (norm, lit) = normalize(&root_removed);
        assert!(needs_watch_reset(&sources, &root_removed, &norm, &lit));

        let ancestor_renamed = notify::Event::new(EventKind::Modify(
            notify::event::ModifyKind::Name(notify::event::RenameMode::Any),
        ))
        .add_path(db.parent().unwrap().to_path_buf());
        let (norm, lit) = normalize(&ancestor_renamed);
        assert!(needs_watch_reset(&sources, &ancestor_renamed, &norm, &lit));
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
        let recent = refresh_recent(
            &mut before,
            std::collections::HashSet::new(),
            &PollScope::default(),
        );
        let recent_modified: Vec<_> = recent
            .iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();
        assert_eq!(recent_modified, vec![&normalize_watch_path(&db)]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_refresh_recent_polls_explicit_roots_sqlite_dirs_and_touched_files_while_skipping_cold_other_dirs()
     {
        let temp = tempfile::tempdir().unwrap();
        let custom_db = temp.path().join("opencode_store");
        let custom_wal = temp.path().join("opencode_store-wal");
        let ag_dir = temp.path().join("conversations");
        let cursor_ws = temp.path().join("workspaceStorage/w1");
        let plain_dir = temp.path().join("sessions");
        std::fs::create_dir_all(&ag_dir).unwrap();
        std::fs::create_dir_all(&cursor_ws).unwrap();
        std::fs::create_dir_all(&plain_dir).unwrap();
        let ag_db = ag_dir.join("conv.db");
        let ag_wal = ag_dir.join("conv.db-wal");
        let cursor_db = cursor_ws.join("state.vscdb");
        let cursor_wal = cursor_ws.join("state.vscdb-wal");
        let cold_plain_db = plain_dir.join("ignored.db");
        let cold_jsonl = plain_dir.join("cold.jsonl");

        let cold_time = std::time::SystemTime::now() - HOT_FILE_WINDOW - Duration::from_secs(60);
        for path in [
            &custom_db,
            &custom_wal,
            &ag_db,
            &ag_wal,
            &cursor_db,
            &cursor_wal,
            &cold_plain_db,
            &cold_jsonl,
        ] {
            std::fs::write(path, "v1").unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(cold_time)
                .unwrap();
        }

        let sources = normalize_watch_sources(&[vec![
            WatchRoot::recursive(custom_db.clone()),
            WatchRoot::recursive(ag_dir.clone()).with_sqlite_polling(),
            WatchRoot::recursive(temp.path().join("workspaceStorage")).with_sqlite_polling(),
            WatchRoot::recursive(plain_dir.clone()),
        ]]);
        let poll_scope = poll_scope_for_sources(&sources);

        let mut watched = std::collections::BTreeMap::new();
        watched.insert(
            normalize_watch_path(temp.path()),
            RecursiveMode::NonRecursive,
        );
        watched.insert(normalize_watch_path(&ag_dir), RecursiveMode::Recursive);
        watched.insert(
            normalize_watch_path(&temp.path().join("workspaceStorage")),
            RecursiveMode::Recursive,
        );
        watched.insert(normalize_watch_path(&plain_dir), RecursiveMode::Recursive);
        let mut known = metadata_snapshot(&watched);

        for path in [
            &custom_db,
            &custom_wal,
            &ag_db,
            &ag_wal,
            &cursor_db,
            &cursor_wal,
            &cold_plain_db,
            &cold_jsonl,
        ] {
            std::fs::write(path, "v2-updated").unwrap();
        }

        let events = refresh_recent(&mut known, std::collections::HashSet::new(), &poll_scope);
        let modified: std::collections::BTreeSet<PathBuf> = events
            .into_iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();

        for expected in [
            &custom_db,
            &custom_wal,
            &ag_db,
            &ag_wal,
            &cursor_db,
            &cursor_wal,
        ] {
            assert!(
                modified.contains(&normalize_watch_path(expected)),
                "expected {} to be polled",
                expected.display()
            );
        }
        assert!(
            !modified.contains(&normalize_watch_path(&cold_plain_db)),
            "cold .db under non-sqlite directory root should be skipped between full polls"
        );
        assert!(
            !modified.contains(&normalize_watch_path(&cold_jsonl)),
            "cold jsonl should be skipped between full polls"
        );

        // A native modify event on a cold jsonl promotes it to hot so later writes are polled.
        let canonical_cold_jsonl = normalize_watch_path(&cold_jsonl);
        let events = refresh_recent(
            &mut known,
            std::collections::HashSet::from([canonical_cold_jsonl.clone()]),
            &poll_scope,
        );
        let modified: Vec<PathBuf> = events
            .into_iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();
        assert_eq!(modified, vec![canonical_cold_jsonl.clone()]);

        std::fs::write(&cold_jsonl, "v3-open-handle-append").unwrap();
        let events = refresh_recent(&mut known, std::collections::HashSet::new(), &poll_scope);
        let modified: Vec<PathBuf> = events
            .into_iter()
            .filter(|(kind, _)| matches!(kind, EventKind::Modify(_)))
            .flat_map(|(_, paths)| paths)
            .collect();
        assert_eq!(modified, vec![canonical_cold_jsonl]);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_static_root_moved_in_with_open_wal_and_symlink_root_changes_are_observed() {
        let temp = tempfile::tempdir().unwrap();
        let watched_dir = temp.path().join("watched");
        let moved_root = watched_dir.join("db-dir");
        let staging_dir = temp.path().join("staging-db");
        let symlink_root = watched_dir.join("linked-sessions");
        let ancestor_parent = temp.path().join("isolated-codex-parent");
        let ancestor_link = ancestor_parent.join("codex-home");
        let ancestor_sessions = ancestor_link.join("sessions");
        let target_a = temp.path().join("target-a");
        let target_b = temp.path().join("target-b");
        let home_a = temp.path().join("home-a");
        let home_b = temp.path().join("home-b");
        let ag_conversations = watched_dir.join("conversations");
        std::fs::create_dir_all(&watched_dir).unwrap();
        std::fs::create_dir_all(&ancestor_parent).unwrap();
        std::fs::create_dir_all(&staging_dir).unwrap();
        std::fs::create_dir_all(&target_a).unwrap();
        std::fs::create_dir_all(&target_b).unwrap();
        std::fs::create_dir_all(home_a.join("sessions")).unwrap();
        std::fs::create_dir_all(home_b.join("sessions")).unwrap();
        std::fs::create_dir_all(&ag_conversations).unwrap();
        std::os::unix::fs::symlink(&home_a, &ancestor_link).unwrap();

        let staging_db = staging_dir.join("app.db");
        let conn = rusqlite::Connection::open(&staging_db).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, val TEXT)", [])
            .unwrap();
        conn.execute("INSERT INTO items (val) VALUES ('initial')", [])
            .unwrap();

        // Prepare a cold Antigravity DB + WAL kept open across watcher startup.
        let cold_ag_db = ag_conversations.join("cold.db");
        let cold_conn = rusqlite::Connection::open(&cold_ag_db).unwrap();
        cold_conn
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        cold_conn
            .execute("CREATE TABLE steps (id INTEGER PRIMARY KEY, val TEXT)", [])
            .unwrap();
        cold_conn
            .execute("INSERT INTO steps (val) VALUES ('init')", [])
            .unwrap();
        let cold_time = std::time::SystemTime::now() - HOT_FILE_WINDOW - Duration::from_secs(60);
        for path in [
            cold_ag_db.clone(),
            PathBuf::from(format!("{}-wal", cold_ag_db.display())),
        ] {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_modified(cold_time)
                .unwrap();
        }

        let events = Arc::new(std::sync::Mutex::new(
            Vec::<(usize, Option<Vec<PathBuf>>)>::new(),
        ));
        let recorded = events.clone();
        let (stop, shutdown) = watch::channel(false);
        watch_paths(
            vec![
                WatchRoots::from(vec![moved_root.clone()]),
                WatchRoots::from(vec![symlink_root.clone()]),
                WatchRoots::from(vec![ancestor_sessions.clone()]),
                WatchRoots::Static(vec![
                    WatchRoot::recursive(ag_conversations.clone()).with_sqlite_polling(),
                ]),
            ],
            Arc::new(move |index, paths| {
                recorded.lock().unwrap().push((index, paths));
            }),
            shutdown,
        )
        .unwrap();

        // Commit to cold Antigravity WAL while keeping connection open.
        cold_conn
            .execute("INSERT INTO steps (val) VALUES ('cold-commit')", [])
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events.lock().unwrap().iter().any(|(index, _)| *index == 3) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            events.lock().unwrap().iter().any(|(index, _)| *index == 3),
            "expected open-handle commit to cold Antigravity WAL to emit callback"
        );
        drop(cold_conn);
        events.lock().unwrap().clear();

        // Retarget symlinked ancestor (CODEX_HOME) in an isolated parent and verify home_b/sessions is observed.
        let ancestor_tmp = ancestor_parent.join("codex-home.tmp");
        std::os::unix::fs::symlink(&home_b, &ancestor_tmp).unwrap();
        std::fs::rename(&ancestor_tmp, &ancestor_link).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|(index, paths)| *index == 2 && paths.is_none())
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
                .any(|(index, paths)| *index == 2 && paths.is_none()),
            "expected retargeting ancestor symlink to trigger refresh"
        );
        events.lock().unwrap().clear();
        std::fs::write(home_b.join("sessions/switched.jsonl"), "{}\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events.lock().unwrap().iter().any(|(index, _)| *index == 2) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            events.lock().unwrap().iter().any(|(index, _)| *index == 2),
            "expected file in switched ancestor symlink target to be observed"
        );
        events.lock().unwrap().clear();

        // Move a directory with an open SQLite DB + WAL into a static watch root.
        std::fs::rename(&staging_dir, &moved_root).unwrap();
        tokio::time::sleep(Duration::from_millis(2500)).await;
        events.lock().unwrap().clear();

        for step in ["commit-1", "commit-2"] {
            conn.execute("INSERT INTO items (val) VALUES (?1)", [step])
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if events.lock().unwrap().iter().any(|(index, _)| *index == 0) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(
                events.lock().unwrap().iter().any(|(index, _)| *index == 0),
                "expected open-handle WAL {step} to emit callback for moved-in static root"
            );
            events.lock().unwrap().clear();
        }
        drop(conn);

        // Create symlink at watch root and verify writes inside target_a are observed.
        std::os::unix::fs::symlink(&target_a, &symlink_root).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|(index, paths)| *index == 1 && paths.is_none())
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
                .any(|(index, paths)| *index == 1 && paths.is_none()),
            "expected creating symlink watch root to trigger refresh"
        );
        events.lock().unwrap().clear();
        std::fs::write(target_a.join("a.jsonl"), "{}\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events.lock().unwrap().iter().any(|(index, _)| *index == 1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            events.lock().unwrap().iter().any(|(index, _)| *index == 1),
            "expected file in symlink target_a to be observed"
        );
        events.lock().unwrap().clear();

        // Replace symlink at watch root to target_b and verify target_b is observed.
        let replacement = watched_dir.join("linked-sessions.tmp");
        std::os::unix::fs::symlink(&target_b, &replacement).unwrap();
        std::fs::rename(&replacement, &symlink_root).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|(index, paths)| *index == 1 && paths.is_none())
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
                .any(|(index, paths)| *index == 1 && paths.is_none()),
            "expected replacing symlink watch root to trigger refresh"
        );
        events.lock().unwrap().clear();
        std::fs::write(target_b.join("b.jsonl"), "{}\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if events.lock().unwrap().iter().any(|(index, _)| *index == 1) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            events.lock().unwrap().iter().any(|(index, _)| *index == 1),
            "expected file in replaced symlink target_b to be observed"
        );
        let _ = stop.send(true);
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
