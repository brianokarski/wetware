/**
 * The real app in a browser tab, for looking at and for `npm run shots`.
 *
 * There is no Rust shell here: the Tauri IPC is mocked over an in-memory data
 * folder, seeded from test/fixtures/data-folder (made-up data). Development
 * only. Nothing in dev/ is part of the production bundle.
 *
 * Query parameters:
 *   today=YYYY-MM-DD   what day the app thinks it is (default 2026-11-17)
 *   folder=fixture     the fixture data folder (default)
 *   folder=empty       a data folder with nothing in it yet
 *   folder=none        no data folder chosen: the first-run state
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { setClock } from "../src/platform/clock";

const FIXTURE_DIR = "../test/fixtures/data-folder/";
const SUGGESTED_ROOT = "/Users/preview/Documents/Wetware Data";
const PICKED_ROOT = "/Users/preview/Notes/Wetware";

const params = new URLSearchParams(window.location.search);
const folder = params.get("folder") ?? "fixture";
const [year, month, day] = (params.get("today") ?? "2026-11-17").split("-").map(Number);
setClock(() => new Date(year, month - 1, day, 9, 41));

const fixture = import.meta.glob("../test/fixtures/data-folder/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const files = new Map<string, string>();
if (folder === "fixture") {
  for (const [path, text] of Object.entries(fixture)) files.set(path.slice(FIXTURE_DIR.length), text);
}

const state = {
  root: folder === "none" ? null : SUGGESTED_ROOT,
  keyStored: false,
  /** When set, data_write fails with this message, as a full disk would. */
  writeError: null as string | null,
  /** Every command the app has called, in order. */
  calls: [] as string[],
};

/** The same rule as the shell: a relative path of plain names. */
function checked(path: unknown): string {
  const parts = String(path).split("/");
  if (path === "" || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw "Path must stay inside the data folder";
  }
  return String(path);
}

mockIPC((command, payload) => {
  const args = (payload ?? {}) as Record<string, unknown>;
  state.calls.push(command);
  switch (command) {
    case "get_data_root":
      return state.root;
    case "suggested_data_root":
      return SUGGESTED_ROOT;
    case "use_suggested_data_root":
      return (state.root = SUGGESTED_ROOT);
    case "choose_data_root":
      return (state.root = PICKED_ROOT);
    case "data_read":
      return files.get(checked(args.path)) ?? null;
    case "data_write":
      if (state.writeError) throw state.writeError;
      files.set(checked(args.path), String(args.contents));
      return null;
    case "data_list": {
      const prefix = `${checked(args.dir)}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => path.slice(prefix.length))
        .filter((name) => !name.startsWith("."))
        .sort();
    }
    case "intervals_key_set":
      state.keyStored = true;
      return null;
    case "intervals_key_exists":
      return state.keyStored;
    case "intervals_key_delete":
      state.keyStored = false;
      return null;
    default:
      throw `Unknown command: ${command}`;
  }
});

/** For scenarios: read the mock folder back, plant files in it, make writes fail. */
const harness = {
  read: (path: string) => files.get(path) ?? null,
  write: (path: string, text: string) => void files.set(path, text),
  paths: () => [...files.keys()].sort(),
  failWrites: (message: string | null) => void (state.writeError = message),
  calls: () => [...state.calls],
};
(window as unknown as { wetware: typeof harness }).wetware = harness;

await import("../src/main");
