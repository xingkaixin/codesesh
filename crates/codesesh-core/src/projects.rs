use crate::contract::ProjectIdentity;
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn path_identity(directory: &str) -> (ProjectIdentity, String) {
    let signature = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&["path", directory]).unwrap())
    );
    (
        ProjectIdentity {
            kind: "path".into(),
            key: directory.into(),
            display_name: Path::new(directory)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| directory.into()),
        },
        signature,
    )
}
