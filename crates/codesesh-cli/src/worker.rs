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
            version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: PROTOCOL_VERSION,
            payload_version: PAYLOAD_VERSION,
            stream_id: self.store.stream_id()?,
            queue: self.store.queue_status()?,
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
    history: Option<crate::options::History>,
) -> Result<()> {
    let origin = hub_url(hub)?;
    let _lock = crate::node_identity::lock(&environment.home, "collector.lock")?;
    let path = codesesh_core::app_paths::root(&environment.home).join("worker.db");
    let sources = discovery::selected_sources(environment, agents);
    let names = sources.iter().map(|s| s.agent.clone()).collect();
    let mut collector = Collector {
        store: WorkerStore::open(&path)?,
        scanners: sources
            .into_iter()
            .map(|source| AgentScanner::for_worker(source, path.clone()))
            .collect(),
        agents: names,
    };
    if collector.store.history_choice()?.is_none() {
        let archive = codesesh_core::app_paths::root(&environment.home).join("codesesh.db");
        let choice = if archive.exists() {
            history.context("Existing standalone history found. Choose --history import to upload it, or --history ignore to leave it untouched. Neither option deletes the original database.")?
        } else {
            crate::options::History::Ignore
        };
        if matches!(choice, crate::options::History::Import) {
            let mut store = collector.store;
            collector.store = tokio::task::spawn_blocking(move || -> Result<WorkerStore> {
                let cache = codesesh_core::storage::Cache::open(Some(&archive))?;
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
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let grant = match collector.store.binding()? {
        Some((saved, grant)) => {
            ensure!(
                saved == origin.as_str(),
                "Worker is already paired with another Hub URL; preserve its pending queue"
            );
            grant
        }
        None => {
            let token=pair_token.map(str::to_owned).or_else(||std::env::var("CODESESH_PAIRING_TOKEN").ok()).context("Pairing required: create a token in the Hub, then provide --pair-token or CODESESH_PAIRING_TOKEN")?;
            let response=client.post(origin.join("api/worker/pair")?).json(&serde_json::json!({"token":token,"name":name.unwrap_or("Worker"),"hello":collector.hello()?})).send().await?;
            ensure!(
                response.status().is_success(),
                "Hub rejected pairing (HTTP {}): {}",
                response.status(),
                response.text().await?
            );
            let grant: PairingGrant = response.json().await?;
            collector.store.bind(origin.as_str(), &grant)?;
            grant
        }
    };
    eprintln!("Worker {} paired with {}", grant.node_id, origin);
    let mut next_hello = Instant::now();
    let mut next_scan = Instant::now();
    let mut next_upload = Instant::now();
    let mut paused = false;
    let mut online = false;
    let mut retry_seconds = 1u64;
    let mut shutdown = Box::pin(crate::shutdown_signal());
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
        if Instant::now() >= next_hello {
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
                    ensure!(
                        hello.epoch == grant.epoch,
                        "HUB_EPOCH_CHANGED: reconciliation is required; queue preserved"
                    );
                    paused = hello.error.is_some();
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
                Ok(response) if response.status() == StatusCode::UNAUTHORIZED => {
                    paused = true;
                    online = false;
                    eprintln!("Worker paused: credential was rejected or revoked");
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
                    eprintln!("Worker upload paused: {}", response.text().await?);
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
