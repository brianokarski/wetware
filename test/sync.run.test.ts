/** A whole sync against the fixture data folder: what lands in the day files, and what is left alone. */
import { describe, expect, it } from "vitest";
import {
  cellState, DEFAULT_SETTINGS, loadHabits, loadMonth, loadSettings, localTimestamp, memoryFs, readDay, SEED_HABITS,
  writeCell, type DataFs, type Settings,
} from "../src/data";
import { runSync, syncRange, testConnection, type SyncJob } from "../src/sync";
import { activitiesJson, berlinJson, fakeSources, folderFs, wellnessJson } from "./syncFixtures";

const NOW = new Date(2026, 10, 17, 9, 41, 7);
const AT = localTimestamp(NOW);
const NO_LOCATION: Settings = { ...DEFAULT_SETTINGS, location: { name: "", latitude: null, longitude: null } };
/** The days the intervals.icu fixture has something new for, beside what the folder already holds. */
const INTERVALS_DAYS = [
  "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31",
  "2026-11-05", "2026-11-09", "2026-11-13", "2026-11-17",
];

async function job(fs: DataFs, overrides: Partial<SyncJob> = {}): Promise<SyncJob> {
  return { fs, sources: fakeSources(), habits: await loadHabits(fs), settings: await loadSettings(fs), now: NOW, ...overrides };
}

/** Lines in `after` that aren't in `before`, and the other way round. */
function changed(before: string, after: string) {
  const [a, b] = [before.split("\n"), after.split("\n")];
  return { added: b.filter((line) => !a.includes(line)), removed: a.filter((line) => !b.includes(line)) };
}

const path = (date: string) => `days/${date}.md`;

describe("the range a sync covers", () => {
  it("runs from seven days before the first of the month through today", () => {
    expect(syncRange("2026-11-17")).toEqual({ oldest: "2026-10-25", newest: "2026-11-17" });
    expect(syncRange("2026-11-01")).toEqual({ oldest: "2026-10-25", newest: "2026-11-01" });
    expect(syncRange("2026-11-30")).toEqual({ oldest: "2026-10-25", newest: "2026-11-30" });
    expect(syncRange("2027-01-15")).toEqual({ oldest: "2026-12-25", newest: "2027-01-15" });
    expect(syncRange("2026-03-10")).toEqual({ oldest: "2026-02-22", newest: "2026-03-10" });
    expect(syncRange("2028-03-10")).toEqual({ oldest: "2028-02-23", newest: "2028-03-10" });
  });

  it("is what each source is asked for", async () => {
    const fs = folderFs();
    const sources = fakeSources();
    const report = await runSync(await job(fs, { sources }));
    expect(report.range).toEqual({ oldest: "2026-10-25", newest: "2026-11-17" });
    expect([...sources.calls].sort()).toEqual([
      "activities 2026-10-25 2026-11-17",
      "weather 37.8 -122.27 2026-10-25 2026-11-17",
      "wellness 2026-10-25 2026-11-17",
    ]);
  });
});

describe("a sync of the fixture folder", () => {
  it("fills in today's run and weather, and records where each came from", async () => {
    const fs = folderFs();
    const before = fs.files.get(path("2026-11-17"))!;
    const report = await runSync(await job(fs));
    expect(report).toMatchObject({ intervals: { status: "synced" }, weather: { status: "synced" }, unwritten: [], withheld: 2, syncedAt: AT });
    expect(report.changed).toHaveLength(24);
    expect(changed(before, fs.files.get(path("2026-11-17"))!)).toEqual({
      added: [
        "run: true", "weather_high_f: 47", "weather_low_f: 40", "weather_precip_in: 0.26", "weather_condition: rain",
        "  run: intervals", "  weather_high_f: open-meteo", "  weather_low_f: open-meteo", "  weather_precip_in: open-meteo",
        "  weather_condition: open-meteo", `_synced_at: ${AT}`,
      ],
      removed: ["_synced_at: 2026-11-17T06:27:00-08:00"],
    });
    const day = await readDay(fs, "2026-11-17");
    expect(day.syncedAt).toBe(AT);
    // What was there before is as it was: synced earlier, with or without a source on record.
    expect(day.values).toMatchObject({ sleep_h: 7.7, hrv: 69, resting_hr: 52, sleep_score: 82 });
  });

  it("creates the file for a day that had none, with a run beside a night of no sleep data", async () => {
    const fs = folderFs();
    expect(fs.files.has(path("2026-11-09"))).toBe(false);
    await runSync(await job(fs));
    expect(fs.files.get(path("2026-11-09"))).toBe(
      [
        "---", "date: 2026-11-09", "weight_lb: 171.1", "resting_hr: 50", "run: true",
        "weather_high_f: 38", "weather_low_f: 33", "weather_precip_in: 0", "weather_condition: drizzle",
        "_sources:", "  weight_lb: intervals", "  resting_hr: intervals", "  run: intervals",
        "  weather_high_f: open-meteo", "  weather_low_f: open-meteo", "  weather_precip_in: open-meteo", "  weather_condition: open-meteo",
        `_synced_at: ${AT}`, "---", "",
      ].join("\n"),
    );
    const habits = await loadHabits(fs);
    const month = await loadMonth(fs, { year: 2026, month: 11 });
    const at = (id: string, date: string) => cellState(habits.find((h) => h.id === id)!, month[date], "2026-11-17").state;
    expect(at("run", "2026-11-09")).toBe("done");
    expect(at("sleep", "2026-11-09")).toBe("no_data");
    expect(at("weight", "2026-11-09")).toBe("done");
    expect(at("run", "2026-11-17")).toBe("done");
    // The weekend the watch was off is still "no data", not a miss, and the Strava stub on the 8th ticked nothing.
    expect(at("run", "2026-11-07")).toBe("no_data");
    expect(at("run", "2026-11-08")).toBe("no_data");
    expect(at("sleep", "2026-11-08")).toBe("no_data");
  });

  it("keeps hand-added keys, comments and notes exactly, changing only its own lines", async () => {
    const fs = folderFs();
    const before = fs.files.get(path("2026-11-10"))!;
    await runSync(await job(fs));
    const expected = before
      .replace("weather_high_f: 62", "weather_high_f: 41")
      .replace("weather_low_f: 50", "weather_low_f: 36")
      .replace("weather_condition: fog\n", "weather_condition: rain\nweather_precip_in: 0\n")
      .replace("  weather_condition: open-meteo\n", "  weather_condition: open-meteo\n  weather_precip_in: open-meteo\n")
      .replace("_synced_at: 2026-11-11T06:20:00-08:00", `_synced_at: ${AT}`);
    expect(fs.files.get(path("2026-11-10"))).toBe(expected);
    expect(expected).toContain('# a comment added by hand\ncaffeine_mg: 180\nobsidian_alias: "Tuesday: long one"\n');
    expect(expected.endsWith("---\n\nSlept badly. Two coffees before ten.\n")).toBe(true);
  });

  it("never writes over a value set by hand", async () => {
    const fs = folderFs();
    const habits = await loadHabits(fs);
    const habit = (id: string) => habits.find((h) => h.id === id)!;
    // The fixture's 13th has sleep cleared by hand, and intervals.icu has 7.3 h for that night.
    expect((await readDay(fs, "2026-11-13")).sources.sleep_h).toBe("manual");
    // By hand, before the sync: sleep corrected, a run un-ticked, a weight entered where the source has one too.
    await writeCell(fs, habit("sleep"), "2026-11-16", 5);
    await writeCell(fs, habit("run"), "2026-11-16", false);
    await writeCell(fs, habit("run"), "2026-11-15", true);
    await runSync(await job(fs, {
      sources: fakeSources({ wellness: wellnessJson().map((r) => (r.id === "2026-11-16" ? { ...r, weight: 80 } : r)) }),
    }));
    expect((await readDay(fs, "2026-11-13")).values).toMatchObject({ sleep_h: null, hrv: 64, resting_hr: 50, sleep_score: 79 });
    const sixteenth = await readDay(fs, "2026-11-16");
    expect(sixteenth.values).toMatchObject({ sleep_h: 5, run: false, weight_lb: 170.8 });
    expect(sixteenth.sources).toMatchObject({ sleep_h: "manual", run: "manual", weight_lb: "manual" });
    expect((await readDay(fs, "2026-11-15")).values.run).toBe(true);
    expect((await readDay(fs, "2026-11-15")).sources.run).toBe("manual");
  });

  it("keeps a value entered by hand while the sync was under way", async () => {
    const inner = folderFs();
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const fs: DataFs = {
      read: async (p) => (await wait(2), inner.read(p)),
      write: async (p, text) => (await wait(2), inner.write(p, text)),
      list: (dir) => inner.list(dir),
    };
    const habits = await loadHabits(fs);
    const sleep = habits.find((h) => h.id === "sleep")!;
    const settings = await loadSettings(fs);
    const syncing = runSync({ fs, sources: fakeSources(), habits, settings, now: NOW });
    // While the sync is fetching and working through the earlier days, the user corrects two nights.
    const edits = Promise.all([writeCell(fs, sleep, "2026-10-26", 4), wait(30).then(() => writeCell(fs, sleep, "2026-11-17", 6))]);
    await Promise.all([syncing, edits]);
    for (const date of ["2026-10-26", "2026-11-17"]) {
      const day = await readDay(inner, date);
      expect(day.sources.sleep_h, date).toBe("manual");
      expect(day.values.weather_condition, date).toBe(date === "2026-10-26" ? "cloudy" : "rain");
    }
    expect((await readDay(inner, "2026-10-26")).values.sleep_h).toBe(4);
    expect((await readDay(inner, "2026-11-17")).values.sleep_h).toBe(6);
  });

  it("leaves Lift and Climb as they are until they name an activity type", async () => {
    const fs = folderFs();
    const before = await loadMonth(fs, { year: 2026, month: 11 });
    await runSync(await job(fs));
    const after = await loadMonth(fs, { year: 2026, month: 11 });
    for (const date of Object.keys(after)) {
      for (const key of ["lift", "climb"]) {
        expect(after[date].values[key], `${key} ${date}`).toBe(before[date].values[key]);
        expect(after[date].sources[key], `${key} ${date}`).toBe(before[date].sources[key]);
      }
    }
    // The fixture has strength sessions and climbs on days with no file: nothing is written for them either.
    expect((await readDay(fs, "2026-10-27")).values).not.toHaveProperty("lift");
    expect((await readDay(fs, "2026-10-27")).values.run).toBe(false);

    // With a type named, the next sync ticks them.
    const habits = (await loadHabits(fs)).map((h) => (h.id === "lift" ? { ...h, source_rule: { activity_types: ["WeightTraining"] } } : h));
    const report = await runSync(await job(fs, { habits }));
    expect(report.changed).toEqual(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-11-09", "2026-11-17"]);
    expect((await readDay(fs, "2026-10-27")).values.lift).toBe(true);
    expect((await readDay(fs, "2026-11-17")).values.lift).toBe(false);
    expect((await readDay(fs, "2026-11-07")).values).not.toHaveProperty("lift");
  });

  it("writes only the files that change, and nothing at all the second time", async () => {
    const fs = folderFs();
    const before = new Map(fs.files);
    const report = await runSync(await job(fs, { settings: NO_LOCATION }));
    expect(report.changed).toEqual(INTERVALS_DAYS);
    expect(report.weather).toEqual({ status: "not_set_up" });
    for (const [file, text] of fs.files) {
      const date = file.slice(5, 15);
      if (!INTERVALS_DAYS.includes(date)) expect(text, file).toBe(before.get(file));
    }
    // No file for the days the watch was off and the day with nothing new.
    expect([...fs.files.keys()].filter((file) => !before.has(file)).sort()).toEqual(
      ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-11-09"].map(path),
    );
    expect(changed(before.get(path("2026-11-05"))!, fs.files.get(path("2026-11-05"))!)).toEqual({
      added: ["resting_hr: 53", "  resting_hr: intervals", `_synced_at: ${AT}`],
      removed: ["_synced_at: 2026-11-06T06:15:00-08:00"],
    });

    // The same sync again, later in the day: nothing is written and no byte changes, `_synced_at` included.
    const writes: string[] = [];
    const counting: DataFs = { ...fs, write: async (p, text) => (writes.push(p), fs.write(p, text)) };
    const later = new Date(2026, 10, 17, 18, 0, 0);
    const settled = new Map(fs.files);
    const again = await runSync(await job(counting, { settings: NO_LOCATION, now: later }));
    expect(again.changed).toEqual([]);
    expect(writes).toEqual([]);
    expect(new Map(fs.files)).toEqual(settled);

    // And the same with the weather: every day changes once, then none.
    expect((await runSync(await job(counting))).changed).toHaveLength(24);
    expect(writes).toHaveLength(24);
    const full = new Map(fs.files);
    const second = await runSync(await job(counting, { now: later }));
    expect(second.changed).toEqual([]);
    expect(writes).toHaveLength(24);
    expect(new Map(fs.files)).toEqual(full);
  });

  it("creates no file in an empty folder for a day the sources have nothing for", async () => {
    const fs = memoryFs();
    const report = await runSync({ fs, sources: fakeSources(), habits: SEED_HABITS, settings: NO_LOCATION, now: NOW });
    expect(report.changed).not.toContain("2026-11-07");
    expect(report.changed).not.toContain("2026-11-08");
    expect(report.changed).toHaveLength(22);
    expect([...fs.files.keys()].sort()).toEqual(report.changed.map(path));
    expect(fs.files.get(path("2026-11-05"))).toBe(
      `---\ndate: 2026-11-05\nresting_hr: 53\nrun: true\n_sources:\n  resting_hr: intervals\n  run: intervals\n_synced_at: ${AT}\n---\n`,
    );
    // Nothing from the sources: no files at all.
    const empty = memoryFs();
    const none = await runSync({ fs: empty, sources: fakeSources({ wellness: [], activities: [], weather: { daily: { time: [] } } }), habits: SEED_HABITS, settings: DEFAULT_SETTINGS, now: NOW });
    expect(none).toMatchObject({ changed: [], intervals: { status: "synced" }, weather: { status: "not_set_up" } });
    expect(empty.files.size).toBe(0);
  });

  it("never keeps a forecast, or an activity dated after today", async () => {
    const fs = memoryFs();
    const weather = berlinJson() as { daily: Record<string, unknown[]> };
    weather.daily.time.push("2026-11-18", "2026-11-19");
    weather.daily.temperature_2m_max.push(9.9, 12.4);
    weather.daily.temperature_2m_min.push(3.1, 5.5);
    weather.daily.precipitation_sum.push(0, 0);
    weather.daily.weather_code.push(3, 0);
    const activities = [...activitiesJson(), { type: "Run", start_date_local: "2026-11-18T06:00:00", elapsed_time: 1800 }];
    const settings: Settings = { location: { name: "Berlin", latitude: 52.52, longitude: 13.41 }, units: { weight: "kg", temperature: "C" } };
    const report = await runSync({ fs, sources: fakeSources({ weather, activities }), habits: SEED_HABITS, settings, now: NOW });
    expect(report.changed[report.changed.length - 1]).toBe("2026-11-17");
    expect(fs.files.has(path("2026-11-18"))).toBe(false);
    expect(fs.files.has(path("2026-11-19"))).toBe(false);
    // Beside the Celsius setting, the keys carry that unit.
    expect((await readDay(fs, "2026-11-17")).values).toMatchObject({ weather_high_c: 9, weather_low_c: 5, weather_precip_mm: 6.7, weather_condition: "rain" });
    expect((await readDay(fs, "2026-11-17")).values).not.toHaveProperty("weather_high_f");
  });
});

describe("the two sources are independent", () => {
  it("syncs the weather with no intervals.icu key, without asking intervals.icu twice", async () => {
    const fs = folderFs();
    const sources = fakeSources({ intervalsProblem: { kind: "no_key" } });
    const report = await runSync(await job(fs, { sources }));
    expect(report.intervals).toEqual({ status: "not_set_up" });
    expect(report.weather).toEqual({ status: "synced" });
    expect(report.changed).toHaveLength(24);
    expect(sources.calls.filter((call) => !call.startsWith("weather"))).toEqual(["wellness 2026-10-25 2026-11-17"]);
    const today = await readDay(fs, "2026-11-17");
    expect(today.values.weather_condition).toBe("rain");
    expect(today.values).not.toHaveProperty("run");
  });

  it("syncs intervals.icu with no location, without asking for the weather", async () => {
    const fs = folderFs();
    const sources = fakeSources();
    for (const location of [{ name: "Oakland", latitude: 37.8, longitude: null }, { name: "", latitude: null, longitude: -122.27 }]) {
      const report = await runSync(await job(fs, { sources, settings: { ...DEFAULT_SETTINGS, location } }));
      expect(report.weather).toEqual({ status: "not_set_up" });
      expect(report.intervals).toEqual({ status: "synced" });
    }
    expect(sources.calls.some((call) => call.startsWith("weather"))).toBe(false);
    expect((await readDay(fs, "2026-11-17")).values.run).toBe(true);
    // Latitude and longitude 0 are a place.
    await runSync(await job(fs, { sources, settings: { ...DEFAULT_SETTINGS, location: { name: "", latitude: 0, longitude: 0 } } }));
    expect(sources.calls).toContain("weather 0 0 2026-10-25 2026-11-17");
  });

  it.each([
    [{ kind: "key_rejected" }],
    [{ kind: "offline" }],
    [{ kind: "rate_limited", retry_after_secs: 60 }],
    [{ kind: "unexpected", detail: "HTTP 500" }],
  ] as const)("reports intervals.icu failing with %o and still syncs the weather", async (problem) => {
    const fs = folderFs();
    const report = await runSync(await job(fs, { sources: fakeSources({ intervalsProblem: problem }) }));
    expect(report.intervals).toEqual({ status: "failed", problem });
    expect(report.weather).toEqual({ status: "synced" });
    expect(report.changed).toHaveLength(24);
    expect((await readDay(fs, "2026-11-17")).values).not.toHaveProperty("run");
  });

  it("reports the weather failing and still syncs intervals.icu", async () => {
    const fs = folderFs();
    const report = await runSync(await job(fs, { sources: fakeSources({ weatherProblem: { kind: "offline" } }) }));
    expect(report.weather).toEqual({ status: "failed", problem: { kind: "offline" } });
    expect(report.intervals).toEqual({ status: "synced" });
    expect(report.changed).toEqual(INTERVALS_DAYS);
  });

  it("takes nothing from intervals.icu unless both its lists arrive and can be read", async () => {
    const cases = [
      { sources: fakeSources({ wellness: { error: "nope" } }), detail: "the wellness records were not a list" },
      { sources: fakeSources({ activities: null }), detail: "the activities were not a list" },
    ];
    for (const { sources, detail } of cases) {
      const fs = folderFs();
      const before = new Map(fs.files);
      const report = await runSync(await job(fs, { sources, settings: NO_LOCATION }));
      expect(report.intervals).toEqual({ status: "failed", problem: { kind: "unexpected", detail } });
      expect(report.changed).toEqual([]);
      expect(new Map(fs.files)).toEqual(before);
    }
    // The wellness records alone would have said "no run" on days whose activities never arrived.
    const fs = folderFs();
    const failing = fakeSources();
    const intervals = failing.intervals;
    failing.intervals = (kind, oldest, newest) =>
      kind === "activities" ? Promise.reject({ kind: "offline" }) : intervals(kind, oldest, newest);
    const report = await runSync(await job(fs, { sources: failing, settings: NO_LOCATION }));
    expect(report).toMatchObject({ intervals: { status: "failed", problem: { kind: "offline" } }, changed: [] });
  });

  it("reads the weather as a problem when it comes back as something else", async () => {
    const fs = folderFs();
    const report = await runSync(await job(fs, { sources: fakeSources({ weather: { error: true, reason: "Latitude must be in range of -90 to 90°." } }) }));
    expect(report.weather).toEqual({ status: "failed", problem: { kind: "unexpected", detail: "the weather had no list of days" } });
    expect(report.changed).toEqual(INTERVALS_DAYS);
  });
});

describe("a day file that can't take the change", () => {
  it("is left exactly as it is and named, and the other days are still written", async () => {
    const fs = folderFs();
    const broken = "---\ndate: 2026-11-12\nmood: 1\nmood: 2\n---\n\nnotes\n";
    fs.files.set(path("2026-11-12"), broken);
    const report = await runSync(await job(fs));
    expect(report.unwritten).toEqual([{ date: "2026-11-12", reason: "Frontmatter: Invalid YAML: Map keys must be unique (line 4)." }]);
    expect(fs.files.get(path("2026-11-12"))).toBe(broken);
    expect(report.changed).toHaveLength(23);
    expect(report.changed).not.toContain("2026-11-12");
  });

  it("is named when it can't be read or written, too", async () => {
    const inner = folderFs();
    const fs: DataFs = {
      ...inner,
      read: (p) => (p === path("2026-11-03") ? Promise.reject(new Error("stream did not contain valid UTF-8")) : inner.read(p)),
      write: (p, text) => (p === path("2026-11-04") ? Promise.reject("No space left on device (os error 28)") : inner.write(p, text)),
    };
    const before = inner.files.get(path("2026-11-04"));
    const report = await runSync(await job(fs));
    expect(report.unwritten).toEqual([
      { date: "2026-11-03", reason: "stream did not contain valid UTF-8" },
      { date: "2026-11-04", reason: "No space left on device (os error 28)" },
    ]);
    expect(inner.files.get(path("2026-11-04"))).toBe(before);
    expect(report.changed).toHaveLength(22);
  });
});

describe("test connection", () => {
  it("counts the activity types of the last 90 days", async () => {
    const sources = fakeSources();
    const summary = await testConnection(sources, NOW);
    expect(sources.calls).toEqual(["activities 2026-08-19 2026-11-17"]);
    expect(summary.types.map((t) => `${t.type} ${t.count}`)).toEqual(["Run 12", "WeightTraining 5", "RockClimbing 2", "Walk 1"]);
    expect(summary.withheld).toBe(2);
  });

  it("rejects with what went wrong", async () => {
    await expect(testConnection(fakeSources({ intervalsProblem: { kind: "key_rejected" } }), NOW)).rejects.toMatchObject({ problem: { kind: "key_rejected" } });
    await expect(testConnection(fakeSources({ activities: {} }), NOW)).rejects.toThrow("the activities were not a list");
  });
});
