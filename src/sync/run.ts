/**
 * A sync from start to finish: fetch from each source, work out what each day
 * should hold, and write the day files that differ. The fetching itself is
 * handed in (`SyncSources`): in the app it is the Rust shell, which holds the
 * API key and makes every network call.
 */
import {
  addDays, dateKey, localTimestamp, monthKey, monthOf, reason, writeDay,
  type DataFs, type Habit, type Settings,
} from "../data";
import { readActivities, readWellness, summariseActivities, type ActivitySummary, type IntervalsData } from "./intervals";
import { intervalsWants, mergeWants, syncPatch, weatherWants, type SyncRange, type Wants } from "./plan";
import { asProblem, type SyncProblem } from "./problems";
import { readWeather } from "./weather";

/** Where the data comes from. Each call resolves to the source's JSON, or rejects with a `SyncProblem`. */
export interface SyncSources {
  /** intervals.icu wellness records or activities for the days from `oldest` to `newest`. */
  intervals(kind: "wellness" | "activities", oldest: string, newest: string): Promise<unknown>;
  /** Open-Meteo daily weather at a place for the days from `oldest` to `newest`. */
  weather(latitude: number, longitude: number, oldest: string, newest: string): Promise<unknown>;
}

/** How a source fared. `not_set_up`: no API key stored, or no location set. Not an error. */
export type SourceOutcome =
  | { status: "synced" }
  | { status: "not_set_up" }
  | { status: "failed"; problem: SyncProblem };

export interface SyncReport {
  range: SyncRange;
  /** What was written to `_synced_at`. */
  syncedAt: string;
  /** The days whose files were written, in order. */
  changed: string[];
  intervals: SourceOutcome;
  weather: SourceOutcome;
  /** Activities in the range that came through Strava and couldn't be read. */
  withheld: number;
  /** Days that had something to write and whose file couldn't take it. */
  unwritten: { date: string; reason: string }[];
  /** The sync was called off part-way (`SyncJob.stillWanted`): the days after the last one changed were not looked at. */
  stopped: boolean;
}

/** How far back the activity types are counted for "Test connection". */
export const CONNECTION_TEST_DAYS = 90;

/** SPEC §7.1: the current month and the seven days before it (late-syncing watches), up to today. */
export function syncRange(today: string): SyncRange {
  return { oldest: addDays(`${monthKey(monthOf(today))}-01`, -7), newest: today };
}

function failed(thrown: unknown): SourceOutcome {
  const problem = asProblem(thrown);
  return problem.kind === "no_key" ? { status: "not_set_up" } : { status: "failed", problem };
}

interface Pulled {
  outcome: SourceOutcome;
  wants: Wants;
  withheld: number;
}

const NOTHING: Wants = new Map();

/**
 * Both intervals.icu lists, or neither: whether a day without a run counts
 * as "no run" depends on the wellness records and the activities together.
 */
async function pullIntervals(sources: SyncSources, habits: Habit[], range: SyncRange): Promise<Pulled> {
  try {
    const wellness = readWellness(await sources.intervals("wellness", range.oldest, range.newest));
    const read = readActivities(await sources.intervals("activities", range.oldest, range.newest));
    const data: IntervalsData = { wellness, ...read };
    return { outcome: { status: "synced" }, wants: intervalsWants(habits, data, range), withheld: read.withheld };
  } catch (e) {
    return { outcome: failed(e), wants: NOTHING, withheld: 0 };
  }
}

async function pullWeather(sources: SyncSources, settings: Settings, range: SyncRange): Promise<Pulled> {
  const { latitude, longitude } = settings.location;
  if (latitude === null || longitude === null) return { outcome: { status: "not_set_up" }, wants: NOTHING, withheld: 0 };
  try {
    const weather = readWeather(await sources.weather(latitude, longitude, range.oldest, range.newest));
    return { outcome: { status: "synced" }, wants: weatherWants(settings.units.temperature, weather, range), withheld: 0 };
  } catch (e) {
    return { outcome: failed(e), wants: NOTHING, withheld: 0 };
  }
}

export interface SyncJob {
  fs: DataFs;
  sources: SyncSources;
  habits: Habit[];
  settings: Settings;
  /** The moment the sync runs: it decides what "today" is and what `_synced_at` says. */
  now: Date;
  /**
   * Asked before each day file is touched. Once it says no, nothing more is
   * read or written: the data folder is being changed under the sync, and
   * what it fetched belongs to the folder it started on.
   */
  stillWanted?: () => boolean;
}

/**
 * Runs one sync. The two sources are independent: either can fail or be not
 * set up without holding back the other. Never rejects for anything a source
 * or a day file does; the report says what happened.
 */
export async function runSync({ fs, sources, habits, settings, now, stillWanted }: SyncJob): Promise<SyncReport> {
  const range = syncRange(dateKey(now));
  const syncedAt = localTimestamp(now);
  const [intervals, weather] = await Promise.all([
    pullIntervals(sources, habits, range),
    pullWeather(sources, settings, range),
  ]);

  const changed: string[] = [];
  const unwritten: SyncReport["unwritten"] = [];
  let stopped = false;
  for (const [date, wants] of mergeWants(intervals.wants, weather.wants)) {
    if (stillWanted && !stillWanted()) {
      stopped = true;
      break;
    }
    let wrote = false;
    try {
      // The patch is worked out against the file as it is when its turn comes, so an edit made meanwhile is seen.
      await writeDay(fs, date, (day) => {
        const patch = syncPatch(day, wants, syncedAt);
        wrote = patch !== null;
        return patch;
      });
      if (wrote) changed.push(date);
    } catch (e) {
      unwritten.push({ date, reason: reason(e) });
    }
  }
  return {
    range, syncedAt, changed, unwritten, stopped,
    intervals: intervals.outcome,
    weather: weather.outcome,
    withheld: intervals.withheld,
  };
}

/**
 * "Test connection": the activity types intervals.icu has for the last 90
 * days, and how many of each. Rejects with what went wrong; `asProblem` names it.
 */
export async function testConnection(sources: SyncSources, now: Date): Promise<ActivitySummary> {
  const today = dateKey(now);
  return summariseActivities(await sources.intervals("activities", addDays(today, -CONNECTION_TEST_DAYS), today));
}
