//! Rust shell: the data folder, file access scoped to it, and the Keychain.
//!
//! The webview never gets an arbitrary file API. Every file command takes a
//! path relative to the data folder and refuses anything that would leave it.

mod files;
mod keychain;

use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const SUGGESTED_FOLDER: &str = "Wetware Data";

#[derive(Default, Clone, Serialize, Deserialize)]
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

/// With `WETWARE_TRACE=1`, print the name of each command to stderr as the
/// webview calls it. Names only: never arguments, paths, contents or secrets.
pub(crate) fn trace(command: &str) {
    static ON: OnceLock<bool> = OnceLock::new();
    if *ON.get_or_init(|| std::env::var("WETWARE_TRACE").is_ok_and(|v| v == "1")) {
        eprintln!("[wetware] {command}");
    }
}

/// App-level config lives outside the data folder, because it's what says
/// where the data folder is.
fn config_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_config_dir().map_err(err)?.join("config.json"))
}

fn load_config(app: &AppHandle) -> AppConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn data_root(shell: &Shell) -> CmdResult<PathBuf> {
    let config = shell.config.lock().map_err(err)?;
    config.data_root.clone().ok_or_else(|| "No data folder chosen yet".into())
}

fn shown(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Make `root` the data folder and remember it. Only ever called with a path
/// this shell came up with itself: the folder dialog's answer or the
/// suggested folder. The webview has no way to name a path.
fn set_data_root(app: &AppHandle, shell: &Shell, root: PathBuf) -> CmdResult<String> {
    if !root.is_absolute() {
        return Err("Data folder must be an absolute path".into());
    }
    std::fs::create_dir_all(&root).map_err(err)?;
    let next = AppConfig { data_root: Some(root.clone()) };
    let json = serde_json::to_string_pretty(&next).map_err(err)?;
    files::write_atomic(&config_path(app)?, json.as_bytes())?;
    *shell.config.lock().map_err(err)? = next;
    Ok(shown(&root))
}

fn suggested_root(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().document_dir().map_err(err)?.join(SUGGESTED_FOLDER))
}

#[tauri::command]
fn get_data_root(shell: State<Shell>) -> CmdResult<Option<String>> {
    trace("get_data_root");
    let config = shell.config.lock().map_err(err)?;
    Ok(config.data_root.as_deref().map(shown))
}

/// `~/Documents/Wetware Data`, for the Settings screen to show.
#[tauri::command]
fn suggested_data_root(app: AppHandle) -> CmdResult<String> {
    trace("suggested_data_root");
    Ok(shown(&suggested_root(&app)?))
}

#[tauri::command]
fn use_suggested_data_root(app: AppHandle, shell: State<Shell>) -> CmdResult<String> {
    trace("use_suggested_data_root");
    let root = suggested_root(&app)?;
    set_data_root(&app, &shell, root)
}

/// Show the native folder picker and use what the user picks. The dialog runs
/// here, not in the webview, so the webview can't pass off a path as the
/// user's choice. Resolves to `None` if the dialog is cancelled.
#[tauri::command]
async fn choose_data_root(app: AppHandle, shell: State<'_, Shell>) -> CmdResult<Option<String>> {
    trace("choose_data_root");
    let start = match shell.config.lock().map_err(err)?.data_root.clone() {
        Some(current) => current,
        None => app.path().document_dir().map_err(err)?,
    };
    let picked = app
        .dialog()
        .file()
        .set_title("Choose where Wetware keeps your data")
        .set_directory(start)
        .set_can_create_directories(true)
        .blocking_pick_folder();
    match picked {
        Some(folder) => set_data_root(&app, &shell, folder.into_path().map_err(err)?).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn data_read(shell: State<Shell>, path: String) -> CmdResult<Option<String>> {
    trace("data_read");
    files::read(&data_root(&shell)?, &path)
}

#[tauri::command]
fn data_write(shell: State<Shell>, path: String, contents: String) -> CmdResult<()> {
    trace("data_write");
    files::write(&data_root(&shell)?, &path, &contents)
}

#[tauri::command]
fn data_list(shell: State<Shell>, dir: String) -> CmdResult<Vec<String>> {
    trace("data_list");
    files::list(&data_root(&shell)?, &dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Used from Rust only. The webview has no permission to call it.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = load_config(app.handle());
            app.manage(Shell { config: Mutex::new(config) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data_root,
            suggested_data_root,
            use_suggested_data_root,
            choose_data_root,
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

    #[test]
    fn file_commands_need_a_data_folder() {
        let shell = Shell { config: Mutex::new(AppConfig::default()) };
        assert!(data_root(&shell).is_err());
        let shell = Shell { config: Mutex::new(AppConfig { data_root: Some("/data".into()) }) };
        assert_eq!(data_root(&shell).unwrap(), Path::new("/data"));
    }
}
