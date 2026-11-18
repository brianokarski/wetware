/**
 * The real app in a browser tab, for looking at and for `npm run shots`.
 *
 * There is no Rust shell here: the Tauri IPC is mocked over an in-memory data
 * folder, seeded from test/fixtures/data-folder (made-up data). Development
 * only. Nothing in dev/ is part of the production bundle.
 *
 * There is no network either. The two fetch commands answer from
 * test/fixtures/sync (made-up intervals.icu data, and a real Open-Meteo
 * response for Berlin), or with nothing new.
 *
 * Query parameters:
 *   today=YYYY-MM-DD   what day the app thinks it is (default 2026-11-17)
 *   folder=fixture     the fixture data folder (default)
 *   folder=empty       a data folder with nothing in it yet
 *   folder=none        no data folder chosen: the first-run state
 *   sync=quiet         the sources have nothing for any day (default)
 *   sync=fixture       the sources answer from test/fixtures/sync
 *   key=none           no intervals.icu key in the Keychain (default)
 *   key=stored         a key that intervals.icu accepts
 *   key=rejected       a key that intervals.icu turns down
 *   told=yes           the user has been told intervals.icu isn't connected (default)
 *   told=no            they haven't yet
 */
import { mockIPC } from "@tauri-apps/api/mocks";
import { setClock } from "../src/platform/clock";

const FIXTURE_DIR = "../test/fixtures/data-folder/";
const SUGGESTED_ROOT = "/Users/preview/Documents/Wetware Data";
const PICKED_ROOT = "/Users/preview/Notes/Wetware";

const params = new URLSearchParams(window.location.search);
const folder = params.get("folder") ?? "fixture";
const answers = params.get("sync") ?? "quiet";
const key = params.get("key") ?? "none";
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

const sources = import.meta.glob("../test/fixtures/sync/*.json", { import: "default", eager: true }) as Record<string, unknown>;
const source = (name: string) => structuredClone(sources[`../test/fixtures/sync/${name}.json`]);

/** What the shell keeps of an activity before handing it over (`ACTIVITY_FIELDS` in net.rs). */
const ACTIVITY_FIELDS = ["id", "start_date_local", "type", "source", "_note", "moving_time", "elapsed_time"];

const state = {
  root: folder === "none" ? null : SUGGESTED_ROOT,
  keyStored: key !== "none",
  /** Whether intervals.icu turns the stored key down. Saving another key makes it one that works. */
  keyRejected: key === "rejected",
  /** When set, the fetch command fails with this, as the shell reports problems. */
  intervalsProblem: null as object | null,
  weatherProblem: null as object | null,
  /** How long a fetch takes, in milliseconds. */
  fetchDelay: 0,
  /** Every fetch the app has asked for, with its arguments. */
  fetches: [] as string[],
  /** The shell's own record of syncing, outside the data folder. */
  sync: { last_synced_ms: null as number | null, intervals_hint_shown: params.get("told") !== "no" },
  /** When set, data_write fails with this message, as a full disk would. */
  writeError: null as string | null,
  /** Paths data_read fails for, and the message it fails with, as the shell does for a file that isn't text. */
  readErrors: new Map<string, string>(),
  /** When set, data_list fails with this message. */
  listError: null as string | null,
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

/** As the shell does: when a sync last ran is forgotten if the folder changes. */
function setRoot(root: string): string {
  if (state.root !== root) state.sync.last_synced_ms = null;
  return (state.root = root);
}

const pause = () => new Promise((resolve) => setTimeout(resolve, state.fetchDelay));

mockIPC(async (command, payload) => {
  const args = (payload ?? {}) as Record<string, unknown>;
  state.calls.push(command);
  switch (command) {
    case "get_data_root":
      return state.root;
    case "suggested_data_root":
      return SUGGESTED_ROOT;
    case "use_suggested_data_root":
      return setRoot(SUGGESTED_ROOT);
    case "choose_data_root":
      return setRoot(PICKED_ROOT);
    case "intervals_fetch": {
      state.fetches.push(`${args.kind} ${args.oldest} ${args.newest}`);
      await pause();
      if (!state.keyStored) throw { kind: "no_key" };
      if (state.keyRejected) throw { kind: "key_rejected" };
      if (state.intervalsProblem) throw state.intervalsProblem;
      if (answers !== "fixture") return [];
      if (args.kind === "wellness") return source("intervals-wellness");
      const activities = source("intervals-activities") as Record<string, unknown>[];
      return activities.map((activity) => Object.fromEntries(Object.entries(activity).filter(([name]) => ACTIVITY_FIELDS.includes(name))));
    }
    case "weather_fetch":
      state.fetches.push(`weather ${args.latitude} ${args.longitude} ${args.oldest} ${args.newest}`);
      await pause();
      if (state.weatherProblem) throw state.weatherProblem;
      return answers === "fixture" ? source("open-meteo-berlin") : { daily: { time: [] } };
    case "sync_state_get":
      return { ...state.sync };
    case "sync_state_set":
      state.sync = { ...(args.state as typeof state.sync) };
      return null;
    case "data_read": {
      const path = checked(args.path);
      const unreadable = state.readErrors.get(path);
      if (unreadable !== undefined) throw unreadable;
      return files.get(path) ?? null;
    }
    case "data_write":
      if (state.writeError) throw state.writeError;
      files.set(checked(args.path), String(args.contents));
      return null;
    case "data_list": {
      if (state.listError) throw state.listError;
      const prefix = `${checked(args.dir)}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => path.slice(prefix.length))
        .filter((name) => !name.startsWith("."))
        .sort();
    }
    case "intervals_key_set":
      state.keyStored = true;
      state.keyRejected = false;
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

/** For scenarios: read the mock folder back, plant files in it, make writes and reads fail. */
const harness = {
  read: (path: string) => files.get(path) ?? null,
  write: (path: string, text: string) => void files.set(path, text),
  paths: () => [...files.keys()].sort(),
  failWrites: (message: string | null) => void (state.writeError = message),
  failList: (message: string | null) => void (state.listError = message),
  failRead: (path: string, message: string | null) =>
    void (message === null ? state.readErrors.delete(path) : state.readErrors.set(path, message)),
  calls: () => [...state.calls],
  /** The fetches asked for so far: "wellness 2026-10-25 2026-11-17", "weather 37.8 -122.27 2026-10-25 2026-11-17". */
  fetches: () => [...state.fetches],
  failIntervals: (problem: object | null) => void (state.intervalsProblem = problem),
  failWeather: (problem: object | null) => void (state.weatherProblem = problem),
  slowFetches: (ms: number) => void (state.fetchDelay = ms),
  syncState: () => ({ ...state.sync }),
};
(window as unknown as { wetware: typeof harness }).wetware = harness;

await import("../src/main");
