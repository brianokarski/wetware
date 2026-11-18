/**
 * The rules that turn what the sources sent into values for day files.
 *
 * Two steps. First, what each source says about each day (`intervalsWants`,
 * `weatherWants`): this knows nothing of what is on disk. Then, for one day
 * file as it is at the moment of writing, which of those may be written
 * (`syncPatch`): a value set by hand is never written over, and a value that
 * is already there is not written again.
 */
import {
  datesBetween, dayKey, VITALS_KEYS, WEATHER_KEYS,
  type Day, type DayPatch, type Habit, type Units,
} from "../data";
import { hasDeviceData, reading, type IntervalsData } from "./intervals";
import { condition, type WeatherDay } from "./weather";

/** What a value's `_sources` entry says when sync wrote it (SPEC §6.2). */
export type SyncSource = "intervals" | "open-meteo";

/** One value a source has for a day. */
export interface Want {
  key: string;
  value: boolean | number | string;
  source: SyncSource;
}

/** The values the sources have, by day. A day with nothing has no entry. */
export type Wants = Map<string, Want[]>;

export interface SyncRange {
  oldest: string;
  newest: string;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

const LB_PER_KG = 2.2046226218;

// ---------------------------------------------------------------------------
// intervals.icu: activities
// ---------------------------------------------------------------------------

interface ActivityRule {
  habit: Habit;
  /** Lower case, for comparing. */
  types: string[];
  minMinutes: number;
}

/** A check habit that intervals.icu activities tick. */
const isActivityHabit = (habit: Habit) =>
  !habit.archived && habit.type === "check" && habit.source === "intervals";

/**
 * The habit's rule for matching activities, or null if it has no activity
 * types to match: it is not set up yet, and sync writes nothing for it.
 */
function activityRule(habit: Habit): ActivityRule | null {
  if (!isActivityHabit(habit)) return null;
  const listed = habit.source_rule?.activity_types;
  const types = (Array.isArray(listed) ? listed : [listed])
    .filter((type): type is string => typeof type === "string" && type.trim() !== "")
    .map((type) => type.trim().toLowerCase());
  if (types.length === 0) return null;
  const least = habit.source_rule?.min_minutes;
  return { habit, types, minMinutes: typeof least === "number" && Number.isFinite(least) && least > 0 ? least : 0 };
}

/** Activity habits that can't be filled in until their `source_rule.activity_types` names a type. */
export function habitsNotSetUp(habits: Habit[]): Habit[] {
  return habits.filter((habit) => isActivityHabit(habit) && activityRule(habit) === null);
}

// ---------------------------------------------------------------------------
// intervals.icu: wellness
// ---------------------------------------------------------------------------

interface WellnessTarget {
  habit: Habit;
  /** The wellness field the habit's value comes from. */
  field: string;
}

const NUMERIC = new Set(["number", "duration"]);

/**
 * The habits a wellness record fills: every numeric intervals habit that
 * names a `source_rule.wellness_field`. The Weight habit is the one case
 * found by its id: it is a manual habit (SPEC §5.4), filled from the record's
 * weight only on days it has one and nothing was entered by hand.
 */
function wellnessTargets(habits: Habit[]): WellnessTarget[] {
  const active = habits.filter((habit) => !habit.archived && NUMERIC.has(habit.type));
  const field = (habit: Habit) => {
    const named = habit.source_rule?.wellness_field;
    return typeof named === "string" && named.trim() !== "" ? named.trim() : null;
  };
  const targets: WellnessTarget[] = [];
  for (const habit of active) {
    const named = field(habit);
    if (habit.source === "intervals" && named !== null) targets.push({ habit, field: named });
  }
  if (!targets.some((target) => target.field === "weight")) {
    const weight = active.find((habit) => habit.id === "weight" && habit.type === "number" && field(habit) === null);
    if (weight) targets.push({ habit: weight, field: "weight" });
  }
  return targets;
}

/**
 * A wellness reading in the habit's unit, or null if there is no saying what
 * that would be. intervals.icu keeps weight in kilograms and durations in
 * seconds; everything else is already a plain count, score or rate.
 */
function inHabitUnit(field: string, value: number, habit: Habit): number | null {
  let converted: number;
  if (field === "weight") {
    if (habit.unit === "kg") converted = round(value, 1);
    else if (habit.unit === "lb") converted = round(value * LB_PER_KG, 1);
    else return null;
  } else if (/Secs$/.test(field)) {
    if (habit.unit === "h") converted = round(value / 3600, 1);
    else if (habit.unit === "min") converted = Math.round(value / 60);
    else return null;
  } else {
    converted = round(value, 2);
  }
  return habit.type === "duration" ? Math.round(converted) : converted;
}

// ---------------------------------------------------------------------------
// What each source says about each day
// ---------------------------------------------------------------------------

/**
 * What intervals.icu has for each day of the range.
 *
 * A wellness field that is missing that day is left out, so the cell reads
 * "no data". An activity habit is `true` on a day with a matching activity.
 * It is `false` only on a day the source shows signs of life: some activity
 * that can be read, or a wellness record with something a device measured.
 * On a day with neither, nothing is said, and the cell reads "no data".
 */
export function intervalsWants(habits: Habit[], data: IntervalsData, range: SyncRange): Wants {
  const rules = habits.map(activityRule).filter((rule): rule is ActivityRule => rule !== null);
  const targets = wellnessTargets(habits);
  const wants: Wants = new Map();

  for (const date of datesBetween(range.oldest, range.newest)) {
    const found: Want[] = [];
    const say = (key: string, value: Want["value"]) => found.push({ key, value, source: "intervals" });
    const record = data.wellness.get(date);
    const activities = data.activities.get(date) ?? [];

    if (record) {
      for (const { habit, field } of targets) {
        const measured = reading(record, field);
        const value = measured === null ? null : inHabitUnit(field, measured, habit);
        if (value !== null) say(dayKey(habit), value);
      }
      const hrv = reading(record, "hrv");
      const restingHr = reading(record, "restingHR");
      const sleepScore = reading(record, "sleepScore");
      if (hrv !== null) say(VITALS_KEYS.hrv, round(hrv, 1));
      if (restingHr !== null) say(VITALS_KEYS.restingHr, Math.round(restingHr));
      if (sleepScore !== null) say(VITALS_KEYS.sleepScore, round(sleepScore, 1));
    }

    const alive = activities.length > 0 || (record !== undefined && hasDeviceData(record));
    for (const { habit, types, minMinutes } of rules) {
      const done = activities.some(
        (activity) =>
          types.includes(activity.type.toLowerCase()) &&
          (minMinutes === 0 || (activity.minutes !== null && activity.minutes >= minMinutes)),
      );
      if (done || alive) say(dayKey(habit), done);
    }
    if (found.length > 0) wants.set(date, found);
  }
  return wants;
}

/**
 * What Open-Meteo has for each day of the range, in the units of the
 * temperature setting: whole degrees, and precipitation in inches beside °F
 * or millimetres beside °C. The range ends today, so a forecast for a day
 * still ahead is never kept.
 */
export function weatherWants(temperature: Units["temperature"], weather: Map<string, WeatherDay>, range: SyncRange): Wants {
  const keys = WEATHER_KEYS[temperature];
  const degrees = (celsius: number) => Math.round(temperature === "F" ? (celsius * 9) / 5 + 32 : celsius);
  const wants: Wants = new Map();

  for (const date of datesBetween(range.oldest, range.newest)) {
    const day = weather.get(date);
    if (!day) continue;
    const found: Want[] = [];
    const say = (key: string, value: Want["value"]) => found.push({ key, value, source: "open-meteo" });
    if (day.high !== null) say(keys.high, degrees(day.high));
    if (day.low !== null) say(keys.low, degrees(day.low));
    if (day.precipitation !== null && day.precipitation >= 0) {
      say(keys.precipitation, temperature === "F" ? round(day.precipitation / 25.4, 2) : round(day.precipitation, 1));
    }
    const word = day.code === null ? null : condition(day.code);
    if (word !== null) say(keys.condition, word);
    if (found.length > 0) wants.set(date, found);
  }
  return wants;
}

/** Both sources' values for each day, intervals.icu first. */
export function mergeWants(...all: Wants[]): Wants {
  const merged: Wants = new Map();
  for (const wants of all) {
    for (const [date, found] of wants) merged.set(date, [...(merged.get(date) ?? []), ...found]);
  }
  return new Map([...merged].sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------
// What may be written to a day file
// ---------------------------------------------------------------------------

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/**
 * Whether sync may set `key` in this day.
 *
 * It may where the day's `_sources` says this same source put the value
 * there. It may not where `_sources` says anything else: `manual` above all,
 * and any other source too. Where `_sources` says nothing about the key, it
 * may only fill a gap (no key, or `null`): a value with no recorded source
 * was typed into the file by hand.
 */
function mayWrite(day: Day, want: Want): boolean {
  if (own(day.sources, want.key)) return day.sources[want.key] === want.source;
  return !own(day.values, want.key) || day.values[want.key] === null;
}

/**
 * The patch that brings a day file in line with what the sources have, or
 * null if there is nothing to change: then the file is not touched, and not
 * created. `_synced_at` is set only along with a value.
 */
export function syncPatch(day: Day, wants: Want[], syncedAt: string): DayPatch | null {
  // No prototype, so a key such as `__proto__` is a key like any other.
  const values: Record<string, Want["value"]> = Object.create(null);
  const sources: Record<string, string> = Object.create(null);
  let changes = 0;
  for (const want of wants) {
    if (!mayWrite(day, want)) continue;
    if (own(day.values, want.key) && day.values[want.key] === want.value) continue;
    values[want.key] = want.value;
    sources[want.key] = want.source;
    changes++;
  }
  return changes > 0 ? { values, sources, syncedAt } : null;
}
