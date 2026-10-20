use anyhow::{Context, Result};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
};

pub(crate) fn is_rollout(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.starts_with("rollout-")
                && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zst"))
        })
}

pub(crate) fn logical_path(path: &Path) -> PathBuf {
    if path.extension().is_some_and(|ext| ext == "zst") {
        path.with_extension("")
    } else {
        path.to_owned()
    }
}

pub(crate) fn physical_path(path: &Path) -> io::Result<Option<PathBuf>> {
    let plain = logical_path(path);
    for candidate in [plain.clone(), plain.with_extension("jsonl.zst")] {
        match std::fs::metadata(&candidate) {
            Ok(metadata) if metadata.is_file() => return Ok(Some(candidate)),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

pub(crate) fn paths(root: &Path) -> Result<Vec<PathBuf>> {
    Ok(files(root)?.into_keys().collect())
}

/// Logical rollout paths mapped to the file `physical_path` would choose, without a `stat` per file.
pub(crate) fn files(root: &Path) -> Result<BTreeMap<PathBuf, PathBuf>> {
    let mut files = BTreeMap::new();
    for name in ["sessions", "archived_sessions"] {
        let directory = root.join(name);
        if !directory.try_exists()? {
            continue;
        }
        for entry in walkdir::WalkDir::new(directory).follow_links(false) {
            let entry = entry.context("enumerating Codex sources")?;
            if entry.file_type().is_file() && is_rollout(entry.path()) {
                let logical = logical_path(entry.path());
                let plain = logical == entry.path();
                let physical = files
                    .entry(logical)
                    .or_insert_with(|| entry.path().to_owned());
                if plain {
                    *physical = entry.path().to_owned();
                }
            }
        }
    }
    Ok(files)
}

pub(crate) fn open(path: &Path) -> Result<(Box<dyn Read>, PathBuf)> {
    // Compression and resume replace the physical file while retaining the logical source.
    for attempt in 0..3 {
        let physical = physical_path(path)?.unwrap_or_else(|| logical_path(path));
        match File::open(&physical) {
            Ok(file) => {
                let reader: Box<dyn Read> = if physical.extension().is_some_and(|ext| ext == "zst")
                {
                    Box::new(zstd::stream::read::Decoder::new(file)?)
                } else {
                    Box::new(file)
                };
                return Ok((reader, physical));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound && attempt < 2 => {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => return Err(error).with_context(|| format!("reading {}", path.display())),
        }
    }
    unreachable!()
}
