//! Rust shell: the data folder, file access scoped to it, the Keychain, and
//! the network.
//!
//! The webview never gets an arbitrary file API. Every file command takes a
//! path relative to the data folder and refuses anything that would leave it.
//! Nor does it get the network: `net` fetches from two fixed hosts.

mod files;
mod keychain;
mod net;

use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const SUGGESTED_FOLDER: &str = "Wetware Data";

#[derive(Default, Clone, Debug, PartialEq, Serialize, Deserialize)]
struct AppConfig {
    data_root: Option<PathBuf>,
    #[serde(default)]
    sync: SyncState,
}

/// What the app remembers about syncing. It lives here, in the app's own
/// config, and not in the user's data folder.
#[derive(Default, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct SyncState {
    /// When a sync last reached a source, in milliseconds since 1970.
    last_synced_ms: Option<u64>,
    /// Whether the user has been told that intervals.icu isn't connected. It is said once.
    intervals_hint_shown: bool,
}

impl AppConfig {
    /// The config with `root` as the data folder. When a sync last ran
    /// belongs to the folder it ran on, so it is forgotten if the folder changes.
    fn with_data_root(&self, root: PathBuf) -> Self {
        let same = self.data_root.as_ref() == Some(&root);
        let last_synced_ms = if same { self.sync.last_synced_ms } else { None };
        AppConfig { data_root: Some(root), sync: SyncState { last_synced_ms, ..self.sync.clone() } }
    }
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
    let next = shell.config.lock().map_err(err)?.with_data_root(root.clone());
    save_config(app, shell, next)?;
    Ok(shown(&root))
}

/// Write the config to disk, then keep it. Nothing changes if the write fails.
fn save_config(app: &AppHandle, shell: &Shell, next: AppConfig) -> CmdResult<()> {
    let json = serde_json::to_string_pretty(&next).map_err(err)?;
    files::write_atomic(&config_path(app)?, json.as_bytes())?;
    *shell.config.lock().map_err(err)? = next;
    Ok(())
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

#[tauri::command]
fn sync_state_get(shell: State<Shell>) -> CmdResult<SyncState> {
    trace("sync_state_get");
    Ok(shell.config.lock().map_err(err)?.sync.clone())
}

#[tauri::command]
fn sync_state_set(app: AppHandle, shell: State<Shell>, state: SyncState) -> CmdResult<()> {
    trace("sync_state_set");
    let next = AppConfig { sync: state, ..shell.config.lock().map_err(err)?.clone() };
    save_config(&app, &shell, next)
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
            net::intervals_fetch,
            net::weather_fetch,
            sync_state_get,
            sync_state_set,
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
        let config = AppConfig { data_root: Some("/data".into()), ..AppConfig::default() };
        let shell = Shell { config: Mutex::new(config) };
        assert_eq!(data_root(&shell).unwrap(), Path::new("/data"));
    }

    #[test]
    fn a_config_written_before_sync_existed_still_loads() {
        let old: AppConfig = serde_json::from_str(r#"{ "data_root": "/data" }"#).unwrap();
        assert_eq!(old, AppConfig { data_root: Some("/data".into()), sync: SyncState::default() });
        assert_eq!(old.sync, SyncState { last_synced_ms: None, intervals_hint_shown: false });
        let partial: AppConfig = serde_json::from_str(r#"{ "data_root": null, "sync": { "last_synced_ms": 5 } }"#).unwrap();
        assert_eq!(partial.sync, SyncState { last_synced_ms: Some(5), intervals_hint_shown: false });
    }

    #[test]
    fn sync_state_round_trips_under_the_names_the_webview_uses() {
        let state = SyncState { last_synced_ms: Some(1_795_023_667_000), intervals_hint_shown: true };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json, serde_json::json!({ "last_synced_ms": 1_795_023_667_000u64, "intervals_hint_shown": true }));
        assert_eq!(serde_json::from_value::<SyncState>(json).unwrap(), state);
        // It holds nothing but those two: there is no place in it for a key.
        assert_eq!(serde_json::to_value(SyncState::default()).unwrap().as_object().unwrap().len(), 2);
    }

    #[test]
    fn the_last_sync_is_forgotten_when_the_data_folder_changes_and_kept_when_it_does_not() {
        let sync = SyncState { last_synced_ms: Some(42), intervals_hint_shown: true };
        let config = AppConfig { data_root: Some("/data".into()), sync: sync.clone() };
        assert_eq!(config.with_data_root("/data".into()), config);
        assert_eq!(
            config.with_data_root("/other".into()),
            AppConfig { data_root: Some("/other".into()), sync: SyncState { last_synced_ms: None, intervals_hint_shown: true } }
        );
        let first = AppConfig::default().with_data_root("/data".into());
        assert_eq!(first, AppConfig { data_root: Some("/data".into()), sync: SyncState::default() });
    }
}
