import { invoke } from "@tauri-apps/api/core";
import type { DataFs } from "../data";

/** File access, scoped by the Rust shell to the chosen data folder. */
export const tauriFs: DataFs = {
  read: (path) => invoke<string | null>("data_read", { path }),
  write: (path, contents) => invoke<void>("data_write", { path, contents }),
  list: (dir) => invoke<string[]>("data_list", { dir }),
};

export const getDataRoot = () => invoke<string | null>("get_data_root");

/**
 * The webview can't name a data folder. It can ask the shell to show the
 * native folder picker, or to use the suggested folder; either way the shell
 * sets the folder itself and reports the path. Null if the picker was cancelled.
 */
export const chooseDataRoot = () => invoke<string | null>("choose_data_root");
export const adoptSuggestedDataRoot = () => invoke<string>("use_suggested_data_root");
/** `~/Documents/Wetware Data`, spelled out. For display only. */
export const suggestedDataRoot = () => invoke<string>("suggested_data_root");

/** The key goes into the Keychain and never comes back to the webview. */
export const intervalsKey = {
  set: (key: string) => invoke<void>("intervals_key_set", { key }),
  exists: () => invoke<boolean>("intervals_key_exists"),
  delete: () => invoke<void>("intervals_key_delete"),
};
