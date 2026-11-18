/** What the day view shows beside a day's habits, and handing a value back to sync. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cellPatch, cellState, cellValue, dayParts, parseDay, parseHabits, SEED_HABITS, unreadableValue, updateDayFile,
  useSyncedPatch, valueSource, valueText, weatherLine, type Habit,
} from "../src/data";
import { handBack, handBackNote, syncCovers, syncHold, syncPatch, syncRange } from "../src/sync";

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
      { key: "_synced_at", text: "2026-11-11T06:20:00-08:00" },
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
    const own = (date: string) => dayParts(fixtureHabits, parseDay(fixtureDay(date), date)).other.filter((entry) => entry.key !== "_synced_at");
    expect(own("2026-11-07")).toEqual([]);
    expect(own("2026-11-14")).toEqual([{ key: "tags", text: "[sick]" }]);
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

  it("shows the file's bookkeeping too: when it was synced, a date that isn't the file's, sources no row shows", () => {
    const parts = dayParts(
      [sleep],
      day(
        "date: 2026-11-11\nsleep_h: 7.7\nhrv: null\nresting_hr: 49\ncaffeine_mg: 180\n" +
          "_sources:\n  sleep_h: intervals\n  resting_hr: intervals\n  hrv: intervals\n  caffeine_mg: manual\n  gone_habit: manual\n  run: 5\n" +
          "_synced_at: 2026-11-10T06:00:00-08:00\n",
      ),
    );
    expect(parts.logged).toEqual([{ key: "resting_hr", label: "Resting heart rate", unit: "bpm", value: 49, source: "intervals" }]);
    expect(parts.other).toEqual([
      // The file is named for the 10th and says the 11th.
      { key: "date", text: "2026-11-11" },
      // A logged key with nothing in it has no row among the logged values, so it and its source are here.
      { key: "hrv", text: "null" },
      { key: "caffeine_mg", text: "180" },
      { key: "_sources.hrv", text: "intervals" },
      { key: "_sources.caffeine_mg", text: "manual" },
      { key: "_sources.gone_habit", text: "manual" },
      { key: "_sources.run", text: "5" },
      { key: "_synced_at", text: "2026-11-10T06:00:00-08:00" },
    ]);
    // The sources of sleep and resting heart rate are in their rows, and a date that agrees is not news.
    expect(dayParts([sleep], day("date: 2026-11-10\nsleep_h: 7.7\n_sources:\n  sleep_h: intervals\n")).other).toEqual([]);
    // A habit's source entry is in its row even when the habit has no value that day.
    expect(dayParts([sleep], day("_sources:\n  sleep_h: manual\n")).other).toEqual([]);
    expect(valueSource(sleep, day("_sources:\n  sleep_h: manual\n"))).toBe("manual");
    // A source entry that isn't text is not something a row can show.
    expect(dayParts([sleep], day("sleep_h: 7\n_sources:\n  sleep_h: [a, b]\n")).other).toEqual([{ key: "_sources.sleep_h", text: "[a, b]" }]);
    // Bookkeeping that isn't what it should be is shown as it is.
    expect(dayParts([], day("_sources: intervals\n_synced_at: [1, 2]\n")).other).toEqual([
      { key: "_sources", text: "intervals" },
      { key: "_synced_at", text: "[1, 2]" },
    ]);
    expect(dayParts(fixtureHabits, parseDay(null, DATE))).toEqual({ logged: [], other: [] });
  });

  it("lists what is in tags that isn't a tag, and a key that only shares a tag habit's name", () => {
    const travel = habit({ id: "travel", type: "tag" });
    const odd = dayParts([travel], day("tags: [travel, {a: 1}, true, sick, 7]\ntravel: by train\n"));
    expect(odd.other).toEqual([
      { key: "tags", text: '[{"a":1}, true, sick, 7]' },
      // The tag habit lives in the tags list. A key called `travel` is the user's own.
      { key: "travel", text: "by train" },
    ]);
    // A number written as a tag is the tag a habit with that id shows.
    expect(dayParts([habit({ id: "7", type: "tag" })], day("tags: [7]\n")).other).toEqual([]);
  });

  it("shows a logged value of any shape as the file has it", () => {
    const parts = dayParts([], day("sleep_score: {a: 1}\nresting_hr: [50, 51]\nhrv: high\n"));
    expect(parts.logged.map((v) => `${v.label}: ${valueText(v.value)}`)).toEqual(["HRV: high", 'Resting heart rate: [50, 51]', 'Sleep score: {"a":1}']);
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

describe("a habit's key that holds something its habit can't", () => {
  const cases: [Habit, string, string][] = [
    [weight, "weight_lb: 182 lb\n", "182 lb"],
    [sleep, 'sleep_h: "7.7"\n', "7.7"],
    [run, 'run: "yes"\n', "yes"],
    [SEED_HABITS.find((h) => h.id === "mood")!, "mood: [1, 2]\n", "[1, 2]"],
    [SEED_HABITS.find((h) => h.id === "morning_pages")!, "morning_pages_words: {count: 812}\n", '{"count":812}'],
    [run, "run: 1\n", "1"],
    [weight, "weight_lb: true\n", "true"],
  ];

  it.each(cases)("%o: the cell reads as empty, and the value is there to be shown as written", (odd, frontmatter, text) => {
    const parsed = day(frontmatter);
    expect(cellValue(odd, parsed)).toBeNull();
    expect(unreadableValue(odd, parsed)).toBe(text);
    // It is in the habit's row and so not among the other properties.
    expect(dayParts([odd], parsed).other).toEqual([]);
  });

  it("is not said of a value the habit can hold, or of no value", () => {
    expect(unreadableValue(weight, day("weight_lb: 171.6\n"))).toBeNull();
    expect(unreadableValue(weight, day("weight_lb: 0\n"))).toBeNull();
    expect(unreadableValue(run, day("run: false\n"))).toBeNull();
    expect(unreadableValue(run, day("run: null\n"))).toBeNull();
    expect(unreadableValue(run, day(""))).toBeNull();
    // A scale out of its range is a number, and is shown in the field as it is.
    expect(unreadableValue(SEED_HABITS.find((h) => h.id === "mood")!, day("mood: 9\n"))).toBeNull();
    expect(unreadableValue(habit({ id: "travel", type: "tag" }), day("travel: by train\ntags: {a: 1}\n"))).toBeNull();
  });
});

describe("use synced value", () => {
  const TODAY = "2026-11-17";
  const lift = SEED_HABITS.find((h) => h.id === "lift")!;
  const held = (h: Habit, frontmatter: string, date = TODAY) => handBack(h, day(frontmatter, date), TODAY);

  it("is offered where a value set by hand, or with no source, stands in sync's way", () => {
    expect(held(sleep, "sleep_h: 5\n_sources:\n  sleep_h: manual\n")).toEqual({ by: "manual" });
    expect(held(sleep, "sleep_h: null\n_sources:\n  sleep_h: manual\n")).toEqual({ by: "manual" });
    expect(held(run, "run: false\n_sources:\n  run: manual\n")).toEqual({ by: "manual" });
    expect(held(sleep, "sleep_h: 6\n")).toEqual({ by: "unrecorded" });
    // A source the app doesn't know blocks sync just as `manual` does.
    expect(held(sleep, "sleep_h: 6\n_sources:\n  sleep_h: garmin\n")).toEqual({ by: "other", source: "garmin" });
    expect(held(run, "run: true\n_sources:\n  run: open-meteo\n")).toEqual({ by: "other", source: "open-meteo" });
  });

  it("is not offered for a value sync wrote, or for nothing at all", () => {
    expect(held(sleep, "sleep_h: 7.7\n_sources:\n  sleep_h: intervals\n")).toBeNull();
    expect(held(sleep, "")).toBeNull();
    expect(held(sleep, "sleep_h: null\n")).toBeNull();
  });

  it("is offered exactly where sync would leave the key alone", () => {
    const files = [
      "", "sleep_h: null\n", "sleep_h: 6\n", "sleep_h: 7.7\n_sources:\n  sleep_h: intervals\n", "sleep_h: 5\n_sources:\n  sleep_h: manual\n",
      "sleep_h: null\n_sources:\n  sleep_h: manual\n", "sleep_h: 6\n_sources:\n  sleep_h: garmin\n", "_sources:\n  sleep_h: manual\n",
      "_sources:\n  sleep_h: intervals\n", 'sleep_h: "7.7"\n',
    ];
    for (const frontmatter of files) {
      const parsed = day(frontmatter, TODAY);
      const writes = syncPatch(parsed, [{ key: "sleep_h", value: 8.8, source: "intervals" }], "x") !== null;
      expect(syncHold(parsed, "sleep_h", "intervals") === null, frontmatter).toBe(writes);
      expect(handBack(sleep, parsed, TODAY) === null, frontmatter).toBe(writes);
    }
  });

  it("is not offered for a habit sync has no rule for: handing it back would only clear it", () => {
    // Lift and Climb as seeded name no activity types. Ticked by hand, they stay ticked.
    expect(held(lift, "lift: true\n_sources:\n  lift: manual\n")).toBeNull();
    const set = habit({ id: "lift", type: "check", source: "intervals", source_rule: { activity_types: ["WeightTraining"] } });
    expect(held(set, "lift: true\n_sources:\n  lift: manual\n")).toEqual({ by: "manual" });
    // Weight, Meditate and Mood are the user's to fill; Morning pages come from the app's own writing room.
    for (const id of ["weight", "meditate", "mood", "morning_pages"]) {
      const manual = SEED_HABITS.find((h) => h.id === id)!;
      const key = manual.unit ? `${manual.id}_${manual.unit}` : manual.id;
      expect(held(manual, `${key}: 1\n_sources:\n  ${key}: manual\n`), id).toBeNull();
    }
    // A habit whose source is the weather: sync logs the weather by itself and fills no habit from it.
    expect(held(habit({ id: "rain", type: "check", source: "weather" }), "rain: true\n_sources:\n  rain: manual\n")).toBeNull();
    // A wellness habit in a unit sync can't convert to, or with no field named, or archived.
    expect(held(habit({ id: "sleep", type: "number", unit: "days", source: "intervals", source_rule: { wellness_field: "sleepSecs" } }), "sleep_days: 1\n")).toBeNull();
    expect(held(habit({ id: "sleep", type: "number", unit: "h", source: "intervals" }), "sleep_h: 1\n")).toBeNull();
    expect(held(habit({ id: "sleep", type: "number", unit: "h", source: "intervals", archived: true, source_rule: { wellness_field: "sleepSecs" } }), "sleep_h: 1\n")).toBeNull();
    expect(held(habit({ id: "travel", type: "tag", source: "intervals" }), "tags: [travel]\n")).toBeNull();
  });

  it("is not offered on a day outside what a sync run today would look at", () => {
    const manual = "sleep_h: 6.5\n_sources:\n  sleep_h: manual\n";
    // Today is the 17th of November: sync covers the 25th of October to today.
    expect(syncRange(TODAY)).toEqual({ oldest: "2026-10-25", newest: TODAY });
    expect(held(sleep, manual, "2026-10-24")).toBeNull();
    expect(held(sleep, manual, "2026-10-20")).toBeNull();
    expect(held(sleep, manual, "2026-10-25")).toEqual({ by: "manual" });
    expect(held(sleep, manual, TODAY)).toEqual({ by: "manual" });
    expect(held(sleep, manual, "2026-11-18")).toBeNull();
    // A month later the same day has dropped out of range.
    expect(handBack(sleep, day(manual, "2026-11-17"), "2026-12-17")).toBeNull();
    expect(handBack(sleep, day(manual, "2026-11-24"), "2026-12-17")).toEqual({ by: "manual" });
    expect(syncCovers(sleep, "2026-10-24", syncRange(TODAY))).toBe(false);
    expect(syncCovers(run, "2026-10-25", syncRange(TODAY))).toBe(true);
    expect(syncCovers(lift, "2026-11-10", syncRange(TODAY))).toBe(false);
    expect(syncCovers(weight, "2026-11-10", syncRange(TODAY))).toBe(false);
  });

  it("says why sync is leaving the value, and what handing it back will and won't do", () => {
    const after = "so sync leaves it alone. Use synced value clears it. The next sync then fills in what intervals.icu has for this day, and leaves it empty if it has nothing.";
    expect(handBackNote({ by: "manual" })).toBe(`Set by hand, ${after}`);
    expect(handBackNote({ by: "unrecorded" })).toBe(`The file records no source for this value, ${after}`);
    expect(handBackNote({ by: "other", source: "garmin" })).toBe(`Marked as coming from garmin, ${after}`);
  });

  it("takes the key and its source entry out, and leaves every other byte", () => {
    const raw = "---\ndate: 2026-11-17\nsleep_h: 5 # corrected\nhrv: 69\n# mine\ncaffeine_mg: 180\n_sources:\n  sleep_h: manual\n  hrv: intervals\n_synced_at: 2026-11-17T06:27:00-08:00\n---\n\nNotes stay.\n";
    const next = updateDayFile(raw, "2026-11-17", useSyncedPatch(sleep));
    expect(next).toBe("---\ndate: 2026-11-17\nhrv: 69\n# mine\ncaffeine_mg: 180\n_sources:\n  hrv: intervals\n_synced_at: 2026-11-17T06:27:00-08:00\n---\n\nNotes stay.\n");
    // Nothing stands in the way now: the cell reads "no data", and the next sync fills it and owns it.
    const after = parseDay(next, "2026-11-17");
    expect(handBack(sleep, after, TODAY)).toBeNull();
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
    expect(handBack(sleep, parseDay(edited, "2026-11-17"), TODAY)).toEqual({ by: "manual" });
  });
});
