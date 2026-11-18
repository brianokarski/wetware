import { invoke } from "@tauri-apps/api/core";
import { FolderChangedError, type DataFs } from "../data";
import { asProblem, SyncFailure, type SyncSources } from "../sync";

/** A folder the shell has opened as the data folder, and the number it gave that opening. */
export interface OpenFolder {
  path: string;
  id: number;
}

/** What the shell refuses a command with when the folder it was for is no longer the one open. */
const FOLDER_CHANGED = "The data folder was changed";

const guarded = <T>(call: Promise<T>): Promise<T> =>
  call.catch((e: unknown) => {
    throw e === FOLDER_CHANGED ? new FolderChangedError() : e;
  });

const opened = new Map<number, DataFs>();

/**
 * File access to one opening of the data folder. Every read and write carries
 * that opening's number, and the shell refuses it (`FolderChangedError`) once
 * another folder has been opened: nothing worked out for one folder can land
 * in another. The same number always gives the same object, so edits to one
 * file queue up behind each other.
 */
export function folderFs(folder: number): DataFs {
  let fs = opened.get(folder);
  if (!fs) {
    fs = {
      read: (path) => guarded(invoke<string | null>("data_read", { folder, path })),
      write: (path, contents) => guarded(invoke<void>("data_write", { folder, path, contents })),
      list: (dir) => guarded(invoke<string[]>("data_list", { folder, dir })),
    };
    opened.set(folder, fs);
  }
  return fs;
}

/** The folder now open, or null if none has been chosen yet. */
export const getDataRoot = () => invoke<OpenFolder | null>("get_data_root");

/**
 * The webview can't name a data folder. It can ask the shell to show the
 * native folder picker, or to use the suggested folder; either way the shell
 * opens the folder itself and reports it. Null if the picker was cancelled:
 * then nothing has changed.
 */
export const chooseDataRoot = () => invoke<OpenFolder | null>("choose_data_root");
export const adoptSuggestedDataRoot = () => invoke<OpenFolder>("use_suggested_data_root");
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

/** The sync record of one opening of the data folder. Refused, like file access, once another is open. */
export const syncStateOf = (folder: number) => ({
  get: () => guarded(invoke<SyncState>("sync_state_get", { folder })),
  set: (state: SyncState) => guarded(invoke<void>("sync_state_set", { folder, state })),
});
