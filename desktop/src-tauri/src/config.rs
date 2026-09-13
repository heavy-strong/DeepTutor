//! Where the desktop shell finds the DeepTutor runtime.
//!
//! Resolution order for every setting: process environment, then
//! `<app config dir>/desktop.json`, then a built-in default. Environment wins so
//! a terminal launch (`DEEPTUTOR_HOME=... deeptutor-desktop`) behaves exactly like
//! `deeptutor start`, while the JSON file serves double-click launches.

use std::env;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

pub const HOME_ENV: &str = "DEEPTUTOR_HOME";
pub const URL_ENV: &str = "DEEPTUTOR_DESKTOP_URL";
pub const PYTHON_ENV: &str = "DEEPTUTOR_DESKTOP_PYTHON";
pub const COMMAND_ENV: &str = "DEEPTUTOR_DESKTOP_COMMAND";
pub const DEV_ENV: &str = "DEEPTUTOR_DESKTOP_DEV";
pub const CONFIG_FILE: &str = "desktop.json";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct FileConfig {
    /// Attach to an already running DeepTutor instead of launching one.
    url: Option<String>,
    /// Runtime workspace root (the `--home` passed to `deeptutor start`).
    home: Option<String>,
    /// Python interpreter that has `deeptutor` installed.
    python: Option<String>,
    /// Explicit `deeptutor` executable (takes precedence over `python`).
    command: Option<String>,
    /// Run the Next.js dev server instead of the production bundle.
    dev: bool,
}

#[derive(Debug, Clone)]
pub struct DesktopConfig {
    pub url: Option<String>,
    pub home: PathBuf,
    pub python: Option<PathBuf>,
    pub command: Option<PathBuf>,
    pub dev: bool,
    /// Where `desktop.json` is (or would be) read from — surfaced in the boot
    /// screen so users know what to edit.
    pub config_path: Option<PathBuf>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn env_var(name: &str) -> Option<String> {
    non_empty(env::var(name).ok())
}

fn env_flag(name: &str) -> Option<bool> {
    env_var(name).map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

/// Walk up from `start` looking for a DeepTutor source checkout, so a debug
/// build living in `desktop/src-tauri/target/` uses the repository it was built
/// from — the same workspace `deeptutor start` would pick from that directory.
pub fn find_source_checkout(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join("pyproject.toml").is_file()
            && dir.join("deeptutor").join("__version__.py").is_file()
            && dir.join("web").is_dir()
        {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn default_home(app: &AppHandle) -> PathBuf {
    if let Ok(cwd) = env::current_dir() {
        if let Some(root) = find_source_checkout(&cwd) {
            return root;
        }
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(root) = find_source_checkout(&exe) {
            return root;
        }
    }
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("home"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn load(app: &AppHandle) -> DesktopConfig {
    let config_path = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(CONFIG_FILE));
    let file: FileConfig = config_path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();

    let home = env_var(HOME_ENV)
        .or_else(|| non_empty(file.home.clone()))
        .map(|raw| expand_home(&raw))
        .unwrap_or_else(|| default_home(app));

    DesktopConfig {
        url: env_var(URL_ENV).or_else(|| non_empty(file.url.clone())),
        home,
        python: env_var(PYTHON_ENV)
            .or_else(|| non_empty(file.python.clone()))
            .map(|raw| expand_home(&raw)),
        command: env_var(COMMAND_ENV)
            .or_else(|| non_empty(file.command.clone()))
            .map(|raw| expand_home(&raw)),
        dev: env_flag(DEV_ENV).unwrap_or(file.dev),
        config_path,
    }
}

/// `~/...` in desktop.json expands to the user's home directory.
fn expand_home(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(raw)
}
