use crate::logging::AppLogger;
use anyhow::Result;
use codesesh_core::{
    pricing::{PricingController, PricingSnapshot},
    runtime::Runtime,
};
use std::time::Duration;

pub fn spawn(
    pricing: PricingController,
    runtime: Runtime,
    logger: AppLogger,
    url: &str,
) -> tokio::task::JoinHandle<()> {
    let url = url.to_owned();
    tokio::spawn(async move {
        let mut shutdown = runtime.shutdown_receiver();
        loop {
            let result = tokio::select! {
                result = refresh_once(&pricing, &runtime, &url, false) => result,
                _ = shutdown.changed() => return,
            };
            if let Err(error) = result {
                logger.warn(
                    "pricing.refresh.error",
                    &serde_json::json!({"error":format!("{error:#}")}),
                );
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(6*60*60)) => {},
                _ = shutdown.changed() => return,
            }
        }
    })
}

pub async fn refresh_once(
    pricing: &PricingController,
    runtime: &Runtime,
    url: &str,
    force: bool,
) -> Result<bool> {
    let download = pricing
        .refresh_from(url, Duration::from_secs(10), force)
        .await;
    if matches!(download, Ok(true)) {
        runtime.refresh_all();
    }
    // Startup must reconcile the usable local prices even if the download failed.
    reprice_history(runtime, pricing.snapshot()?);
    download
}

pub fn reprice_history(
    runtime: &Runtime,
    snapshot: PricingSnapshot,
) -> tokio::task::JoinHandle<Result<()>> {
    let runtime = runtime.clone();
    // Repricing must finish even if the browser that changed prices disconnects between batches.
    tokio::spawn(async move {
        let result = runtime.reprice_all(snapshot).await;
        if let Err(error) = &result
            && let Some(logger) = crate::logging::current()
        {
            logger.warn(
                "pricing.history.error",
                &serde_json::json!({"error":format!("{error:#}")}),
            );
        }
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use codesesh_core::{pricing::Pricing, wire::PricingHistoryPhase};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn forced_download_replaces_a_fresh_catalog_and_preserves_it_on_failure() {
        use axum::{Json, Router, routing::get};
        let home = tempfile::tempdir().unwrap();
        let pricing = PricingController::load(home.path());
        let runtime = Runtime::start(home.path().join("cache.db"), vec![], 1)
            .await
            .unwrap();
        let catalog = |model: &str| {
            Json(json!({"vendor":{"models":{model:{"cost":{"input":7,"output":11}}}}}))
        };
        let app = Router::new()
            .route("/old", get(async move || catalog("previous-model")))
            .route("/new", get(async move || catalog("new-model")))
            .route("/invalid", get(async || Json(json!({}))));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let old = format!("{origin}/old");
        let new = format!("{origin}/new");
        assert!(refresh_once(&pricing, &runtime, &old, false).await.unwrap());
        assert!(!refresh_once(&pricing, &runtime, &new, false).await.unwrap());
        let original_generation = pricing.generation();
        let cache_dir = home.path().join(".codesesh");
        let saved = home.path().join("previous-cache");
        std::fs::rename(&cache_dir, &saved).unwrap();
        std::fs::write(&cache_dir, "blocked directory").unwrap();
        assert!(refresh_once(&pricing, &runtime, &new, true).await.is_err());
        assert_eq!(pricing.generation(), original_generation);
        std::fs::remove_file(&cache_dir).unwrap();
        std::fs::rename(saved, cache_dir).unwrap();
        assert!(refresh_once(&pricing, &runtime, &new, true).await.unwrap());
        assert!(!refresh_once(&pricing, &runtime, &new, true).await.unwrap());
        let published = pricing.snapshot().unwrap().pricing;
        assert_eq!(
            published.list_official_models(Some("new-model"), 10).total,
            2
        );
        assert!(
            refresh_once(&pricing, &runtime, &format!("{origin}/invalid"), true)
                .await
                .is_err()
        );
        assert_eq!(pricing.generation(), published.generation());
        assert_eq!(
            Pricing::load(home.path()).generation(),
            published.generation()
        );
        runtime.shutdown().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn slow_or_failed_downloads_leave_local_prices_and_runtime_available() {
        for stale in [false, true] {
            for success in [false, true] {
                let home = tempfile::tempdir().unwrap();
                let path = home.path().join(".codesesh/models-dev-pricing.json");
                if stale {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    std::fs::write(&path, json!({"timestamp":1,"data":{"cached-model":{"inputCostPerToken":1,"outputCostPerToken":2}}}).to_string()).unwrap();
                }
                let pricing = PricingController::load(home.path());
                let generation = pricing.generation();
                assert_eq!(
                    pricing
                        .snapshot()
                        .unwrap()
                        .pricing
                        .resolve("cached-model")
                        .is_some(),
                    stale
                );
                let runtime = Runtime::start(home.path().join("cache.db"), vec![], 1)
                    .await
                    .unwrap();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://{}/prices", listener.local_addr().unwrap());
                let refresh_pricing = pricing.clone();
                let refresh_runtime = runtime.clone();
                let task = tokio::spawn(async move {
                    refresh_once(&refresh_pricing, &refresh_runtime, &url, false).await
                });
                let (mut stream, _) =
                    tokio::time::timeout(Duration::from_secs(5), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let mut request = [0; 8192];
                assert!(stream.read(&mut request).await.unwrap() > 0);
                assert!(!task.is_finished());
                assert_eq!(pricing.snapshot().unwrap().generation(), generation);
                tokio::time::timeout(Duration::from_secs(2), runtime.read(|_| Ok(())))
                    .await
                    .unwrap()
                    .unwrap();
                assert!(runtime.status().pricing_history.is_none());
                let status = if success { "200 OK" } else { "503 Unavailable" };
                let body = json!({"openai":{"models":{"downloaded-model":{"cost":{"input":7,"output":11}}}}}).to_string();
                stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                assert_eq!(task.await.unwrap().is_ok(), success);
                let mut statuses = runtime.statuses();
                tokio::time::timeout(
                    Duration::from_secs(5),
                    statuses.wait_for(|status| {
                        status.pricing_history.as_ref().is_some_and(|history| {
                            history.generation == pricing.generation()
                                && history.phase == PricingHistoryPhase::Current
                        })
                    }),
                )
                .await
                .unwrap()
                .unwrap();
                assert_eq!(pricing.generation() != generation, success);
                assert_eq!(
                    Pricing::load(home.path()).generation(),
                    pricing.generation()
                );
                runtime.shutdown().await.unwrap();
            }
        }
    }
}
