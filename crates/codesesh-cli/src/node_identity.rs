use anyhow::{Context, Result};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::Path,
};

fn private_file(path: &Path) -> Result<OpenOptions> {
    std::fs::create_dir_all(path.parent().context("Missing state directory")?)?;
    let mut options = OpenOptions::new();
    options.write(true).read(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options)
}

pub fn lock(home: &Path, name: &str) -> Result<File> {
    let path = codesesh_core::app_paths::root(home).join(name);
    let file = private_file(&path)?.open(path)?;
    file.try_lock()
        .context("Another CodeSesh process already owns this role on this machine")?;
    Ok(file)
}

pub fn hub_id(home: &Path) -> Result<String> {
    let path = codesesh_core::app_paths::root(home).join("hub-identity");
    if path.exists() {
        let value = std::fs::read_to_string(&path)?;
        uuid::Uuid::parse_str(value.trim())
            .context("Hub identity is invalid; preserve the file for recovery")?;
        return Ok(value.trim().to_owned());
    }
    let identity = uuid::Uuid::new_v4().to_string();
    let mut file = private_file(&path)?.create_new(true).open(path)?;
    file.write_all(identity.as_bytes())?;
    file.sync_all()?;
    Ok(identity)
}

pub fn mode_lock(home: &Path, distributed: bool) -> Result<File> {
    let root = codesesh_core::app_paths::root(home);
    let switch =
        private_file(&root.join("mode-switch.lock"))?.open(root.join("mode-switch.lock"))?;
    switch.lock()?;
    anyhow::ensure!(
        distributed
            || !(root.join("services/hub.enabled").exists()
                || root.join("services/worker.enabled").exists()),
        "Hub or Worker service is enabled. Run codesesh hub stop and codesesh worker stop before returning to standalone mode."
    );
    let (own, other) = if distributed {
        ("distributed-mode.lock", "standalone-mode.lock")
    } else {
        ("standalone-mode.lock", "distributed-mode.lock")
    };
    let other = private_file(&root.join(other))?.open(root.join(other))?;
    other.try_lock().context(if distributed {
        "Standalone CodeSesh is running. Stop it before starting Hub or Worker."
    } else {
        "Hub or Worker is running. Stop both before returning to standalone mode."
    })?;
    let own = private_file(&root.join(own))?.open(root.join(own))?;
    own.try_lock_shared()?;
    Ok(own)
}

pub fn local_worker_key(home: &Path) -> Result<String> {
    let path = codesesh_core::app_paths::root(home).join("local-worker-key");
    if path.exists() {
        let value = std::fs::read_to_string(&path)?;
        anyhow::ensure!(
            value.len() == 64,
            "Invalid local Worker key; preserve the file for recovery"
        );
        return Ok(value);
    }
    let value = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut file = private_file(&path)?.create_new(true).open(path)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    Ok(value)
}
