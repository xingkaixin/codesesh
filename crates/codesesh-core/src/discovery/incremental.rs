use super::{
    AgentSource,
    backfill::{BATCH_SIZE, Backfill, Item, ItemScope, inventory},
    has_sources, scan_source,
};
use crate::{
    agents::{self, ParsedSession, ScanDelta, opencode::DatabaseSnapshot},
    pricing::{Pricing, PricingController},
    runtime,
    storage::Cache,
};
use anyhow::{Result, bail};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

pub struct AgentScanner {
    source: AgentSource,
    cache_path: PathBuf,
    pricing: Arc<Pricing>,
    controller: Option<PricingController>,
    previous: Vec<ParsedSession>,
    durable_references: HashSet<crate::contract::SessionReference>,
    initialized: bool,
    backfill: Option<Backfill>,
    startup_from: Option<f64>,
    startup_to: Option<f64>,
    target: Option<crate::contract::SessionReference>,
    baseline:
        HashMap<crate::contract::SessionReference, (crate::contract::SessionHead, Option<PathBuf>)>,
    rejected: Arc<AtomicBool>,
    cursor: agents::cursor::CursorSync,
    opencode: Option<DatabaseSnapshot>,
    fingerprints: HashMap<String, String>,
    pricing_generation: u64,
}
impl AgentScanner {
    pub fn new(source: AgentSource, cache_path: PathBuf, pricing: Arc<Pricing>) -> Self {
        Self {
            source,
            cache_path,
            pricing,
            controller: None,
            previous: Vec::new(),
            durable_references: HashSet::new(),
            initialized: false,
            backfill: None,
            startup_from: None,
            startup_to: None,
            target: None,
            baseline: HashMap::new(),
            rejected: Arc::new(AtomicBool::new(false)),
            cursor: Default::default(),
            opencode: None,
            fingerprints: HashMap::new(),
            pricing_generation: 0,
        }
    }
    pub fn with_pricing_controller(
        source: AgentSource,
        cache_path: PathBuf,
        controller: PricingController,
    ) -> Result<Self> {
        let ticket = controller.snapshot()?;
        let mut scanner = Self::new(source, cache_path, Arc::new(ticket.pricing));
        scanner.controller = Some(controller);
        Ok(scanner)
    }
    pub fn with_startup_window(mut self, from: Option<f64>, to: Option<f64>) -> Self {
        self.startup_from = from;
        self.startup_to = to;
        self
    }
    pub fn with_target_session(
        mut self,
        target: Option<crate::contract::SessionReference>,
    ) -> Self {
        self.target = target.filter(|target| target.agent_name == self.source.agent);
        self
    }
    pub fn into_runtime_source(self) -> runtime::AgentSource {
        let name = self.source.agent.clone();
        let mut roots = vec![self.source.data_root.clone(), self.source.scan_path.clone()];
        roots.sort();
        roots.dedup();
        let scanner = Mutex::new(self);
        runtime::AgentSource {
            name,
            roots,
            scan: Arc::new(move |request| {
                request.cancellation.check()?;
                let batch = scanner
                    .lock()
                    .map_err(|_| anyhow::anyhow!("agent scanner lock poisoned"))?
                    .refresh_with_checkpoint(
                        request.changed_paths.as_deref(),
                        request.checkpoint.as_ref(),
                    )?;
                request.cancellation.check()?;
                Ok(batch)
            }),
        }
    }
    pub fn refresh(&mut self, paths: Option<&[PathBuf]>) -> Result<runtime::ScanBatch> {
        self.refresh_with_checkpoint(paths, None)
    }
    pub fn refresh_with_checkpoint(
        &mut self,
        paths: Option<&[PathBuf]>,
        checkpoint: Option<&serde_json::Value>,
    ) -> Result<runtime::ScanBatch> {
        let ticket = self
            .controller
            .as_ref()
            .map(PricingController::snapshot)
            .transpose()?;
        let pricing_changed = ticket
            .as_ref()
            .is_some_and(|ticket| ticket.generation() != self.pricing.generation());
        if let Some(ticket) = &ticket {
            self.pricing = Arc::new(ticket.pricing.clone());
        }
        if self.rejected.swap(false, Ordering::AcqRel) || pricing_changed {
            self.initialized = false;
            self.backfill = None;
            self.cursor = Default::default();
            self.opencode = None;
            self.fingerprints.clear();
        }
        if !self.initialized {
            self.restore()?;
        }
        let page_mode =
            self.backfill.is_some() || !self.initialized || paths.is_none() || checkpoint.is_some();
        let (mut delta, next_checkpoint, complete) = if page_mode {
            self.page(paths, checkpoint)?
        } else {
            (self.read(paths)?, None, true)
        };
        for session in &mut delta.upserts {
            agents::complete_projections(session);
        }
        if delta.complete {
            let refs: HashSet<_> = delta
                .upserts
                .iter()
                .map(|session| session.head.reference.clone())
                .collect();
            delta.removed.extend(
                self.durable_references
                    .iter()
                    .filter(|reference| !refs.contains(*reference))
                    .cloned(),
            );
        }
        let removed: HashSet<_> = delta.removed.iter().cloned().collect();
        let changed: HashSet<_> = delta
            .upserts
            .iter()
            .map(|session| session.head.reference.clone())
            .collect();
        self.previous.retain(|session| {
            !removed.contains(&session.head.reference) && !changed.contains(&session.head.reference)
        });
        self.previous.extend(delta.upserts.clone());
        for reference in &removed {
            self.baseline.remove(reference);
        }
        for session in &delta.upserts {
            self.baseline.insert(
                session.head.reference.clone(),
                (session.head.clone(), Some(session.source.clone())),
            );
        }
        self.durable_references = self.baseline.keys().cloned().collect();
        self.initialized = true;
        let rejected = self.rejected.clone();
        Ok(runtime::ScanBatch {
            sessions: delta.upserts,
            removed: removed.into_iter().collect(),
            checkpoint: next_checkpoint,
            pricing: ticket,
            complete,
            on_reject: Some(Box::new(move || {
                rejected.store(true, Ordering::Release);
            })),
        })
    }
    fn page(
        &mut self,
        paths: Option<&[PathBuf]>,
        checkpoint: Option<&serde_json::Value>,
    ) -> Result<(ScanDelta, Option<serde_json::Value>, bool)> {
        let hints = paths.is_some_and(|paths| !paths.is_empty());
        if self.backfill.is_none() {
            let local = self.backfill.as_ref().map(Backfill::checkpoint);
            let saved = checkpoint.or(local.as_ref());
            let mut items = inventory(&self.source)?;
            if let Some(target) = &self.target {
                let known = self
                    .baseline
                    .get(target)
                    .and_then(|(_, source)| source.as_ref());
                let target_key = super::backfill::target_key(&self.source, &target.session_id)?;
                for item in &mut items {
                    item.target = known.is_some_and(|path| item.path.as_ref() == Some(path))
                        || item.key == target_key
                        || item.path.as_ref().is_some_and(|path| {
                            path.file_stem().is_some_and(|name| {
                                name.to_string_lossy().ends_with(&target.session_id)
                            }) || path
                                .file_name()
                                .is_some_and(|name| name == target.session_id.as_str())
                        });
                }
            }
            if items.is_empty()
                && !has_sources(&self.source)?
                && !self.durable_references.is_empty()
            {
                bail!(
                    "Agent {} is unavailable; retaining durable sessions",
                    self.source.agent
                );
            }
            self.backfill = Some(Backfill::new(
                items,
                self.startup_from,
                self.startup_to,
                self.pricing.generation(),
                saved,
                false,
            ));
        }
        if hints {
            self.backfill
                .as_mut()
                .unwrap()
                .dirty
                .extend(paths.unwrap().iter().cloned());
        }
        let plan = self.backfill.as_ref().unwrap();
        if plan.offset > 0
            && !plan.dirty.is_empty()
            && (!plan.refreshed || plan.offset == plan.items.len())
        {
            let changed: Vec<_> = plan.dirty.iter().cloned().collect();
            let delta = self.read_dirty(&changed)?;
            let plan = self.backfill.as_mut().unwrap();
            plan.dirty.clear();
            plan.refreshed = true;
            plan.epoch = plan.epoch.wrapping_add(1);
            let complete = plan.offset == plan.items.len();
            let checkpoint = (!complete).then(|| plan.checkpoint());
            if complete {
                self.backfill = None;
            }
            return Ok((delta, checkpoint, complete));
        }
        let end = (plan.offset + BATCH_SIZE).min(plan.items.len());
        let selected = plan.items[plan.offset..end].to_vec();
        let mut delta = self.read_page(&selected)?;
        let refs: HashSet<_> = delta
            .upserts
            .iter()
            .map(|session| session.head.reference.clone())
            .collect();
        let scope = ItemScope::new(&selected);
        delta.removed.extend(
            self.baseline
                .iter()
                .filter(|(reference, _)| {
                    !refs.contains(*reference) && self.matches_scope(reference, &scope)
                })
                .map(|(reference, _)| reference.clone()),
        );
        self.backfill.as_mut().unwrap().offset = end;
        self.backfill.as_mut().unwrap().refreshed = false;
        let plan = self.backfill.as_ref().unwrap();
        let exhausted = end == plan.items.len();
        let complete = exhausted && plan.dirty.is_empty();
        let checkpoint = (!complete).then(|| plan.checkpoint());
        if exhausted {
            let scope = ItemScope::new(&plan.items);
            delta.removed.extend(
                self.baseline
                    .iter()
                    .filter(|(reference, (_, source))| {
                        source.is_some()
                            && !refs.contains(*reference)
                            && !self.matches_scope(reference, &scope)
                    })
                    .map(|(reference, _)| reference.clone()),
            );
            if complete {
                self.backfill = None;
            }
        }
        delta.complete = false;
        Ok((delta, checkpoint, complete))
    }
    fn matches_scope(
        &self,
        reference: &crate::contract::SessionReference,
        scope: &ItemScope,
    ) -> bool {
        if !scope.paths.is_empty() {
            return self
                .baseline
                .get(reference)
                .and_then(|(_, source)| source.as_ref())
                .is_some_and(|source| scope.paths.contains(source));
        }
        let mut current = Some(reference);
        let mut seen = HashSet::new();
        while let Some(reference) = current {
            if scope.keys.contains(reference.session_id.as_str()) {
                return true;
            }
            if !seen.insert(reference) {
                return false;
            }
            current = self
                .baseline
                .get(reference)
                .and_then(|(head, _)| head.parent_reference.as_ref());
        }
        false
    }
    fn read_dirty(&mut self, paths: &[PathBuf]) -> Result<ScanDelta> {
        let plan = self.backfill.as_ref().unwrap();
        let original: HashSet<_> = plan.items.iter().map(|item| item.key.as_str()).collect();
        let current = inventory(&self.source)?;
        let added: Vec<_> = current
            .iter()
            .filter(|item| !original.contains(item.key.as_str()))
            .cloned()
            .collect();
        if current.iter().all(|item| item.path.is_none())
            && !has_sources(&self.source)?
            && !self.durable_references.is_empty()
        {
            bail!(
                "Agent {} is unavailable; retaining durable sessions",
                self.source.agent
            );
        }
        let eligible: HashSet<_> = plan.items[..plan.offset]
            .iter()
            .chain(
                current
                    .iter()
                    .filter(|item| !original.contains(item.key.as_str())),
            )
            .map(|item| item.key.clone())
            .collect();
        let result = match self.source.agent.as_str() {
            "cursor" => {
                let delta = self.cursor.refresh_selected(
                    &self.source.scan_path,
                    &self.pricing,
                    &eligible,
                )?;
                Ok(ScanDelta {
                    upserts: delta.upserts,
                    removed: delta.removed,
                    complete: false,
                })
            }
            "opencode" | "zcode" => {
                let path = if self.source.agent == "opencode" {
                    self.source.scan_path.clone()
                } else {
                    self.source.scan_path.join("cli/db/db.sqlite")
                };
                let snapshot = agents::opencode::refresh_selected_database(
                    &path,
                    &self.source.agent,
                    self.source.agent == "opencode",
                    &self.pricing,
                    &eligible,
                    self.opencode.as_ref(),
                )?;
                let delta = ScanDelta {
                    upserts: snapshot.upserts.clone(),
                    removed: snapshot.removed.clone(),
                    complete: false,
                };
                self.opencode = Some(snapshot);
                Ok(delta)
            }
            "deepchat" | "cherrystudio" | "minimax-code" => self.desktop_selected(Some(&eligible)),
            _ => {
                let global = paths.iter().any(|path| {
                    self.source.scan_path.starts_with(path)
                        || path.file_name().is_some_and(|name| {
                            matches!(
                                name.to_str(),
                                Some(
                                    "session_index.jsonl"
                                        | "sessions-index.json"
                                        | "kimi.json"
                                        | "config.toml"
                                )
                            )
                        })
                });
                if global {
                    let paths: Vec<_> = current
                        .iter()
                        .filter(|item| eligible.contains(&item.key))
                        .filter_map(|item| item.path.clone())
                        .collect();
                    self.read(Some(&paths))
                } else {
                    self.read(Some(paths))
                }
            }
        };
        let delta = result?;
        self.backfill.as_mut().unwrap().items.extend(added);
        Ok(delta)
    }
    fn read_page(&mut self, selected: &[Item]) -> Result<ScanDelta> {
        if selected.is_empty() {
            return Ok(ScanDelta::default());
        }
        let ids: HashSet<_> = selected.iter().map(|item| item.key.clone()).collect();
        let root = &self.source.scan_path;
        let upserts = match self.source.agent.as_str() {
            "cursor" => self.cursor.scan_selected(root, &self.pricing, &ids)?,
            "opencode" | "zcode" => {
                let path = if self.source.agent == "opencode" {
                    root.clone()
                } else {
                    root.join("cli/db/db.sqlite")
                };
                let snapshot = agents::opencode::scan_selected_snapshot(
                    &path,
                    &self.source.agent,
                    self.source.agent == "opencode",
                    &self.pricing,
                    &ids,
                    self.opencode.as_ref(),
                )?;
                let heads: HashMap<_, _> = snapshot
                    .sessions
                    .iter()
                    .map(|session| (&session.head.reference, &session.head))
                    .collect();
                let upserts = snapshot
                    .sessions
                    .iter()
                    .filter(|session| {
                        let mut reference = Some(&session.head.reference);
                        let mut seen = HashSet::new();
                        while let Some(current) = reference {
                            if ids.contains(&current.session_id) {
                                return true;
                            }
                            if !seen.insert(current) {
                                return false;
                            }
                            reference = heads
                                .get(current)
                                .and_then(|head| head.parent_reference.as_ref());
                        }
                        false
                    })
                    .cloned()
                    .collect();
                self.opencode = Some(snapshot);
                upserts
            }
            "deepchat" | "cherrystudio" | "minimax-code" => {
                let (upserts, fingerprints) = match self.source.agent.as_str() {
                    "deepchat" => agents::deepchat::scan_page(root, &self.pricing, &ids)?,
                    "cherrystudio" => agents::cherrystudio::scan_page(root, &self.pricing, &ids)?,
                    _ => agents::minimax_code::scan_page(root, &self.pricing, &ids)?,
                };
                self.fingerprints.extend(fingerprints);
                self.pricing_generation = self.pricing.generation();
                upserts
            }
            _ => {
                let paths: Vec<_> = selected
                    .iter()
                    .filter_map(|item| item.path.clone())
                    .collect();
                return self.read(Some(&paths));
            }
        };
        Ok(ScanDelta {
            upserts,
            ..Default::default()
        })
    }
    fn restore(&mut self) -> Result<()> {
        self.previous.clear();
        self.durable_references.clear();
        self.baseline.clear();
        if !self.cache_path.exists() {
            return Ok(());
        }
        let cache = Cache::open_read_only(&self.cache_path)?;
        for head in cache
            .snapshot()?
            .into_iter()
            .filter(|head| head.reference.agent_name == self.source.agent)
        {
            self.durable_references.insert(head.reference.clone());
            let source: Option<String> = cache.connection().query_row(
                "SELECT source_path FROM sessions WHERE agent_name=?1 AND session_id=?2",
                [&head.reference.agent_name, &head.reference.session_id],
                |row| row.get(0),
            )?;
            self.baseline.insert(
                head.reference.clone(),
                (head.clone(), source.as_ref().map(PathBuf::from)),
            );
            if let Some(source) = source
                && let Some(detail) = cache.detail(head.clone())?
            {
                self.previous.push(ParsedSession {
                    head,
                    source: source.into(),
                    detail,
                });
            }
        }
        Ok(())
    }
    fn full(&self) -> Result<ScanDelta> {
        let result = scan_source(&self.source, &self.pricing)?;
        if !result.available && (!self.previous.is_empty() || !self.durable_references.is_empty()) {
            bail!(
                "Agent {} is unavailable; retaining durable sessions",
                self.source.agent
            );
        }
        Ok(ScanDelta {
            upserts: result.sessions,
            removed: vec![],
            complete: true,
        })
    }
    fn read(&mut self, paths: Option<&[PathBuf]>) -> Result<ScanDelta> {
        let root = &self.source.scan_path;
        let pricing = &self.pricing;
        match self.source.agent.as_str() {
            "cursor" => {
                if !has_sources(&self.source)?
                    && (!self.previous.is_empty() || !self.durable_references.is_empty())
                {
                    bail!("Cursor database is unavailable");
                }
                let delta = self.cursor.refresh(root, pricing)?;
                Ok(ScanDelta {
                    upserts: delta.upserts,
                    removed: delta.removed,
                    complete: false,
                })
            }
            "opencode" | "zcode" => {
                if !has_sources(&self.source)?
                    && (!self.previous.is_empty() || !self.durable_references.is_empty())
                {
                    bail!("{} database is unavailable", self.source.agent);
                }
                let path = if self.source.agent == "opencode" {
                    root.clone()
                } else {
                    root.join("cli/db/db.sqlite")
                };
                let snapshot = agents::opencode::refresh_database(
                    &path,
                    &self.source.agent,
                    self.source.agent == "opencode",
                    pricing,
                    self.opencode.as_ref(),
                )?;
                let delta = ScanDelta {
                    upserts: snapshot.upserts.clone(),
                    removed: snapshot.removed.clone(),
                    complete: false,
                };
                self.opencode = Some(snapshot);
                Ok(delta)
            }
            "deepchat" | "cherrystudio" | "minimax-code" => self.desktop(),
            "kimi" | "kimi-code" if paths.is_some() => {
                let paths = paths.unwrap();
                let dirs = if self.source.agent == "kimi" {
                    agents::kimi::affected_session_dirs(root, &self.source.data_root, paths)?
                } else {
                    agents::kimi_code::affected_session_dirs(root, paths)?
                };
                let Some(dirs) = dirs else {
                    return self.full();
                };
                let upserts = if self.source.agent == "kimi" {
                    agents::kimi::scan_paths_with_data_root(
                        root,
                        &self.source.data_root,
                        pricing,
                        paths,
                    )?
                } else {
                    agents::kimi_code::scan_paths(root, pricing, paths)?
                };
                Ok(selected_delta(upserts, &self.previous, |session| {
                    dirs.iter().any(|dir| session.source.starts_with(dir))
                }))
            }
            "grok" if paths.is_some() => {
                let paths = paths.unwrap();
                if paths.iter().any(|path| root.starts_with(path)) {
                    return self.full();
                }
                let mut sources = HashSet::new();
                for path in paths {
                    for session in &self.previous {
                        if path.starts_with(session.source.parent().unwrap_or(&session.source))
                            || session.source.starts_with(path)
                        {
                            sources.insert(session.source.clone());
                        }
                    }
                    if path.is_dir() {
                        for entry in walkdir::WalkDir::new(path) {
                            let entry = entry?;
                            if entry.file_type().is_file() && entry.file_name() == "summary.json" {
                                sources.insert(entry.into_path());
                            }
                        }
                    } else if let Some(parent) = path.parent() {
                        let source = parent.join("summary.json");
                        if source.exists()
                            || path.file_name().is_some_and(|name| name == "summary.json")
                        {
                            sources.insert(source);
                        }
                    }
                }
                let paths: Vec<_> = sources.iter().cloned().collect();
                let upserts = agents::grok::scan_paths(root, pricing, &paths)?;
                Ok(selected_delta(upserts, &self.previous, |session| {
                    sources.contains(&session.source)
                }))
            }
            "codex" if paths.is_some() => agents::codex::scan_changed(
                &self.source.data_root,
                pricing,
                paths.unwrap(),
                &self.previous,
            ),
            "claudecode" if paths.is_some() => {
                agents::claudecode::scan_changed(root, pricing, paths.unwrap(), &self.previous)
            }
            "pi" if paths.is_some() => {
                agents::pi::scan_changed(root, pricing, paths.unwrap(), &self.previous)
            }
            "dsh" if paths.is_some() => {
                agents::dsh::scan_changed(root, pricing, paths.unwrap(), &self.previous)
            }
            _ => self.full(),
        }
    }
    fn desktop(&mut self) -> Result<ScanDelta> {
        self.desktop_selected(None)
    }
    fn desktop_selected(&mut self, eligible: Option<&HashSet<String>>) -> Result<ScanDelta> {
        if !has_sources(&self.source)? {
            if self.previous.is_empty() && self.durable_references.is_empty() {
                return Ok(ScanDelta {
                    complete: true,
                    ..Default::default()
                });
            }
            bail!("{} database is unavailable", self.source.agent);
        }
        let root = &self.source.scan_path;
        let current = match self.source.agent.as_str() {
            "deepchat" => agents::deepchat::fingerprints(root)?,
            "cherrystudio" => agents::cherrystudio::fingerprints(root)?,
            _ => agents::minimax_code::fingerprints(root)?,
        };
        let generation = self.pricing.generation();
        let changed: HashSet<_> = current
            .iter()
            .filter(|(id, hash)| {
                eligible.is_none_or(|eligible| eligible.contains(*id))
                    && (self.pricing_generation != generation
                        || self.fingerprints.get(*id) != Some(*hash))
            })
            .map(|(id, _)| id.clone())
            .collect();
        let mut removed: Vec<_> = self
            .previous
            .iter()
            .filter(|session| {
                eligible
                    .is_none_or(|eligible| eligible.contains(&session.head.reference.session_id))
                    && !current.contains_key(&session.head.reference.session_id)
            })
            .map(|session| session.head.reference.clone())
            .collect();
        let upserts = if changed.is_empty() {
            Vec::new()
        } else {
            match self.source.agent.as_str() {
                "deepchat" => agents::deepchat::scan_selected(root, &self.pricing, &changed)?,
                "cherrystudio" => {
                    agents::cherrystudio::scan_selected(root, &self.pricing, &changed)?
                }
                _ => agents::minimax_code::scan_selected(root, &self.pricing, &changed)?,
            }
        };
        let retained: HashSet<_> = upserts
            .iter()
            .map(|session| session.head.reference.clone())
            .collect();
        removed.extend(
            self.previous
                .iter()
                .filter(|session| {
                    changed.contains(&session.head.reference.session_id)
                        && !retained.contains(&session.head.reference)
                })
                .map(|session| session.head.reference.clone()),
        );
        if let Some(eligible) = eligible {
            for id in eligible {
                if let Some(hash) = current.get(id) {
                    self.fingerprints.insert(id.clone(), hash.clone());
                } else {
                    self.fingerprints.remove(id);
                }
            }
        } else {
            self.fingerprints = current;
        }
        self.pricing_generation = generation;
        Ok(ScanDelta {
            upserts,
            removed,
            complete: false,
        })
    }
}
fn selected_delta(
    upserts: Vec<ParsedSession>,
    previous: &[ParsedSession],
    affected: impl Fn(&ParsedSession) -> bool,
) -> ScanDelta {
    let refs: HashSet<_> = upserts
        .iter()
        .map(|session| session.head.reference.clone())
        .collect();
    let removed = previous
        .iter()
        .filter(|session| affected(session) && !refs.contains(&session.head.reference))
        .map(|session| session.head.reference.clone())
        .collect();
    ScanDelta {
        upserts,
        removed,
        complete: false,
    }
}
