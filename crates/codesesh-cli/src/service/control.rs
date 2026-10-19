use super::{Descriptor, Report, ServiceRole, path, write_private};
use anyhow::Result;
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use subtle::ConstantTimeEq;
use tokio::sync::watch;

#[derive(Clone)]
struct Control {
    descriptor: Descriptor,
    report: Arc<Mutex<Report>>,
    last_path: PathBuf,
    pairing_path: PathBuf,
    stop: watch::Sender<bool>,
}
static CONTROL: OnceLock<Control> = OnceLock::new();

pub(super) async fn start(home: &Path, role: ServiceRole) -> Result<()> {
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
    Ok(())
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

pub fn paired() {
    if let Some(control) = CONTROL.get() {
        let _ = std::fs::remove_file(&control.pairing_path);
    }
}
