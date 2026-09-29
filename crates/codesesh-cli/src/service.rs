mod native;

use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceRole {
    Hub,
    Worker,
}
impl ServiceRole {
    pub fn name(self) -> &'static str {
        match self {
            Self::Hub => "hub",
            Self::Worker => "worker",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum, Serialize, Deserialize)]
pub enum Action {
    Start,
    Stop,
    Restart,
    Status,
    Open,
}
#[derive(Serialize, Deserialize)]
struct Configuration {
    version: u32,
    args: crate::options::Args,
    directory: PathBuf,
    environment: std::collections::BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Descriptor {
    endpoint: String,
    token: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Report {
    pid: u32,
    phase: String,
    detail: String,
    progress: Option<(u64, u64)>,
    url: Option<String>,
    updated_at: i64,
    stopping: bool,
}
#[derive(Clone)]
struct Control {
    descriptor: Descriptor,
    report: Arc<Mutex<Report>>,
    last_path: PathBuf,
    pairing_path: PathBuf,
    stop: watch::Sender<bool>,
}
static CONTROL: OnceLock<Control> = OnceLock::new();

fn root(home: &Path) -> PathBuf {
    codesesh_core::app_paths::root(home).join("services")
}
fn path(home: &Path, role: ServiceRole, suffix: &str) -> PathBuf {
    root(home).join(format!("{}.{}", role.name(), suffix))
}
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(path.parent().context("Missing service directory")?)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}
fn load(home: &Path, role: ServiceRole) -> Result<Configuration> {
    let config: Configuration =
        serde_json::from_slice(&std::fs::read(path(home, role, "json")).context(
            "No saved service configuration. Start Hub, or start Worker with --hub, first.",
        )?)?;
    ensure!(
        config.version == 1,
        "Unsupported service configuration version"
    );
    Ok(config)
}
fn selection(args: &crate::options::Args) -> Option<(ServiceRole, Action)> {
    match args.command.as_ref()? {
        crate::options::Role::Hub {
            action: Some(action),
            ..
        } => Some((ServiceRole::Hub, *action)),
        crate::options::Role::Worker {
            action: Some(action),
            ..
        } => Some((ServiceRole::Worker, *action)),
        _ => None,
    }
}
async fn request(home: &Path, role: ServiceRole, stop: bool) -> Result<Report> {
    let descriptor: Descriptor =
        serde_json::from_slice(&std::fs::read(path(home, role, "runtime.json"))?)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()?;
    let request = if stop {
        client.post(format!("{}/stop", descriptor.endpoint))
    } else {
        client.get(format!("{}/status", descriptor.endpoint))
    };
    Ok(request
        .bearer_auth(&descriptor.token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}
fn display(role: ServiceRole, report: &Report) {
    println!(
        "{}: {}{} (PID {})",
        role.name(),
        report.phase,
        if report.stopping { ", stopping" } else { "" },
        report.pid
    );
    println!("{}", report.detail);
    if let Some((done, total)) = report.progress {
        println!(
            "Progress: {done}/{total} ({:.0}%)",
            done as f64 * 100.0 / total.max(1) as f64
        );
    }
    if let Some(url) = &report.url {
        println!("Console: {url}");
    }
}

fn display_logs(home: &Path, role: ServiceRole) {
    let directory = load(home, role)
        .ok()
        .and_then(|config| {
            config
                .environment
                .get("CODESESH_LOG_DIR")
                .map(|directory| config.directory.join(directory))
        })
        .unwrap_or_else(|| codesesh_core::app_paths::root(home).join("logs"));
    println!(
        "Service stdout/stderr: {}",
        path(home, role, "log").display()
    );
    println!("Application logs: {} (codesesh-*.log)", directory.display());
}

pub async fn dispatch(args: &crate::options::Args, home: &Path) -> Result<bool> {
    let Some((role, action)) = selection(args) else {
        return Ok(false);
    };
    ensure!(
        !args.watch || action == Action::Status,
        "--watch is only supported with status"
    );
    if action == Action::Status {
        display_logs(home, role);
        if args.watch && request(home, role, false).await.is_ok() {
            watch_status(home, role, None).await?;
        } else {
            match request(home, role, false).await {
                Ok(report) => display(role, &report),
                Err(_) => {
                    let enabled = path(home, role, "enabled").exists();
                    if enabled {
                        println!("{}: not responding", role.name());
                        println!("{}", native::status(home, role).await?);
                    } else {
                        println!("{}: stopped", role.name());
                        println!("Start with: codesesh {} start", role.name());
                    }
                    if let Ok(bytes) = std::fs::read(path(home, role, "last.json"))
                        && let Ok(last) = serde_json::from_slice::<Report>(&bytes)
                        && last.phase == "failed"
                    {
                        println!("Last exit: {} — {}", last.phase, last.detail);
                    }
                }
            }
        }
        return Ok(true);
    }
    if action == Action::Open {
        ensure!(role == ServiceRole::Hub, "Only Hub has a Web console");
        let report = request(home, role, false)
            .await
            .context("Hub is not running")?;
        crate::open_browser(
            report
                .url
                .as_deref()
                .context("Hub is still initializing; use hub status --watch")?,
        )
        .await?;
        return Ok(true);
    }
    let _action_lock = crate::node_identity::lock(home, &format!("service-{}.lock", role.name()))?;
    if matches!(action, Action::Stop | Action::Restart) {
        if request(home, role, true).await.is_ok() {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            while request(home, role, false).await.is_ok() {
                ensure!(
                    tokio::time::Instant::now() < deadline,
                    "Stop requested; the current operation is still finishing. Check status before restarting. No process was forcibly killed."
                );
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        native::stop(home, role).await?;
        let _stopped = crate::node_identity::lock(
            home,
            if role == ServiceRole::Hub {
                "hub.lock"
            } else {
                "collector.lock"
            },
        )
        .context("Service process is still running; stop was not confirmed")?;
        match std::fs::remove_file(path(home, role, "enabled")) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if action == Action::Stop {
            println!("{}: stopped", role.name());
            return Ok(true);
        }
    } else if let Ok(report) = request(home, role, false).await {
        display(role, &report);
        println!("Already started. Use restart to restart the saved configuration.");
        return Ok(true);
    }
    let _mode = crate::node_identity::mode_lock(home, true)?;
    let role_lock = crate::node_identity::lock(
        home,
        if role == ServiceRole::Hub {
            "hub.lock"
        } else {
            "collector.lock"
        },
    )?;

    let default_hub_start = {
        use clap::Parser;
        let mut defaults = crate::options::Args::parse_from(["codesesh", "hub", "start"]);
        defaults.no_open = args.no_open;
        serde_json::to_value(&defaults)? == serde_json::to_value(args)?
    };
    let saved = if (default_hub_start && path(home, role, "json").exists())
        || action == Action::Restart
        || matches!(
            &args.command,
            Some(crate::options::Role::Worker { hub: None, .. })
        ) {
        if role == ServiceRole::Worker && !path(home, role, "json").exists() {
            None
        } else {
            Some(load(home, role)?)
        }
    } else {
        None
    };
    let mut configured = saved
        .as_ref()
        .map(|config| config.args.clone())
        .unwrap_or_else(|| args.clone());
    let mut pairing = None;
    match configured
        .command
        .as_mut()
        .context("Missing service role")?
    {
        crate::options::Role::Hub {
            action,
            recover_data,
            ..
        } => {
            *action = None;
            ensure!(
                !*recover_data,
                "Run hub --recover-data in the foreground once before starting the service"
            );
        }
        crate::options::Role::Worker {
            action,
            hub,
            pair_token,
            pair_token_stdin,
            ..
        } => {
            *action = None;
            if hub.is_none() {
                let worker_path = codesesh_core::app_paths::root(home).join("worker.db");
                let binding = if worker_path.exists() {
                    codesesh_core::sync::WorkerStore::open(&worker_path)?.binding()?
                } else {
                    None
                };
                let (origin, _) = binding.context("Worker has not been paired yet. Start with: codesesh worker start --hub <Hub URL> --pair-token-stdin")?;
                eprintln!("Using existing Worker pairing: {origin}");
                *hub = Some(origin);
            }
            pairing = pair_token
                .take()
                .or_else(|| std::env::var("CODESESH_PAIRING_TOKEN").ok());
            if *pair_token_stdin {
                eprintln!("Pairing token:");
                let mut token = String::new();
                use std::io::{BufRead, Read};
                std::io::stdin().lock().take(512).read_line(&mut token)?;
                pairing = Some(token.trim().to_owned());
                *pair_token_stdin = false;
            }
            if let Some(token) = &pairing {
                ensure!(token.len() == 64, "Invalid pairing token length");
            }
        }
    }
    configured.watch = false;
    configured.service_run = None;
    configured.no_open = true;
    configured.plan()?;
    let config = Configuration {
        version: 1,
        args: configured,
        directory: saved
            .as_ref()
            .map(|config| config.directory.clone())
            .unwrap_or(std::env::current_dir()?),
        environment: saved
            .map(|config| config.environment)
            .unwrap_or_else(native::environment),
    };
    write_private(
        &path(home, role, "json"),
        &serde_json::to_vec_pretty(&config)?,
    )?;
    if let Some(token) = pairing {
        write_private(&path(home, role, "pairing"), token.as_bytes())?;
    }
    if role == ServiceRole::Hub && !args.no_open {
        write_private(&path(home, role, "open"), b"open")?;
    }
    let log = path(home, role, "log");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(log)?;
    match std::fs::remove_file(path(home, role, "last.json")) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    drop(role_lock);
    native::start(home, role).await?;
    write_private(&path(home, role, "enabled"), b"enabled")?;
    println!("{}: starting in the background.", role.name());
    display_logs(home, role);
    watch_status(home, role, Some(Duration::from_secs(10))).await?;
    Ok(true)
}

async fn watch_status(home: &Path, role: ServiceRole, limit: Option<Duration>) -> Result<()> {
    use indicatif::{ProgressBar, ProgressStyle};
    let bar = ProgressBar::new_spinner();
    bar.enable_steady_tick(Duration::from_millis(100));
    let started = tokio::time::Instant::now();
    let mut previous = String::new();
    let mut last_output = tokio::time::Instant::now();
    let mut missing_since = None;
    loop {
        if let Ok(report) = request(home, role, false).await {
            missing_since = None;
            bar.set_message(format!(
                "{}: {} — {}",
                role.name(),
                report.phase,
                report.detail
            ));
            if let Some((done, total)) = report.progress {
                bar.set_style(ProgressStyle::with_template(
                    "{msg} [{bar:24}] {pos}/{len} ({percent}%) {elapsed}",
                )?);
                bar.set_length(total);
                bar.set_position(done);
            } else {
                bar.set_style(ProgressStyle::with_template("{spinner} {msg} {elapsed}")?);
            }
            use std::io::IsTerminal;
            if previous != report.detail
                || (!std::io::stderr().is_terminal()
                    && last_output.elapsed() >= Duration::from_secs(5))
            {
                eprintln!(
                    "{}: {}{}",
                    role.name(),
                    report.detail,
                    report
                        .progress
                        .map(|(done, total)| format!(
                            " {done}/{total} ({:.0}%)",
                            done as f64 * 100.0 / total.max(1) as f64
                        ))
                        .unwrap_or_default()
                );
                previous = report.detail.clone();
                last_output = tokio::time::Instant::now();
            }
            if matches!(
                report.phase.as_str(),
                "ready" | "connected" | "offline" | "paused"
            ) {
                bar.finish_and_clear();
                display(role, &report);
                return Ok(());
            }
        } else {
            let missing = missing_since.get_or_insert_with(tokio::time::Instant::now);
            if missing.elapsed() >= Duration::from_secs(3) {
                if let Ok(bytes) = std::fs::read(path(home, role, "last.json"))
                    && let Ok(last) = serde_json::from_slice::<Report>(&bytes)
                    && chrono::Utc::now().timestamp_millis() - last.updated_at
                        < started.elapsed().as_millis() as i64 + 1000
                {
                    bar.finish_and_clear();
                    display(role, &last);
                    ensure!(
                        last.phase != "failed",
                        "Service failed. Service stdout/stderr: {}",
                        path(home, role, "log").display()
                    );
                    return Ok(());
                }
                if limit.is_none() {
                    bar.finish_and_clear();
                    anyhow::bail!(
                        "Service is no longer responding. Use status and inspect {}",
                        path(home, role, "log").display()
                    );
                }
            }
        }
        if limit.is_some_and(|limit| started.elapsed() >= limit) {
            bar.finish_and_clear();
            println!(
                "Still starting. Follow progress with: codesesh {} status --watch",
                role.name()
            );
            return Ok(());
        }
        tokio::select! {_=tokio::signal::ctrl_c()=>{bar.finish_and_clear();return Ok(());},_=tokio::time::sleep(Duration::from_millis(250))=>{}}
    }
}

pub async fn boot(role: ServiceRole, home: &Path) -> Result<crate::options::Args> {
    let config = load(home, role)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let descriptor = Descriptor {
        endpoint: format!("http://{}", listener.local_addr()?),
        token: uuid::Uuid::new_v4().to_string(),
    };
    let (stop, _) = watch::channel(false);
    let control = Control {
        descriptor: descriptor.clone(),
        last_path: path(home, role, "last.json"),
        pairing_path: path(home, role, "pairing"),
        report: Arc::new(Mutex::new(Report {
            pid: std::process::id(),
            phase: "starting".into(),
            detail: "Checking mode locks and legacy directory migration".into(),
            progress: None,
            url: None,
            updated_at: chrono::Utc::now().timestamp_millis(),
            stopping: false,
        })),
        stop,
    };
    CONTROL
        .set(control.clone())
        .map_err(|_| anyhow::anyhow!("Service control already initialized"))?;
    write_private(
        &path(home, role, "runtime.json"),
        &serde_json::to_vec(&descriptor)?,
    )?;
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            Router::new()
                .route("/status", get(control_status))
                .route("/stop", post(control_stop))
                .with_state(control),
        )
        .await;
    });
    let mut args = config.args;
    if let Some(crate::options::Role::Worker { pair_token, .. }) = &mut args.command {
        let secret = path(home, role, "pairing");
        if secret.exists() {
            *pair_token = Some(std::fs::read_to_string(&secret)?);
        }
    }
    Ok(args)
}
fn authorized(control: &Control, headers: &HeaderMap) -> bool {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    bool::from(token.as_bytes().ct_eq(control.descriptor.token.as_bytes()))
}
async fn control_status(
    State(control): State<Control>,
    headers: HeaderMap,
) -> Result<Json<Report>, StatusCode> {
    if !authorized(&control, &headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let mut report = control
        .report
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();
    report.stopping = *control.stop.borrow();
    Ok(Json(report))
}
async fn control_stop(
    State(control): State<Control>,
    headers: HeaderMap,
) -> Result<Json<Report>, StatusCode> {
    if !authorized(&control, &headers) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    control.stop.send_replace(true);
    control_status(State(control), headers).await
}
pub fn stopping() -> bool {
    CONTROL.get().is_some_and(|control| *control.stop.borrow())
}
pub async fn shutdown_requested() {
    if let Some(control) = CONTROL.get() {
        let mut stop = control.stop.subscribe();
        if !*stop.borrow() {
            let _ = stop.changed().await;
        }
    } else {
        std::future::pending::<()>().await;
    }
}
pub fn report(phase: &str, detail: &str, progress: Option<(u64, u64)>, url: Option<&str>) {
    if let Some(control) = CONTROL.get()
        && let Ok(mut report) = control.report.lock()
    {
        report.phase = phase.into();
        report.detail = detail.into();
        report.progress = progress;
        report.updated_at = chrono::Utc::now().timestamp_millis();
        if let Some(url) = url {
            report.url = Some(url.into());
        }
    }
}
pub fn finished(error: Option<&anyhow::Error>) {
    if let Some(error) = error {
        report("failed", &format!("{error:#}"), None, None);
    } else {
        report("stopped", "Service exited normally", None, None);
    }
    if let Some(control) = CONTROL.get()
        && let Ok(report) = control.report.lock()
        && let Ok(bytes) = serde_json::to_vec(&*report)
    {
        let _ = write_private(&control.last_path, &bytes);
    }
}

pub fn prepare_process() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    let Some(index) = args.iter().position(|arg| arg == "--service-run") else {
        return Ok(());
    };
    let role = match args.get(index + 1).map(String::as_str) {
        Some("hub") => ServiceRole::Hub,
        Some("worker") => ServiceRole::Worker,
        _ => anyhow::bail!("Invalid service role"),
    };
    let environment = codesesh_core::discovery::PathEnvironment::current()?;
    let config = load(&environment.home, role)?;
    std::env::set_current_dir(&config.directory)?;
    for (key, value) in config.environment {
        // This runs before the Tokio runtime or any application threads are created.
        unsafe {
            std::env::set_var(key, value);
        }
    }
    Ok(())
}

pub fn paired() {
    if let Some(control) = CONTROL.get() {
        let _ = std::fs::remove_file(&control.pairing_path);
    }
}

pub fn take_open_request(home: &Path) -> bool {
    std::fs::remove_file(path(home, ServiceRole::Hub, "open")).is_ok()
}
