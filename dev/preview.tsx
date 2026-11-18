/**
 * The real app in a browser tab, for looking at and for `npm run shots`.
 *
 * There is no Rust shell here: the Tauri IPC is mocked over an in-memory data
 * folder, seeded from test/fixtures/data-folder (made-up data). Development
 * only. Nothing in dev/ is part of the production bundle.
 *
 * The mock keeps the shell's rule about folders: each opening of a folder
 * gets a number, file commands carry it, and one with a stale number is
 * refused. The folder the picker gives can be the same files under another
 * path (the default), a different folder with files of its own, or nothing
 * at all (cancelled): see `pick` below.
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
/** What the picker gives by default: another path to the same files. */
const PICKED_ROOT = "/Users/preview/Notes/Wetware";
/** What the picker gives after `pick("other")`: a folder of its own, holding the fixture as it is on disk. */
const OTHER_ROOT = "/Users/preview/Elsewhere/Wetware";
const FOLDER_CHANGED = "The data folder was changed";

const params = new URLSearchParams(window.location.search);
const folder = params.get("folder") ?? "fixture";
const answers = params.get("sync") ?? "quiet";
const key = params.get("key") ?? "none";
const [year, month, day] = (params.get("today") ?? "2026-11-17").split("-").map(Number);
let clock = new Date(year, month - 1, day, 9, 41);
setClock(() => clock);

const fixture = import.meta.glob("../test/fixtures/data-folder/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const fixtureFiles = () => new Map(Object.entries(fixture).map(([path, text]) => [path.slice(FIXTURE_DIR.length), text]));

type Files = Map<string, string>;
const files: Files = folder === "fixture" ? fixtureFiles() : new Map();
const folders = new Map<string, Files>([[SUGGESTED_ROOT, files], [PICKED_ROOT, files], [OTHER_ROOT, fixtureFiles()]]);

const sources = import.meta.glob("../test/fixtures/sync/*.json", { import: "default", eager: true }) as Record<string, unknown>;
const source = (name: string) => structuredClone(sources[`../test/fixtures/sync/${name}.json`]);

/** What the shell keeps of an activity before handing it over (`ACTIVITY_FIELDS` in net.rs). */
const ACTIVITY_FIELDS = ["id", "start_date_local", "type", "source", "_note", "moving_time", "elapsed_time"];

const state = {
  root: folder === "none" ? null : (SUGGESTED_ROOT as string | null),
  /** The number of the folder now open. It goes up with every opening. */
  folderId: 1,
  /** What the folder picker does next. */
  picker: "same" as "same" | "other" | "cancel",
  /** File commands refused for carrying the number of a folder that was left. */
  refused: [] as string[],
  /** Every write that was let through: the folder it landed in, and the number it carried. */
  writes: [] as { root: string; path: string; folder: number }[],
  keyStored: key !== "none",
  /** Whether intervals.icu turns the stored key down. Saving another key makes it one that works. */
  keyRejected: key === "rejected",
  /** When set, the fetch command fails with this, as the shell reports problems. */
  intervalsProblem: null as object | null,
  weatherProblem: null as object | null,
  /** How long a fetch takes, in milliseconds. */
  fetchDelay: 0,
  /** Whether intervals.icu writes its activities' starts in a form the app doesn't expect: a space where the T is. */
  oddStarts: false,
  /** How long a read or a write of a path takes. `*` is every path that has no time of its own. */
  readDelays: new Map<string, number>(),
  writeDelays: new Map<string, number>(),
  /** Every fetch the app has asked for, with its arguments. */
  fetches: [] as string[],
  /** The shell's own record of syncing, outside the data folder. */
  sync: { last_synced_ms: null as number | null, intervals_hint_shown: params.get("told") !== "no" },
  /** When set, data_write fails with this message, as a full disk would. */
  writeError: null as string | null,
  /** Paths data_read and data_write fail for, and the message, as the shell does for a file it can't read or replace. */
  readErrors: new Map<string, string>(),
  writeErrors: new Map<string, string>(),
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

/** As the shell does: a new number for every opening, and the last sync forgotten if the folder is another one. */
function open(root: string) {
  if (state.root !== root) state.sync.last_synced_ms = null;
  state.root = root;
  return { path: root, id: ++state.folderId };
}

/**
 * The files a command carrying this folder number is for, as the shell
 * decides it: the folder now open if the number is its own, and a refusal
 * if not. The answer holds for that one command, however long it takes.
 */
function filesFor(command: string, number: unknown): { root: string; files: Files } {
  if (state.root === null) throw "No data folder chosen yet";
  if (number !== state.folderId) {
    state.refused.push(command);
    throw FOLDER_CHANGED;
  }
  return { root: state.root, files: folders.get(state.root)! };
}

const wait = (ms: number) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const delay = (delays: Map<string, number>, path: string) => wait(delays.get(path) ?? delays.get("*") ?? 0);

mockIPC(async (command, payload) => {
  const args = (payload ?? {}) as Record<string, unknown>;
  state.calls.push(command);
  switch (command) {
    case "get_data_root":
      return state.root === null ? null : { path: state.root, id: state.folderId };
    case "suggested_data_root":
      return SUGGESTED_ROOT;
    case "use_suggested_data_root":
      return open(SUGGESTED_ROOT);
    case "choose_data_root":
      if (state.picker === "cancel") return null;
      return open(state.picker === "other" ? OTHER_ROOT : PICKED_ROOT);
    case "intervals_fetch": {
      state.fetches.push(`${args.kind} ${args.oldest} ${args.newest}`);
      await wait(state.fetchDelay);
      if (!state.keyStored) throw { kind: "no_key" };
      if (state.keyRejected) throw { kind: "key_rejected" };
      if (state.intervalsProblem) throw state.intervalsProblem;
      if (answers !== "fixture") return [];
      if (args.kind === "wellness") return source("intervals-wellness");
      const activities = source("intervals-activities") as Record<string, unknown>[];
      return activities
        .map((activity) => Object.fromEntries(Object.entries(activity).filter(([name]) => ACTIVITY_FIELDS.includes(name))))
        .map((activity) => (state.oddStarts ? { ...activity, start_date_local: String(activity.start_date_local).replace("T", " ") } : activity));
    }
    case "weather_fetch":
      state.fetches.push(`weather ${args.latitude} ${args.longitude} ${args.oldest} ${args.newest}`);
      await wait(state.fetchDelay);
      if (state.weatherProblem) throw state.weatherProblem;
      return answers === "fixture" ? source("open-meteo-berlin") : { daily: { time: [] } };
    case "sync_state_get":
      filesFor(command, args.folder);
      return { ...state.sync };
    case "sync_state_set":
      filesFor(command, args.folder);
      state.sync = { ...(args.state as typeof state.sync) };
      return null;
    case "data_read": {
      const path = checked(args.path);
      const { files } = filesFor(command, args.folder);
      await delay(state.readDelays, path);
      const unreadable = state.readErrors.get(path);
      if (unreadable !== undefined) throw unreadable;
      return files.get(path) ?? null;
    }
    case "data_write": {
      const path = checked(args.path);
      const { root, files } = filesFor(command, args.folder);
      await delay(state.writeDelays, path);
      const refusal = state.writeErrors.get(path) ?? state.writeError;
      if (refusal) throw refusal;
      files.set(path, String(args.contents));
      state.writes.push({ root, path, folder: Number(args.folder) });
      return null;
    }
    case "data_list": {
      const prefix = `${checked(args.dir)}/`;
      const { files } = filesFor(command, args.folder);
      if (state.listError) throw state.listError;
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

const current = () => folders.get(state.root ?? SUGGESTED_ROOT)!;
const set = <K, V>(map: Map<K, V>, key: K, value: V | null) => void (value === null ? map.delete(key) : map.set(key, value));

/** For scenarios: read the mock folders back, plant files in them, make reads, writes and fetches slow or fail. */
const harness = {
  /** The folder now open. */
  read: (path: string) => current().get(path) ?? null,
  write: (path: string, text: string) => void current().set(path, text),
  paths: () => [...current().keys()].sort(),
  /** A folder by name, open or not: "suggested" (where the app starts) or "other" (what `pick("other")` opens). */
  readIn: (which: "suggested" | "other", path: string) => folders.get(which === "other" ? OTHER_ROOT : SUGGESTED_ROOT)!.get(path) ?? null,
  pathsIn: (which: "suggested" | "other") => [...folders.get(which === "other" ? OTHER_ROOT : SUGGESTED_ROOT)!.keys()].sort(),
  root: () => state.root,
  /** What the folder picker does the next time it is opened. */
  pick: (mode: "same" | "other" | "cancel") => void (state.picker = mode),
  /** File commands the shell refused because the folder they were for had been left. */
  refused: () => [...state.refused],
  /** Every write let through: where it landed and the folder number it carried. */
  writes: () => state.writes.map((write) => ({ ...write })),
  failWrites: (message: string | null) => void (state.writeError = message),
  failWrite: (path: string, message: string | null) => set(state.writeErrors, path, message),
  failList: (message: string | null) => void (state.listError = message),
  failRead: (path: string, message: string | null) => set(state.readErrors, path, message),
  /** Make reads or writes of a path take this long. `*` is every path with no time of its own; null puts it back. */
  slowRead: (path: string, ms: number | null) => set(state.readDelays, path, ms),
  slowWrite: (path: string, ms: number | null) => set(state.writeDelays, path, ms),
  calls: () => [...state.calls],
  /** The fetches asked for so far: "wellness 2026-10-25 2026-11-17", "weather 37.8 -122.27 2026-10-25 2026-11-17". */
  fetches: () => [...state.fetches],
  failIntervals: (problem: object | null) => void (state.intervalsProblem = problem),
  failWeather: (problem: object | null) => void (state.weatherProblem = problem),
  slowFetches: (ms: number) => void (state.fetchDelay = ms),
  /** Make every activity's start unreadable, as it would be if intervals.icu wrote it another way. */
  oddStarts: (on: boolean) => void (state.oddStarts = on),
  syncState: () => ({ ...state.sync }),
  /** Move the app's clock to another time of the same day. */
  setTime: (hours: number, minutes: number) => void (clock = new Date(year, month - 1, day, hours, minutes)),
};
(window as unknown as { wetware: typeof harness }).wetware = harness;

await import("../src/main");
