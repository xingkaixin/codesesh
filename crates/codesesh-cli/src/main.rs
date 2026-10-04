mod assets;
mod cache_path;
mod http;
mod json_scan;
mod logging;
mod migration;
mod node_identity;
mod options;
mod pricing_refresh;
mod service;
mod trace;
mod worker;
use anyhow::{Context, Result};
use base64::Engine;
use clap::Parser;
use codesesh_core::{
    discovery::{self, AgentScanner, PathEnvironment, ScanOptions},
    pricing::PricingController,
    runtime::Runtime,
    state::StateStore,
};
use std::{path::PathBuf, sync::Arc};

fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var_os("MallocSpaceEfficient").is_none() {
        use std::os::unix::process::CommandExt;
        // libmalloc reads this before main; exec preserves the PID and inherited I/O.
        let error = match std::env::current_exe() {
            Ok(executable) => std::process::Command::new(executable)
                .args(std::env::args_os().skip(1))
                .env("MallocSpaceEfficient", "1")
                .exec(),
            Err(error) => error,
        };
        eprintln!("codesesh: cannot initialize the allocator: {error}");
        std::process::exit(1);
    }
    if let Err(error) = service::prepare_process() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
    main_async();
}

#[tokio::main]
async fn main_async() {
    let result = run().await;
    let result = if service::stopping() { Ok(()) } else { result };
    service::finished(result.as_ref().err());
    if let Err(error) = &result {
        eprintln!("{error:#}");
        if let Some(logger) = logging::current() {
            logger.error(
                "cli.fatal",
                &serde_json::json!({"error":format!("{error:#}")}),
            );
        }
    }
    if let Some(logger) = logging::current() {
        let _ = logger.shutdown();
    }
    if result.is_err() {
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let started = std::time::Instant::now();
    let raw: Vec<_> = std::env::args_os()
        .map(|arg| if arg == "-v" { "--version".into() } else { arg })
        .collect();
    let mut args = match options::Args::try_parse_from(raw) {
        Ok(args) => args,
        Err(error) => {
            let code = if matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            ) {
                0
            } else {
                1
            };
            error.print()?;
            std::process::exit(code);
        }
    };
    let environment = PathEnvironment::current()?;
    if let Some(role) = args.service_run {
        args = service::boot(role, &environment.home).await?;
    } else if service::dispatch(&args, &environment.home).await? {
        return Ok(());
    }
    let plan = args.plan()?;
    let _mode_lock = node_identity::mode_lock(&environment.home, args.command.is_some())?;
    let migration_warnings = migration::run(&args, &environment.home).await?;
    let logger = logging::initialize()?;
    for warning in migration_warnings {
        logger.warn(
            "migration.retained",
            &serde_json::json!({"message": warning}),
        );
    }
    logger.info("cli.start",&serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"host":args.host,"json":args.json,"trace":args.trace,"log_path":logger.path()}));
    logger.info(
        "perf.startup.prepare",
        &serde_json::json!({"duration_ms": started.elapsed().as_secs_f64() * 1000.0}),
    );
    logger.debug(
        "cli.options",
        &serde_json::json!({"cache":args.cache&&!args.no_cache,"days":plan.days}),
    );
    if let Some(options::Role::Worker {
        hub,
        name,
        pair_token,
        pair_token_stdin,
        history,
        ..
    }) = &args.command
    {
        return worker::run(
            &environment,
            &plan.agents,
            hub.as_deref().context("Worker requires --hub")?,
            name.as_deref(),
            pair_token.as_deref(),
            *pair_token_stdin,
            *history,
        )
        .await;
    }
    let hub_enabled = matches!(args.command, Some(options::Role::Hub { .. }));
    let scan_local = !hub_enabled;
    let _hub_lock = (!args.json)
        .then(|| node_identity::lock(&environment.home, "hub.lock"))
        .transpose()?;
    let _collector_lock = (scan_local
        && (!args.json
            || codesesh_core::app_paths::root(&environment.home)
                .join("worker.db")
                .exists()))
    .then(|| node_identity::lock(&environment.home, "collector.lock"))
    .transpose()?;
    let pricing_started = std::time::Instant::now();
    let pricing_controller = PricingController::load(&environment.home);
    let pricing = Arc::new(pricing_controller.snapshot()?.pricing);
    logger.info(
        "perf.startup.pricing",
        &serde_json::json!({"duration_ms": pricing_started.elapsed().as_secs_f64() * 1000.0}),
    );
    let persistent = codesesh_core::app_paths::root(&environment.home).join("codesesh.db");
    if args.clear_cache {
        for suffix in ["", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", persistent.to_string_lossy()));
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        eprintln!("Cache cleared.");
    }
    let temporary = (!args.cache || args.no_cache)
        .then(|| std::env::temp_dir().join(format!("codesesh-{}", uuid::Uuid::new_v4())));
    let cache_path = temporary
        .as_ref()
        .map(|dir| dir.join("codesesh.db"))
        .unwrap_or(persistent);
    let database_started = std::time::Instant::now();
    let (cache_path, fallback_cleanup) = tokio::task::spawn_blocking(move || {
        if hub_enabled {
            cache_path::open(&cache_path)?;
            Ok((cache_path, None))
        } else {
            cache_path::choose(&cache_path)
        }
    })
    .await??;
    logger.info(
        "perf.startup.database",
        &serde_json::json!({"duration_ms": database_started.elapsed().as_secs_f64() * 1000.0}),
    );
    let temporary = fallback_cleanup.or(temporary);
    let local_source = if scan_local {
        let home = environment.home.clone();
        let path = cache_path.clone();
        let pricing = pricing.clone();
        tokio::task::spawn_blocking(move || -> Result<String> {
            let root = codesesh_core::app_paths::root(&home);
            if root.join("worker.db").exists() && root.join("hub-identity").exists() {
                let mut worker = codesesh_core::sync::WorkerStore::open(&root.join("worker.db"))?;
                let mut cache = codesesh_core::storage::Cache::open(Some(&path))?;
                if let Some(node) = cache.resume_local_worker(
                    &mut worker,
                    &node_identity::hub_id(&home)?,
                    &pricing,
                )? {
                    eprintln!("Continuing this machine's existing Worker source: {node}");
                    return Ok(node);
                }
            }
            Ok(codesesh_core::contract::local_source_node_id())
        })
        .await??
    } else {
        codesesh_core::contract::local_source_node_id()
    };
    if service::stopping() {
        return Ok(());
    }
    let sources = if scan_local {
        discovery::selected_sources(&environment, &plan.agents)
    } else {
        Vec::new()
    };
    if args.json {
        let scan_options = ScanOptions {
            agents: plan.agents,
            cwd: plan.cwd,
            from: plan.from,
            to: plan.to,
            days: None,
            now: None,
        };
        let (result, report, scan_duration) = tokio::task::spawn_blocking(move || {
            let scan_started = std::time::Instant::now();
            let mut report = args.trace.then(trace::Report::default);
            let result = json_scan::run_for_source(
                &sources,
                &scan_options,
                &pricing,
                &cache_path,
                report.as_mut(),
                &local_source,
            );
            (result, report, scan_started.elapsed())
        })
        .await?;
        if let Some(path) = temporary {
            std::fs::remove_dir_all(path)?;
        }
        if let Some(report) = report {
            report.print("scanSessions", scan_duration);
        }
        let result = result?;
        println!("{}", serde_json::to_string(&result)?);
        logger.info(
            "cli.json_output",
            &serde_json::json!({"session_count":result.sessions.len()}),
        );
        return Ok(());
    }
    let enabled_agents = if hub_enabled {
        codesesh_core::agents::catalog(0)
            .into_iter()
            .map(|agent| agent.name)
            .filter(|name| {
                plan.agents.is_empty()
                    || plan
                        .agents
                        .iter()
                        .any(|agent| agent.eq_ignore_ascii_case(name))
            })
            .collect()
    } else {
        discovery::selected_sources(&environment, &plan.agents)
            .into_iter()
            .map(|source| source.agent)
            .collect()
    };
    let runtime_sources = sources
        .into_iter()
        .map(|source| {
            AgentScanner::with_pricing_controller(
                source,
                cache_path.clone(),
                pricing_controller.clone(),
            )
            .map(|scanner| {
                scanner
                    .with_source_node(&local_source)
                    .with_startup_window(plan.from, plan.to)
                    .with_target_session(plan.session.as_ref().map(|(agent, id)| {
                        codesesh_core::contract::SessionReference {
                            source_node_id: codesesh_core::contract::local_source_node_id(),
                            agent_name: agent.clone(),
                            session_id: id.clone(),
                        }
                    }))
                    .into_runtime_source()
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let runtime_started = std::time::Instant::now();
    let runtime = if hub_enabled {
        Runtime::start_hub(cache_path, runtime_sources, 4).await?
    } else {
        Runtime::start(cache_path, runtime_sources, 4).await?
    };
    if hub_enabled {
        let hub_id = node_identity::hub_id(&environment.home)?;
        let local_key = node_identity::local_worker_key(&environment.home)?;
        let recover = matches!(
            args.command,
            Some(options::Role::Hub {
                recover_data: true,
                ..
            })
        );
        runtime
            .hub_control(move |cache| {
                cache.initialize_hub(&hub_id)?;
                cache.configure_local_worker(&local_key)?;
                if recover {
                    cache.rotate_data_epoch()?;
                }
                Ok(())
            })
            .await?;
    }
    let runtime_duration = runtime_started.elapsed();
    let timings = runtime.startup_timings();
    logger.info(
        "perf.startup.runtime",
        &serde_json::json!({
            "duration_ms": runtime_duration.as_secs_f64() * 1000.0,
            "cache_open_ms": timings.cache_open.as_secs_f64() * 1000.0,
            "snapshot_ms": timings.snapshot.as_secs_f64() * 1000.0,
            "watch_registration_ms": timings.watch_registration.as_secs_f64() * 1000.0,
            "watch_snapshot_ms": timings.watch_snapshot.as_secs_f64() * 1000.0,
        }),
    );
    let mut scan_status = runtime.statuses();
    let mut scan_shutdown = runtime.shutdown_receiver();
    logger.info("scan.startup.start", &serde_json::json!({}));
    tokio::spawn(async move {
        loop {
            let status = scan_status.borrow_and_update().clone();
            if !status.active {
                for agent in status.agent_statuses.values() {
                    logger.info("scan.startup.agent", &serde_json::json!({
                        "agent": agent.agent_name,
                        "duration_ms": agent.completed_at.zip(agent.started_at).map(|(end, start)| end - start),
                        "session_count": agent.sessions,
                        "failed": agent.error.is_some(),
                        "error": agent.error,
                    }));
                }
                logger.info("scan.startup.done", &serde_json::json!({
                    "duration_ms": status.completed_at.zip(status.started_at).map(|(end, start)| end - start),
                    "failed_agents": status.agent_statuses.values().filter(|agent| agent.error.is_some()).map(|agent| &agent.agent_name).collect::<Vec<_>>(),
                }));
                break;
            }
            tokio::select! {
                result = scan_status.changed() => if result.is_err() { break; },
                _ = scan_shutdown.changed() => break,
            }
        }
    });
    let listener = bind(&args.host, plan.port).await?;
    let address = listener.local_addr()?;
    let token = (args.auth || args.remote_access).then(|| {
        let mut bytes = Vec::with_capacity(32);
        bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
        bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    });
    let home = environment.home.clone();
    let saved =
        match tokio::task::spawn_blocking(move || StateStore::from_environment(&home)).await? {
            Ok(saved) => Some(saved),
            Err(error) => {
                eprintln!("User state is unavailable: {error:#}");
                logger.warn(
                    "state.open.error",
                    &serde_json::json!({"error":format!("{error:#}")}),
                );
                None
            }
        };
    let state = http::State::new(
        runtime.clone(),
        pricing_controller.clone(),
        saved,
        http::Options {
            token: token.clone(),
            hostname: args.host.clone(),
            port: address.port(),
            tls: args.tls_cert.is_some(),
            trust_proxy: args.trust_proxy,
            public_origin: plan.public_origin.clone(),
            loopback_authority: options::loopback(&args.host) && !args.remote_access,
            default_from: plan.from,
            default_to: plan.to,
            default_days: plan.days,
            enabled_agents,
            cwd: plan.cwd,
        },
    );
    let state = Arc::new(if hub_enabled { state.with_hub() } else { state });
    let router = http::router(state);
    let origin = plan.public_origin.unwrap_or_else(|| {
        format!(
            "{}://{address}",
            if args.tls_cert.is_some() {
                "https"
            } else {
                "http"
            }
        )
    });
    let mut startup = url::Url::parse(&origin)?;
    if let Some((agent, id)) = plan.session {
        startup
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid startup URL"))?
            .extend([agent.to_lowercase().as_str(), &id]);
    }
    if let Some(token) = &token {
        startup.query_pairs_mut().append_pair("access_token", token);
    }
    let mut advertised = startup.clone();
    advertised.set_path("/");
    if args.trace {
        let mut report = trace::Report::default();
        report.record("runtime.initialize", runtime_duration);
        report.print("startup", started.elapsed());
    }
    logger.info(
        "perf.startup",
        &serde_json::json!({"duration_ms":started.elapsed().as_secs_f64()*1000.0}),
    );
    println!("{advertised}");
    logger.flush()?;
    service::report(
        "ready",
        &format!("Hub listening at {origin}"),
        None,
        Some(startup.as_str()),
    );
    if (!args.no_open || service::take_open_request(&environment.home))
        && let Err(error) = open_browser(startup.as_str()).await
    {
        eprintln!("Unable to open browser: {error:#}. Open the URL printed above.");
    }
    let pricing_task = pricing_refresh::spawn(
        pricing_controller,
        runtime.clone(),
        logger.clone(),
        codesesh_core::pricing::MODELS_DEV_URL,
    );
    let result = if let (Some(cert), Some(key)) = (args.tls_cert, args.tls_key) {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
            .await
            .context("Unable to read the TLS certificate or key")?;
        let handle = axum_server::Handle::new();
        let stop = handle.clone();
        let stopping_runtime = runtime.clone();
        tokio::spawn(async move {
            shutdown_signal().await;
            if let Err(error) = stopping_runtime.shutdown().await {
                eprintln!("Shutdown failed: {error:#}");
            }
            stop.graceful_shutdown(Some(std::time::Duration::from_secs(5)));
        });
        axum_server::from_tcp_rustls(listener.into_std()?, config)?
            .handle(handle)
            .serve(router.into_make_service())
            .await
    } else {
        let stopping_runtime = runtime.clone();
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                shutdown_signal().await;
                if let Err(error) = stopping_runtime.shutdown().await {
                    eprintln!("Shutdown failed: {error:#}");
                }
            })
            .await
    };
    pricing_task.abort();
    runtime.shutdown().await?;
    if let Some(path) = temporary {
        std::fs::remove_dir_all(path)?;
    }
    logger.info("cli.shutdown", &serde_json::json!({"phase":"server"}));
    result?;
    Ok(())
}

async fn bind(host: &str, port: Option<u16>) -> Result<tokio::net::TcpListener> {
    let first = port.unwrap_or(4521);
    for offset in 0..=if port.is_none() { 20 } else { 0 } {
        match tokio::net::TcpListener::bind((host, first + offset)).await {
            Ok(listener) => return Ok(listener),
            Err(error)
                if error.kind() == std::io::ErrorKind::AddrInUse
                    && port.is_none()
                    && offset < 20 => {}
            Err(error) => return Err(error.into()),
        }
    }
    unreachable!()
}
async fn open_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = tokio::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = tokio::process::Command::new("xdg-open");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        command.arg(url).kill_on_drop(true).output(),
    )
    .await
    .context("Browser launcher timed out")??;
    anyhow::ensure!(
        output.status.success(),
        "Browser launcher failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(())
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut hup = signal(SignalKind::hangup()).expect("install SIGHUP handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{},_=hup.recv()=>{},_=service::shutdown_requested()=>{}}
    }
    #[cfg(not(unix))]
    {
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = service::shutdown_requested() => {} }
    }
}
