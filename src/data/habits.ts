import { parse, stringify } from "yaml";
import type { DataFs } from "./fs";
import { YAML_OUT } from "./yamlPatch";

export const HABITS_FILE = "habits.yaml";

export type HabitType = "check" | "number" | "scale" | "progress" | "duration" | "tag";
export type HabitSource = "manual" | "intervals" | "weather" | "morning_pages";
export type HabitDirection = "higher" | "lower" | "neutral";

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

const DEFAULTS: Omit<Habit, "id" | "name" | "type" | "order"> = {
  unit: null,
  goal: null,
  direction: "higher",
  source: "manual",
  source_rule: null,
  color: "#111111",
  show_on_calendar: false,
  archived: false,
};

function seed(order: number, h: Pick<Habit, "id" | "name" | "type"> & Partial<Habit>): Habit {
  return { ...DEFAULTS, ...h, order } as Habit;
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

export function parseHabits(raw: string): Habit[] {
  const data = parse(raw) as { habits?: unknown } | null;
  const list = Array.isArray(data?.habits) ? data.habits : [];
  return list
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object" && "id" in h)
    .map((h, i) => ({ ...DEFAULTS, name: String(h.id), type: "check", order: i + 1, ...h }) as Habit)
    .sort((a, b) => a.order - b.order);
}

export function serializeHabits(habits: Habit[]): string {
  return stringify({ habits }, YAML_OUT);
}

/** Reads habits.yaml, writing the seed set the first time the folder is used. */
export async function loadHabits(fs: DataFs): Promise<Habit[]> {
  const raw = await fs.read(HABITS_FILE);
  if (raw === null) {
    await fs.write(HABITS_FILE, serializeHabits(SEED_HABITS));
    return SEED_HABITS.map((h) => ({ ...h }));
  }
  return parseHabits(raw);
}

export async function saveHabits(fs: DataFs, habits: Habit[]): Promise<void> {
  await fs.write(HABITS_FILE, serializeHabits(habits));
}

/** The morning pages word goal is the goal of the habit fed by the writing room. */
export function morningPagesGoal(habits: Habit[]): number | null {
  return habits.find((h) => h.source === "morning_pages")?.goal ?? null;
}

export async function setMorningPagesGoal(fs: DataFs, goal: number): Promise<Habit[]> {
  const habits = (await loadHabits(fs)).map((h) =>
    h.source === "morning_pages" ? { ...h, goal } : h,
  );
  await saveHabits(fs, habits);
  return habits;
}
