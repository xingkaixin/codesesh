use anyhow::{Result, ensure};
use codesesh_core::migration::{Options, Progress};
use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle};
use std::{
    io::{self, IsTerminal, Write},
    path::Path,
    time::Duration,
};

pub async fn run(args: &crate::options::Args, home: &Path) -> Result<Vec<String>> {
    let options = Options {
        home: home.to_owned(),
        environment: std::env::vars_os()
            .filter_map(|(k, v)| k.into_string().ok().map(|k| (k, v)))
            .collect(),
        state: !args.json && std::env::var("CODESESH_STATE_STORE").as_deref() != Ok("memory"),
        cache: args.cache && !args.no_cache,
        clear_cache: args.clear_cache,
    };
    let accepted = args.migrate_data;
    let interactive = io::stderr().is_terminal() && io::stdin().is_terminal();
    let animate = interactive && !args.json && std::env::var("TERM").as_deref() != Ok("dumb");
    tokio::task::spawn_blocking(move || {
        let bar = ProgressBar::with_draw_target(None, if animate { ProgressDrawTarget::stderr_with_hz(10) } else { ProgressDrawTarget::hidden() });
        bar.enable_steady_tick(Duration::from_millis(100));
        let mut previous = None;
        let result = codesesh_core::migration::run(options, |paths| {
            bar.suspend(|| -> Result<()> {
                eprintln!("CodeSesh needs to migrate these files:");
                for path in paths { eprintln!("  {}", path.display()); }
                if accepted { return Ok(()); }
                ensure!(interactive, "Stop older CodeSesh instances, then rerun with --migrate-data to confirm migration (or run in an interactive terminal).");
                eprint!("Stop any running older version of CodeSesh. Has it been stopped? [y/N] ");
                io::stderr().flush()?;
                let mut answer = String::new();
                io::stdin().read_line(&mut answer)?;
                ensure!(matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes"), "Migration cancelled; existing data was not changed.");
                Ok(())
            })
        }, |progress: Progress| {
            let key = (progress.phase, progress.path.clone(), progress.total.is_some());
            if previous.as_ref() != Some(&key) {
                if !animate { eprintln!("{}: {}", progress.phase, progress.path.display()); }
                let template = if progress.total.is_some() { "{msg} [{bar:24}] {pos}/{len} ({percent}%)" } else { "{spinner} {msg} {elapsed}" };
                bar.set_style(ProgressStyle::with_template(template).expect("valid progress template"));
                bar.set_position(0);
                previous = Some(key);
            }
            bar.set_message(format!("{} {}", progress.phase, progress.path.file_name().unwrap_or_default().to_string_lossy()));
            if let Some(total) = progress.total { bar.set_length(total); }
            bar.set_position(progress.done);
        });
        bar.finish_and_clear();
        let warnings = result?;
        if previous.is_some() { eprintln!("Data migration checks complete."); }
        for warning in &warnings { eprintln!("{warning}"); }
        Ok(warnings)
    }).await?
}
