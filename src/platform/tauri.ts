import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import type { DataFs } from "../data";

/** File access, scoped by the Rust shell to the chosen data folder. */
export const tauriFs: DataFs = {
  read: (path) => invoke<string | null>("data_read", { path }),
  write: (path, contents) => invoke<void>("data_write", { path, contents }),
  list: (dir) => invoke<string[]>("data_list", { dir }),
};

export const getDataRoot = () => invoke<string | null>("get_data_root");
export const setDataRoot = (path: string) => invoke<void>("set_data_root", { path });

/** Native folder picker. Resolves to null if cancelled. */
export async function chooseDataRoot(current: string | null): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    canCreateDirectories: true,
    title: "Choose where Wetware keeps your data",
    defaultPath: current ?? (await documentDir()),
  });
  return typeof picked === "string" ? picked : null;
}

export async function suggestedDataRoot(): Promise<string> {
  return join(await documentDir(), "Wetware Data");
}

/** The key goes into the Keychain and never comes back to the webview. */
export const intervalsKey = {
  set: (key: string) => invoke<void>("intervals_key_set", { key }),
  exists: () => invoke<boolean>("intervals_key_exists"),
  delete: () => invoke<void>("intervals_key_delete"),
};
