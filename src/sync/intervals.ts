/**
 * intervals.icu responses, as the API sends them, into what happened on each
 * day. Field names are the ones in the API's OpenAPI document
 * (https://intervals.icu/api/v1/docs): `Wellness` and `Activity`.
 */
import { parseDateKey } from "../data";
import { SourceShapeError } from "./problems";

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === "object" && value !== null && !Array.isArray(value);

/** One activity that can be read: what it was, the day it started, how long it ran. */
export interface Activity {
  /** The local day it started on. */
  date: string;
  /** The API's `type`, as spelled: `Run`, `WeightTraining`, ... */
  type: string;
  /** Null when the record gives no duration. */
  minutes: number | null;
}

export interface IntervalsData {
  /** Wellness records by local day, as sent. */
  wellness: Map<string, Dict>;
  /** The activities that can be read, by the local day they started on. */
  activities: Map<string, Activity[]>;
  /** Activities that reached intervals.icu through Strava (`source: STRAVA`): sent as stubs with no detail. */
  withheld: number;
  /**
   * Records that can't be used: a wellness record whose day can't be read, an
   * activity whose start can't be read, an activity from any source but
   * Strava that has no type, and anything that isn't a record at all.
   */
  unreadable: number;
  /**
   * The days that have an activity of no known kind (a Strava stub, or one
   * with no type): something was done that day, and there is no saying what.
   */
  unreadableDays: Set<string>;
}

/**
 * Values that intervals.icu carries over from the athlete's settings when
 * nothing was measured that day. Each has a flag that says so, and a value so
 * flagged is not a reading.
 */
const CARRIED_OVER: Record<string, string> = { weight: "tempWeight", restingHR: "tempRestingHR" };

/**
 * A measured value from a wellness record, or null if the field is missing,
 * null, not a number, zero or less (none of these is ever truly zero), or
 * flagged as carried over.
 */
export function reading(record: Dict, field: string): number | null {
  const value = Object.prototype.hasOwnProperty.call(record, field) ? record[field] : undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const flag = CARRIED_OVER[field];
  return flag !== undefined && record[flag] === true ? null : value;
}

/**
 * Measurements a watch or ring takes by itself: sleep time and score, heart
 * rate asleep and at rest, HRV, blood oxygen, breathing, steps and floors. A
 * day with any of these was a day the device was worn and syncing. Nothing
 * else on a record counts: not fitness and fatigue, which intervals.icu
 * computes for every day, and not what a person rates or types in (sleep
 * quality, readiness, mood, soreness, weight, comments).
 */
const DEVICE_FIELDS = [
  "sleepSecs", "sleepScore", "avgSleepingHR", "restingHR", "hrv", "hrvSDNN", "spO2", "respiration", "steps", "floorsClimbed",
];

/** Whether a wellness record holds at least one thing a device measured that day. */
export function hasDeviceData(record: Dict): boolean {
  return DEVICE_FIELDS.some((field) => reading(record, field) !== null);
}

/** The local day at the start of `2026-11-17` or `2026-11-17T06:12:44`, or null. */
function localDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = value.slice(0, 10);
  const rest = value.slice(10);
  return parseDateKey(day) && (rest === "" || rest.startsWith("T")) ? day : null;
}

/**
 * `GET /athlete/0/wellness`: a list of records whose `id` is the local day.
 * A record with no day that can be read is counted, not kept.
 */
export function readWellness(raw: unknown): Pick<IntervalsData, "wellness"> & { unreadable: number } {
  if (!Array.isArray(raw)) throw new SourceShapeError("the wellness records were not a list");
  const wellness = new Map<string, Dict>();
  let unreadable = 0;
  for (const record of raw) {
    if (isDict(record) && typeof record.id === "string" && parseDateKey(record.id)) wellness.set(record.id, record);
    else unreadable++;
  }
  return { wellness, unreadable };
}

const seconds = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export interface ActivitiesRead extends Pick<IntervalsData, "activities" | "withheld" | "unreadable" | "unreadableDays"> {
  /** The types of the activities that have a type but no start that can be read. */
  undatedTypes: string[];
}

/**
 * `GET /athlete/0/activities`: a list of activities.
 *
 * One that came through Strava is sent as a stub (an id, a start time,
 * `source: STRAVA` and a note) with no type or duration. Stubs are counted
 * and their days noted, and they are otherwise left out: there is no saying
 * what they were. The same goes for an activity from elsewhere that has no
 * type, which is counted as unreadable, as is one whose start can't be read.
 */
export function readActivities(raw: unknown): ActivitiesRead {
  if (!Array.isArray(raw)) throw new SourceShapeError("the activities were not a list");
  const activities = new Map<string, Activity[]>();
  const unreadableDays = new Set<string>();
  const undatedTypes: string[] = [];
  let withheld = 0;
  let unreadable = 0;
  for (const item of raw) {
    if (!isDict(item)) {
      unreadable++;
      continue;
    }
    const type = typeof item.type === "string" ? item.type.trim() : "";
    const date = localDay(item.start_date_local);
    if (item.source === "STRAVA" || type === "") {
      if (item.source === "STRAVA") withheld++;
      else unreadable++;
      if (date !== null) unreadableDays.add(date);
      continue;
    }
    if (date === null) {
      unreadable++;
      undatedTypes.push(type);
      continue;
    }
    // How long it ran: the longer of the time on the clock and the time moving, since lifting and climbing barely "move".
    const lengths = [seconds(item.elapsed_time), seconds(item.moving_time)].filter((s): s is number => s !== null);
    const minutes = lengths.length > 0 ? Math.max(...lengths) / 60 : null;
    activities.set(date, [...(activities.get(date) ?? []), { date, type, minutes }]);
  }
  return { activities, withheld, unreadable, unreadableDays, undatedTypes };
}

export interface ActivitySummary {
  /** Each distinct `type`, as spelled by intervals.icu, most frequent first. */
  types: { type: string; count: number }[];
  /** Activities whose type could be read. */
  total: number;
  /** Stubs that came through Strava. */
  withheld: number;
  /** Activities sync can't use: no type, or a start it can't place on a day. */
  unreadable: number;
}

/**
 * The activity types in a response and how many of each: what a habit's
 * `activity_types` can be set to. A type is listed whether or not the
 * activity's start can be read: naming it needs no date.
 */
export function summariseActivities(raw: unknown): ActivitySummary {
  const { activities, withheld, unreadable, undatedTypes } = readActivities(raw);
  const counts = new Map<string, number>();
  const placed = [...activities.values()].flat().map((activity) => activity.type);
  for (const type of [...placed, ...undatedTypes]) counts.set(type, (counts.get(type) ?? 0) + 1);
  const types = [...counts].map(([type, count]) => ({ type, count }));
  types.sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
  return { types, total: types.reduce((sum, { count }) => sum + count, 0), withheld, unreadable };
}
