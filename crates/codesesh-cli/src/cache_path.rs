use anyhow::Result;
use codesesh_core::storage::Cache;
use std::path::{Path, PathBuf};

pub fn choose(path: &Path) -> Result<(PathBuf, Option<PathBuf>)> {
    match open(path) {
        Ok(_) => Ok((path.to_owned(), None)),
        Err(error) => {
            eprintln!(
                "Cache unavailable at {}: {error:#}; using a temporary cache.",
                path.display()
            );
            let directory =
                std::env::temp_dir().join(format!("codesesh-fallback-{}", uuid::Uuid::new_v4()));
            let fallback = directory.join("codesesh.db");
            open(&fallback)?;
            Ok((fallback, Some(directory)))
        }
    }
}

pub fn open(path: &Path) -> Result<Cache> {
    use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle};
    use std::{
        io::IsTerminal,
        time::{Duration, Instant},
    };
    let interactive = std::io::stderr().is_terminal();
    let bar = ProgressBar::with_draw_target(
        None,
        if interactive {
            ProgressDrawTarget::stderr_with_hz(10)
        } else {
            ProgressDrawTarget::hidden()
        },
    );
    let mut phase = String::new();
    let mut last_output = Instant::now();
    let result = Cache::open_with_progress(Some(path), |progress| {
        anyhow::ensure!(
            !crate::service::stopping(),
            "Database initialization cancelled; original database retained"
        );
        crate::service::report(
            "database",
            &progress.phase,
            progress.total.map(|total| (progress.done, total)),
            None,
        );
        let changed = phase != progress.phase;
        if changed {
            phase = progress.phase.clone();
            bar.reset_elapsed();
            bar.set_position(0);
            bar.set_message(phase.clone());
            bar.enable_steady_tick(Duration::from_millis(100));
        }
        let template = if progress.total.is_some_and(|total| total > 0) {
            "{msg} [{bar:24}] {pos}/{len} pages ({percent}%) {elapsed}"
        } else {
            "{spinner} {msg} {elapsed}"
        };
        bar.set_style(ProgressStyle::with_template(template).expect("valid progress template"));
        if let Some(total) = progress.total {
            bar.set_length(total);
        }
        bar.set_position(progress.done);
        if !interactive
            && (changed
                || last_output.elapsed() >= Duration::from_secs(5)
                || progress
                    .total
                    .is_some_and(|total| total > 0 && progress.done == total))
        {
            eprintln!(
                "{}{}",
                phase,
                progress
                    .total
                    .filter(|total| *total > 0)
                    .map(|total| format!(
                        " {}/{} ({:.0}%)",
                        progress.done,
                        total,
                        progress.done as f64 * 100.0 / total as f64
                    ))
                    .unwrap_or_default()
            );
            last_output = Instant::now();
        }
        Ok(())
    });
    bar.finish_and_clear();
    if !phase.is_empty() {
        eprintln!(
            "Database initialization {}.",
            if result.is_ok() {
                "complete"
            } else {
                "failed; see the error below"
            }
        );
    }
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn corrupt_database_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codesesh.db");
        std::fs::write(&path, b"not-a-SQLite").unwrap();
        let (chosen, cleanup) = super::choose(&path).unwrap();
        assert_ne!(chosen, path);
        assert_eq!(std::fs::read(path).unwrap(), b"not-a-SQLite");
        std::fs::remove_dir_all(cleanup.unwrap()).unwrap();
    }
}
