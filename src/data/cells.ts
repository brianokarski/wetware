/**
 * What one box of the month grid holds: a habit on a day. Reading a cell,
 * deciding its state, counting a month, parsing what was typed into a cell,
 * and writing a cell back to its day file.
 */
import { DAYS_DIR, parseDay, readDay, tagList, writeDay, type Day, type DayPatch, type DayValue } from "./dayFile";
import { TAGS_KEY } from "./dayKeys";
import type { DataFs } from "./fs";
import { dayKey, type Habit, type HabitType } from "./habits";
import type { Parsed } from "./input";
import { daysInMonth, monthDates, type YearMonth } from "./month";

/** SPEC §5.3. `done` means the cell has a value; see `Cell.met` for progress habits. */
export type CellState = "done" | "missed" | "no_data" | "pending" | "future";

/** What a cell can be set to: on or off for check and tag habits, a number for the rest, null to clear. */
export type CellValue = boolean | number | null;

export interface Cell {
  state: CellState;
  /** `true` for a ticked check or a tag that is present, the number for other types, else null. */
  value: true | number | null;
  /**
   * Whether the day counts toward the month: the same as having a value,
   * except for a progress habit, which has to reach its goal.
   */
  met: boolean;
  /** Progress habits with a value: how far toward the goal, from just above 0 to 1. */
  fraction?: number;
}

/**
 * Sources outside the app, whose silence means "no data" and not a miss.
 * `open-meteo` is what a weather value's `_sources` entry says (SPEC §6.2).
 */
const EXTERNAL_SOURCES = new Set(["intervals", "weather", "open-meteo"]);

/** The day's tags (SPEC §6.2). A `tag` habit is on when its id is one of them. */
export function dayTags(day: Day): string[] {
  return tagList(day.values[TAGS_KEY]);
}

/** The frontmatter value behind a cell, as written. Undefined if the key isn't there. */
function rawValue(habit: Habit, day: Day): DayValue | undefined {
  const key = dayKey(habit);
  return Object.prototype.hasOwnProperty.call(day.values, key) ? day.values[key] : undefined;
}

/** The cell's value if it has one for its habit's type, else null. */
export function cellValue(habit: Habit, day: Day): true | number | null {
  if (habit.type === "tag") return dayTags(day).includes(habit.id) ? true : null;
  const raw = rawValue(habit, day);
  if (habit.type === "check") return raw === true ? true : null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (habit.type === "progress" && raw <= 0) return null;
  return raw;
}

/**
 * Where the cell's value comes from: what the day file recorded for it, or
 * else the habit's own source. A synced cell the user cleared by hand is
 * therefore manual.
 */
export function cellSource(habit: Habit, day: Day): string {
  const key = dayKey(habit);
  const recorded = habit.type !== "tag" && Object.prototype.hasOwnProperty.call(day.sources, key);
  return recorded ? day.sources[key] : habit.source;
}

/** A cell's value and whether it counts toward the month, whatever day it is. */
function measure(habit: Habit, day: Day): Pick<Cell, "value" | "met" | "fraction"> {
  const value = cellValue(habit, day);
  if (value === null) return { value, met: false };
  if (habit.type !== "progress" || typeof value !== "number") return { value, met: true };
  // With no goal to reach, any amount counts.
  const fraction = habit.goal !== null && habit.goal > 0 ? Math.min(1, value / habit.goal) : 1;
  return { value, met: fraction >= 1, fraction };
}

/** `today` is a date key. Dates compare as text because the keys are zero-padded. */
export function cellState(habit: Habit, day: Day, today: string): Cell {
  const measured = measure(habit, day);
  if (measured.value !== null) return { state: "done", ...measured };
  if (day.date > today) return { state: "future", ...measured };
  if (day.date === today) return { state: "pending", ...measured };
  // An explicit `false` says the thing didn't happen. That is known, not missing.
  const saidNo = habit.type === "check" && rawValue(habit, day) === false;
  // Morning pages come from the app's own writing room, so an empty day is a miss.
  const external = !saidNo && EXTERNAL_SOURCES.has(cellSource(habit, day));
  return { state: external ? "no_data" : "missed", ...measured };
}

/** "14/30": the days of the month that count for a habit, out of all its days. A count and nothing more. */
export function monthCount(habit: Habit, days: Iterable<Day>, ym: YearMonth): { done: number; total: number } {
  let done = 0;
  for (const day of days) if (measure(habit, day).met) done++;
  return { done, total: daysInMonth(ym) };
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const WHOLE = /^\+?\d+$/;

/**
 * The largest number a cell takes, either side of zero. Six digits is more
 * than a day's weight, minutes, steps or words needs, and can still be shown.
 */
export const MAX_CELL_NUMBER = 999_999;

/**
 * What was typed into a cell, as a value for a habit of that type. An empty
 * field clears the cell. `ok: false` means the input is invalid and nothing
 * should be written.
 */
export function parseCellInput(type: HabitType, text: string): Parsed<number | null> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  const invalid = { ok: false } as const;
  if (type === "number") {
    const value = DECIMAL.test(trimmed) ? Number(trimmed) : NaN;
    return Math.abs(value) <= MAX_CELL_NUMBER ? { ok: true, value } : invalid;
  }
  if (type === "scale" || type === "duration" || type === "progress") {
    const value = WHOLE.test(trimmed) ? Number(trimmed) : NaN;
    if (!(value <= MAX_CELL_NUMBER)) return invalid;
    if (type === "scale" && (value < 1 || value > 5)) return invalid;
    return { ok: true, value };
  }
  // Check and tag habits are toggled, not typed.
  return invalid;
}

/** Whether `value` is one a cell of this habit can be set to. */
function fits(habit: Habit, value: CellValue): boolean {
  if (habit.type === "check" || habit.type === "tag") return typeof value === "boolean";
  if (value === null) return true;
  if (typeof value !== "number" || !(Math.abs(value) <= MAX_CELL_NUMBER)) return false;
  if (habit.type === "number") return true;
  return Number.isInteger(value) && (habit.type === "scale" ? value >= 1 && value <= 5 : value >= 0);
}

/**
 * The day-file patch that sets a cell from the grid. The value is recorded
 * as manual. Un-ticking a check writes `false`; clearing another type writes
 * `null`. A tag habit adds or removes its id in `tags` and records no source.
 */
export function cellPatch(habit: Habit, value: CellValue): DayPatch {
  if (!fits(habit, value)) throw new RangeError(`Not a value for ${habit.name}: ${String(value)}`);
  if (habit.type === "tag") return { tags: value ? { add: [habit.id] } : { remove: [habit.id] } };
  const key = dayKey(habit);
  return { values: { [key]: value }, sources: { [key]: "manual" } };
}

/**
 * The day as it will read once `patch` is written. Lets the grid show a change
 * before the file is saved. Covers the parts of a patch a cell uses.
 */
export function withPatch(day: Day, patch: DayPatch): Day {
  const values = { ...day.values };
  for (const [key, value] of Object.entries(patch.values ?? {})) {
    if (value === undefined) delete values[key];
    else values[key] = value;
  }
  if (patch.tags) {
    const { add = [], remove = [] } = patch.tags;
    const tags = dayTags(day).filter((tag) => !remove.includes(tag));
    for (const tag of add) if (!tags.includes(tag)) tags.push(tag);
    values[TAGS_KEY] = tags;
  }
  const sources = { ...day.sources };
  for (const [key, source] of Object.entries(patch.sources ?? {})) {
    if (source === undefined) delete sources[key];
    else sources[key] = source;
  }
  return { ...day, values, sources };
}

/**
 * Sets one cell and writes its day file. Resolves to the day as saved, and
 * rejects, writing nothing, if the value doesn't fit the habit's type.
 */
export async function writeCell(fs: DataFs, habit: Habit, date: string, value: CellValue): Promise<Day> {
  return writeDay(fs, date, cellPatch(habit, value));
}

/**
 * Every day of a month, keyed by date. A day with no file is an empty day.
 * One listing and then only the files that exist are read. A file that can't
 * be read (not text, no permission) doesn't stop the month: that day comes
 * back empty with `error` set, like a file that can't be parsed.
 */
export async function loadMonth(fs: DataFs, ym: YearMonth): Promise<Record<string, Day>> {
  const present = new Set(await fs.list(DAYS_DIR));
  const load = async (date: string): Promise<Day> => {
    if (!present.has(`${date}.md`)) return parseDay(null, date);
    try {
      return await readDay(fs, date);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { ...parseDay(null, date), error: `The file could not be read: ${reason}.` };
    }
  };
  const days = await Promise.all(monthDates(ym).map(load));
  return Object.fromEntries(days.map((day) => [day.date, day]));
}

/** Thousands, millions and so on, for numbers too long to show in full. */
const UNITS: [string, number][] = [["k", 1e3], ["M", 1e6], ["B", 1e9], ["T", 1e12]];
/** How far a shortened number may be from the real one, as a share of it. */
const ROUNDING_ALLOWED = 0.05;

/**
 * A number in at most `width` characters, for a narrow cell: decimals go
 * first, then thousands become "k" and millions "M". It never says something
 * that isn't so: a form that would be off by more than a twentieth is not
 * used, and if nothing honest fits, the shortest honest form is returned even
 * though it is longer than asked. The full value goes in the cell's label.
 */
export function shortNumber(value: number, width = 4): string {
  const text = (n: number) => String(n).replace("e+", "e");
  const forms = [text(value), text(Number(value.toFixed(1))), text(Math.round(value))];
  UNITS.forEach(([suffix, unit], i) => {
    for (const count of [Math.round(value / unit), Number((value / unit).toFixed(1))]) {
      const close = Math.abs(count * unit - value) <= Math.abs(value) * ROUNDING_ALLOWED;
      // A thousand of a unit is one of the next: "1M", not "1000k".
      const carries = Math.abs(count) >= 1000 && i < UNITS.length - 1;
      if (count !== 0 && close && !carries) forms.push(`${text(count)}${suffix}`);
    }
  });
  // Past the trillions the units run out: powers of ten, as JavaScript itself writes them from 1e21.
  if (Math.abs(value) >= UNITS[UNITS.length - 1][1] * 1000) {
    for (const digits of [0, 1]) {
      const power = value.toExponential(digits).replace("e+", "e").replace(".0e", "e");
      if (Math.abs(Number(power) - value) <= Math.abs(value) * ROUNDING_ALLOWED) forms.push(power);
    }
  }
  const fits = forms.find((form) => form.length <= width);
  return fits ?? forms.reduce((best, form) => (form.length < best.length ? form : best));
}

/** What a cell holds, in words, for its accessible label. Plain statements: an empty day is just empty. */
export function describeCell(habit: Habit, cell: Cell): string {
  if (cell.value === null) {
    return { done: "", missed: "empty", no_data: "no data", pending: "not filled in yet", future: "not here yet" }[cell.state];
  }
  const unit = habit.unit ? ` ${habit.unit}` : "";
  switch (habit.type) {
    case "check":
      return "done";
    case "tag":
      return "tagged";
    case "scale":
      return `${cell.value} of 5`;
    case "progress":
      if (habit.goal === null) return `${cell.value}${unit}`;
      return `${cell.value} of ${habit.goal}${unit}${cell.met ? ", goal met" : ""}`;
    default:
      return `${cell.value}${unit}`;
  }
}

/** The small print beside a habit's name: its unit, goal or range. Empty for check and tag habits. */
export function habitHint(habit: Habit): string {
  if (habit.type === "scale") return "1–5";
  if (habit.type === "progress" && habit.goal !== null) return `${habit.goal}${habit.unit ? ` ${habit.unit}` : ""}`;
  return habit.type === "check" || habit.type === "tag" ? "" : (habit.unit ?? "");
}
