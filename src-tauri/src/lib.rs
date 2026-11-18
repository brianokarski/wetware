//! Rust shell: the data folder, file access scoped to it, and the Keychain.
//!
//! The webview never gets an arbitrary file API. Every file command takes a
//! path relative to the data folder and refuses anything that would leave it.

mod keychain;

use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Default, Serialize, Deserialize)]
struct AppConfig {
    data_root: Option<PathBuf>,
}

struct Shell {
    config: Mutex<AppConfig>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// App-level config lives outside the data folder, because it's what says
/// where the data folder is.
fn config_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("config.json"))
}

fn load_config(app: &AppHandle) -> AppConfig {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Resolve a data-folder-relative path, rejecting absolute paths and `..`.
fn resolve(shell: &Shell, rel: &str) -> CmdResult<PathBuf> {
    let root = shell
        .config
        .lock()
        .map_err(err)?
        .data_root
        .clone()
        .ok_or("No data folder chosen yet")?;
    let rel = Path::new(rel);
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("Path must stay inside the data folder".into());
    }
    Ok(root.join(rel))
}

/// Write via a temp file and rename, so a crash can't leave a half-written file.
fn write_atomic(path: &Path, contents: &str) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err)?;
    }
    let name = path.file_name().ok_or("Path has no file name")?.to_string_lossy();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, contents).map_err(err)?;
    fs::rename(&tmp, path).map_err(err)
}

#[tauri::command]
fn get_data_root(shell: State<Shell>) -> CmdResult<Option<String>> {
    let config = shell.config.lock().map_err(err)?;
    Ok(config.data_root.as_ref().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn set_data_root(app: AppHandle, shell: State<Shell>, path: String) -> CmdResult<()> {
    let root = PathBuf::from(path);
    if !root.is_absolute() {
        return Err("Data folder must be an absolute path".into());
    }
    fs::create_dir_all(&root).map_err(err)?;
    let mut config = shell.config.lock().map_err(err)?;
    config.data_root = Some(root);
    let json = serde_json::to_string_pretty(&*config).map_err(err)?;
    write_atomic(&config_path(&app)?, &json)
}

#[tauri::command]
fn data_read(shell: State<Shell>, path: String) -> CmdResult<Option<String>> {
    match fs::read_to_string(resolve(&shell, &path)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn data_write(shell: State<Shell>, path: String, contents: String) -> CmdResult<()> {
    write_atomic(&resolve(&shell, &path)?, &contents)
}

#[tauri::command]
fn data_list(shell: State<Shell>, dir: String) -> CmdResult<Vec<String>> {
    let entries = match fs::read_dir(resolve(&shell, &dir)?) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(err(e)),
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !n.starts_with('.'))
        .collect();
    names.sort();
    Ok(names)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = load_config(app.handle());
            app.manage(Shell { config: Mutex::new(config) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data_root,
            set_data_root,
            data_read,
            data_write,
            data_list,
            keychain::intervals_key_set,
            keychain::intervals_key_exists,
            keychain::intervals_key_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(root: &Path) -> Shell {
        Shell { config: Mutex::new(AppConfig { data_root: Some(root.to_path_buf()) }) }
    }

    #[test]
    fn resolve_stays_inside_the_data_folder() {
        let s = shell(Path::new("/data"));
        assert_eq!(resolve(&s, "days/2026-11-17.md").unwrap(), Path::new("/data/days/2026-11-17.md"));
        assert!(resolve(&s, "../secrets").is_err());
        assert!(resolve(&s, "days/../../etc/passwd").is_err());
        assert!(resolve(&s, "/etc/passwd").is_err());
    }

    #[test]
    fn resolve_needs_a_data_folder() {
        let s = Shell { config: Mutex::new(AppConfig::default()) };
        assert!(resolve(&s, "habits.yaml").is_err());
    }

    #[test]
    fn write_atomic_creates_parents_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("wetware-test-{}", std::process::id()));
        let file = dir.join("days/2026-11-17.md");
        write_atomic(&file, "hello").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "hello");
        assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
