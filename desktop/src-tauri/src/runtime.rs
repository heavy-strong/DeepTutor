//! Lifecycle of the local DeepTutor runtime behind the desktop window.
//!
//! The shell does not reimplement `deeptutor start`; it plays the role of the
//! parent that `deeptutor start --detach` normally is. `deeptutor/runtime/launcher.py`
//! already defines a small file contract for that parent:
//!
//! * `<home>/data/user/runtime/launcher.json` — written by the parent with a
//!   `token` before spawning; the worker flips `status` to `"ready"` and adds
//!   `frontend_url` once both servers answer.
//! * `<home>/data/user/runtime/launcher.stop` — the parent writes the token
//!   here to request a graceful shutdown (what `deeptutor stop` does).
//!
//! Driving that contract means a window closed here stops both servers the
//! same way `deeptutor stop` would, and a runtime left by `deeptutor start
//! --detach` can simply be attached to.

use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{self, DesktopConfig};

pub const STATUS_EVENT: &str = "deeptutor:status";
const DETACHED_WORKER_ENV: &str = "DEEPTUTOR_DETACHED_WORKER";
const DETACHED_TOKEN_ENV: &str = "DEEPTUTOR_DETACHED_TOKEN";
const DESKTOP_ENV: &str = "DEEPTUTOR_DESKTOP";
const READY_TIMEOUT: Duration = Duration::from_secs(300);
const ATTACH_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const LOG_TAIL: usize = 200;
const DEFAULT_BACKEND_PORT: u16 = 8001;
const DEFAULT_FRONTEND_PORT: u16 = 3782;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Starting,
    Ready,
    Failed,
}

/// What the boot screen renders. Also the payload of every `STATUS_EVENT`.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub phase: Phase,
    pub message: String,
    pub url: Option<String>,
    pub home: String,
    pub log_path: Option<String>,
    pub config_path: Option<String>,
    pub attached: bool,
    pub lines: Vec<String>,
}

struct Inner {
    status: RuntimeStatus,
    lines: VecDeque<String>,
    child: Option<Child>,
    token: Option<String>,
    paths: Option<DetachedPaths>,
    generation: u64,
}

#[derive(Clone)]
pub struct Runtime(Arc<Mutex<Inner>>);

#[derive(Debug, Clone)]
struct DetachedPaths {
    state: PathBuf,
    stop: PathBuf,
    log: PathBuf,
}

impl DetachedPaths {
    fn for_home(home: &Path) -> Self {
        let root = home.join("data").join("user").join("runtime");
        Self {
            state: root.join("launcher.json"),
            stop: root.join("launcher.stop"),
            log: root.join("launcher.log"),
        }
    }
}

impl Runtime {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Inner {
            status: RuntimeStatus {
                phase: Phase::Starting,
                message: "Starting DeepTutor…".to_string(),
                url: None,
                home: String::new(),
                log_path: None,
                config_path: None,
                attached: false,
                lines: Vec::new(),
            },
            lines: VecDeque::new(),
            child: None,
            token: None,
            paths: None,
            generation: 0,
        })))
    }

    pub fn status(&self) -> RuntimeStatus {
        let inner = self.0.lock().unwrap();
        let mut status = inner.status.clone();
        status.lines = inner.lines.iter().cloned().collect();
        status
    }

    fn update(&self, app: &AppHandle, f: impl FnOnce(&mut RuntimeStatus)) {
        let status = {
            let mut inner = self.0.lock().unwrap();
            f(&mut inner.status);
            let mut status = inner.status.clone();
            status.lines = inner.lines.iter().cloned().collect();
            status
        };
        if cfg!(debug_assertions) {
            eprintln!("[deeptutor-desktop] {:?}: {}", status.phase, status.message);
        }
        let _ = app.emit(STATUS_EVENT, status);
    }

    fn push_line(&self, app: &AppHandle, line: String) {
        let line = strip_ansi(&line);
        let status = {
            let mut inner = self.0.lock().unwrap();
            if inner.lines.len() >= LOG_TAIL {
                inner.lines.pop_front();
            }
            if cfg!(debug_assertions) {
                eprintln!("[deeptutor] {line}");
            }
            inner.lines.push_back(line);
            let mut status = inner.status.clone();
            status.lines = inner.lines.iter().cloned().collect();
            status
        };
        let _ = app.emit(STATUS_EVENT, status);
    }

    /// Launch (or attach to) the runtime on a background thread. Each call
    /// bumps a generation counter so a stale worker thread from a previous
    /// attempt can no longer flip the status.
    pub fn start(&self, app: AppHandle) {
        let generation = {
            let mut inner = self.0.lock().unwrap();
            inner.generation += 1;
            inner.lines.clear();
            inner.generation
        };
        let runtime = self.clone();
        thread::Builder::new()
            .name("deeptutor-runtime".into())
            .spawn(move || {
                let config = config::load(&app);
                runtime.update(&app, |s| {
                    s.phase = Phase::Starting;
                    s.message = "Starting DeepTutor…".to_string();
                    s.url = None;
                    s.home = config.home.display().to_string();
                    s.config_path = config.config_path.as_ref().map(|p| p.display().to_string());
                    s.log_path = None;
                    s.attached = false;
                });
                match runtime.boot(&app, &config, generation) {
                    Ok(url) => {
                        if runtime.is_current(generation) {
                            runtime.update(&app, |s| {
                                s.phase = Phase::Ready;
                                s.message = "DeepTutor is ready.".to_string();
                                s.url = Some(url.clone());
                            });
                            navigate(&app, &url);
                        }
                    }
                    Err(message) => {
                        if runtime.is_current(generation) {
                            runtime.stop_owned();
                            runtime.update(&app, |s| {
                                s.phase = Phase::Failed;
                                s.message = message;
                            });
                        }
                    }
                }
            })
            .expect("spawn runtime thread");
    }

    fn is_current(&self, generation: u64) -> bool {
        self.0.lock().unwrap().generation == generation
    }

    fn boot(
        &self,
        app: &AppHandle,
        config: &DesktopConfig,
        generation: u64,
    ) -> Result<String, String> {
        if let Some(url) = &config.url {
            self.push_line(app, format!("Attaching to {url} ({} set)", config::URL_ENV));
            self.update(app, |s| s.attached = true);
            return wait_for_http(url, ATTACH_TIMEOUT, || !self.is_current(generation))
                .map(|_| url.clone());
        }

        let home = &config.home;
        let paths = DetachedPaths::for_home(home);
        self.update(app, |s| s.log_path = Some(paths.log.display().to_string()));

        // A runtime started by `deeptutor start --detach` (or a previous shell
        // that did not get to clean up) is reused rather than fought over ports.
        if let Some(url) = existing_ready_url(home, &paths) {
            self.push_line(app, format!("Attaching to running DeepTutor at {url}"));
            self.update(app, |s| s.attached = true);
            return Ok(url);
        }

        let (program, mut args) = resolve_command(config)?;
        args.push("--home".into());
        args.push(home.display().to_string());
        args.push("--no-browser".into());
        if config.dev {
            args.push("--dev".into());
        }
        self.push_line(app, format!("Workspace: {}", home.display()));
        self.push_line(
            app,
            format!("Command: {} {}", program.display(), args.join(" ")),
        );

        let token = new_token();
        fs::create_dir_all(paths.state.parent().unwrap()).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&paths.stop);
        write_json(
            &paths.state,
            &json!({
                "version": 1,
                "token": token,
                "pid": Value::Null,
                "status": "starting",
                "home": home.display().to_string(),
                "log": paths.log.display().to_string(),
                "dev": config.dev,
                "started_at": unix_now(),
                "desktop": true,
            }),
        )?;

        let mut command = Command::new(&program);
        command
            .args(&args)
            .current_dir(home)
            .env(config::HOME_ENV, home.as_os_str())
            .env(DETACHED_WORKER_ENV, "1")
            .env(DETACHED_TOKEN_ENV, &token)
            .env(DESKTOP_ENV, "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8:replace")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        platform::prepare(&mut command);

        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start `{}`: {e}", program.display()))?;
        let pid = child.id();
        // `deeptutor stop` and the launcher's own "already running" check key
        // off a live pid, so record it now that we know it.
        if let Some(mut state) = read_json(&paths.state) {
            state["pid"] = json!(pid);
            write_json(&paths.state, &state)?;
        }

        let stdout = child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>);
        let stderr = child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>);
        {
            let mut inner = self.0.lock().unwrap();
            inner.child = Some(child);
            inner.token = Some(token.clone());
            inner.paths = Some(paths.clone());
        }
        for pipe in [stdout, stderr].into_iter().flatten() {
            self.pump(app.clone(), pipe, paths.log.clone());
        }

        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if !self.is_current(generation) {
                return Err("Superseded by a newer start attempt.".into());
            }
            if let Some(code) = self.try_wait_child() {
                return Err(format!(
                    "DeepTutor exited during startup (exit code {code}). See the log below."
                ));
            }
            if let Some(state) = read_json(&paths.state) {
                if state["token"].as_str() == Some(token.as_str())
                    && state["status"].as_str() == Some("ready")
                {
                    if let Some(url) = state["frontend_url"].as_str() {
                        let url = normalize_loopback(url);
                        wait_for_http(&url, Duration::from_secs(30), || {
                            !self.is_current(generation)
                        })?;
                        return Ok(url);
                    }
                }
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "DeepTutor did not become ready within {} seconds.",
                    READY_TIMEOUT.as_secs()
                ));
            }
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn try_wait_child(&self) -> Option<i32> {
        let mut inner = self.0.lock().unwrap();
        let child = inner.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            _ => None,
        }
    }

    fn pump(&self, app: AppHandle, pipe: Box<dyn Read + Send>, log_path: PathBuf) {
        let runtime = self.clone();
        thread::spawn(move || {
            let mut log = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
                .ok();
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                if let Some(log) = log.as_mut() {
                    let _ = writeln!(log, "{line}");
                }
                runtime.push_line(&app, line);
            }
        });
    }

    /// Stop a runtime this shell launched. Runtimes we merely attached to are
    /// left alone — they belong to whoever started them.
    pub fn stop_owned(&self) {
        let (child, token, paths) = {
            let mut inner = self.0.lock().unwrap();
            (inner.child.take(), inner.token.take(), inner.paths.take())
        };
        let Some(mut child) = child else { return };
        if let (Some(token), Some(paths)) = (&token, &paths) {
            let _ = fs::write(&paths.stop, token);
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        if !matches!(child.try_wait(), Ok(Some(_))) {
            platform::kill_tree(&mut child);
            let _ = child.wait();
        }
        if let (Some(token), Some(paths)) = (token, paths) {
            if read_json(&paths.state)
                .map(|state| state["token"].as_str() == Some(token.as_str()))
                .unwrap_or(false)
            {
                let _ = fs::remove_file(&paths.state);
            }
            let _ = fs::remove_file(&paths.stop);
        }
    }
}

fn navigate(app: &AppHandle, url: &str) {
    let handle = app.clone();
    let url = url.to_string();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            if let Ok(parsed) = url.parse() {
                let _ = window.navigate(parsed);
            }
        }
    });
}

/// The frontend URL of a DeepTutor that is already serving this workspace.
///
/// Two sources: the detached-launcher state file (a `deeptutor start --detach`
/// or an earlier shell), and the configured ports themselves — someone may have
/// `deeptutor start` running in a terminal, and the launcher would refuse to
/// start a second backend on the same port. The backend's `/` banner is what
/// tells DeepTutor apart from an unrelated service on that port.
fn existing_ready_url(home: &Path, paths: &DetachedPaths) -> Option<String> {
    let probe = Duration::from_secs(2);
    if let Some(state) = read_json(&paths.state) {
        if state["status"].as_str() == Some("ready") {
            if let Some(url) = state["frontend_url"].as_str() {
                let url = normalize_loopback(url);
                if http_ready(&url, probe) {
                    return Some(url);
                }
            }
        }
    }
    let (backend_port, frontend_port) = configured_ports(home);
    let banner = http_get(&format!("http://127.0.0.1:{backend_port}/"), probe)?;
    if !banner.contains("DeepTutor") {
        return None;
    }
    let url = format!("http://127.0.0.1:{frontend_port}");
    http_ready(&url, probe).then_some(url)
}

/// `(backend_port, frontend_port)` from `data/user/settings/system.json`,
/// falling back to the launcher's defaults.
fn configured_ports(home: &Path) -> (u16, u16) {
    let system = read_json(
        &home
            .join("data")
            .join("user")
            .join("settings")
            .join("system.json"),
    );
    let port = |key: &str, default: u16| {
        system
            .as_ref()
            .and_then(|v| v[key].as_u64())
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0)
            .unwrap_or(default)
    };
    (
        port("backend_port", DEFAULT_BACKEND_PORT),
        port("frontend_port", DEFAULT_FRONTEND_PORT),
    )
}

/// The launcher advertises `http://localhost:<port>`; the webview should not
/// depend on the OS resolving `localhost` to the same family the server bound.
fn normalize_loopback(url: &str) -> String {
    url.replacen("://localhost:", "://127.0.0.1:", 1)
        .replacen("://localhost/", "://127.0.0.1/", 1)
}

/// Locate `deeptutor start`, mirroring `start_deeptutor.command`: explicit
/// overrides, the workspace's own virtualenv, then whatever is on PATH.
fn resolve_command(config: &DesktopConfig) -> Result<(PathBuf, Vec<String>), String> {
    let module_args = || {
        vec![
            "-m".to_string(),
            "deeptutor_cli.main".to_string(),
            "start".to_string(),
        ]
    };
    if let Some(command) = &config.command {
        return Ok((command.clone(), vec!["start".into()]));
    }
    if let Some(python) = &config.python {
        return Ok((python.clone(), module_args()));
    }
    for candidate in [
        config.home.join(".venv").join("Scripts").join("python.exe"),
        config.home.join(".venv").join("bin").join("python"),
    ] {
        if candidate.is_file() && python_has_deeptutor(&candidate) {
            return Ok((candidate, module_args()));
        }
    }
    if let Some(deeptutor) = which("deeptutor") {
        return Ok((deeptutor, vec!["start".into()]));
    }
    for name in ["python3", "python"] {
        if let Some(python) = which(name) {
            if python_has_deeptutor(&python) {
                return Ok((python, module_args()));
            }
        }
    }
    Err(format!(
        "Could not find a DeepTutor installation.\n\
         Install it (`pip install deeptutor`, or `pip install -e .` inside a checkout with a `.venv`), \
         or point the shell at one with {} / {} or `python` / `command` in {}.",
        config::PYTHON_ENV,
        config::COMMAND_ENV,
        config
            .config_path
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| config::CONFIG_FILE.to_string()),
    ))
}

fn python_has_deeptutor(python: &Path) -> bool {
    let mut command = Command::new(python);
    command
        .args(["-c", "import deeptutor_cli.main"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    platform::prepare(&mut command);
    command.status().map(|s| s.success()).unwrap_or(false)
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
            name.to_string(),
        ]
    } else {
        vec![name.to_string()]
    };
    for dir in std::env::split_paths(&path) {
        for file in &names {
            let candidate = dir.join(file);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn wait_for_http(url: &str, timeout: Duration, cancelled: impl Fn() -> bool) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cancelled() {
            return Err("Superseded by a newer start attempt.".into());
        }
        if http_ready(url, Duration::from_secs(2)) {
            return Ok(());
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err(format!(
        "{url} did not answer within {} seconds.",
        timeout.as_secs()
    ))
}

/// Minimal readiness probe: any HTTP status line counts, exactly like the
/// launcher's own `_http_ready`. Avoids pulling an HTTP client into the shell.
fn http_ready(url: &str, timeout: Duration) -> bool {
    http_get(url, timeout).is_some()
}

/// Raw `GET`; returns the first few KB of the response (headers + body) when
/// the peer speaks HTTP at all.
fn http_get(url: &str, timeout: Duration) -> Option<String> {
    let (host, port, path) = split_http_url(url)?;
    let addr = (host.as_str(), port).to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&addr, timeout).ok()?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut buf = Vec::with_capacity(4096);
    let _ = stream.take(4096).read_to_end(&mut buf);
    if !buf.starts_with(b"HTTP/") {
        return None;
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn split_http_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (authority, 80),
    };
    Some((host.to_string(), port, path.to_string()))
}

/// npm and Next colour their output even without a TTY; the boot screen is
/// plain text.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 32 hex characters, like the launcher's own `secrets.token_hex(16)`. This is
/// a handle for a local stop file, not a secret that leaves the machine, so a
/// time/pid-seeded xorshift is enough and keeps `rand` out of the shell.
fn new_token() -> String {
    let mut seed =
        unix_now().to_bits() ^ (std::process::id() as u64).rotate_left(32) ^ 0x9E37_79B9_7F4A_7C15;
    let mut out = String::with_capacity(32);
    for _ in 0..4 {
        seed ^= seed >> 12;
        seed ^= seed << 25;
        seed ^= seed >> 27;
        out.push_str(&format!("{:016x}", seed.wrapping_mul(0x2545_F491_4F6C_DD1D))[..8]);
    }
    out
}

mod platform {
    use std::process::{Child, Command};

    #[cfg(windows)]
    pub fn prepare(command: &mut Command) {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    pub fn prepare(command: &mut Command) {
        use std::os::unix::process::CommandExt;
        // Own process group so the whole backend/frontend tree can be signalled.
        command.process_group(0);
    }

    #[cfg(windows)]
    pub fn kill_tree(child: &mut Child) {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let _ = child.kill();
    }

    #[cfg(not(windows))]
    pub fn kill_tree(child: &mut Child) {
        let pgid = format!("-{}", child.id());
        let _ = Command::new("kill").args(["-TERM", "--", &pgid]).status();
        std::thread::sleep(std::time::Duration::from_secs(2));
        let _ = Command::new("kill").args(["-KILL", "--", &pgid]).status();
        let _ = child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_http_urls() {
        assert_eq!(
            split_http_url("http://127.0.0.1:3782/"),
            Some(("127.0.0.1".into(), 3782, "/".into()))
        );
        assert_eq!(
            split_http_url("http://localhost:3000"),
            Some(("localhost".into(), 3000, "/".into()))
        );
        assert_eq!(split_http_url("https://example.com/"), None);
    }

    #[test]
    fn rewrites_localhost_only_once() {
        assert_eq!(
            normalize_loopback("http://localhost:3782"),
            "http://127.0.0.1:3782"
        );
        assert_eq!(
            normalize_loopback("http://127.0.0.1:3782/"),
            "http://127.0.0.1:3782/"
        );
    }

    #[test]
    fn strips_sgr_sequences() {
        assert_eq!(strip_ansi("\u{1b}[31m\u{1b}[1m>\u{1b}[0m plain"), "> plain");
        assert_eq!(strip_ansi("no escapes"), "no escapes");
    }

    #[test]
    fn tokens_look_like_token_hex() {
        let token = new_token();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
