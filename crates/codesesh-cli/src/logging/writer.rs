use regex::Regex;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::SystemTime,
};

pub(super) struct Config {
    pub directory: PathBuf,
    pub path: PathBuf,
    pub prefix: String,
    pub max_file_bytes: usize,
    pub max_files: usize,
    pub max_directory_bytes: usize,
    pub max_age_ms: u64,
}
pub(super) struct Writer {
    config: Config,
    file: Option<File>,
    created: bool,
    prepared: bool,
    bytes: usize,
    rotation: usize,
    recovery: bool,
}
struct Managed {
    path: PathBuf,
    name: String,
    bytes: u64,
    modified: SystemTime,
    protected: bool,
}
static MANAGED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^codesesh(?:-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?:active|emergency|\d+)|-\d+|-\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+|-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-\d+)?\.log$").unwrap()
});
static ACTIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^codesesh-(\d+)(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(?:active|emergency))?\.log$").unwrap()
});
impl Writer {
    pub(super) fn new(config: Config) -> Self {
        Self {
            config,
            file: None,
            created: false,
            prepared: false,
            bytes: 0,
            rotation: 0,
            recovery: false,
        }
    }
    pub(super) fn append(&mut self, line: &[u8]) -> io::Result<()> {
        let result = self.append_inner(line);
        if result.is_err() {
            self.recovery = true;
            self.file = None;
        }
        result
    }
    fn append_inner(&mut self, line: &[u8]) -> io::Result<()> {
        self.open()?;
        if self.bytes > 0 && line.len() > self.config.max_file_bytes.saturating_sub(self.bytes) {
            self.rotate()?;
        }
        let file = self.file.as_mut().expect("opened log file");
        if self.recovery && self.bytes > 0 {
            file.write_all(b"\n")?;
            self.bytes += 1;
        }
        self.recovery = false;
        file.write_all(line)?;
        self.bytes += line.len();
        Ok(())
    }
    fn prepare(&mut self) -> io::Result<()> {
        if self.prepared {
            return Ok(());
        }
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&self.config.directory)?;
        private(&self.config.directory, true)?;
        for entry in fs::read_dir(&self.config.directory)? {
            let entry = entry?;
            if entry.file_type()?.is_file()
                && MANAGED.is_match(&entry.file_name().to_string_lossy())
            {
                private(&entry.path(), false)?;
            }
        }
        self.prepared = true;
        Ok(())
    }
    fn open(&mut self) -> io::Result<()> {
        if self.file.is_some() {
            return Ok(());
        }
        self.prepare()?;
        let mut options = OpenOptions::new();
        options.write(true).append(true);
        if !self.created {
            options.create_new(true);
        } else {
            options.create(true);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        if self.created {
            match fs::symlink_metadata(&self.config.path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "log path is a symbolic link",
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        let file = options.open(&self.config.path)?;
        self.created = true;
        self.bytes = file.metadata()?.len().try_into().unwrap_or(usize::MAX);
        private(&self.config.path, false)?;
        self.file = Some(file);
        self.prune()
    }
    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        self.rotation += 1;
        fs::rename(
            &self.config.path,
            self.config
                .directory
                .join(format!("{}-{}.log", self.config.prefix, self.rotation)),
        )?;
        self.created = false;
        self.bytes = 0;
        self.open()
    }
    pub(super) fn flush(&mut self) -> io::Result<()> {
        if let Some(file) = self.file.as_mut() {
            file.flush()?;
            file.sync_data()?;
        }
        Ok(())
    }
    pub(super) fn close(&mut self) -> io::Result<()> {
        let result = self.flush();
        self.file = None;
        result?;
        if self.prepared {
            self.prune()?;
        }
        Ok(())
    }
    fn prune(&self) -> io::Result<()> {
        let now = SystemTime::now();
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.config.directory)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type()?.is_file() || !MANAGED.is_match(&name) {
                continue;
            }
            let metadata = match fs::symlink_metadata(entry.path()) {
                Ok(m) if m.is_file() => m,
                Ok(_) => continue,
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e),
            };
            let protected = entry.path() == self.config.path
                || name == "codesesh.log"
                || ACTIVE
                    .captures(&name)
                    .and_then(|c| c[1].parse::<u32>().ok())
                    .is_some_and(alive);
            let file = Managed {
                path: entry.path(),
                name,
                bytes: metadata.len(),
                modified: metadata.modified()?,
                protected,
            };
            if !protected
                && now
                    .duration_since(file.modified)
                    .is_ok_and(|age| age.as_millis() > u128::from(self.config.max_age_ms))
            {
                remove(&file.path)?;
            } else {
                files.push(file)
            }
        }
        let mut total = files.iter().map(|f| f.bytes).sum::<u64>();
        let mut count = files.len();
        files.sort_by(|a, b| a.modified.cmp(&b.modified).then(a.name.cmp(&b.name)));
        for file in files {
            if count <= self.config.max_files && total <= self.config.max_directory_bytes as u64 {
                break;
            }
            if file.protected {
                continue;
            }
            remove(&file.path)?;
            total = total.saturating_sub(file.bytes);
            count -= 1;
        }
        Ok(())
    }
}
fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}
fn private(path: &Path, directory: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )
    }
    #[cfg(not(unix))]
    {
        let _ = (path, directory);
        Ok(())
    }
}
fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() {
        return true;
    }
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return true;
        };
        // Signal zero only checks process existence; EPERM also means the owner is alive.
        unsafe {
            libc::kill(pid, 0) == 0
                || io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output();
        output
            .map(|o| {
                !o.status.success()
                    || String::from_utf8_lossy(&o.stdout).contains(&format!(",\"{pid}\","))
            })
            .unwrap_or(true)
    }
    #[cfg(not(any(unix, windows)))]
    {
        true
    }
}
