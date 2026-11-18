/** What the day view shows beside a day's habits, and handing a value back to sync. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cellPatch, cellState, dayParts, holdsBackSync, parseDay, parseHabits, SEED_HABITS, updateDayFile, useSyncedPatch,
  valueSource, valueText, weatherLine, type Habit,
} from "../src/data";
import { syncPatch } from "../src/sync";

const DATE = "2026-11-10";
const fixtureDay = (date: string) => readFileSync(new URL(`./fixtures/data-folder/days/${date}.md`, import.meta.url), "utf8");
const fixtureHabits = parseHabits(readFileSync(new URL("./fixtures/data-folder/habits.yaml", import.meta.url), "utf8"));
const day = (frontmatter: string, date = DATE) => parseDay(`---\n${frontmatter}---\n`, date);
const habit = (fields: Partial<Habit> & Pick<Habit, "id">): Habit => parseHabits(`habits:\n  - ${JSON.stringify(fields)}\n`)[0];
const sleep = SEED_HABITS.find((h) => h.id === "sleep")!;
const run = SEED_HABITS.find((h) => h.id === "run")!;
const weight = SEED_HABITS.find((h) => h.id === "weight")!;

describe("the parts of a day beside its habits", () => {
  it("splits the fixture's 10th into what was logged and what is the user's own", () => {
    const { logged, other } = dayParts(fixtureHabits, parseDay(fixtureDay("2026-11-10"), DATE));
    expect(logged.map((v) => `${v.label} ${v.value}${v.unit ? ` ${v.unit}` : ""} (${v.source})`)).toEqual([
      "HRV 55 ms (null)",
      "Resting heart rate 51 bpm (null)",
      "Sleep score 80 (null)",
      "High 62 °F (open-meteo)",
      "Low 50 °F (open-meteo)",
      "Conditions fog (open-meteo)",
    ]);
    expect(other).toEqual([
      { key: "caffeine_mg", text: "180" },
      { key: "obsidian_alias", text: "Tuesday: long one" },
    ]);
  });

  it("puts every frontmatter key in exactly one place: a habit's row, the log, or the other properties", () => {
    for (const date of ["2026-11-04", "2026-11-07", "2026-11-10", "2026-11-14", "2026-11-17"]) {
      const parsed = parseDay(fixtureDay(date), date);
      const { logged, other } = dayParts(fixtureHabits, parsed);
      const shown = fixtureHabits.filter((h) => !h.archived);
      const habitKeys = shown.filter((h) => h.type !== "tag").map((h) => (h.unit ? `${h.id}_${h.unit}` : h.id));
      const places = (key: string) =>
        [habitKeys.includes(key), logged.some((v) => v.key === key), other.some((v) => v.key === key)].filter(Boolean).length;
      for (const key of Object.keys(parsed.values)) {
        // Tags are shown by their tag habits; the fixture's `sick` has none, so it is among the other properties.
        if (key === "tags") continue;
        expect(places(key), `${date} ${key}`).toBe(1);
      }
    }
    expect(dayParts(fixtureHabits, parseDay(fixtureDay("2026-11-07"), "2026-11-07")).other).toEqual([]);
    expect(dayParts(fixtureHabits, parseDay(fixtureDay("2026-11-14"), "2026-11-14")).other).toEqual([{ key: "tags", text: "[sick]" }]);
  });

  it("lists the values of an archived habit and the tags no habit shows, so nothing in the file is out of sight", () => {
    const habits = [
      habit({ id: "run", type: "check" }),
      habit({ id: "floss", type: "check", archived: true }),
      habit({ id: "travel", type: "tag" }),
      habit({ id: "old_tag", type: "tag", archived: true }),
    ];
    const parts = dayParts(habits, day("run: true\nfloss: true\ntags: [travel, sick, old_tag]\nweather_high_c: 9\nweather_precip_mm: 6.7\n"));
    expect(parts.other).toEqual([
      { key: "floss", text: "true" },
      { key: "tags", text: "[sick, old_tag]" },
    ]);
    expect(parts.logged.map((v) => `${v.label} ${v.value} ${v.unit}`)).toEqual(["High 9 °C", "Precipitation 6.7 mm"]);
    // A single tag written as a word, a list with nothing left over, and a tags map that is something else altogether.
    expect(dayParts(habits, day("tags: sick\n")).other).toEqual([{ key: "tags", text: "[sick]" }]);
    expect(dayParts(habits, day("tags: [travel]\n")).other).toEqual([]);
    expect(dayParts(habits, day("tags:\n  travel: true\n")).other).toEqual([{ key: "tags", text: '{"travel":true}' }]);
  });

  it("leaves out a logged key that holds nothing, and the file's own bookkeeping", () => {
    const parts = dayParts([], day("date: 2026-11-10\nhrv: null\nresting_hr: 49\n_sources:\n  resting_hr: intervals\n_synced_at: 2026-11-10T06:00:00-08:00\n"));
    expect(parts.logged).toEqual([{ key: "resting_hr", label: "Resting heart rate", unit: "bpm", value: 49, source: "intervals" }]);
    expect(parts.other).toEqual([]);
    expect(dayParts(fixtureHabits, parseDay(null, DATE))).toEqual({ logged: [], other: [] });
  });

  it("writes a value the way the file would", () => {
    expect(valueText("Tuesday: long one")).toBe("Tuesday: long one");
    expect(valueText(180)).toBe("180");
    expect(valueText(false)).toBe("false");
    expect(valueText(null)).toBe("null");
    expect(valueText(["a", 2, null])).toBe("[a, 2, null]");
    expect(valueText({ dose: 2, with: ["food"] })).toBe('{"dose":2,"with":["food"]}');
  });
});

describe("the weather on one line", () => {
  it("is in the unit of the setting when the file has it, and in the file's own when it doesn't", () => {
    const both = day("weather_high_f: 47\nweather_low_f: 40\nweather_precip_in: 0.26\nweather_high_c: 9\nweather_low_c: 5\nweather_precip_mm: 6.7\nweather_condition: rain\n");
    expect(weatherLine(both, "F")).toBe("47° / 40° F, rain, 0.26 in");
    expect(weatherLine(both, "C")).toBe("9° / 5° C, rain, 6.7 mm");
    const fahrenheit = day("weather_high_f: 62\nweather_low_f: 50\nweather_condition: fog\n");
    expect(weatherLine(fahrenheit, "F")).toBe("62° / 50° F, fog");
    expect(weatherLine(fahrenheit, "C")).toBe("62° / 50° F, fog");
  });

  it("says only what the day has", () => {
    expect(weatherLine(day("weather_high_f: 47\n"), "F")).toBe("47° F");
    expect(weatherLine(day("weather_precip_in: 0\nweather_low_f: 0\n"), "F")).toBe("0° F, 0 in");
    expect(weatherLine(day("weather_condition: clear\n"), "F")).toBe("clear");
    expect(weatherLine(day("weather_high_f: warm\nweather_condition: 7\n"), "F")).toBeNull();
    expect(weatherLine(day("mood: 4\n"), "F")).toBeNull();
    expect(weatherLine(parseDay(null, DATE), "C")).toBeNull();
  });
});

describe("where a habit's value came from", () => {
  it("is what the day's _sources says", () => {
    const synced = day("sleep_h: 7.7\nrun: false\n_sources:\n  sleep_h: intervals\n  run: manual\n");
    expect(valueSource(sleep, synced)).toBe("intervals");
    expect(valueSource(run, synced)).toBe("manual");
    expect(valueSource(SEED_HABITS.find((h) => h.id === "morning_pages")!, day("morning_pages_words: 812\n_sources:\n  morning_pages_words: morning_pages\n"))).toBe("morning_pages");
    // A cell cleared by hand is still a thing done by hand.
    expect(valueSource(sleep, day("sleep_h: null\n_sources:\n  sleep_h: manual\n"))).toBe("manual");
  });

  it("is unrecorded for a value with no entry there, and nothing for no value", () => {
    expect(valueSource(sleep, day("sleep_h: 6\n"))).toBe("unrecorded");
    expect(valueSource(run, day("run: false\n"))).toBe("unrecorded");
    expect(valueSource(sleep, day("sleep_h: null\n"))).toBeNull();
    expect(valueSource(sleep, day(""))).toBeNull();
    expect(valueSource(sleep, parseDay(null, DATE))).toBeNull();
  });

  it("is manual for a tag that is on", () => {
    const travel = habit({ id: "travel", type: "tag" });
    expect(valueSource(travel, day("tags: [travel]\n"))).toBe("manual");
    expect(valueSource(travel, day("tags: [sick]\n"))).toBeNull();
  });
});

describe("use synced value", () => {
  it("is offered where a value set by hand, or with no source, stands in sync's way", () => {
    expect(holdsBackSync(sleep, day("sleep_h: 5\n_sources:\n  sleep_h: manual\n"))).toBe(true);
    expect(holdsBackSync(sleep, day("sleep_h: null\n_sources:\n  sleep_h: manual\n"))).toBe(true);
    expect(holdsBackSync(run, day("run: false\n_sources:\n  run: manual\n"))).toBe(true);
    expect(holdsBackSync(sleep, day("sleep_h: 6\n"))).toBe(true);
  });

  it("is not offered for a synced value, an empty one, or a habit sync has no part in", () => {
    expect(holdsBackSync(sleep, day("sleep_h: 7.7\n_sources:\n  sleep_h: intervals\n"))).toBe(false);
    expect(holdsBackSync(sleep, day(""))).toBe(false);
    expect(holdsBackSync(sleep, day("sleep_h: null\n"))).toBe(false);
    // Weight, Meditate and Mood are the user's to fill; Morning pages come from the app's own writing room.
    for (const id of ["weight", "meditate", "mood", "morning_pages"]) {
      const manual = SEED_HABITS.find((h) => h.id === id)!;
      const key = manual.unit ? `${manual.id}_${manual.unit}` : manual.id;
      expect(holdsBackSync(manual, day(`${key}: 1\n_sources:\n  ${key}: manual\n`)), id).toBe(false);
    }
    expect(holdsBackSync(habit({ id: "travel", type: "tag", source: "intervals" }), day("tags: [travel]\n"))).toBe(false);
  });

  it("takes the key and its source entry out, and leaves every other byte", () => {
    const raw = "---\ndate: 2026-11-17\nsleep_h: 5 # corrected\nhrv: 69\n# mine\ncaffeine_mg: 180\n_sources:\n  sleep_h: manual\n  hrv: intervals\n_synced_at: 2026-11-17T06:27:00-08:00\n---\n\nNotes stay.\n";
    const next = updateDayFile(raw, "2026-11-17", useSyncedPatch(sleep));
    expect(next).toBe("---\ndate: 2026-11-17\nhrv: 69\n# mine\ncaffeine_mg: 180\n_sources:\n  hrv: intervals\n_synced_at: 2026-11-17T06:27:00-08:00\n---\n\nNotes stay.\n");
    // Nothing stands in the way now: the cell reads "no data", and the next sync fills it and owns it.
    const after = parseDay(next, "2026-11-17");
    expect(holdsBackSync(sleep, after)).toBe(false);
    expect(cellState(sleep, after, "2026-11-18").state).toBe("no_data");
    const synced = updateDayFile(next, "2026-11-17", syncPatch(after, [{ key: "sleep_h", value: 7.7, source: "intervals" }], "2026-11-18T06:30:00-08:00")!);
    expect(parseDay(synced, "2026-11-17")).toMatchObject({ values: { sleep_h: 7.7 }, sources: { sleep_h: "intervals" } });
    // Before it was used, the same sync would have left the 5 alone.
    expect(syncPatch(parseDay(raw, "2026-11-17"), [{ key: "sleep_h", value: 7.7, source: "intervals" }], "x")).toBeNull();
  });

  it("works on a value with no source entry, on the last entry of _sources, and changes nothing when there is nothing to take", () => {
    expect(updateDayFile("---\ndate: 2026-11-17\nsleep_h: 6\nmood: 4\n---\n", "2026-11-17", useSyncedPatch(sleep))).toBe("---\ndate: 2026-11-17\nmood: 4\n---\n");
    const only = updateDayFile("---\ndate: 2026-11-17\nrun: false\n_sources:\n  run: manual\n---\n", "2026-11-17", useSyncedPatch(run));
    expect(parseDay(only, "2026-11-17")).toMatchObject({ values: {}, sources: {}, error: null });
    expect(only).not.toContain("run");
    const untouched = "---\ndate: 2026-11-17\nmood: 4\n_sources:\n  mood: manual\n---\n";
    expect(updateDayFile(untouched, "2026-11-17", useSyncedPatch(sleep))).toBe(untouched);
    // It is the habit's own key that goes: the unit is part of it.
    expect(Object.keys(useSyncedPatch(weight).values!)).toEqual(["weight_lb"]);
  });

  it("is undone by editing the cell again, which is manual once more", () => {
    const raw = "---\ndate: 2026-11-17\nsleep_h: 5\n_sources:\n  sleep_h: manual\n---\n";
    const handed = updateDayFile(raw, "2026-11-17", useSyncedPatch(sleep));
    const edited = updateDayFile(handed, "2026-11-17", cellPatch(sleep, 6));
    expect(parseDay(edited, "2026-11-17")).toMatchObject({ values: { sleep_h: 6 }, sources: { sleep_h: "manual" } });
    expect(holdsBackSync(sleep, parseDay(edited, "2026-11-17"))).toBe(true);
  });
});
