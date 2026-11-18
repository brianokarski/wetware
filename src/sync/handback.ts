/**
 * "Use synced value": when a habit's value on a day can be handed back to
 * sync, and what to say about it. Handing back takes the key and its
 * `_sources` entry out of the file (`useSyncedPatch` in the data layer), so
 * that nothing stands in the way of the next sync.
 */
import { dayKey, type Day, type Habit } from "../data";
import { syncCovers, syncHold, type SyncHold } from "./plan";
import { syncRange } from "./run";

/**
 * What is keeping sync from this habit's value on this day, if handing it
 * back would do any good: a sync run today could write that key for that
 * day. Null otherwise: sync isn't held back, or the habit's rule isn't set
 * up, or the day is one sync no longer looks at, and the action would only
 * clear the value.
 */
export function handBack(habit: Habit, day: Day, today: string): SyncHold | null {
  if (habit.type === "tag" || !syncCovers(habit, day.date, syncRange(today))) return null;
  return syncHold(day, dayKey(habit), "intervals");
}

/** What the day view says beside the action: why sync is leaving the value, and what using it will do. */
export function handBackNote(hold: SyncHold): string {
  const why = {
    manual: "Set by hand",
    unrecorded: "The file records no source for this value",
    other: `Marked as coming from ${hold.by === "other" ? hold.source : ""}`,
  }[hold.by];
  return `${why}, so sync leaves it alone. Use synced value clears it. The next sync then fills in what intervals.icu has for this day, and leaves it empty if it has nothing.`;
}
