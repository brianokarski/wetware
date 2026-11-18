/**
 * A single day laid out for reading: beside its habits, what the app logged
 * by itself, and whatever else the file holds. Nothing in the frontmatter is
 * left out of sight: a key is a habit's, or the app's own log, or it is
 * listed among the other properties.
 */
import { dayTags, isSynced } from "./cells";
import { tagList, type Day, type DayPatch, type DayValue } from "./dayFile";
import { TAGS_KEY, VITALS_KEYS, WEATHER_KEYS } from "./dayKeys";
import { dayKey, type Habit } from "./habits";
import type { Units } from "./settings";

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** A value the app logs by itself each day, beside the habits (SPEC §5.4). */
export interface LoggedValue {
  key: string;
  label: string;
  unit: string | null;
  value: DayValue;
  /** What the day's `_sources` says of it, or null if it says nothing. */
  source: string | null;
}

/** A frontmatter entry that is neither a habit's nor the app's log: the user's own, shown as written. */
export interface OtherProperty {
  key: string;
  text: string;
}

const { F, C } = WEATHER_KEYS;
const LOGGED: Pick<LoggedValue, "key" | "label" | "unit">[] = [
  { key: VITALS_KEYS.hrv, label: "HRV", unit: "ms" },
  { key: VITALS_KEYS.restingHr, label: "Resting heart rate", unit: "bpm" },
  { key: VITALS_KEYS.sleepScore, label: "Sleep score", unit: null },
  { key: F.high, label: "High", unit: "°F" },
  { key: F.low, label: "Low", unit: "°F" },
  { key: C.high, label: "High", unit: "°C" },
  { key: C.low, label: "Low", unit: "°C" },
  { key: F.precipitation, label: "Precipitation", unit: "in" },
  { key: C.precipitation, label: "Precipitation", unit: "mm" },
  { key: F.condition, label: "Conditions", unit: null },
];

/** A frontmatter value as it reads: text as it is, a list between brackets, anything nested as JSON. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(valueText).join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * What a day holds beside the values of the habits on show.
 *
 * `logged`: HRV, resting heart rate, sleep score and the weather, where the
 * day has them. `other`: every remaining frontmatter key, in the file's
 * order. That is the user's own keys, the values of habits that are archived
 * (hidden, with their data kept), and any tags that no tag habit shows.
 */
export function dayParts(habits: Habit[], day: Day): { logged: LoggedValue[]; other: OtherProperty[] } {
  const logged = LOGGED.filter(({ key }) => own(day.values, key) && day.values[key] !== null).map((entry) => ({
    ...entry,
    value: day.values[entry.key],
    source: own(day.sources, entry.key) ? day.sources[entry.key] : null,
  }));

  const shown = habits.filter((habit) => !habit.archived);
  const habitKeys = new Set(shown.filter((habit) => habit.type !== "tag").map(dayKey));
  const tagHabits = new Set(shown.filter((habit) => habit.type === "tag").map((habit) => habit.id));
  const loggedKeys = new Set(LOGGED.map(({ key }) => key));
  const other: OtherProperty[] = [];
  for (const [key, value] of Object.entries(day.values)) {
    if (habitKeys.has(key) || loggedKeys.has(key)) continue;
    if (key === TAGS_KEY && (Array.isArray(value) || typeof value === "string" || typeof value === "number")) {
      // The tags a tag habit shows are in its row. The rest are listed here.
      const rest = tagList(value).filter((tag) => !tagHabits.has(tag));
      if (rest.length > 0) other.push({ key, text: valueText(rest) });
      continue;
    }
    other.push({ key, text: valueText(value) });
  }
  return { logged, other };
}

/**
 * Where a habit's value on a day came from: what `_sources` says, or
 * `unrecorded` for a value with no entry there (typed into the file by
 * hand, as far as sync is concerned), or null if there is no value to speak
 * of. A tag is always set by hand.
 */
export function valueSource(habit: Habit, day: Day): string | null {
  if (habit.type === "tag") return dayTags(day).includes(habit.id) ? "manual" : null;
  const key = dayKey(habit);
  if (own(day.sources, key)) return day.sources[key];
  return own(day.values, key) && day.values[key] !== null ? "unrecorded" : null;
}

/**
 * Whether the habit's value on this day is one sync is keeping its hands off
 * and could fill again: a synced habit, with a value (or a cleared cell) set
 * by hand, or with no source on record.
 */
export function holdsBackSync(habit: Habit, day: Day): boolean {
  if (habit.type === "tag" || !isSynced(habit)) return false;
  const source = valueSource(habit, day);
  return source === "manual" || source === "unrecorded";
}

/**
 * "Use synced value": takes the habit's key and its `_sources` entry out of
 * the day, so that nothing set by hand stands in the way and the next sync
 * fills the value in again. Nothing else in the file changes.
 */
export function useSyncedPatch(habit: Habit): DayPatch {
  const key = dayKey(habit);
  // No prototype, so a key such as `__proto__` is a key like any other.
  const values: Record<string, undefined> = Object.create(null);
  const sources: Record<string, undefined> = Object.create(null);
  values[key] = undefined;
  sources[key] = undefined;
  return { values, sources };
}

/**
 * The day's weather on one line, "47° / 40° F, rain, 0.26 in", from whichever
 * unit the file has it in, the one in Settings first. Null if none was logged.
 */
export function weatherLine(day: Day, prefer: Units["temperature"]): string | null {
  const number = (key: string) => (typeof day.values[key] === "number" && own(day.values, key) ? (day.values[key] as number) : null);
  for (const unit of prefer === "F" ? (["F", "C"] as const) : (["C", "F"] as const)) {
    const keys = WEATHER_KEYS[unit];
    const [high, low, rain] = [number(keys.high), number(keys.low), number(keys.precipitation)];
    if (high === null && low === null && rain === null) continue;
    const condition = own(day.values, keys.condition) ? day.values[keys.condition] : null;
    const temperatures = [high, low].filter((t) => t !== null).map((t) => `${t}°`);
    return [
      temperatures.length > 0 ? `${temperatures.join(" / ")} ${unit}` : null,
      typeof condition === "string" && condition !== "" ? condition : null,
      rain === null ? null : `${rain} ${unit === "F" ? "in" : "mm"}`,
    ].filter((part) => part !== null).join(", ");
  }
  const condition = own(day.values, F.condition) ? day.values[F.condition] : null;
  return typeof condition === "string" && condition !== "" ? condition : null;
}
