import { invoke } from "@tauri-apps/api/core";
import type { DataFs } from "../data";
import { asProblem, SyncFailure, type SyncSources } from "../sync";

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

/** A fetch the shell turned down, as the `SyncFailure` the sync rules expect. */
const fetched = (call: Promise<unknown>) =>
  call.catch((e: unknown) => {
    throw new SyncFailure(asProblem(e));
  });

/**
 * The network, by way of the shell. The webview names what it wants (which
 * list, which days, which place) and the shell builds the URL, adds the key
 * from the Keychain where one is needed, and makes the call.
 */
export const syncSources: SyncSources = {
  intervals: (kind, oldest, newest) => fetched(invoke("intervals_fetch", { kind, oldest, newest })),
  weather: (latitude, longitude, oldest, newest) =>
    fetched(invoke("weather_fetch", { latitude, longitude, oldest, newest })),
};

/** What the app remembers about syncing. Kept in the app's own config, outside the data folder. */
export interface SyncState {
  /** When a sync last reached a source, in milliseconds since 1970. Null: not yet, on this data folder. */
  last_synced_ms: number | null;
  /** Whether the user has been told that intervals.icu isn't connected. */
  intervals_hint_shown: boolean;
}

export const syncState = {
  get: () => invoke<SyncState>("sync_state_get"),
  set: (state: SyncState) => invoke<void>("sync_state_set", { state }),
};
