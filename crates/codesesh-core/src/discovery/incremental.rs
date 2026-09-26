use super::{
    AgentSource,
    backfill::{BATCH_SIZE, Backfill, Item, ItemScope, inventory},
    has_sources, scan_source,
};
use crate::{
    agents::{self, ParsedSession, ScanDelta, SessionRecord, opencode::DatabaseSnapshot},
    pricing::{PriceDependencies, Pricing, PricingController, capture_dependencies},
    runtime,
    storage::Cache,
};
use anyhow::Result;
use rusqlite::OptionalExtension;
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
    previous: Vec<SessionRecord>,
    durable_references: HashSet<crate::contract::SessionReference>,
    initialized: bool,
    history_complete: bool,
    backfill: Option<Backfill>,
    startup_from: Option<f64>,
    startup_to: Option<f64>,
    target: Option<crate::contract::SessionReference>,
    baseline: HashMap<
        crate::contract::SessionReference,
        (Option<crate::contract::SessionReference>, Option<PathBuf>),
    >,
    rejected: Arc<AtomicBool>,
    cursor: agents::cursor::CursorSync,
    opencode: Option<DatabaseSnapshot>,
    fingerprints: HashMap<String, String>,
    price_dependencies: Option<PriceDependencies>,
    file_fingerprints: HashMap<String, String>,
    empty_sources: HashSet<String>,
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
            history_complete: false,
            backfill: None,
            startup_from: None,
            startup_to: None,
            target: None,
            baseline: HashMap::new(),
            rejected: Arc::new(AtomicBool::new(false)),
            cursor: Default::default(),
            opencode: None,
            fingerprints: HashMap::new(),
            price_dependencies: Some(HashMap::new()),
            file_fingerprints: HashMap::new(),
            empty_sources: HashSet::new(),
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
        let root = &self.source.scan_path;
        let mut roots = match self.source.agent.as_str() {
            "cursor" => vec![
                root.join("globalStorage/state.vscdb"),
                root.join("workspaceStorage"),
            ],
            "deepchat" => vec![root.join("app_db/agent.db")],
            "cherrystudio" => vec![root.join("Data/cherrystudio.sqlite")],
            "minimax-code" => vec![root.join("v2/sqlite/runtime-state.sqlite")],
            "zcode" => vec![root.join("cli/db/db.sqlite")],
            "dsh" => vec![root.join("sessions"), root.join("attachments/v1")],
            "codex" | "kimi-code" => vec![
                root.clone(),
                self.source.data_root.join("session_index.jsonl"),
            ],
            "kimi" => vec![
                root.clone(),
                self.source.data_root.join("kimi.json"),
                self.source.data_root.join("config.toml"),
            ],
            _ => vec![root.clone()],
        };
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
        let pricing_changed = ticket.as_ref().is_some_and(|ticket| {
            ticket.generation() != self.pricing.generation()
                && self
                    .price_dependencies
                    .as_ref()
                    .is_none_or(|dependencies| !ticket.pricing.matches_dependencies(dependencies))
        });
        if let Some(ticket) = &ticket {
            self.pricing = Arc::new(ticket.pricing.clone());
        }
        if self.rejected.swap(false, Ordering::AcqRel) {
            self.initialized = false;
            self.backfill = None;
            self.cursor = Default::default();
            self.opencode = None;
            self.fingerprints.clear();
        }
        if pricing_changed
            || !self.initialized
            || self.baseline.is_empty() && !self.durable_references.is_empty()
        {
            self.restore()?;
        }
        let page_mode =
            self.backfill.is_some() || !self.initialized || paths.is_none() || checkpoint.is_some();
        let (result, dependencies) = capture_dependencies(|| {
            if page_mode {
                self.page(paths, checkpoint)
            } else {
                self.read_live(paths)
            }
        });
        let (mut delta, mut next_checkpoint, complete) = result?;
        if let Some(previous) = &mut self.price_dependencies {
            previous.extend(dependencies);
        }
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
        self.previous
            .extend(delta.upserts.iter().map(SessionRecord::from));
        for reference in &removed {
            self.baseline.remove(reference);
        }
        for session in &delta.upserts {
            self.baseline.insert(
                session.head.reference.clone(),
                (
                    session.head.parent_reference.clone(),
                    Some(session.source.clone()),
                ),
            );
        }
        self.durable_references = self.baseline.keys().cloned().collect();
        self.initialized = true;
        self.empty_sources
            .retain(|key| self.file_fingerprints.contains_key(key));
        if !matches!(self.source.agent.as_str(), "cursor") {
            let checkpoint = next_checkpoint.get_or_insert_with(|| serde_json::json!({}));
            checkpoint["incremental"] = self.history_complete.into();
            checkpoint["sourceState"] = serde_json::json!({
                "version": 1,
                "historyComplete": self.history_complete || complete,
                "parserVersion": agents::parser_version(&self.source.agent),
                "generation": self.pricing.generation(),
                "priceDependencies": self.price_dependencies,
                "root": self.source.scan_path,
                "files": self.file_fingerprints,
                "databaseSessions": self.fingerprints,
                "emptySources": self.empty_sources,
            });
        }
        if page_mode && complete && self.cache_path.is_file() {
            // Release headers interleaved with parsed bodies; the next refresh reloads durable metadata.
            self.previous = Vec::new();
            self.baseline = HashMap::new();
        }
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
            let present: HashSet<_> = items.iter().map(|item| item.key.as_str()).collect();
            self.file_fingerprints
                .retain(|key, _| present.contains(key.as_str()));
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
                return Ok((ScanDelta::default(), None, true));
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
            let dirty = std::mem::take(&mut self.backfill.as_mut().unwrap().dirty);
            let delta = match self.read_dirty() {
                Ok(delta) => delta,
                Err(error) => {
                    self.backfill.as_mut().unwrap().dirty.extend(dirty);
                    return Err(error);
                }
            };
            let plan = self.backfill.as_mut().unwrap();
            plan.refreshed = true;
            plan.epoch = plan.epoch.wrapping_add(1);
            let complete = plan.offset == plan.items.len() && plan.dirty.is_empty();
            let checkpoint = (!complete).then(|| plan.checkpoint());
            if complete {
                self.backfill = None;
            }
            return Ok((delta, checkpoint, complete));
        }
        let offset = plan.offset;
        let items = std::mem::take(&mut self.backfill.as_mut().unwrap().items);
        let result = self.read_page(&items[offset..], true);
        self.backfill.as_mut().unwrap().items = items;
        let (mut delta, reused, consumed) = result?;
        let end = offset + consumed;
        let selected = self.backfill.as_ref().unwrap().items[offset..end].to_vec();
        let refs: HashSet<_> = delta
            .upserts
            .iter()
            .map(|session| session.head.reference.clone())
            .collect();
        let mut refs = refs;
        refs.extend(reused);
        if let Some(snapshot) = &self.opencode {
            refs.extend(
                snapshot
                    .sessions
                    .iter()
                    .map(|session| session.head.reference.clone()),
            );
        }
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
                .and_then(|(parent, _)| parent.as_ref());
        }
        false
    }
    fn read_dirty(&mut self) -> Result<ScanDelta> {
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
            return Ok(ScanDelta::default());
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
                let mut snapshot = agents::opencode::refresh_selected_database(
                    &path,
                    &self.source.agent,
                    self.source.agent == "opencode",
                    &self.pricing,
                    &eligible,
                    self.opencode.as_ref(),
                )?;
                let delta = ScanDelta {
                    upserts: std::mem::take(&mut snapshot.upserts),
                    removed: std::mem::take(&mut snapshot.removed),
                    complete: false,
                };
                snapshot.release_bodies();
                self.opencode = Some(snapshot);
                Ok(delta)
            }
            "deepchat" | "cherrystudio" | "minimax-code" => self.desktop_selected(Some(&eligible)),
            _ => {
                let pending: Vec<_> = current
                    .iter()
                    .filter(|item| {
                        eligible.contains(&item.key)
                            && self.file_fingerprints.get(&item.key) != Some(&item.fingerprint)
                    })
                    .cloned()
                    .collect();
                let mut count = 0;
                let mut bytes = 0_u64;
                for item in pending.iter().take(BATCH_SIZE) {
                    if count > 0 && bytes.saturating_add(item.bytes) > 16 * 1024 * 1024 {
                        break;
                    }
                    bytes = bytes.saturating_add(item.bytes);
                    count += 1;
                }
                let (mut delta, _, _) = self.read_page(&pending[..count], false)?;
                self.backfill
                    .as_mut()
                    .unwrap()
                    .dirty
                    .extend(pending[count..].iter().filter_map(|item| item.path.clone()));
                let present: HashSet<_> = current
                    .iter()
                    .filter_map(|item| item.path.as_ref())
                    .collect();
                delta.removed.extend(
                    self.previous
                        .iter()
                        .filter(|record| !present.contains(&record.source))
                        .map(|record| record.head.reference.clone()),
                );
                Ok(delta)
            }
        };
        let delta = result?;
        let parsed: HashSet<_> = delta
            .upserts
            .iter()
            .map(|session| &session.source)
            .collect();
        for item in &current {
            if item.path.as_ref().is_some_and(|path| parsed.contains(path)) {
                self.file_fingerprints
                    .insert(item.key.clone(), item.fingerprint.clone());
            }
        }
        self.backfill.as_mut().unwrap().items.extend(added);
        Ok(delta)
    }
    fn read_live(
        &mut self,
        paths: Option<&[PathBuf]>,
    ) -> Result<(ScanDelta, Option<serde_json::Value>, bool)> {
        if matches!(
            self.source.agent.as_str(),
            "cursor" | "opencode" | "zcode" | "deepchat" | "cherrystudio" | "minimax-code"
        ) {
            return Ok((self.read(paths)?, None, true));
        }
        let current = inventory(&self.source)?;
        if current.is_empty()
            && !self.source.scan_path.try_exists()?
            && !self.durable_references.is_empty()
        {
            return Ok((ScanDelta::default(), None, true));
        }
        let changed: Vec<_> = current
            .iter()
            .filter(|item| self.file_fingerprints.get(&item.key) != Some(&item.fingerprint))
            .collect();
        if changed.len() > BATCH_SIZE
            || (changed.len() > 1
                && changed.iter().map(|item| item.bytes).sum::<u64>() > 16 * 1024 * 1024)
        {
            return self.page(None, None);
        }
        let (mut delta, mut retained, _) = self.read_page(&current, false)?;
        retained.extend(
            delta
                .upserts
                .iter()
                .map(|session| session.head.reference.clone()),
        );
        delta
            .removed
            .extend(self.durable_references.difference(&retained).cloned());
        let present: HashSet<_> = current.iter().map(|item| item.key.as_str()).collect();
        self.file_fingerprints
            .retain(|key, _| present.contains(key.as_str()));
        Ok((delta, None, true))
    }
    fn read_page(
        &mut self,
        selected: &[Item],
        limit_changes: bool,
    ) -> Result<(ScanDelta, HashSet<crate::contract::SessionReference>, usize)> {
        let mut reused = HashSet::new();
        let mut changed = Vec::new();
        let mut bytes = 0_u64;
        let mut consumed = 0;
        let mut projections = HashMap::new();
        let mut by_source: HashMap<_, Vec<_>> = HashMap::new();
        for record in &self.previous {
            by_source.entry(&record.source).or_default().push(record);
        }
        let mut by_key: HashMap<_, Vec<_>> = HashMap::new();
        if self.source.agent != "cursor" && selected.iter().any(|item| item.path.is_none()) {
            for record in &self.previous {
                let mut reference = &record.head.reference;
                let mut seen = HashSet::new();
                while seen.insert(reference) {
                    let Some((Some(parent), _)) = self.baseline.get(reference) else {
                        break;
                    };
                    if !self.baseline.contains_key(parent) {
                        break;
                    }
                    reference = parent;
                }
                by_key
                    .entry(&reference.session_id)
                    .or_default()
                    .push(record);
            }
        }
        for item in selected {
            let records = match &item.path {
                Some(path) => by_source.get(path),
                None => by_key.get(&item.key),
            };
            let current = (records.is_some() || self.empty_sources.contains(&item.key))
                && self.source.agent != "cursor"
                && self.file_fingerprints.get(&item.key) == Some(&item.fingerprint)
                && records.into_iter().flatten().all(|record| {
                    let projection = projections
                        .entry(record.head.directory.clone())
                        .or_insert_with(|| {
                            crate::projects::compute_identity_projection(&record.head.directory)
                        });
                    projection.identity == record.head.project_identity
                        && record.head.project_identity_input_signature.as_ref()
                            == Some(&projection.input_signature)
                        && record.head.project_identity_resolver_revision.as_ref()
                            == Some(&projection.resolver_revision)
                });
            if current {
                reused.extend(
                    records
                        .into_iter()
                        .flatten()
                        .map(|record| record.head.reference.clone()),
                );
            } else {
                if limit_changes
                    && !changed.is_empty()
                    && (changed.len() >= BATCH_SIZE
                        || bytes.saturating_add(item.bytes) > 16 * 1024 * 1024)
                {
                    break;
                }
                bytes = bytes.saturating_add(item.bytes);
                changed.push(item.clone());
            }
            consumed += 1;
        }
        let delta = self.read_selected(&changed)?;
        for item in changed.iter().filter(|_| self.source.agent != "cursor") {
            if delta.upserts.iter().any(|session| match &item.path {
                Some(path) => path == &session.source,
                None => session.head.reference.session_id == item.key,
            }) {
                self.empty_sources.remove(&item.key);
            } else {
                self.empty_sources.insert(item.key.clone());
            }
            self.file_fingerprints
                .insert(item.key.clone(), item.fingerprint.clone());
        }
        Ok((delta, reused, consumed))
    }
    fn read_selected(&mut self, selected: &[Item]) -> Result<ScanDelta> {
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
                let mut snapshot = agents::opencode::scan_selected_snapshot(
                    &path,
                    &self.source.agent,
                    self.source.agent == "opencode",
                    &self.pricing,
                    &ids,
                    self.opencode.as_ref(),
                )?;
                let upserts = std::mem::take(&mut snapshot.upserts);
                snapshot.release_bodies();
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
        self.file_fingerprints.clear();
        self.empty_sources.clear();
        self.history_complete = false;
        self.price_dependencies = Some(HashMap::new());
        if !self.cache_path.exists() {
            return Ok(());
        }
        let cache = Cache::open_read_only(&self.cache_path)?;
        let saved: Option<String> = cache
            .connection()
            .query_row(
                "SELECT value FROM cache_meta WHERE key=?1",
                [format!("rust_source_state:{}", self.source.agent)],
                |row| row.get(0),
            )
            .optional()?;
        let state = saved.and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok());
        let pricing_changed = state.as_ref().is_some_and(|state| {
            state["generation"].as_u64() != Some(self.pricing.generation())
                && !serde_json::from_value::<PriceDependencies>(state["priceDependencies"].clone())
                    .is_ok_and(|dependencies| self.pricing.matches_dependencies(&dependencies))
        });
        if let Some(state) = state
            && state["version"] == 1
            && state["parserVersion"].as_str() == Some(agents::parser_version(&self.source.agent))
            && state["root"].as_str() == self.source.scan_path.to_str()
        {
            self.price_dependencies =
                serde_json::from_value(state["priceDependencies"].clone()).ok();
            self.history_complete = match state["historyComplete"].as_bool() {
                Some(complete) => complete,
                None => cache.connection().query_row(
                    "SELECT EXISTS(SELECT 1 FROM cache_initialization WHERE agent_name=?)",
                    [&self.source.agent],
                    |row| row.get(0),
                )?,
            };
            self.file_fingerprints =
                serde_json::from_value(state["files"].clone()).unwrap_or_default();
            self.empty_sources =
                serde_json::from_value(state["emptySources"].clone()).unwrap_or_default();
            self.fingerprints =
                serde_json::from_value(state["databaseSessions"].clone()).unwrap_or_default();
        }

        for head in cache.agent_snapshot(&self.source.agent)? {
            self.durable_references.insert(head.reference.clone());
            let (source, has_cost_inputs): (Option<String>, bool) = cache.connection().query_row(
                "SELECT source_path,COALESCE(json_extract(meta_json,'$.rustPricing.version')=1,0) FROM sessions WHERE agent_name=?1 AND session_id=?2",
                [&head.reference.agent_name, &head.reference.session_id],
                |row| Ok((row.get(0)?,row.get(1)?)),
            )?;
            if pricing_changed && !has_cost_inputs {
                self.file_fingerprints.remove(&head.reference.session_id);
                self.fingerprints.remove(&head.reference.session_id);
                if let Some(source) = &source {
                    self.file_fingerprints.remove(source);
                }
            }
            self.baseline.insert(
                head.reference.clone(),
                (
                    head.parent_reference.clone(),
                    source.as_ref().map(PathBuf::from),
                ),
            );
            if let Some(source) = source {
                let attachments = if head.reference.agent_name == "dsh" {
                    cache
                        .detail(head.clone())?
                        .map(|detail| {
                            agents::dsh::AttachmentReferences::from_messages(&detail.messages)
                        })
                        .unwrap_or_default()
                } else {
                    Default::default()
                };
                self.previous.push(SessionRecord {
                    head,
                    source: source.into(),
                    attachments,
                });
            }
        }
        Ok(())
    }
    fn full(&self) -> Result<ScanDelta> {
        let result = scan_source(&self.source, &self.pricing)?;
        if !result.available && (!self.previous.is_empty() || !self.durable_references.is_empty()) {
            return Ok(ScanDelta::default());
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
                    return Ok(ScanDelta::default());
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
                    return Ok(ScanDelta::default());
                }
                let path = if self.source.agent == "opencode" {
                    root.clone()
                } else {
                    root.join("cli/db/db.sqlite")
                };
                let mut snapshot = agents::opencode::refresh_database(
                    &path,
                    &self.source.agent,
                    self.source.agent == "opencode",
                    pricing,
                    self.opencode.as_ref(),
                )?;
                let delta = ScanDelta {
                    upserts: std::mem::take(&mut snapshot.upserts),
                    removed: std::mem::take(&mut snapshot.removed),
                    complete: false,
                };
                snapshot.release_bodies();
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
            return Ok(ScanDelta::default());
        }
        let root = &self.source.scan_path;
        let current = match self.source.agent.as_str() {
            "deepchat" => agents::deepchat::fingerprints(root)?,
            "cherrystudio" => agents::cherrystudio::fingerprints(root)?,
            _ => agents::minimax_code::fingerprints(root)?,
        };
        let changed: HashSet<_> = current
            .iter()
            .filter(|(id, hash)| {
                eligible.is_none_or(|eligible| eligible.contains(*id))
                    && self.fingerprints.get(*id) != Some(*hash)
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
        Ok(ScanDelta {
            upserts,
            removed,
            complete: false,
        })
    }
}
fn selected_delta(
    upserts: Vec<ParsedSession>,
    previous: &[SessionRecord],
    affected: impl Fn(&SessionRecord) -> bool,
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
