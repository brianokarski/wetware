/** The fixture data folder feeds the screenshots, so it has to keep showing everything the grid can show. */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cellState, dayTags, loadHabitsFile, loadMonth, loadSettings, memoryFs, monthCount, type CellState,
} from "../src/data";

const ROOT = new URL("./fixtures/data-folder/", import.meta.url);
const TODAY = "2026-11-17";

function fixtureFs() {
  const files: Record<string, string> = {};
  for (const name of readdirSync(ROOT, { recursive: true }) as string[]) {
    if (/\.(md|yaml)$/.test(name)) files[name.split("\\").join("/")] = readFileSync(new URL(name, ROOT), "utf8");
  }
  return memoryFs(files);
}

describe("fixture data folder", () => {
  it("has the nine seed habits plus a tag and a duration habit and an archived one, with nothing skipped", async () => {
    const { habits, skipped } = await loadHabitsFile(fixtureFs());
    expect(skipped).toEqual([]);
    expect(habits.filter((h) => !h.archived).map((h) => h.id)).toEqual([
      "weight", "run", "lift", "climb", "sleep", "morning_pages", "meditate", "brain_fog", "mood", "stretch", "travel",
    ]);
    expect(habits.filter((h) => h.archived).map((h) => h.id)).toEqual(["floss"]);
    expect(new Set(habits.map((h) => h.type))).toEqual(new Set(["check", "number", "scale", "progress", "duration", "tag"]));
  });

  it("has settings that read cleanly", async () => {
    expect(await loadSettings(fixtureFs())).toEqual({
      location: { name: "Oakland", latitude: 37.8, longitude: -122.27 },
      units: { weight: "lb", temperature: "F" },
    });
  });

  it("shows every cell state in November 2026, and no day file needs fixing", async () => {
    const fs = fixtureFs();
    const { habits } = await loadHabitsFile(fs);
    const month = await loadMonth(fs, { year: 2026, month: 11 });
    const seen = new Set<CellState>();
    for (const day of Object.values(month)) {
      expect(day.error).toBeNull();
      for (const habit of habits) seen.add(cellState(habit, day, TODAY).state);
    }
    expect(seen).toEqual(new Set(["done", "missed", "no_data", "pending", "future"]));
  });

  it("has the particular days the screenshots are meant to show", async () => {
    const fs = fixtureFs();
    const { habits } = await loadHabitsFile(fs);
    const month = await loadMonth(fs, { year: 2026, month: 11 });
    const habit = (id: string) => habits.find((h) => h.id === id)!;
    const at = (id: string, day: number) => cellState(habit(id), month[`2026-11-${String(day).padStart(2, "0")}`], TODAY);

    // A run recorded by intervals, on a night with no sleep data.
    expect(at("run", 5).state).toBe("done");
    expect(month["2026-11-05"].sources.run).toBe("intervals");
    expect(at("sleep", 5).state).toBe("no_data");
    // A weekend with the watch off: nothing from intervals at all, and a tag.
    expect(at("run", 7).state).toBe("no_data");
    expect(at("travel", 7).state).toBe("done");
    // Missed manual days, a day with no file, and a synced cell cleared by hand.
    expect(at("weight", 4).state).toBe("missed");
    expect(month["2026-11-09"].body).toBe("");
    expect(at("meditate", 9).state).toBe("missed");
    expect(at("sleep", 13).state).toBe("missed");
    // An explicit false, a partial progress day and a met one.
    expect(at("run", 2).state).toBe("missed");
    expect(at("morning_pages", 3)).toMatchObject({ state: "done", met: false, fraction: 0.4 });
    expect(at("morning_pages", 1)).toMatchObject({ state: "done", met: true });
    // Notes in the body, and frontmatter keys the app doesn't know.
    expect(month["2026-11-03"].notes).toContain("estuary");
    expect(month["2026-11-10"].values.caffeine_mg).toBe(180);
    expect(dayTags(month["2026-11-14"])).toEqual(["sick"]);
    // Today: a morning sync has run, the rest is still open.
    expect(at("sleep", 17).state).toBe("done");
    expect(at("weight", 17).state).toBe("pending");
    expect(at("weight", 18).state).toBe("future");
    // Counts the screenshot should show.
    expect(monthCount(habit("run"), Object.values(month), { year: 2026, month: 11 })).toEqual({ done: 7, total: 30 });
    expect(monthCount(habit("morning_pages"), Object.values(month), { year: 2026, month: 11 })).toEqual({ done: 8, total: 30 });
  });
});
