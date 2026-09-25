mod http;
use anyhow::{Context, Result, bail};
use clap::Parser;
use codesesh_core::{agents, contract::SessionIndex, storage::Cache};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Parser)]
#[command(name = "codesesh", version, about = "Browse local AI coding sessions")]
struct Args {
    #[arg(short = 'j', long)]
    json: bool,
    #[arg(short = 'a', long)]
    agent: Option<String>,
    #[arg(short = 'd', long, default_value = "7")]
    days: u32,
    #[arg(short = 'p', long, default_value = "4521")]
    port: u16,
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long = "noOpen", alias = "no-open")]
    no_open: bool,
    #[arg(long)]
    cwd: Option<PathBuf>,
    #[arg(long)]
    from: Option<String>,
    #[arg(long)]
    to: Option<String>,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let args = Args::parse();
    if args.agent.as_deref() != Some("codex") {
        bail!("Rust P1 requires --agent codex; other adapters are pending P2");
    }
    if args.cwd.is_some() || args.from.is_some() || args.to.is_some() {
        bail!("Rust P1 does not yet support cwd/from/to filtering");
    }
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .context("Rust P1 requires an explicit CODEX_HOME")?;
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .context("Rust P1 requires an isolated home directory")?;
    let pricing = codesesh_core::pricing::Pricing::load(&home);
    let mut sessions =
        tokio::task::spawn_blocking(move || agents::codex::scan(&root, &pricing)).await??;
    if args.days > 0 {
        let from = chrono::Utc::now().timestamp_millis() - i64::from(args.days) * 86_400_000;
        sessions.retain(|session| session.detail.head.time_updated >= from);
    }
    let cache_path = home.join(".cache/codesesh/codesesh.db");
    let (cache, sessions) = tokio::task::spawn_blocking(move || -> Result<_> {
        let mut cache = Cache::open_preview(&cache_path)?;
        cache.publish(&mut sessions)?;
        Ok((cache, sessions))
    })
    .await??;
    if args.json {
        println!(
            "{}",
            serde_json::to_string(&SessionIndex {
                agents: agents::catalog(sessions.len()),
                sessions: sessions
                    .into_iter()
                    .map(|session| session.detail.head)
                    .collect()
            })?
        );
        return Ok(());
    }
    if !matches!(args.host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        bail!("Rust P1 supports loopback HTTP only");
    }
    let listener = tokio::net::TcpListener::bind((args.host.as_str(), args.port)).await?;
    let token = uuid::Uuid::new_v4().to_string();
    let address = listener.local_addr()?;
    let state = Arc::new(http::State {
        sessions: sessions
            .into_iter()
            .map(|session| session.detail.head)
            .collect(),
        cache: Mutex::new(cache),
        token: token.clone(),
        days: args.days,
    });
    let router = http::router(state);
    println!("http://{address}/?access_token={token}");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut hup = signal(SignalKind::hangup()).expect("install SIGHUP handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {}, _ = hup.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
