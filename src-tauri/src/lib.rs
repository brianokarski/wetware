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

/// A folder the shell has opened as the data folder, and the number it gave
/// that opening.
#[derive(Debug, Clone, PartialEq, Serialize)]
struct OpenFolder {
    path: String,
    id: u64,
}

/// What a command is refused with when it carries the number of a folder
/// that is no longer the one open.
const FOLDER_CHANGED: &str = "The data folder was changed";
const NO_FOLDER: &str = "No data folder chosen yet";

struct Open {
    config: AppConfig,
    /// The number of the folder now open. It goes up every time a folder is
    /// opened, the same one again included, and is never reused.
    folder: u64,
}

/// The shell is the guard between the webview and the data folder. Every
/// time it opens a folder it gives that opening a number, and every command
/// that reads, writes or records anything for a folder carries the number it
/// was given. A command whose number is stale is refused: what the webview
/// worked out for one folder can't land in another.
struct Shell {
    open: Mutex<Open>,
}

impl Shell {
    fn new(config: AppConfig) -> Self {
        Shell { open: Mutex::new(Open { config, folder: 1 }) }
    }

    /// The folder now open, if there is one.
    fn opened(&self) -> CmdResult<Option<OpenFolder>> {
        let open = self.open.lock().map_err(err)?;
        Ok(open.config.data_root.as_deref().map(|root| OpenFolder { path: shown(root), id: open.folder }))
    }

    /// Where the folder numbered `folder` is, if it is still the one open.
    /// The answer is good for the one command that asked: a file command
    /// that got it reads or writes there even if the folder changes meanwhile.
    fn root_for(&self, folder: u64) -> CmdResult<PathBuf> {
        let open = self.open.lock().map_err(err)?;
        let root = open.config.data_root.clone().ok_or(NO_FOLDER)?;
        if folder != open.folder {
            return Err(FOLDER_CHANGED.into());
        }
        Ok(root)
    }

    /// Make `root` the data folder under a new number. `persist` writes the
    /// new config to disk first; if that fails nothing changes.
    fn open_folder(&self, root: PathBuf, persist: &dyn Fn(&AppConfig) -> CmdResult<()>) -> CmdResult<OpenFolder> {
        let mut open = self.open.lock().map_err(err)?;
        let next = open.config.with_data_root(root.clone());
        persist(&next)?;
        open.config = next;
        open.folder += 1;
        Ok(OpenFolder { path: shown(&root), id: open.folder })
    }

    fn sync_state(&self, folder: u64) -> CmdResult<SyncState> {
        self.root_for(folder)?;
        Ok(self.open.lock().map_err(err)?.config.sync.clone())
    }

    /// Record what a sync of the folder numbered `folder` has to remember.
    fn set_sync_state(&self, folder: u64, state: SyncState, persist: &dyn Fn(&AppConfig) -> CmdResult<()>) -> CmdResult<()> {
        let mut open = self.open.lock().map_err(err)?;
        if open.config.data_root.is_none() {
            return Err(NO_FOLDER.into());
        }
        if folder != open.folder {
            return Err(FOLDER_CHANGED.into());
        }
        let next = AppConfig { sync: state, ..open.config.clone() };
        persist(&next)?;
        open.config = next;
        Ok(())
    }
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

fn shown(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Make `root` the data folder and remember it. Only ever called with a path
/// this shell came up with itself: the folder dialog's answer or the
/// suggested folder. The webview has no way to name a path.
fn set_data_root(app: &AppHandle, shell: &Shell, root: PathBuf) -> CmdResult<OpenFolder> {
    if !root.is_absolute() {
        return Err("Data folder must be an absolute path".into());
    }
    std::fs::create_dir_all(&root).map_err(err)?;
    shell.open_folder(root, &|config| write_config(app, config))
}

fn write_config(app: &AppHandle, config: &AppConfig) -> CmdResult<()> {
    let json = serde_json::to_string_pretty(config).map_err(err)?;
    files::write_atomic(&config_path(app)?, json.as_bytes())
}

fn suggested_root(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().document_dir().map_err(err)?.join(SUGGESTED_FOLDER))
}

/// The folder now open and its number, or `None` if none has been chosen.
#[tauri::command]
fn get_data_root(shell: State<Shell>) -> CmdResult<Option<OpenFolder>> {
    trace("get_data_root");
    shell.opened()
}

/// `~/Documents/Wetware Data`, for the Settings screen to show.
#[tauri::command]
fn suggested_data_root(app: AppHandle) -> CmdResult<String> {
    trace("suggested_data_root");
    Ok(shown(&suggested_root(&app)?))
}

#[tauri::command]
fn use_suggested_data_root(app: AppHandle, shell: State<Shell>) -> CmdResult<OpenFolder> {
    trace("use_suggested_data_root");
    let root = suggested_root(&app)?;
    set_data_root(&app, &shell, root)
}

/// Show the native folder picker and use what the user picks. The dialog runs
/// here, not in the webview, so the webview can't pass off a path as the
/// user's choice. Resolves to `None` if the dialog is cancelled: then nothing
/// has changed, and the folder that was open keeps its number.
#[tauri::command]
async fn choose_data_root(app: AppHandle, shell: State<'_, Shell>) -> CmdResult<Option<OpenFolder>> {
    trace("choose_data_root");
    let start = match shell.open.lock().map_err(err)?.config.data_root.clone() {
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

fn read_in(shell: &Shell, folder: u64, path: &str) -> CmdResult<Option<String>> {
    files::read(&shell.root_for(folder)?, path)
}

fn write_in(shell: &Shell, folder: u64, path: &str, contents: &str) -> CmdResult<()> {
    files::write(&shell.root_for(folder)?, path, contents)
}

fn list_in(shell: &Shell, folder: u64, dir: &str) -> CmdResult<Vec<String>> {
    files::list(&shell.root_for(folder)?, dir)
}

#[tauri::command]
fn data_read(shell: State<Shell>, folder: u64, path: String) -> CmdResult<Option<String>> {
    trace("data_read");
    read_in(&shell, folder, &path)
}

#[tauri::command]
fn data_write(shell: State<Shell>, folder: u64, path: String, contents: String) -> CmdResult<()> {
    trace("data_write");
    write_in(&shell, folder, &path, &contents)
}

#[tauri::command]
fn data_list(shell: State<Shell>, folder: u64, dir: String) -> CmdResult<Vec<String>> {
    trace("data_list");
    list_in(&shell, folder, &dir)
}

#[tauri::command]
fn sync_state_get(shell: State<Shell>, folder: u64) -> CmdResult<SyncState> {
    trace("sync_state_get");
    shell.sync_state(folder)
}

#[tauri::command]
fn sync_state_set(app: AppHandle, shell: State<Shell>, folder: u64, state: SyncState) -> CmdResult<()> {
    trace("sync_state_set");
    shell.set_sync_state(folder, state, &|config| write_config(&app, config))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Used from Rust only. The webview has no permission to call it.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config = load_config(app.handle());
            app.manage(Shell::new(config));
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

    /// Two empty folders to open in turn, removed when dropped.
    struct Folders {
        a: PathBuf,
        b: PathBuf,
    }

    impl Folders {
        fn new(name: &str) -> Self {
            let base = std::env::temp_dir().join(format!("wetware-shell-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            let (a, b) = (base.join("a"), base.join("b"));
            std::fs::create_dir_all(&a).unwrap();
            std::fs::create_dir_all(&b).unwrap();
            Folders { a, b }
        }

        fn names(dir: &Path) -> Vec<String> {
            let mut names: Vec<String> = walk(dir).into_iter().map(|p| p.strip_prefix(dir).unwrap().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        }
    }

    impl Drop for Folders {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(self.a.parent().unwrap());
        }
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.path().is_dir() {
                found.extend(walk(&entry.path()));
            } else {
                found.push(entry.path());
            }
        }
        found
    }

    /// Nothing to write the config to in a test: it is only kept.
    fn kept(_: &AppConfig) -> CmdResult<()> {
        Ok(())
    }

    fn shell_on(root: &Path) -> (Shell, u64) {
        let shell = Shell::new(AppConfig::default());
        let opened = shell.open_folder(root.to_path_buf(), &kept).unwrap();
        (shell, opened.id)
    }

    #[test]
    fn file_commands_need_a_data_folder() {
        let shell = Shell::new(AppConfig::default());
        assert_eq!(shell.opened().unwrap(), None);
        for folder in [0, 1, 2] {
            assert_eq!(shell.root_for(folder), Err(NO_FOLDER.into()));
            assert_eq!(read_in(&shell, folder, "habits.yaml"), Err(NO_FOLDER.into()));
            assert_eq!(shell.set_sync_state(folder, SyncState::default(), &kept), Err(NO_FOLDER.into()));
        }
        // A folder remembered from the last run is open from the start, under a number.
        let shell = Shell::new(AppConfig { data_root: Some("/data".into()), ..AppConfig::default() });
        let opened = shell.opened().unwrap().unwrap();
        assert_eq!(opened.path, "/data");
        assert_eq!(shell.root_for(opened.id).unwrap(), Path::new("/data"));
    }

    #[test]
    fn every_opening_of_a_folder_gets_a_number_of_its_own() {
        let folders = Folders::new("numbers");
        let (shell, first) = shell_on(&folders.a);
        let second = shell.open_folder(folders.b.clone(), &kept).unwrap();
        // The same folder opened again is a new opening.
        let third = shell.open_folder(folders.b.clone(), &kept).unwrap();
        let fourth = shell.open_folder(folders.a.clone(), &kept).unwrap();
        let ids = [first, second.id, third.id, fourth.id];
        assert!(ids.windows(2).all(|pair| pair[0] < pair[1]), "{ids:?}");
        assert_eq!(shell.opened().unwrap(), Some(fourth.clone()));
        assert_eq!(fourth.path, shown(&folders.a));
        // Only the last number is good, though the first was for the very same folder.
        assert_eq!(shell.root_for(fourth.id).unwrap(), folders.a);
        for stale in [0, first, second.id, third.id, fourth.id + 1] {
            assert_eq!(shell.root_for(stale), Err(FOLDER_CHANGED.into()), "{stale}");
        }
    }

    #[test]
    fn a_file_command_with_a_stale_number_is_refused_and_touches_neither_folder() {
        let folders = Folders::new("stale");
        let (shell, old) = shell_on(&folders.a);
        write_in(&shell, old, "days/2026-11-16.md", "left behind").unwrap();
        let new = shell.open_folder(folders.b.clone(), &kept).unwrap().id;
        write_in(&shell, new, "days/2026-11-16.md", "in the new folder").unwrap();

        // What the webview worked out for the folder it left: refused, whatever it is.
        assert_eq!(write_in(&shell, old, "days/2026-11-17.md", "from a sync of the old folder"), Err(FOLDER_CHANGED.into()));
        assert_eq!(write_in(&shell, old, "days/2026-11-16.md", "from a sync of the old folder"), Err(FOLDER_CHANGED.into()));
        assert_eq!(read_in(&shell, old, "days/2026-11-16.md"), Err(FOLDER_CHANGED.into()));
        assert_eq!(list_in(&shell, old, "days"), Err(FOLDER_CHANGED.into()));

        // Neither the folder that was left nor the one that was opened has changed.
        assert_eq!(Folders::names(&folders.a), ["days/2026-11-16.md"]);
        assert_eq!(Folders::names(&folders.b), ["days/2026-11-16.md"]);
        assert_eq!(std::fs::read_to_string(folders.a.join("days/2026-11-16.md")).unwrap(), "left behind");
        assert_eq!(read_in(&shell, new, "days/2026-11-16.md").unwrap().as_deref(), Some("in the new folder"));
        assert_eq!(list_in(&shell, new, "days").unwrap(), ["2026-11-16.md"]);
    }

    #[test]
    fn a_write_let_through_before_the_folder_changed_lands_in_the_folder_it_was_for() {
        let folders = Folders::new("under-way");
        let (shell, old) = shell_on(&folders.a);
        // The command has been let through and knows where it is going; then the folder changes under it.
        let root = shell.root_for(old).unwrap();
        shell.open_folder(folders.b.clone(), &kept).unwrap();
        files::write(&root, "days/2026-11-17.md", "written as the folder changed").unwrap();
        assert_eq!(Folders::names(&folders.a), ["days/2026-11-17.md"]);
        assert!(Folders::names(&folders.b).is_empty());
    }

    #[test]
    fn what_a_sync_remembers_is_refused_for_a_folder_that_was_left() {
        let folders = Folders::new("sync-state");
        let (shell, old) = shell_on(&folders.a);
        let synced = SyncState { last_synced_ms: Some(42), intervals_hint_shown: true };
        shell.set_sync_state(old, synced.clone(), &kept).unwrap();
        assert_eq!(shell.sync_state(old).unwrap(), synced);

        let new = shell.open_folder(folders.b.clone(), &kept).unwrap().id;
        // The new folder has not been synced. The old folder's sync can't say it has, or ask.
        let fresh = SyncState { last_synced_ms: None, intervals_hint_shown: true };
        assert_eq!(shell.sync_state(new).unwrap(), fresh);
        let late = SyncState { last_synced_ms: Some(99), intervals_hint_shown: false };
        assert_eq!(shell.set_sync_state(old, late, &kept), Err(FOLDER_CHANGED.into()));
        assert_eq!(shell.sync_state(old), Err(FOLDER_CHANGED.into()));
        assert_eq!(shell.sync_state(new).unwrap(), fresh);
    }

    #[test]
    fn nothing_changes_when_the_config_can_not_be_written() {
        let folders = Folders::new("persist");
        let (shell, id) = shell_on(&folders.a);
        let full = |_: &AppConfig| -> CmdResult<()> { Err("No space left on device".into()) };
        assert_eq!(shell.open_folder(folders.b.clone(), &full), Err("No space left on device".into()));
        assert_eq!(shell.opened().unwrap(), Some(OpenFolder { path: shown(&folders.a), id }));
        assert_eq!(shell.root_for(id).unwrap(), folders.a);
        let synced = SyncState { last_synced_ms: Some(42), intervals_hint_shown: true };
        assert_eq!(shell.set_sync_state(id, synced, &full), Err("No space left on device".into()));
        assert_eq!(shell.sync_state(id).unwrap(), SyncState::default());
    }

    #[test]
    fn an_open_folder_reaches_the_webview_as_a_path_and_a_number() {
        let opened = OpenFolder { path: "/Users/someone/Notes".into(), id: 7 };
        assert_eq!(serde_json::to_value(opened).unwrap(), serde_json::json!({ "path": "/Users/someone/Notes", "id": 7 }));
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
