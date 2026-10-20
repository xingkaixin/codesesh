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
    fn expand_home(&self, value: &str) -> Option<PathBuf> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        Some(if value == "~" {
            self.home.clone()
        } else if value.starts_with("~/") || value.starts_with("~\\") {
            self.home.join(&value[2..])
        } else {
            PathBuf::from(value)
        })
    }
    pub(crate) fn read_env_path(&self, name: &str) -> Option<PathBuf> {
        let path = self.expand_home(self.variables.get(name)?)?;
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
    #[cfg(test)]
    pub(crate) fn data_home(&self) -> PathBuf {
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
    fn pi_settings_session_dir(&self, agent_dir: &Path) -> Option<PathBuf> {
        let settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(agent_dir.join("settings.json")).ok()?).ok()?;
        // Pi resolves a relative sessionDir from the directory it runs in, which is unknown here.
        self.expand_home(settings["sessionDir"].as_str()?)
            .filter(|path| path.is_absolute())
    }
    pub(crate) fn data_root(&self, agent: &str) -> Option<PathBuf> {
        Some(match agent {
            "claudecode" => self.home_path("CLAUDE_CONFIG_DIR", ".claude"),
            "qoder" => self.home_path("QODER_CONFIG_DIR", ".qoder"),
            "qoder-cn" => self.home_path("QODERCN_CONFIG_DIR", ".qoder-cn"),
            "codex" => self.home_path("CODEX_HOME", ".codex"),
            "antigravity-cli" => self
                .read_env_path("AGY_CONVERSATIONS_DIR")
                .and_then(|path| path.parent().map(Path::to_owned))
                .unwrap_or_else(|| self.home.join(".gemini/antigravity-cli")),
            "gemini-cli" => self
                .read_env_path("GEMINI_CLI_HOME")
                .unwrap_or_else(|| self.home.clone())
                .join(".gemini"),
            "kimi" => self.home_path("KIMI_SHARE_DIR", ".kimi"),
            "kimi-code" => self.home_path("KIMI_CODE_HOME", ".kimi-code"),
            "grok" => self.home_path("GROK_HOME", ".grok"),
            "pi" => self.home_path("PI_CODING_AGENT_DIR", ".pi/agent"),
            "omp" => self.home.join(".omp"),
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
            "droid" => self
                .read_env_path("FACTORY_HOME_OVERRIDE")
                .unwrap_or_else(|| self.home.clone())
                .join(".factory"),
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
    pub(crate) fn source(&self, agent: &str) -> Option<AgentSource> {
        let data_root = self.data_root(agent)?;
        let fallback = self.cwd.join("data").join(agent);
        let primary = match agent {
            "antigravity-cli" => self
                .read_env_path("AGY_CONVERSATIONS_DIR")
                .unwrap_or_else(|| data_root.join("conversations")),
            "gemini-cli" => data_root.join("tmp"),
            "claudecode" | "qoder" | "qoder-cn" => data_root.join("projects"),
            "codex" | "kimi" | "kimi-code" | "grok" => data_root.join("sessions"),
            "droid" => data_root.join("sessions"),
            "pi" => self
                .read_env_path("PI_CODING_AGENT_SESSION_DIR")
                .or_else(|| self.pi_settings_session_dir(&data_root))
                .unwrap_or_else(|| data_root.join("sessions")),
            "omp" => match self.read_env_path("XDG_DATA_HOME") {
                Some(path) if self.platform != "win32" && path.join("omp").exists() => {
                    path.join("omp/sessions")
                }
                _ => data_root.join("agent/sessions"),
            },
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
                    let fallback = fallback.join("opencode.db");
                    if !primary.exists() && fallback.exists() {
                        fallback
                    } else {
                        primary
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
