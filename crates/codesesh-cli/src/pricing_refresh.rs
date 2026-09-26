use crate::logging::AppLogger;
use anyhow::Result;
use codesesh_core::{pricing::PricingController, runtime::Runtime};
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
        let refresh = async {
            let previous = pricing.generation();
            if pricing.refresh_from(&url, Duration::from_secs(10)).await? {
                let publish = pricing.clone();
                tokio::task::spawn_blocking(move || publish.publish_pending()).await??;
                if pricing.generation() != previous {
                    runtime.refresh_all();
                }
            }
            Ok::<_, anyhow::Error>(())
        };
        let result: Result<()> = tokio::select! {
            result = refresh => result,
            _ = shutdown.changed() => return,
        };
        if let Err(error) = result {
            logger.warn(
                "pricing.refresh.error",
                &serde_json::json!({"error":format!("{error:#}")}),
            );
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::LoggerOptions;
    use codesesh_core::pricing::Pricing;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn slow_or_failed_downloads_leave_local_prices_and_runtime_available() {
        for stale in [false, true] {
            for success in [false, true] {
                let home = tempfile::tempdir().unwrap();
                let path = home.path().join(".cache/codesesh/models-dev-pricing.json");
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
                let logger = AppLogger::new(LoggerOptions {
                    log_dir: Some(home.path().join("logs")),
                    ..Default::default()
                })
                .unwrap();
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://{}/prices", listener.local_addr().unwrap());
                let task = spawn(pricing.clone(), runtime.clone(), logger.clone(), &url);
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
                let status = if success { "200 OK" } else { "503 Unavailable" };
                let body = json!({"openai":{"models":{"downloaded-model":{"cost":{"input":7,"output":11}}}}}).to_string();
                stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                task.await.unwrap();
                assert_eq!(pricing.generation() != generation, success);
                assert_eq!(
                    Pricing::load(home.path()).generation(),
                    pricing.generation()
                );
                runtime.shutdown().await.unwrap();
                logger.shutdown().unwrap();
            }
        }
    }
}
