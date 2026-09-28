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
