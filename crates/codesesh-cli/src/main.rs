mod assets;
mod cache_path;
mod http;
mod json_scan;
mod logging;
mod options;
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

#[tokio::main]
async fn main() {
    let result = run().await;
    if let Err(error) = &result {
        eprintln!("{error:#}");
        if let Ok(logger) = logging::initialize() {
            logger.error(
                "cli.fatal",
                &serde_json::json!({"error":format!("{error:#}")}),
            );
        }
    }
    if let Ok(logger) = logging::initialize() {
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
    let args = match options::Args::try_parse_from(raw) {
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
    let plan = args.plan()?;
    let logger = logging::initialize()?;
    logger.info("cli.start",&serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"host":args.host,"json":args.json,"trace":args.trace,"log_path":logger.path()}));
    logger.debug(
        "cli.options",
        &serde_json::json!({"cache":args.cache&&!args.no_cache,"days":plan.days}),
    );
    let environment = PathEnvironment::current()?;
    let pricing_controller = PricingController::load(&environment.home);
    if let Err(error) = pricing_controller.refresh().await {
        logger.warn(
            "pricing.refresh.error",
            &serde_json::json!({"error":format!("{error:#}")}),
        );
    }
    let publish = pricing_controller.clone();
    tokio::task::spawn_blocking(move || publish.publish_pending()).await??;
    let pricing = Arc::new(pricing_controller.snapshot()?.pricing);
    let persistent = environment.home.join(".cache/codesesh/codesesh.db");
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
    let (cache_path, fallback_cleanup) =
        tokio::task::spawn_blocking(move || cache_path::choose(&cache_path)).await??;
    let temporary = fallback_cleanup.or(temporary);
    let sources = discovery::selected_sources(&environment, &plan.agents);
    if args.json {
        let scan_options = ScanOptions {
            agents: plan.agents,
            cwd: plan.cwd,
            from: plan.from,
            to: plan.to,
            days: None,
            now: None,
        };
        let result = tokio::task::spawn_blocking(move || {
            json_scan::run(&sources, &scan_options, &pricing, &cache_path)
        })
        .await?;
        if let Some(path) = temporary {
            std::fs::remove_dir_all(path)?;
        }
        let result = result?;
        println!("{}", serde_json::to_string(&result)?);
        logger.info(
            "cli.json_output",
            &serde_json::json!({"session_count":result.sessions.len()}),
        );
        return Ok(());
    }
    let enabled_agents = sources.iter().map(|source| source.agent.clone()).collect();
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
                    .with_startup_window(plan.from, plan.to)
                    .with_target_session(plan.session.as_ref().map(|(agent, id)| {
                        codesesh_core::contract::SessionReference {
                            agent_name: agent.clone(),
                            session_id: id.clone(),
                        }
                    }))
                    .into_runtime_source()
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let runtime = Runtime::start(cache_path, runtime_sources, 4).await?;
    let listener = bind(&args.host, plan.port).await?;
    let address = listener.local_addr()?;
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
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
    let state = Arc::new(http::State::new(
        runtime.clone(),
        saved,
        http::Options {
            token: token.clone(),
            hostname: args.host.clone(),
            port: address.port(),
            tls: args.tls_cert.is_some(),
            trust_proxy: args.trust_proxy,
            loopback_authority: options::loopback(&args.host) && !args.remote_access,
            default_from: plan.from,
            default_to: plan.to,
            default_days: plan.days,
            enabled_agents,
            cwd: plan.cwd,
        },
    ));
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
    startup
        .query_pairs_mut()
        .append_pair("access_token", &token);
    let mut advertised = startup.clone();
    advertised.set_path("/");
    println!("{advertised}");
    if args.trace {
        logger.info(
            "perf.startup",
            &serde_json::json!({"duration_ms":started.elapsed().as_secs_f64()*1000.0}),
        );
    }
    logger.flush()?;
    if !args.no_open {
        open_browser(startup.as_str());
    }
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
fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    if let Err(error) = result {
        eprintln!("Unable to open browser: {error}");
    }
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut hup = signal(SignalKind::hangup()).expect("install SIGHUP handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{},_=hup.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
