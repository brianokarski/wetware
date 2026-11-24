import { stringify } from "yaml";
import { APP_DAY_KEYS } from "./dayKeys";
import type { DataFs } from "./fs";
import { inTurn } from "./queue";
import { isDict, patchYaml, readYaml, same, YAML_OUT, type YamlOp } from "./yamlPatch";

export const HABITS_FILE = "habits.yaml";

const HABIT_TYPES = ["check", "number", "scale", "progress", "duration", "tag"] as const;
const HABIT_SOURCES = ["manual", "intervals", "weather", "morning_pages"] as const;
const HABIT_DIRECTIONS = ["higher", "lower", "neutral"] as const;

export type HabitType = (typeof HABIT_TYPES)[number];
export type HabitSource = (typeof HABIT_SOURCES)[number];
export type HabitDirection = (typeof HABIT_DIRECTIONS)[number];

export interface SourceRule {
  activity_types?: string[];
  min_minutes?: number;
  /** intervals.icu wellness field, e.g. sleepSecs */
  wellness_field?: string;
  [key: string]: unknown;
}

export interface Habit {
  id: string;
  name: string;
  type: HabitType;
  unit: string | null;
  goal: number | null;
  direction: HabitDirection;
  source: HabitSource;
  source_rule: SourceRule | null;
  color: string;
  show_on_calendar: boolean;
  order: number;
  archived: boolean;
  /** Keys we don't know about are carried through untouched. */
  [key: string]: unknown;
}

/** What a new habit needs. Everything else falls back to a default in memory. */
export type NewHabit = Pick<Habit, "id"> & Partial<Habit>;

/** An entry in habits.yaml that couldn't be used. It stays in the file as it is. */
export interface SkippedHabit {
  /** Position in the file's list, from 0. */
  index: number;
  id: string | null;
  reason: string;
}

export interface HabitsFile {
  habits: Habit[];
  skipped: SkippedHabit[];
}

/** habits.yaml can't be used as it is, or a change to it isn't valid. */
export class HabitsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HabitsError";
  }
}

/**
 * Used in memory for anything a habit doesn't say. Never written to the file
 * on the user's behalf: only the seed set spells every field out.
 */
const DEFAULTS: Pick<
  Habit,
  "unit" | "goal" | "direction" | "source" | "source_rule" | "color" | "show_on_calendar" | "archived"
> = {
  unit: null,
  goal: null,
  direction: "higher",
  source: "manual",
  source_rule: null,
  color: "#111111",
  show_on_calendar: false,
  archived: false,
};

const FIELD_ORDER = [
  "id", "name", "type", "unit", "goal", "direction", "source", "source_rule", "color",
  "show_on_calendar", "order", "archived",
];

/** A seed habit with every field spelled out, in the order SPEC §5.2 lists them. */
function seed(order: number, h: Pick<Habit, "id" | "name" | "type"> & Partial<Habit>): Habit {
  const full: Record<string, unknown> = { ...DEFAULTS, ...h, order };
  return Object.fromEntries(FIELD_ORDER.map((key) => [key, full[key]])) as Habit;
}

/**
 * SPEC §5.4. Lift and Climb have no activity types yet: they get filled in
 * from Brian's real intervals.icu data in Milestone 3 (open question 3).
 */
export const SEED_HABITS: Habit[] = [
  seed(1, { id: "weight", name: "Weight", type: "number", unit: "lb", direction: "neutral" }),
  seed(2, {
    id: "run", name: "Run", type: "check", source: "intervals",
    source_rule: { activity_types: ["Run"], min_minutes: 0 },
    color: "#3A7D44", show_on_calendar: true,
  }),
  seed(3, {
    id: "lift", name: "Lift", type: "check", source: "intervals",
    source_rule: { activity_types: [], min_minutes: 0 },
    color: "#C2452D", show_on_calendar: true,
  }),
  seed(4, {
    id: "climb", name: "Climb", type: "check", source: "intervals",
    source_rule: { activity_types: [], min_minutes: 0 },
    color: "#2F5FA8", show_on_calendar: true,
  }),
  seed(5, {
    id: "sleep", name: "Sleep", type: "number", unit: "h", source: "intervals",
    source_rule: { wellness_field: "sleepSecs" },
  }),
  seed(6, {
    id: "morning_pages", name: "Morning pages", type: "progress", unit: "words", goal: 750,
    source: "morning_pages", color: "#D9A21B", show_on_calendar: true,
  }),
  seed(7, { id: "meditate", name: "Meditate", type: "check", color: "#7A4FA3", show_on_calendar: true }),
  seed(8, { id: "brain_fog", name: "Brain fog", type: "scale", direction: "lower" }),
  seed(9, { id: "mood", name: "Mood", type: "scale" }),
];

/** Frontmatter key for a habit: its id, plus a unit suffix when it has one (SPEC §6.2). */
export function dayKey(habit: Pick<Habit, "id" | "unit">): string {
  return habit.unit ? `${habit.id}_${habit.unit}` : habit.id;
}

// ---------------------------------------------------------------------------
// Reading: every field is checked and given its proper type.
// ---------------------------------------------------------------------------

/** Thrown inside `normalise` when a field can't be used. */
class Unusable extends Error {}

const absent = (value: unknown) => value === undefined || value === null;

function text(field: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Unusable(`${field} is not text`);
}

function numeric(field: string, value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  throw new Unusable(`${field} is not a number`);
}

const TRUE = new Set(["true", "yes", "on"]);
const FALSE = new Set(["false", "no", "off"]);

function bool(field: string, value: unknown): boolean {
  if (typeof value === "boolean") return value;
  // YAML 1.1 habits: `yes` and `no` are read as text by YAML 1.2.
  if (typeof value === "string" && TRUE.has(value.toLowerCase())) return true;
  if (typeof value === "string" && FALSE.has(value.toLowerCase())) return false;
  throw new Unusable(`${field} is not true or false`);
}

function choice<T extends string>(field: string, options: readonly T[], value: unknown): T {
  const found = options.find((option) => option === value);
  if (found === undefined) throw new Unusable(`${field} is not one of ${options.join(", ")}`);
  return found;
}

/**
 * One habits.yaml entry as a Habit. `position` is where it sits in the file,
 * from 1, and is its order unless it says otherwise. Throws `Unusable` rather
 * than guess at a field it can't read.
 */
function normalise(entry: unknown, position: number): Habit {
  if (!isDict(entry)) throw new Unusable("is not a set of key: value lines");
  if (absent(entry.id)) throw new Unusable("has no id");
  const id = text("id", entry.id);
  if (id.trim() === "") throw new Unusable("has no id");
  const or = <T>(value: unknown, fallback: T, read: (value: unknown) => T): T =>
    absent(value) ? fallback : read(value);

  let sourceRule: SourceRule | null = null;
  if (isDict(entry.source_rule)) sourceRule = entry.source_rule;
  else if (!absent(entry.source_rule)) throw new Unusable("source_rule is not a set of key: value lines");
  if (!absent(entry.unit) && typeof entry.unit !== "string") throw new Unusable("unit is not text");
  if (!absent(entry.color) && typeof entry.color !== "string") throw new Unusable("color is not text");

  return {
    ...entry,
    id,
    name: or(entry.name, id, (v) => text("name", v)),
    type: or(entry.type, "check", (v) => choice("type", HABIT_TYPES, v)),
    unit: (entry.unit as string | null | undefined) ?? DEFAULTS.unit,
    goal: or(entry.goal, DEFAULTS.goal, (v) => numeric("goal", v)),
    direction: or(entry.direction, DEFAULTS.direction, (v) => choice("direction", HABIT_DIRECTIONS, v)),
    source: or(entry.source, DEFAULTS.source, (v) => choice("source", HABIT_SOURCES, v)),
    source_rule: sourceRule,
    color: (entry.color as string | null | undefined) ?? DEFAULTS.color,
    show_on_calendar: or(entry.show_on_calendar, DEFAULTS.show_on_calendar, (v) => bool("show_on_calendar", v)),
    order: or(entry.order, position, (v) => numeric("order", v)),
    archived: or(entry.archived, DEFAULTS.archived, (v) => bool("archived", v)),
  };
}

/**
 * Why a habit can't keep its values under its day key, or null if it can. The
 * key has to be the habit's alone: not one the app owns, and not another
 * habit's. A tag habit is exempt, because it lives in the tags list and never
 * writes to its key.
 */
function keyClash(habit: Habit, others: Habit[]): string | null {
  if (habit.type === "tag") return null;
  const key = dayKey(habit);
  if (APP_DAY_KEYS.includes(key)) return `would store its values under ${key}, a key the app keeps for itself`;
  const other = others.find((h) => h.id !== habit.id && h.type !== "tag" && dayKey(h) === key);
  return other ? `would store its values under ${key}, the same key as ${other.name}` : null;
}

interface Entry {
  habit: Habit;
  /** Position in the file's list, from 0: the index to patch at. */
  index: number;
}

interface FileState {
  entries: Entry[];
  skipped: SkippedHabit[];
  /** How many items the file's list has, usable or not. */
  length: number;
}

function readFile(raw: string): FileState {
  const data = readYaml(raw) ?? {};
  if (!isDict(data)) throw new HabitsError(`${HABITS_FILE} has to start with a habits: list`);
  const list = data.habits ?? [];
  if (!Array.isArray(list)) throw new HabitsError(`habits in ${HABITS_FILE} has to be a list`);

  const entries: Entry[] = [];
  const skipped: SkippedHabit[] = [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    try {
      const habit = normalise(entry, index + 1);
      if (seen.has(habit.id)) throw new Unusable("repeats an id used earlier in the file");
      const clash = keyClash(habit, entries.map((e) => e.habit));
      if (clash) throw new Unusable(clash);
      seen.add(habit.id);
      entries.push({ habit, index });
    } catch (e) {
      if (!(e instanceof Unusable)) throw e;
      const id = isDict(entry) && (typeof entry.id === "string" || typeof entry.id === "number") ? String(entry.id) : null;
      skipped.push({ index, id, reason: e.message });
    }
  });
  return { entries, skipped, length: list.length };
}

const inOrder = (entries: Entry[]): Entry[] => [...entries].sort((a, b) => a.habit.order - b.habit.order);

/**
 * Reads habits.yaml. An entry with a field that can't be used is left out and
 * listed in `skipped`. Throws if the file isn't valid YAML or has no usable
 * `habits` list, since it then can't be saved to either.
 */
export function parseHabitsFile(raw: string): HabitsFile {
  const { entries, skipped } = readFile(raw);
  return { habits: inOrder(entries).map((e) => e.habit), skipped };
}

export function parseHabits(raw: string): Habit[] {
  return parseHabitsFile(raw).habits;
}

/** The whole file from scratch. Only used to write the seed set. */
export function serializeHabits(habits: Habit[]): string {
  return stringify({ habits }, YAML_OUT);
}

/** Reads habits.yaml, writing the seed set the first time the folder is used. */
export function loadHabitsFile(fs: DataFs): Promise<HabitsFile> {
  return inTurn(fs, HABITS_FILE, async () => parseHabitsFile(await readOrSeed(fs)));
}

export async function loadHabits(fs: DataFs): Promise<Habit[]> {
  return (await loadHabitsFile(fs)).habits;
}

async function readOrSeed(fs: DataFs): Promise<string> {
  const raw = await fs.read(HABITS_FILE);
  if (raw !== null) return raw;
  const seeded = serializeHabits(SEED_HABITS);
  await fs.write(HABITS_FILE, seeded);
  return seeded;
}

// ---------------------------------------------------------------------------
// Writing: every change is a patch to the entries it names.
// ---------------------------------------------------------------------------

/** Reads the file, applies the operations `build` returns, and writes it back. One at a time. */
function patchFile(fs: DataFs, build: (state: FileState) => YamlOp[]): Promise<Habit[]> {
  return inTurn(fs, HABITS_FILE, async () => {
    const raw = await readOrSeed(fs);
    const next = patchYaml(raw, build(readFile(raw)));
    if (next !== raw) await fs.write(HABITS_FILE, next);
    return parseHabits(next);
  });
}

function find(state: FileState, id: string): Entry {
  const entry = state.entries.find((e) => e.habit.id === id);
  if (!entry) throw new HabitsError(`No habit with the id ${id}`);
  return entry;
}

/** Operations that bring one entry in line with `changes`, touching only fields that differ. */
function changeOps(state: FileState, entry: Entry, changes: Partial<Habit>): YamlOp[] {
  const { habit, index } = entry;
  if (changes.id !== undefined && changes.id !== habit.id) {
    throw new HabitsError("A habit's id can't be changed: its day values are stored under it");
  }
  const ops: YamlOp[] = [];
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || same(value, habit[key])) continue;
    ops.push({ op: "set", path: ["habits", index, key], value });
  }
  check(state, { ...habit, ...changes }, index);
  return ops;
}

/** Throws unless `habit` is something `parseHabits` would read back, beside the habits already there. */
function check(state: FileState, habit: Record<string, unknown>, index: number): void {
  try {
    const clash = keyClash(normalise(habit, index + 1), state.entries.map((e) => e.habit));
    if (clash) throw new Unusable(clash);
  } catch (e) {
    if (e instanceof Unusable) throw new HabitsError(`Not a valid habit: ${e.message}`);
    throw e;
  }
}

/** Operations that add a habit to the end of the list and of the order. */
function addOps(state: FileState, habit: NewHabit): YamlOp[] {
  const taken = (id: string) =>
    state.entries.some((e) => e.habit.id === id) || state.skipped.some((s) => s.id === id);
  if (taken(String(habit.id))) throw new HabitsError(`There is already a habit with the id ${habit.id}`);
  check(state, habit, state.length);

  // Known fields in the order SPEC §5.2 lists them, then anything else as given.
  const entry: Record<string, unknown> = {};
  for (const key of [...FIELD_ORDER, ...Object.keys(habit)]) {
    if (habit[key] !== undefined) entry[key] = habit[key];
  }
  if (entry.order === undefined) {
    // Its place in the file puts it last unless earlier habits were given higher numbers.
    const last = Math.max(0, ...state.entries.map((e) => e.habit.order));
    if (last >= state.length + 1) entry.order = Math.floor(last) + 1;
  }
  return [{ op: "append", path: ["habits"], value: entry }];
}

/** Changes fields of one habit. Fields that already have the given value are not written. */
export function updateHabit(fs: DataFs, id: string, changes: Partial<Habit>): Promise<Habit[]> {
  return patchFile(fs, (state) => changeOps(state, find(state, id), changes));
}

/** Adds a habit at the end. Only the fields given are written. */
export function addHabit(fs: DataFs, habit: NewHabit): Promise<Habit[]> {
  return patchFile(fs, (state) => addOps(state, habit));
}

/** Archiving hides a habit from the grid and keeps its data (SPEC §8.5). */
export function archiveHabit(fs: DataFs, id: string, archived = true): Promise<Habit[]> {
  return updateHabit(fs, id, { archived });
}

/**
 * Puts habits in the order of `ids`. Habits not named keep their relative
 * order after the ones that are. Only `order` values that change are written.
 */
export function reorderHabits(fs: DataFs, ids: string[]): Promise<Habit[]> {
  return patchFile(fs, (state) => {
    const named = [...new Set(ids)].map((id) => find(state, id));
    const rest = inOrder(state.entries).filter((e) => !named.includes(e));
    return [...named, ...rest].flatMap((entry, i) => changeOps(state, entry, { order: i + 1 }));
  });
}

/**
 * Brings the file in line with `habits`: changed fields are patched, habits
 * the file doesn't have are added. Nothing is ever removed, and a habit read
 * from the file and saved straight back changes nothing.
 */
export function saveHabits(fs: DataFs, habits: Habit[]): Promise<Habit[]> {
  return patchFile(fs, (state) => {
    const ops: YamlOp[] = [];
    // The file as it will be once the habits added so far are in it.
    const next: FileState = { ...state, entries: [...state.entries] };
    for (const habit of habits) {
      const entry = state.entries.find((e) => e.habit.id === habit.id);
      if (entry) {
        ops.push(...changeOps(next, entry, habit));
        continue;
      }
      // New to the file: leave out whatever is only a default.
      const position = next.length + 1;
      const given = Object.entries(habit).filter(([key, value]) => {
        if (key === "id") return true;
        if (key === "name") return value !== habit.id;
        if (key === "type") return value !== "check";
        if (key === "order") return value !== position;
        return !(key in DEFAULTS) || !same(value, DEFAULTS[key as keyof typeof DEFAULTS]);
      });
      ops.push(...addOps(next, Object.fromEntries(given) as NewHabit));
      next.entries.push({ habit, index: next.length });
      next.length = position;
    }
    return ops;
  });
}

/** The morning pages word goal is the goal of the habit fed by the writing room. */
export function morningPagesGoal(habits: Habit[]): number | null {
  return habits.find((h) => h.source === "morning_pages")?.goal ?? null;
}

export function setMorningPagesGoal(fs: DataFs, goal: number): Promise<Habit[]> {
  if (!Number.isSafeInteger(goal) || goal < 1) {
    return Promise.reject(new HabitsError("The word goal has to be a whole number, 1 or more"));
  }
  return patchFile(fs, (state) => {
    const entry = state.entries.find((e) => e.habit.source === "morning_pages");
    if (!entry) throw new HabitsError("No habit has morning_pages as its source");
    return changeOps(state, entry, { goal });
  });
}
