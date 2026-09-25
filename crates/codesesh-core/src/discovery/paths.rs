use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct PathEnvironment {
    pub home: PathBuf,
    pub cwd: PathBuf,
    pub platform: String,
    pub variables: HashMap<String, String>,
}
impl PathEnvironment {
    pub fn current() -> std::io::Result<Self> {
        Ok(Self {
            home: std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from)
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "home directory is unavailable",
                    )
                })?,
            cwd: std::env::current_dir()?,
            platform: if cfg!(windows) {
                "win32"
            } else if cfg!(target_os = "macos") {
                "darwin"
            } else {
                "linux"
            }
            .into(),
            variables: std::env::vars().collect(),
        })
    }
    pub fn read_env_path(&self, name: &str) -> Option<PathBuf> {
        let value = self.variables.get(name)?.trim();
        if value.is_empty() {
            return None;
        }
        let path = if value == "~" {
            self.home.clone()
        } else if value.starts_with("~/") || value.starts_with("~\\") {
            self.home.join(&value[2..])
        } else {
            PathBuf::from(value)
        };
        Some(if path.is_absolute() {
            path
        } else {
            crate::projects::normalize_project_directory(&self.cwd.join(path).to_string_lossy())
                .into()
        })
    }
    fn home_path(&self, name: &str, fallback: &str) -> PathBuf {
        self.read_env_path(name)
            .unwrap_or_else(|| self.home.join(fallback))
    }
    pub fn data_home(&self) -> PathBuf {
        self.read_env_path("XDG_DATA_HOME").unwrap_or_else(|| {
            if self.platform == "win32" {
                self.read_env_path("LOCALAPPDATA")
                    .or_else(|| self.read_env_path("APPDATA"))
                    .unwrap_or_else(|| self.home.join("AppData/Local"))
            } else {
                self.home.join(".local/share")
            }
        })
    }
    fn desktop(&self, name: &str) -> PathBuf {
        match self.platform.as_str() {
            "darwin" => self.home.join("Library/Application Support").join(name),
            "win32" => self
                .read_env_path("APPDATA")
                .unwrap_or_else(|| self.home.join("AppData/Roaming"))
                .join(name),
            _ => self
                .read_env_path("XDG_CONFIG_HOME")
                .unwrap_or_else(|| self.home.join(".config"))
                .join(name),
        }
    }
    pub fn data_root(&self, agent: &str) -> Option<PathBuf> {
        Some(match agent {
            "claudecode" => self.home_path("CLAUDE_CONFIG_DIR", ".claude"),
            "codex" => self.home_path("CODEX_HOME", ".codex"),
            "kimi" => self.home_path("KIMI_SHARE_DIR", ".kimi"),
            "kimi-code" => self.home_path("KIMI_CODE_HOME", ".kimi-code"),
            "grok" => self.home_path("GROK_HOME", ".grok"),
            "pi" => self.home_path("PI_HOME", ".pi"),
            "dsh" => self.home_path("DSH_HOME", ".dsh"),
            "cursor" => match self.read_env_path("CURSOR_DATA_PATH") {
                Some(path) => path,
                None => {
                    let path = self.desktop("Cursor").join("User");
                    if !path.exists() {
                        return None;
                    }
                    path
                }
            },
            "deepchat" => self
                .read_env_path("DEEPCHAT_USER_DATA_DIR")
                .unwrap_or_else(|| self.desktop("DeepChat")),
            "cherrystudio" => self
                .read_env_path("CHERRYSTUDIO_USER_DATA_DIR")
                .unwrap_or_else(|| self.desktop("CherryStudio")),
            "opencode" => self
                .read_env_path("XDG_DATA_HOME")
                .unwrap_or_else(|| self.home.join(".local/share"))
                .join("opencode"),
            "zcode" if self.platform == "darwin" || self.platform == "win32" => {
                self.home.join(".zcode")
            }
            "minimax-code" => self
                .read_env_path("MINIMAX_DATA_DIR")
                .or_else(|| self.read_env_path("MAVIS_DATA_DIR"))
                .unwrap_or_else(|| {
                    let first = self.home.join(".minimax");
                    let second = self.home.join(".minimax-code");
                    if !first.join("v2/sqlite/runtime-state.sqlite").exists()
                        && second.join("v2/sqlite/runtime-state.sqlite").exists()
                    {
                        second
                    } else {
                        first
                    }
                }),
            _ => return None,
        })
    }
    pub fn source(&self, agent: &str) -> Option<AgentSource> {
        let data_root = self.data_root(agent)?;
        let fallback = self.cwd.join("data").join(agent);
        let primary = match agent {
            "claudecode" => data_root.join("projects"),
            "codex" | "kimi" | "kimi-code" | "grok" => data_root.join("sessions"),
            "pi" => data_root.join("agent/sessions"),
            "opencode" => {
                if let Some(value) = self
                    .variables
                    .get("OPENCODE_DB")
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                {
                    if value == ":memory:" {
                        return None;
                    }
                    let path = Path::new(value);
                    if path.is_absolute() {
                        path.to_owned()
                    } else {
                        data_root.join(path)
                    }
                } else {
                    let primary = data_root.join("opencode.db");
                    if primary.exists() {
                        primary
                    } else {
                        fallback.join("opencode.db")
                    }
                }
            }
            _ => data_root.clone(),
        };
        let scan_path = if matches!(agent, "claudecode" | "kimi" | "grok" | "pi")
            && !primary.exists()
            && fallback.exists()
        {
            fallback
        } else {
            primary
        };
        Some(AgentSource {
            agent: agent.into(),
            data_root,
            scan_path,
        })
    }
}

#[derive(Clone, Debug)]
pub struct AgentSource {
    pub agent: String,
    pub data_root: PathBuf,
    pub scan_path: PathBuf,
}
