/**
 * The only way the data layer touches disk. Paths are relative to the data
 * folder root and use forward slashes. The Tauri shell provides the real one;
 * tests use `memoryFs`.
 */
export interface DataFs {
  /** Resolves to null when the file doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Creates parent folders as needed. */
  write(path: string, text: string): Promise<void>;
  /** File names (not paths) directly inside `dir`. Empty if it doesn't exist. */
  list(dir: string): Promise<string[]>;
  /**
   * Takes a file away, but only if it holds exactly `expected`: the app
   * never removes what it hasn't just read. A file that isn't there is
   * already gone. Rejects, removing nothing, if it holds anything else.
   */
  remove(path: string, expected: string): Promise<void>;
}

/**
 * The data folder this `DataFs` was for is no longer the one open, and the
 * shell has refused the read or write. Nothing was touched. Work that was
 * under way for that folder has nowhere to go and should stop.
 */
export class FolderChangedError extends Error {
  constructor() {
    super("The data folder was changed");
    this.name = "FolderChangedError";
  }
}

export function memoryFs(initial: Record<string, string> = {}): DataFs & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, text) {
      files.set(path, text);
    },
    async remove(path, expected) {
      if (!files.has(path)) return;
      if (files.get(path) !== expected) throw new Error(`${path} has changed, so it was not removed`);
      files.delete(path);
    },
    async list(dir) {
      const prefix = dir.replace(/\/$/, "") + "/";
      return [...files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
        .map((p) => p.slice(prefix.length))
        .sort();
    },
  };
}
