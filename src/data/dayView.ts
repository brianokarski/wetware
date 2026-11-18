/**
 * A single day laid out for reading: beside its habits, what the app logged
 * by itself, and whatever else the file holds. Nothing in the frontmatter is
 * left out of sight: a key is a habit's, or the app's own log, or it is
 * listed among the other properties.
 */
import { dayTags } from "./cells";
import type { Day, DayPatch, DayValue } from "./dayFile";
import { TAGS_KEY, VITALS_KEYS, WEATHER_KEYS } from "./dayKeys";
import { dayKey, type Habit } from "./habits";
import type { Units } from "./settings";
import { isDict } from "./yamlPatch";

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

const isTagText = (item: unknown) => typeof item === "string" || typeof item === "number";

/**
 * What a day holds beside the values of the habits on show. Between the
 * habits' rows and these two lists, everything in the frontmatter is shown
 * somewhere.
 *
 * `logged`: HRV, resting heart rate, sleep score and the weather, where the
 * day has a value for them.
 *
 * `other`: the rest, in the file's order, as written.
 * - The user's own keys, and the values of habits that are archived.
 * - A logged key that holds nothing (`hrv: null`).
 * - Whatever is in `tags` that no tag habit shows, text or not.
 * - The file's bookkeeping: `_synced_at`, a `date` that isn't the day the
 *   file is named for, and any `_sources` entry that no row shows (its key
 *   has no row here, or what it says isn't text).
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
  /** The keys whose rows show where their value came from. */
  const sourced = new Set([...habitKeys, ...logged.map(({ key }) => key)]);

  const other: OtherProperty[] = [];
  const list = (key: string, value: unknown) => other.push({ key, text: valueText(value) });
  for (const [key, value] of Object.entries(day.raw)) {
    if (key === "date") {
      if (valueText(value) !== day.date) list(key, value);
    } else if (key === "_sources") {
      if (!isDict(value)) list(key, value);
      else {
        for (const [entry, source] of Object.entries(value)) {
          if (!sourced.has(entry) || typeof source !== "string") list(`_sources.${entry}`, source);
        }
      }
    } else if (habitKeys.has(key)) {
      // In its habit's row, readable as that habit's type or not.
    } else if (loggedKeys.has(key)) {
      if (value === null) list(key, value);
    } else if (key === TAGS_KEY && (Array.isArray(value) || isTagText(value))) {
      // The tags a tag habit shows are in its row. The rest are listed here, whatever they are.
      const items = Array.isArray(value) ? value : [value];
      const rest = items.filter((item) => !(isTagText(item) && tagHabits.has(String(item).trim())));
      if (rest.length > 0) list(key, rest);
    } else {
      list(key, value);
    }
  }
  return { logged, other };
}

/**
 * What the file holds under a habit's key when it isn't something a habit
 * of that type can hold: text where a number goes (`weight_lb: 182 lb`), a
 * list, a word where true or false goes. The cell reads as empty; this is
 * the value as written, to be shown beside it. Null when the key is absent,
 * empty, or readable.
 */
export function unreadableValue(habit: Habit, day: Day): string | null {
  if (habit.type === "tag") return null;
  const key = dayKey(habit);
  const raw = own(day.values, key) ? day.values[key] : null;
  if (raw === null) return null;
  const readable = habit.type === "check" ? typeof raw === "boolean" : typeof raw === "number" && Number.isFinite(raw);
  return readable ? null : valueText(raw);
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
