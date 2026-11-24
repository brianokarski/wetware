/** Made-up source responses and the fixture data folder, for the sync tests. */
import { readdirSync, readFileSync } from "node:fs";
import { memoryFs } from "../src/data";
import { SyncFailure, type SyncProblem, type SyncSources } from "../src/sync";

const SYNC = new URL("./fixtures/sync/", import.meta.url);
const FOLDER = new URL("./fixtures/data-folder/", import.meta.url);

const json = (name: string): unknown => JSON.parse(readFileSync(new URL(name, SYNC), "utf8"));

/** A fresh copy each time, so one test can't change what the next one reads. */
export const wellnessJson = () => json("intervals-wellness.json") as Record<string, unknown>[];
export const activitiesJson = () => json("intervals-activities.json") as Record<string, unknown>[];
/** A real Open-Meteo response for Berlin, 2026-10-25 to 2026-11-17, in °C and mm. */
export const berlinJson = () => json("open-meteo-berlin.json") as Record<string, unknown>;

/** The fixture data folder, in memory. */
export function folderFs() {
  const files: Record<string, string> = {};
  for (const name of readdirSync(FOLDER, { recursive: true }) as string[]) {
    if (/\.(md|yaml)$/.test(name)) files[name.split("\\").join("/")] = readFileSync(new URL(name, FOLDER), "utf8");
  }
  return memoryFs(files);
}

export interface FakeSources extends SyncSources {
  /** Every fetch made, in order: "wellness 2026-10-25 2026-11-17", "weather 52.52 13.41 2026-10-25 2026-11-17". */
  calls: string[];
}

/**
 * Sources that answer from the fixtures. `intervals` or `weather` can be
 * replaced by a problem to fail with, or by other JSON to answer with.
 */
export function fakeSources(
  options: {
    wellness?: unknown;
    activities?: unknown;
    weather?: unknown;
    intervalsProblem?: SyncProblem;
    weatherProblem?: SyncProblem;
  } = {},
): FakeSources {
  const calls: string[] = [];
  return {
    calls,
    async intervals(kind, oldest, newest) {
      calls.push(`${kind} ${oldest} ${newest}`);
      if (options.intervalsProblem) throw new SyncFailure(options.intervalsProblem);
      if (kind === "wellness") return "wellness" in options ? options.wellness : wellnessJson();
      return "activities" in options ? options.activities : activitiesJson();
    },
    async weather(latitude, longitude, oldest, newest) {
      calls.push(`weather ${latitude} ${longitude} ${oldest} ${newest}`);
      if (options.weatherProblem) throw new SyncFailure(options.weatherProblem);
      return "weather" in options ? options.weather : berlinJson();
    },
  };
}
