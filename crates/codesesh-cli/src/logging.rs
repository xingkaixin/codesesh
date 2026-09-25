mod record;
mod writer;

use serde_json::Value;
use std::{
    collections::VecDeque,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, OnceLock, mpsc},
    thread,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}
impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
    fn parse(value: &str) -> Self {
        match value {
            "debug" => Self::Debug,
            "warn" => Self::Warn,
            "error" => Self::Error,
            _ => Self::Info,
        }
    }
    fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Default)]
pub struct LogContext {
    pub request_id: Option<String>,
    pub operation_id: Option<String>,
    pub publication_id: Option<String>,
}

#[derive(Default)]
pub struct LoggerOptions {
    pub log_dir: Option<PathBuf>,
    pub level: Option<Level>,
    pub max_file_bytes: Option<usize>,
    pub max_files: Option<usize>,
    pub max_directory_bytes: Option<usize>,
    pub max_age_ms: Option<u64>,
    pub max_queue_bytes: Option<usize>,
    pub max_record_bytes: Option<usize>,
}

#[derive(Clone)]
pub struct AppLogger {
    inner: Arc<Inner>,
    context: LogContext,
}
struct Inner {
    shared: Arc<Shared>,
    handle: Mutex<Option<thread::JoinHandle<()>>>,
    level: Level,
    path: PathBuf,
}
struct Shared {
    state: Mutex<Queue>,
    ready: Condvar,
    encoder: record::Encoder,
    max_queue_bytes: usize,
}
#[derive(Default)]
struct Queue {
    entries: VecDeque<Command>,
    bytes: usize,
    dropped: [u64; 4],
    sequence: u64,
    closed: bool,
    finished: bool,
    error: Option<io::ErrorKind>,
}
struct Entry {
    line: Vec<u8>,
    level: Level,
}
enum Command {
    Entry(Entry),
    Flush(mpsc::Sender<io::Result<()>>),
    Shutdown,
}

fn positive(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| {
            n.is_finite()
                && n.floor() > 0.0
                && n.floor() <= 9_007_199_254_740_991.0
                && n.floor() <= usize::MAX as f64
        })
        .map(|n| n.floor() as usize)
        .unwrap_or(fallback)
}
fn select(option: Option<usize>, name: &str, fallback: usize) -> usize {
    option
        .filter(|n| *n > 0)
        .unwrap_or_else(|| positive(name, fallback))
}
fn result(error: Option<io::ErrorKind>) -> io::Result<()> {
    match error {
        Some(kind) => Err(io::Error::new(kind, "log storage unavailable")),
        None => Ok(()),
    }
}

impl AppLogger {
    pub fn from_env() -> io::Result<Self> {
        Self::new(LoggerOptions::default())
    }
    pub fn new(options: LoggerOptions) -> io::Result<Self> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let directory = options
            .log_dir
            .or_else(|| std::env::var_os("CODESESH_LOG_DIR").map(PathBuf::from))
            .unwrap_or_else(|| {
                std::env::var_os("XDG_CACHE_HOME")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| home.join(".cache"))
                    .join("codesesh/logs")
            });
        let run_id = uuid::Uuid::new_v4().to_string();
        let prefix = format!("codesesh-{}-{run_id}", std::process::id());
        let path = directory.join(format!("{prefix}-active.log"));
        let config = writer::Config {
            directory,
            path: path.clone(),
            prefix,
            max_file_bytes: select(options.max_file_bytes, "CODESESH_LOG_MAX_BYTES", 5_000_000),
            max_files: select(options.max_files, "CODESESH_LOG_MAX_FILES", 10),
            max_directory_bytes: select(
                options.max_directory_bytes,
                "CODESESH_LOG_MAX_TOTAL_BYTES",
                50_000_000,
            ),
            max_age_ms: options.max_age_ms.filter(|n| *n > 0).unwrap_or_else(|| {
                positive("CODESESH_LOG_MAX_AGE_DAYS", 7)
                    .checked_mul(86_400_000)
                    .and_then(|n| u64::try_from(n).ok())
                    .unwrap_or(604_800_000)
            }),
        };
        let shared = Arc::new(Shared {
            state: Mutex::new(Queue::default()),
            ready: Condvar::new(),
            encoder: record::Encoder::new(
                run_id,
                select(
                    options.max_record_bytes,
                    "CODESESH_LOG_MAX_RECORD_BYTES",
                    64 * 1024,
                )
                .max(512),
                home,
            ),
            max_queue_bytes: select(
                options.max_queue_bytes,
                "CODESESH_LOG_MAX_QUEUE_BYTES",
                1_000_000,
            ),
        });
        let worker = Arc::clone(&shared);
        let handle = thread::Builder::new()
            .name("codesesh-log-writer".into())
            .spawn(move || drain(worker, config))?;
        Ok(Self {
            inner: Arc::new(Inner {
                shared,
                handle: Mutex::new(Some(handle)),
                level: options.level.unwrap_or_else(|| {
                    Level::parse(&std::env::var("CODESESH_LOG_LEVEL").unwrap_or_default())
                }),
                path,
            }),
            context: LogContext::default(),
        })
    }
    pub fn path(&self) -> &Path {
        &self.inner.path
    }
    pub fn with_context(&self, context: LogContext) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            context: LogContext {
                request_id: context
                    .request_id
                    .or_else(|| self.context.request_id.clone()),
                operation_id: context
                    .operation_id
                    .or_else(|| self.context.operation_id.clone()),
                publication_id: context
                    .publication_id
                    .or_else(|| self.context.publication_id.clone()),
            },
        }
    }
    pub fn emit(&self, level: Level, event: &str, data: &Value) {
        if level < self.inner.level {
            return;
        }
        let shared = &self.inner.shared;
        let mut queue = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if queue.closed {
            return;
        }
        queue.sequence += 1;
        let line = shared
            .encoder
            .encode(level, event, data, &self.context, queue.sequence);
        if line.len() > shared.max_queue_bytes {
            queue.dropped[level.index()] += 1;
            shared.ready.notify_all();
            return;
        }
        if queue.bytes + line.len() > shared.max_queue_bytes && level >= Level::Warn {
            let reclaimable: usize = queue
                .entries
                .iter()
                .filter_map(|command| match command {
                    Command::Entry(entry) if entry.level < level => Some(entry.line.len()),
                    _ => None,
                })
                .sum();
            if reclaimable < queue.bytes + line.len() - shared.max_queue_bytes {
                queue.dropped[level.index()] += 1;
                shared.ready.notify_all();
                return;
            }
            for candidate_level in [Level::Debug, Level::Info, Level::Warn] {
                if candidate_level >= level {
                    break;
                }
                let mut index = 0;
                while queue.bytes + line.len() > shared.max_queue_bytes
                    && index < queue.entries.len()
                {
                    let evict = matches!(&queue.entries[index],Command::Entry(entry) if entry.level==candidate_level);
                    if evict {
                        if let Some(Command::Entry(entry)) = queue.entries.remove(index) {
                            queue.bytes -= entry.line.len();
                            queue.dropped[entry.level.index()] += 1;
                        }
                    } else {
                        index += 1
                    }
                }
            }
        }
        if queue.bytes + line.len() > shared.max_queue_bytes {
            queue.dropped[level.index()] += 1;
        } else {
            queue.bytes += line.len();
            queue
                .entries
                .push_back(Command::Entry(Entry { line, level }));
        }
        shared.ready.notify_all();
    }
    pub fn debug(&self, event: &str, data: &Value) {
        self.emit(Level::Debug, event, data)
    }
    pub fn info(&self, event: &str, data: &Value) {
        self.emit(Level::Info, event, data)
    }
    pub fn warn(&self, event: &str, data: &Value) {
        self.emit(Level::Warn, event, data)
    }
    pub fn error(&self, event: &str, data: &Value) {
        self.emit(Level::Error, event, data)
    }
    pub fn flush(&self) -> io::Result<()> {
        let shared = &self.inner.shared;
        let (sender, receiver) = mpsc::channel();
        let mut queue = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if queue.closed {
            while !queue.finished {
                queue = shared.ready.wait(queue).unwrap_or_else(|e| e.into_inner());
            }
            return result(queue.error);
        }
        queue.entries.push_back(Command::Flush(sender));
        shared.ready.notify_all();
        drop(queue);
        receiver
            .recv()
            .map_err(|_| io::Error::other("log writer stopped"))?
    }
    pub fn shutdown(&self) -> io::Result<()> {
        self.inner.shutdown()
    }
}
impl Inner {
    fn shutdown(&self) -> io::Result<()> {
        let mut queue = self.shared.state.lock().unwrap_or_else(|e| e.into_inner());
        if !queue.closed {
            queue.closed = true;
            queue.entries.push_back(Command::Shutdown);
            self.shared.ready.notify_all();
        }
        while !queue.finished {
            queue = self
                .shared
                .ready
                .wait(queue)
                .unwrap_or_else(|e| e.into_inner());
        }
        let outcome = result(queue.error);
        drop(queue);
        if let Some(handle) = self.handle.lock().unwrap_or_else(|e| e.into_inner()).take() {
            handle
                .join()
                .map_err(|_| io::Error::other("log writer panicked"))?;
        }
        outcome
    }
}
impl Drop for Inner {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

fn drain(shared: Arc<Shared>, config: writer::Config) {
    let mut writer = writer::Writer::new(config);
    loop {
        let mut queue = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        while queue.entries.is_empty() && queue.dropped == [0; 4] {
            queue = shared.ready.wait(queue).unwrap_or_else(|e| e.into_inner());
        }
        if queue.dropped != [0; 4] {
            let dropped = std::mem::take(&mut queue.dropped);
            queue.sequence += 1;
            let line=shared.encoder.encode(Level::Warn,"logger.records_dropped",&serde_json::json!({"debug":dropped[0],"info":dropped[1],"warn":dropped[2],"error":dropped[3]}),&LogContext::default(),queue.sequence);
            drop(queue);
            report(&shared, writer.append(&line), true);
            continue;
        }
        let command = queue.entries.pop_front().expect("nonempty log queue");
        if let Command::Entry(entry) = &command {
            queue.bytes -= entry.line.len();
        }
        drop(queue);
        match command {
            Command::Entry(entry) => report(&shared, writer.append(&entry.line), true),
            Command::Flush(sender) => {
                report(&shared, writer.flush(), false);
                let queue = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                let _ = sender.send(result(queue.error));
            }
            Command::Shutdown => {
                report(&shared, writer.close(), false);
                let mut queue = shared.state.lock().unwrap_or_else(|e| e.into_inner());
                queue.finished = true;
                shared.ready.notify_all();
                return;
            }
        }
    }
}
fn report(shared: &Shared, outcome: io::Result<()>, recover: bool) {
    let mut queue = shared.state.lock().unwrap_or_else(|e| e.into_inner());
    match outcome {
        Ok(()) => {
            if recover {
                queue.error = None;
            }
        }
        Err(error) => {
            if queue.error.is_none() {
                eprintln!("[codesesh] Log storage unavailable ({:?})", error.kind());
            }
            queue.error = Some(error.kind());
        }
    }
}

static GLOBAL: OnceLock<AppLogger> = OnceLock::new();
pub fn initialize() -> io::Result<&'static AppLogger> {
    if GLOBAL.get().is_none() {
        let logger = AppLogger::from_env()?;
        let _ = GLOBAL.set(logger);
    }
    Ok(GLOBAL.get().expect("initialized logger"))
}
pub fn current() -> Option<&'static AppLogger> {
    GLOBAL.get()
}

#[cfg(test)]
mod tests;
