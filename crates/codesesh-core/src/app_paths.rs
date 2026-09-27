use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

pub fn root(home: &Path) -> PathBuf {
    home.join(".codesesh")
}

pub fn logs(home: &Path) -> PathBuf {
    std::env::var_os("CODESESH_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root(home).join("logs"))
}

pub fn legacy_state(
    home: &Path,
    platform: &str,
    env: impl Fn(&str) -> Option<OsString>,
) -> PathBuf {
    match platform {
        "darwin" | "macos" => home.join("Library/Application Support/codesesh"),
        "win32" | "windows" => env("APPDATA")
            .or_else(|| env("LOCALAPPDATA"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("codesesh"),
        _ => env("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("codesesh"),
    }
}
