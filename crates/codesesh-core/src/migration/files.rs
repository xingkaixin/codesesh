use super::Progress;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub(super) struct Fingerprint {
    pub path: PathBuf,
    pub hash: String,
    pub size: u64,
}

pub(super) fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).with_context(|| format!("Inspect {}", path.display())),
    }
}

pub(super) fn hash(path: &Path, report: &mut impl FnMut(Progress)) -> Result<String> {
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "Not a regular file: {}",
        path.display()
    );
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut digest = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    let mut done = 0;
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
        done += n as u64;
        report(Progress::new("Verifying", path, done, Some(size)));
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

pub(super) fn fingerprints(
    path: &Path,
    database: bool,
    report: &mut impl FnMut(Progress),
) -> Result<Vec<Fingerprint>> {
    let mut paths = vec![path.to_owned()];
    if database {
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut name = path.as_os_str().to_owned();
            name.push(suffix);
            paths.push(name.into());
        }
    }
    paths
        .into_iter()
        .filter_map(|path| match exists(&path) {
            Ok(false) => None,
            Ok(true) => Some(hash(&path, report).and_then(|hash| {
                Ok(Fingerprint {
                    size: fs::metadata(&path)?.len(),
                    path,
                    hash,
                })
            })),
            Err(e) => Some(Err(e)),
        })
        .collect()
}

pub(super) fn copy(source: &Path, target: &Path, report: &mut impl FnMut(Progress)) -> Result<()> {
    let mut input = File::open(source)?;
    let mut output = File::options().write(true).truncate(true).open(target)?;
    let size = input.metadata()?.len();
    let mut done = 0;
    let mut buffer = [0; 128 * 1024];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        output.write_all(&buffer[..n])?;
        done += n as u64;
        report(Progress::new("Migrating", source, done, Some(size)));
    }
    output.sync_all()?;
    ensure!(
        hash(source, report)? == hash(target, report)?,
        "File verification failed: {}",
        source.display()
    );
    Ok(())
}

pub(super) fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

pub(super) fn private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub(super) fn temporary(target: &Path) -> Result<tempfile::NamedTempFile> {
    let mut name = std::ffi::OsString::from(".migration-");
    name.push(
        target
            .file_name()
            .context("Migration target has no filename")?,
    );
    name.push(".tmp");
    let parent = target.parent().context("Migration target has no parent")?;
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut entry = name.clone();
        entry.push(suffix);
        let path = parent.join(entry);
        if exists(&path)? {
            fs::remove_file(&path)
                .with_context(|| format!("Remove interrupted migration file {}", path.display()))?;
        }
    }
    Ok(tempfile::Builder::new()
        .prefix(&name)
        .rand_bytes(0)
        .tempfile_in(parent)?)
}
