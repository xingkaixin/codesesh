use anyhow::{Context, Result, ensure};
use codesesh_core::{
    discovery::{self, AgentScanner, PathEnvironment},
    sync::{
        HubHello, PAYLOAD_VERSION, PROTOCOL_VERSION, PairingGrant, Receipt, Upload, WorkerHello,
        WorkerStore,
    },
};
use reqwest::{Client, StatusCode};
use std::time::{Duration, Instant};

struct Collector {
    store: WorkerStore,
    scanners: Vec<AgentScanner>,
    agents: Vec<String>,
    error: Option<String>,
}

impl Collector {
    fn scan(&mut self) -> Result<()> {
        for (scanner, agent) in self.scanners.iter_mut().zip(&self.agents) {
            let checkpoint = self.store.checkpoint(agent)?;
            let mut batch = scanner.refresh_with_checkpoint(None, checkpoint.as_ref())?;
            self.store.save_batch(agent, &mut batch)?;
        }
        Ok(())
    }

    fn hello(&self) -> Result<WorkerHello> {
        Ok(WorkerHello {
            collection_complete: self.store.collection_complete(&self.agents)?,
            collection_error: self.error.clone().or(self.store.pause_reason()?),
            epoch: self.store.binding()?.map(|(_, grant)| grant.epoch),
            confirmed_sequence: self.store.confirmed_sequence()?,
            version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: PROTOCOL_VERSION,
            payload_version: PAYLOAD_VERSION,
            stream_id: self.store.stream_id()?,
            queue: self.store.queue_status()?,
            rescan: self.store.rescan_progress()?,
        })
    }
}

fn hub_url(value: &str) -> Result<url::Url> {
    let url = url::Url::parse(value).context("Invalid Hub URL")?;
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "Hub URL must contain only the origin, without credentials or a path"
    );
    ensure!(
        url.scheme() == "https"
            || url.scheme() == "http" && url.host_str().is_some_and(crate::options::loopback),
        "Remote Worker connections require HTTPS; HTTP is allowed only on loopback"
    );
    Ok(url)
}

pub async fn run(
    environment: &PathEnvironment,
    agents: &[String],
    hub: &str,
    name: Option<&str>,
    pair_token: Option<&str>,
    pair_token_stdin: bool,
    history: Option<crate::options::History>,
) -> Result<()> {
    let origin = hub_url(hub)?;
    let _lock = crate::node_identity::lock(&environment.home, "collector.lock")?;
    let path = codesesh_core::app_paths::root(&environment.home).join("worker.db");
    let sources = discovery::selected_sources(environment, agents);
    let restart_sources = sources.clone();
    let names = sources.iter().map(|s| s.agent.clone()).collect();
    let mut collector = Collector {
        store: WorkerStore::open(&path)?,
        scanners: sources
            .into_iter()
            .map(|source| AgentScanner::for_worker(source, path.clone()))
            .collect(),
        agents: names,
        error: None,
    };
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "x-codesesh-worker-instance",
        uuid::Uuid::new_v4().to_string().parse()?,
    );
    let client = Client::builder()
        .default_headers(headers)
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let existing = collector.store.binding()?;
    let explicit_pairing = pair_token.is_some() || pair_token_stdin;
    let mut grant = match existing {
        Some((saved, grant)) if !explicit_pairing => {
            if saved != origin.as_str() {
                let response = client
                    .post(origin.join("api/worker/hello")?)
                    .bearer_auth(&grant.credential)
                    .json(&collector.hello()?)
                    .send()
                    .await?;
                ensure!(
                    response.status().is_success(),
                    "Cannot verify the new Hub URL; existing binding and queue preserved"
                );
                let hello: HubHello = response.json().await?;
                ensure!(
                    hello.hub_id == grant.hub_id,
                    "HUB_IDENTITY_CHANGED: supply a new pairing token explicitly; queue preserved"
                );
                collector.store.update_origin(origin.as_str())?;
            }
            grant
        }
        existing => {
            let token = if pair_token_stdin {
                eprintln!("Pairing token:");
                tokio::task::spawn_blocking(|| -> Result<String> {
                    use std::io::{BufRead, Read};
                    let mut value = String::new();
                    std::io::stdin().lock().take(513).read_line(&mut value)?;
                    ensure!(value.trim().len() == 64, "Invalid pairing token length");
                    Ok(value.trim().to_owned())
                })
                .await??
            } else {
                pair_token.map(str::to_owned).or_else(||std::env::var("CODESESH_PAIRING_TOKEN").ok()).context("Pairing required: create a token in the Hub, then use --pair-token-stdin or CODESESH_PAIRING_TOKEN")?
            };
            let root = codesesh_core::app_paths::root(&environment.home);
            let local_identity =
                if root.join("local-worker-key").exists() && root.join("hub-identity").exists() {
                    Some((
                        std::fs::read_to_string(root.join("hub-identity"))?,
                        std::fs::read_to_string(root.join("local-worker-key"))?,
                    ))
                } else {
                    None
                };
            let stream = collector.store.stream_id()?;
            let mut request = client.post(origin.join("api/worker/pair")?).json(&serde_json::json!({"token":token,"name":name.unwrap_or("Worker"),"hello":collector.hello()?}));
            if let Some((hub_id, key)) = &local_identity {
                request = request
                    .header("x-codesesh-local-hub-id", hub_id.trim())
                    .header(
                        "x-codesesh-local-proof",
                        codesesh_core::sync::local_worker_proof(
                            key,
                            hub_id.trim(),
                            &token,
                            &stream,
                        ),
                    );
            }
            let response = request.send().await?;
            ensure!(
                response.status().is_success(),
                "Hub rejected pairing (HTTP {}): {}",
                response.status(),
                response.text().await?
            );
            let grant: PairingGrant = response.json().await?;
            if let Ok(identity) = std::fs::read_to_string(root.join("hub-identity")) {
                ensure!(
                    identity.trim() != grant.hub_id
                        || grant.node_id == codesesh_core::contract::LOCAL_SOURCE_NODE_ID,
                    "This machine's Hub did not confirm the local source. Restart Hub with this version before pairing again; no history was uploaded."
                );
            }
            if existing.is_some() {
                collector.store.rebind(origin.as_str(), &grant)?;
            } else {
                collector.store.bind(origin.as_str(), &grant)?;
            }
            grant
        }
    };
    crate::service::paired();
    if grant.node_id == codesesh_core::contract::LOCAL_SOURCE_NODE_ID {
        let root = codesesh_core::app_paths::root(&environment.home);
        let identity = std::fs::read_to_string(root.join("hub-identity"))
            .context("Local Worker requires this Hub's installation identity")?;
        ensure!(
            identity.trim() == grant.hub_id,
            "Hub returned a local source belonging to another installation"
        );
        if collector.store.next_upload()?.is_none() && collector.store.recovery()?.is_none() {
            eprintln!(
                "Same-machine Hub verified; adopting existing local scan progress (no history import)."
            );
            crate::service::report(
                "starting",
                "Adopting existing local scan progress",
                None,
                None,
            );
            let archive = root.join("codesesh.db");
            let mut store = collector.store;
            let local_grant = grant.clone();
            collector.store = tokio::task::spawn_blocking(move || -> Result<WorkerStore> {
                let cache = codesesh_core::storage::Cache::open_read_only(&archive)?;
                if let Some(count) = store.adopt_local_history(&cache, &local_grant)? {
                    eprintln!("Local Worker ready: {count} existing sessions retained under the same source.");
                }
                Ok(store)
            })
            .await??;
        }
    } else if collector.store.history_choice()?.is_none() {
        let archive = codesesh_core::app_paths::root(&environment.home).join("codesesh.db");
        let choice = if archive.exists() {
            history.context("Existing standalone history found. Worker is paired; rerun without a pairing token and choose --history import to upload it, or --history ignore to leave it untouched. Neither option deletes the original database.")?
        } else {
            crate::options::History::Ignore
        };
        if matches!(choice, crate::options::History::Import) {
            let mut store = collector.store;
            collector.store = tokio::task::spawn_blocking(move || -> Result<WorkerStore> {
                let cache = crate::cache_path::open(&archive)?;
                for head in cache.snapshot()? {
                    if head.reference.source_node_id
                        != codesesh_core::contract::LOCAL_SOURCE_NODE_ID
                    {
                        continue;
                    }
                    if let Some(captured) = cache.capture_session(&head.reference)? {
                        let mut batch = codesesh_core::runtime::ScanBatch {
                            sessions: vec![captured.into_parsed()?],
                            removed: Vec::new(),
                            checkpoint: None,
                            complete: false,
                            on_reject: None,
                            pricing: None,
                        };
                        store.save_batch(&head.reference.agent_name, &mut batch)?;
                    }
                }
                store.finish_history_import("import")?;
                Ok(store)
            })
            .await??;
        } else {
            collector.store.finish_history_import("ignore")?;
        }
    }

    eprintln!("Worker {} paired with {}", grant.node_id, origin);
    crate::service::report("starting", "Worker paired; connecting to Hub", None, None);
    let mut next_status = Instant::now();
    let mut next_hello = Instant::now();
    let mut next_scan = Instant::now();
    let mut next_upload = Instant::now();
    let mut paused = collector.store.pause_reason()?.is_some();
    let mut online = false;
    let mut retry_seconds = 1u64;
    let mut shutdown = Box::pin(crate::shutdown_signal());
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
        if Instant::now() >= next_status {
            let queue = collector.store.queue_status()?;
            let phase = if paused {
                "paused"
            } else if online {
                "connected"
            } else {
                "offline"
            };
            let detail = format!(
                "{} pending batches, {} bytes{}",
                queue.batches,
                queue.bytes,
                collector
                    .store
                    .pause_reason()?
                    .map(|reason| format!("; {reason}"))
                    .unwrap_or_default()
            );
            crate::service::report(phase, &detail, None, None);
            next_status = Instant::now() + Duration::from_secs(5);
        }
        if Instant::now() >= next_hello {
            if let Some(recovery) = collector.store.recovery()? {
                crate::service::report(
                    "recovering",
                    "Reconciling the Hub data epoch; pending queue preserved",
                    None,
                    None,
                );
                let response = client
                    .post(origin.join("api/worker/recover")?)
                    .bearer_auth(&grant.credential)
                    .header("x-codesesh-worker-version", env!("CARGO_PKG_VERSION"))
                    .header("x-codesesh-protocol-version", PROTOCOL_VERSION)
                    .json(&recovery)
                    .send()
                    .await;
                match response {
                    Ok(response) if response.status().is_success() => {
                        grant.epoch = recovery.epoch;
                        collector.store.finish_recovery(origin.as_str(), &grant)?;
                        next_hello = Instant::now();
                    }
                    Ok(response) => {
                        eprintln!("Worker recovery pending: {}", response.text().await?);
                        next_hello = Instant::now() + backoff(15);
                    }
                    Err(_) => {
                        next_hello = Instant::now() + backoff(5);
                    }
                }
                online = false;
                paused = true;
                continue;
            }
            let result = client
                .post(origin.join("api/worker/hello")?)
                .bearer_auth(&grant.credential)
                .json(&collector.hello()?)
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => {
                    let hello: HubHello = response.json().await?;
                    ensure!(
                        hello.hub_id == grant.hub_id,
                        "HUB_IDENTITY_CHANGED: stop and pair explicitly with the new Hub"
                    );
                    if hello.error.is_none()
                        && (hello.epoch != grant.epoch
                            || hello.confirmed_sequence < collector.store.confirmed_sequence()?
                            || collector.store.recovery()?.is_some())
                    {
                        collector.store.prepare_recovery(&hello.epoch)?;
                        next_hello = Instant::now();
                        online = false;
                        paused = true;
                        continue;
                    }
                    if hello.error.is_none()
                        && let Some(task) = &hello.rescan
                        && collector.store.begin_rescan(task, &collector.agents)?
                    {
                        collector.scanners = restart_sources
                            .iter()
                            .cloned()
                            .map(|source| AgentScanner::for_worker(source, path.clone()))
                            .collect();
                        next_scan = Instant::now();
                    }
                    paused = hello.error.is_some();
                    collector
                        .store
                        .set_pause(hello.error.map(|_| "VERSION_INCOMPATIBLE"))?;
                    online = !paused;
                    if let Some(reason) = hello.error {
                        eprintln!(
                            "Worker paused: {reason:?}; Hub {}, minimum Worker {}",
                            hello.version, hello.minimum_worker_version
                        );
                    }
                    next_hello = Instant::now()
                        + Duration::from_secs(if paused {
                            60
                        } else {
                            hello.heartbeat_seconds.clamp(5, 60) as u64
                        });
                    retry_seconds = 1;
                }
                Ok(response)
                    if matches!(
                        response.status(),
                        StatusCode::UNAUTHORIZED | StatusCode::CONFLICT
                    ) =>
                {
                    paused = true;
                    online = false;
                    let reason = response.text().await?;
                    collector.store.set_pause(Some(&reason))?;
                    eprintln!("Worker paused: {reason}");
                    next_hello = Instant::now() + Duration::from_secs(60);
                }
                _ => {
                    online = false;
                    next_hello = Instant::now() + backoff(retry_seconds);
                    retry_seconds = (retry_seconds * 2).min(60);
                }
            }
        }
        if !paused && Instant::now() >= next_scan {
            let (returned, result) = tokio::task::spawn_blocking(move || {
                let result = collector.scan();
                (collector, result)
            })
            .await?;
            collector = returned;
            collector.error = result.as_ref().err().map(|error| {
                format!("SOURCE_OR_STORAGE_ERROR: {error:#}")
                    .chars()
                    .take(2048)
                    .collect()
            });
            if let Err(error) = result {
                eprintln!("Worker scan failed; progress retained: {error:#}");
            }
            next_scan = Instant::now() + Duration::from_secs(5);
        }
        if online
            && Instant::now() >= next_upload
            && let Some(pending) = collector.store.next_upload()?
        {
            let request = Upload {
                epoch: grant.epoch.clone(),
                stream_id: collector.store.stream_id()?,
                sequence: pending.sequence,
                payload_version: pending.payload_version,
                digest: pending.digest,
                operation: pending.operation,
            };
            let result = client
                .post(origin.join("api/worker/upload")?)
                .bearer_auth(&grant.credential)
                .header("x-codesesh-worker-version", env!("CARGO_PKG_VERSION"))
                .header("x-codesesh-protocol-version", PROTOCOL_VERSION)
                .json(&request)
                .send()
                .await;
            match result {
                Ok(response) if response.status().is_success() => {
                    let receipt: Receipt = response.json().await?;
                    ensure!(
                        receipt.epoch == grant.epoch,
                        "Receipt belongs to a different Hub epoch; queue preserved"
                    );
                    collector.store.acknowledge(
                        &receipt.stream_id,
                        receipt.sequence,
                        &receipt.digest,
                    )?;
                    retry_seconds = 1;
                }
                Ok(response)
                    if response.status() == StatusCode::CONFLICT
                        || response.status() == StatusCode::UNAUTHORIZED =>
                {
                    paused = true;
                    online = false;
                    let error = response.text().await?;
                    collector.store.set_pause(Some(&error))?;
                    eprintln!("Worker upload paused: {error}");
                    next_hello = Instant::now() + Duration::from_secs(60);
                }
                Ok(response) => {
                    let delay = response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(retry_seconds)
                        .clamp(1, 300);
                    next_upload = Instant::now() + backoff(delay);
                    retry_seconds = (retry_seconds * 2).min(60);
                }
                Err(_) => {
                    online = false;
                    next_hello = Instant::now() + backoff(retry_seconds);
                    retry_seconds = (retry_seconds * 2).min(60);
                }
            }
        }
    }
    Ok(())
}

fn backoff(seconds: u64) -> Duration {
    let random = uuid::Uuid::new_v4();
    let jitter = u16::from_le_bytes([random.as_bytes()[0], random.as_bytes()[1]]) as u64 % 1000;
    Duration::from_millis(seconds * 1000 + jitter)
}
