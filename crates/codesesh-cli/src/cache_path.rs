use anyhow::Result;
use codesesh_core::storage::Cache;
use std::path::{Path, PathBuf};

pub fn choose(path: &Path) -> Result<(PathBuf, Option<PathBuf>)> {
    match Cache::open(Some(path)) {
        Ok(_) => Ok((path.to_owned(), None)),
        Err(error) => {
            eprintln!(
                "Cache unavailable at {}: {error:#}; using a temporary cache.",
                path.display()
            );
            let directory =
                std::env::temp_dir().join(format!("codesesh-fallback-{}", uuid::Uuid::new_v4()));
            let fallback = directory.join("codesesh.db");
            Cache::open(Some(&fallback))?;
            Ok((fallback, Some(directory)))
        }
    }
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
