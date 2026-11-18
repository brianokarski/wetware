/** The rules that turn source data into day values, and decide what may be written over. */
import { describe, expect, it } from "vitest";
import { parseDay, parseHabits, SEED_HABITS, updateDayFile, type Habit } from "../src/data";
import {
  habitsNotSetUp, intervalsWants, mergeWants, readActivities, readWeather, readWellness, syncPatch, weatherWants,
  type IntervalsData, type Want,
} from "../src/sync";
import { activitiesJson, berlinJson, wellnessJson } from "./syncFixtures";

const RANGE = { oldest: "2026-10-25", newest: "2026-11-17" };
const DAY = "2026-11-17";
const ONE_DAY = { oldest: DAY, newest: DAY };

/** Source data for one day, from the wellness record and activities given. */
function oneDay(record: Record<string, unknown> | null, activities: Record<string, unknown>[] = []): IntervalsData {
  return {
    wellness: readWellness(record ? [{ id: DAY, ...record }] : []),
    ...readActivities(activities.map((activity) => ({ start_date_local: `${DAY}T06:00:00`, ...activity }))),
  };
}

/** What the sources say about the one day, as `key: value` pairs. */
function said(habits: Habit[], data: IntervalsData): Record<string, unknown> {
  const wants = intervalsWants(habits, data, ONE_DAY).get(DAY) ?? [];
  for (const want of wants) expect(want.source).toBe("intervals");
  return Object.fromEntries(wants.map((want) => [want.key, want.value]));
}

const habit = (fields: Partial<Habit> & Pick<Habit, "id">): Habit => parseHabits(`habits:\n  - ${JSON.stringify(fields)}\n`)[0];
const run = habit({ id: "run", type: "check", source: "intervals", source_rule: { activity_types: ["Run"], min_minutes: 0 } });
const sleep = habit({ id: "sleep", type: "number", unit: "h", source: "intervals", source_rule: { wellness_field: "sleepSecs" } });

describe("activity habits", () => {
  it("are true on a day with an activity of one of their types", () => {
    expect(said([run], oneDay(null, [{ type: "Run", elapsed_time: 1800 }]))).toEqual({ run: true });
    expect(said([run], oneDay(null, [{ type: "Walk" }, { type: "Run" }]))).toEqual({ run: true });
  });

  it("match the type as intervals.icu spells it, whatever the case, and nothing that merely contains it", () => {
    const trail = habit({ id: "trail", type: "check", source: "intervals", source_rule: { activity_types: [" trailrun ", "VirtualRun"] } });
    expect(said([run, trail], oneDay(null, [{ type: "TrailRun" }]))).toEqual({ run: false, trail: true });
    expect(said([run, trail], oneDay(null, [{ type: "VIRTUALRUN" }]))).toEqual({ run: false, trail: true });
    expect(said([run, trail], oneDay(null, [{ type: "run" }]))).toEqual({ run: true, trail: false });
  });

  it("need the activity to be at least min_minutes long", () => {
    const long = habit({ id: "long_run", type: "check", source: "intervals", source_rule: { activity_types: ["Run"], min_minutes: 30 } });
    expect(said([long], oneDay(null, [{ type: "Run", elapsed_time: 1799 }]))).toEqual({ long_run: false });
    expect(said([long], oneDay(null, [{ type: "Run", elapsed_time: 1800 }]))).toEqual({ long_run: true });
    expect(said([long], oneDay(null, [{ type: "Run", elapsed_time: 600 }, { type: "Run", moving_time: 2400 }]))).toEqual({ long_run: true });
    // No length on record: it can't be said to be long enough. With no minimum it still counts.
    expect(said([long], oneDay(null, [{ type: "Run" }]))).toEqual({ long_run: false });
    expect(said([run], oneDay(null, [{ type: "Run" }]))).toEqual({ run: true });
  });

  it("are false on a day the device was alive and nothing matched", () => {
    // Another activity that day.
    expect(said([run], oneDay(null, [{ type: "WeightTraining" }]))).toEqual({ run: false });
    // No activity, but the watch measured something.
    expect(said([run], oneDay({ restingHR: 50 }))).toEqual({ run: false, resting_hr: 50 });
    expect(said([run], oneDay({ steps: 8000 }))).toEqual({ run: false });
  });

  it("say nothing on a day the source has nothing for", () => {
    expect(said([run], oneDay(null))).toEqual({});
    // A record that only holds what intervals.icu computes or carries over is not a sign of life.
    expect(said([run], oneDay({ ctl: 42.1, atl: 39.5, rampRate: 0.6, restingHR: 50, tempRestingHR: true }))).toEqual({});
    expect(said([run], oneDay({ weight: 77.6, mood: 3 }))).toEqual({});
  });

  it("don't count an activity that came through Strava, for or against", () => {
    const stub = { source: "STRAVA", _note: "STRAVA activities are not available via the API" };
    expect(said([run], oneDay(null, [stub]))).toEqual({});
    expect(said([run], oneDay(null, [{ ...stub, type: "Run" }]))).toEqual({});
    expect(said([run], oneDay(null, [stub, { type: "Run" }]))).toEqual({ run: true });
  });

  it("don't say no on a day with an activity that can't be read: it might have been the run", () => {
    const stub = { source: "STRAVA", _note: "STRAVA activities are not available via the API" };
    const lift = habit({ id: "lift", type: "check", source: "intervals", source_rule: { activity_types: ["WeightTraining"] } });
    // The watch was on all day and there is a strength session, but the other thing done that day is a blank.
    expect(said([run, lift], oneDay({ steps: 9000, restingHR: 50 }, [stub, { type: "WeightTraining" }]))).toEqual({ lift: true, resting_hr: 50 });
    expect(said([run, lift], oneDay({ steps: 9000 }, [stub]))).toEqual({});
    // Without the stub, the same day does say no.
    expect(said([run, lift], oneDay({ steps: 9000 }, [{ type: "WeightTraining" }]))).toEqual({ run: false, lift: true });
    // A stub on another day says nothing about this one.
    const data = oneDay({ steps: 9000 }, [{ ...stub, start_date_local: "2026-11-16T06:00:00" }]);
    expect(said([run], data)).toEqual({ run: false });
  });

  it("are left alone until they name an activity type", () => {
    const unset = [
      habit({ id: "lift", type: "check", source: "intervals", source_rule: { activity_types: [], min_minutes: 0 } }),
      habit({ id: "climb", type: "check", source: "intervals", source_rule: { min_minutes: 0 } }),
      habit({ id: "swim", type: "check", source: "intervals" }),
      habit({ id: "row", type: "check", source: "intervals", source_rule: { activity_types: ["", "  ", 7] } }),
    ];
    const everything = oneDay({ steps: 9000 }, [{ type: "WeightTraining" }, { type: "RockClimbing" }, { type: "Swim" }]);
    expect(said([run, ...unset], everything)).toEqual({ run: false });
    expect(habitsNotSetUp([run, sleep, ...unset]).map((h) => h.id)).toEqual(["lift", "climb", "swim", "row"]);
    // The seed set: Lift and Climb.
    expect(habitsNotSetUp(SEED_HABITS).map((h) => h.name)).toEqual(["Lift", "Climb"]);
    // Once a type is named, the same day fills in.
    const lift = habit({ id: "lift", type: "check", source: "intervals", source_rule: { activity_types: "WeightTraining" } });
    expect(said([lift], everything)).toEqual({ lift: true });
    expect(habitsNotSetUp([lift])).toEqual([]);
  });

  it("are only the check habits that intervals.icu fills, and not archived ones", () => {
    const others = [
      habit({ id: "meditate", type: "check", source: "manual", source_rule: { activity_types: ["Run"] } }),
      habit({ id: "old_run", type: "check", source: "intervals", archived: true, source_rule: { activity_types: ["Run"] } }),
      habit({ id: "old_lift", type: "check", source: "intervals", archived: true }),
      habit({ id: "miles", type: "number", source: "intervals", source_rule: { activity_types: ["Run"] } }),
    ];
    expect(said(others, oneDay({ steps: 9000 }, [{ type: "Run" }]))).toEqual({});
    expect(habitsNotSetUp(others)).toEqual([]);
  });
});

describe("wellness values", () => {
  it("fill the habit that names the field, in hours to one decimal place", () => {
    expect(said([sleep], oneDay({ sleepSecs: 27720 }))).toEqual({ sleep_h: 7.7 });
    expect(said([sleep], oneDay({ sleepSecs: 27000 }))).toEqual({ sleep_h: 7.5 });
    expect(said([sleep], oneDay({ sleepSecs: 25020 }))).toEqual({ sleep_h: 7 }); // 6.95 h
    // By the field it names, not by what it is called.
    const kip = habit({ id: "kip", name: "Kip", type: "number", unit: "h", source: "intervals", source_rule: { wellness_field: "sleepSecs" } });
    const named = habit({ id: "sleep", type: "number", unit: "h", source: "intervals" });
    expect(said([kip, named], oneDay({ sleepSecs: 27720 }))).toEqual({ kip_h: 7.7 });
  });

  it("are left out when the field is missing or null, even on a day with a run", () => {
    expect(said([run, sleep], oneDay({ sleepSecs: null, restingHR: 53 }, [{ type: "Run" }]))).toEqual({ run: true, resting_hr: 53 });
    expect(said([run, sleep], oneDay({ restingHR: 53 }, [{ type: "Run" }]))).toEqual({ run: true, resting_hr: 53 });
    expect(said([run, sleep], oneDay({ sleepSecs: 0 }, [{ type: "Run" }]))).toEqual({ run: true });
    expect(said([run, sleep], oneDay(null, [{ type: "Run" }]))).toEqual({ run: true });
  });

  it("log HRV, resting heart rate and sleep score beside the habits", () => {
    expect(said([], oneDay({ hrv: 68.44, restingHR: 49, sleepScore: 91 }))).toEqual({ hrv: 68.4, resting_hr: 49, sleep_score: 91 });
    expect(said([], oneDay({ hrv: null, restingHR: 49, sleepScore: null }))).toEqual({ resting_hr: 49 });
    expect(said([], oneDay({ restingHR: 50, tempRestingHR: true }))).toEqual({});
    expect(said([], oneDay({ ctl: 40, atl: 38 }))).toEqual({});
  });

  it("convert to the habit's unit, or say nothing when there is no saying what that is", () => {
    const minutes = habit({ id: "sleep", type: "duration", unit: "min", source: "intervals", source_rule: { wellness_field: "sleepSecs" } });
    const days = habit({ id: "sleep", type: "number", unit: "days", source: "intervals", source_rule: { wellness_field: "sleepSecs" } });
    const steps = habit({ id: "steps", type: "number", source: "intervals", source_rule: { wellness_field: "steps" } });
    const spo2 = habit({ id: "spo2", type: "number", unit: "pct", source: "intervals", source_rule: { wellness_field: "spO2" } });
    const record = { sleepSecs: 27750, steps: 9120, spO2: 96.456 };
    expect(said([minutes], oneDay(record))).toEqual({ sleep_min: 463 });
    expect(said([days], oneDay(record))).toEqual({});
    expect(said([steps, spo2], oneDay(record))).toEqual({ steps: 9120, spo2_pct: 96.46 });
  });

  it("only fill number and duration habits that intervals.icu is the source of", () => {
    const others = [
      habit({ id: "nap", type: "number", unit: "h", source: "manual", source_rule: { wellness_field: "sleepSecs" } }),
      habit({ id: "rested", type: "check", source: "intervals", source_rule: { wellness_field: "sleepSecs" } }),
      habit({ id: "feel", type: "scale", source: "intervals", source_rule: { wellness_field: "mood" } }),
      habit({ id: "old", type: "number", unit: "h", source: "intervals", archived: true, source_rule: { wellness_field: "sleepSecs" } }),
      habit({ id: "blank", type: "number", unit: "h", source: "intervals", source_rule: { wellness_field: "  " } }),
    ];
    expect(said(others, oneDay({ sleepSecs: 27720, mood: 3 }))).toEqual({});
  });
});

describe("weight", () => {
  const weight = SEED_HABITS[0];

  it("fills the manual Weight habit, in its unit, when the record has one", () => {
    expect(weight).toMatchObject({ id: "weight", source: "manual", unit: "lb" });
    expect(said([weight], oneDay({ weight: 77.6 }))).toEqual({ weight_lb: 171.1 });
    const kilos = habit({ id: "weight", type: "number", unit: "kg" });
    expect(said([kilos], oneDay({ weight: 77.64 }))).toEqual({ weight_kg: 77.6 });
  });

  it("is left out when it is null, carried over, or in a unit that isn't a weight", () => {
    expect(said([weight], oneDay({ weight: null, steps: 100 }))).toEqual({});
    expect(said([weight], oneDay({ weight: 77.9, tempWeight: true }))).toEqual({});
    expect(said([habit({ id: "weight", type: "number", unit: "stone" })], oneDay({ weight: 77.6 }))).toEqual({});
    expect(said([habit({ id: "weight", type: "number" })], oneDay({ weight: 77.6 }))).toEqual({});
    expect(said([habit({ id: "weight", type: "number", unit: "lb", archived: true })], oneDay({ weight: 77.6 }))).toEqual({});
  });

  it("goes to a habit that names the weight field instead, if there is one", () => {
    const mass = habit({ id: "mass", type: "number", unit: "kg", source: "intervals", source_rule: { wellness_field: "weight" } });
    expect(said([weight, mass], oneDay({ weight: 77.6 }))).toEqual({ mass_kg: 77.6 });
  });
});

describe("the fixture month", () => {
  const habits = SEED_HABITS;
  const data: IntervalsData = { wellness: readWellness(wellnessJson()), ...readActivities(activitiesJson()) };
  const wants = intervalsWants(habits, data, RANGE);
  const on = (date: string) => Object.fromEntries((wants.get(date) ?? []).map((want) => [want.key, want.value]));

  it("has a run, sleep and the vitals on the right days", () => {
    expect(on("2026-11-17")).toEqual({ sleep_h: 7.7, hrv: 69, resting_hr: 52, sleep_score: 82, run: true });
    expect(on("2026-11-16")).toEqual({ sleep_h: 6.9, hrv: 62, resting_hr: 51, sleep_score: 71, run: true });
    expect(on("2026-11-15")).toEqual({ sleep_h: 7, hrv: 67, resting_hr: 50, sleep_score: 85, run: false });
    expect(on("2026-10-25")).toEqual({ sleep_h: 7.6, hrv: 66, resting_hr: 49, sleep_score: 84, run: true });
  });

  it("has a run and no sleep on a night the watch recorded none", () => {
    expect(on("2026-11-05")).toEqual({ resting_hr: 53, run: true });
    expect(on("2026-11-09")).toEqual({ weight_lb: 171.1, resting_hr: 50, run: true });
  });

  it("has nothing at all for the days the watch was off, Strava stub or not", () => {
    expect(wants.has("2026-11-07")).toBe(false);
    expect(wants.has("2026-11-08")).toBe(false);
    expect(data.withheld).toBe(2);
  });

  it("says nothing about Lift or Climb on any day, and never takes a carried-over weight", () => {
    const keys = new Set([...wants.values()].flat().map((want) => want.key));
    expect([...keys].sort()).toEqual(["hrv", "resting_hr", "run", "sleep_h", "sleep_score", "weight_lb"]);
    expect(on("2026-11-04")).toEqual({ sleep_h: 8.1, hrv: 72, resting_hr: 51, sleep_score: 89, run: false });
  });

  it("stays inside the range, whatever the source sent", () => {
    const narrow = intervalsWants(habits, data, { oldest: "2026-11-10", newest: "2026-11-12" });
    expect([...narrow.keys()]).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(intervalsWants(habits, data, { oldest: "2026-11-18", newest: "2026-11-30" }).size).toBe(0);
  });
});

describe("weather", () => {
  const weather = readWeather(berlinJson());
  const on = (wants: Map<string, Want[]>, date: string) => Object.fromEntries((wants.get(date) ?? []).map((want) => [want.key, want.value]));

  it("is written in °F and inches beside the Fahrenheit setting", () => {
    const wants = weatherWants("F", weather, RANGE);
    expect(wants.size).toBe(24);
    // 13.7 °C, 7.3 °C, 7.5 mm, code 63.
    expect(on(wants, "2026-10-25")).toEqual({ weather_high_f: 57, weather_low_f: 45, weather_precip_in: 0.3, weather_condition: "rain" });
    expect(on(wants, "2026-11-09")).toEqual({ weather_high_f: 38, weather_low_f: 33, weather_precip_in: 0, weather_condition: "drizzle" });
    expect(on(wants, "2026-11-05")).toEqual({ weather_high_f: 50, weather_low_f: 39, weather_precip_in: 0, weather_condition: "cloudy" });
    for (const want of [...wants.values()].flat()) expect(want.source).toBe("open-meteo");
  });

  it("is written in °C and millimetres beside the Celsius setting", () => {
    const wants = weatherWants("C", weather, RANGE);
    expect(on(wants, "2026-10-25")).toEqual({ weather_high_c: 14, weather_low_c: 7, weather_precip_mm: 7.5, weather_condition: "rain" });
    expect(on(wants, "2026-11-17")).toEqual({ weather_high_c: 9, weather_low_c: 5, weather_precip_mm: 6.7, weather_condition: "rain" });
  });

  it("never keeps a day after the range's last, which is today", () => {
    const withForecast = readWeather({
      daily: {
        time: ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"],
        temperature_2m_max: [11.2, 8.5, 9.9, 12.4],
        temperature_2m_min: [7.2, 4.7, 3.1, 5.5],
        precipitation_sum: [1.4, 6.7, 0, 0],
        weather_code: [80, 80, 3, 0],
      },
    });
    expect([...weatherWants("F", withForecast, RANGE).keys()]).toEqual(["2026-11-16", "2026-11-17"]);
  });

  it("leaves out what a day doesn't have", () => {
    const partial = readWeather({
      daily: { time: ["2026-11-16", "2026-11-17"], temperature_2m_max: [11.2, null], temperature_2m_min: [null, null], precipitation_sum: [null, null], weather_code: [42, null] },
    });
    const wants = weatherWants("F", partial, RANGE);
    expect(on(wants, "2026-11-16")).toEqual({ weather_high_f: 52 });
    expect(wants.has("2026-11-17")).toBe(false);
  });

  it("sits after what intervals.icu has for the same day", () => {
    const merged = mergeWants(
      new Map([["2026-11-17", [{ key: "run", value: true, source: "intervals" as const }]]]),
      new Map([
        ["2026-11-16", [{ key: "weather_high_f", value: 52, source: "open-meteo" as const }]],
        ["2026-11-17", [{ key: "weather_high_f", value: 47, source: "open-meteo" as const }]],
      ]),
    );
    expect([...merged.keys()]).toEqual(["2026-11-16", "2026-11-17"]);
    expect(merged.get("2026-11-17")!.map((want) => want.key)).toEqual(["run", "weather_high_f"]);
  });
});

describe("what may be written to a day file", () => {
  const AT = "2026-11-17T06:30:00-08:00";
  const want = (key: string, value: Want["value"], source: Want["source"] = "intervals"): Want => ({ key, value, source });
  const day = (frontmatter: string) => parseDay(`---\n${frontmatter}---\n`, DAY);

  it("fills a day that has nothing, and records where each value came from", () => {
    expect(syncPatch(day(""), [want("run", true), want("sleep_h", 7.7), want("weather_high_f", 47, "open-meteo")], AT)).toEqual({
      values: { run: true, sleep_h: 7.7, weather_high_f: 47 },
      sources: { run: "intervals", sleep_h: "intervals", weather_high_f: "open-meteo" },
      syncedAt: AT,
    });
  });

  it("never writes over a value set by hand", () => {
    const manual = day("run: false\nsleep_h: 5\nweight_lb: null\n_sources:\n  run: manual\n  sleep_h: manual\n  weight_lb: manual\n");
    expect(syncPatch(manual, [want("run", true), want("sleep_h", 7.7), want("weight_lb", 171.1)], AT)).toBeNull();
    // The rest of the day still fills in around it.
    expect(syncPatch(manual, [want("run", true), want("hrv", 69)], AT)).toEqual({ values: { hrv: 69 }, sources: { hrv: "intervals" }, syncedAt: AT });
  });

  it("takes a value with no recorded source for one typed into the file by hand", () => {
    const typed = day("sleep_h: 6\nrun: true\nweather_condition: sunny\n");
    expect(syncPatch(typed, [want("sleep_h", 7.7), want("run", false), want("weather_condition", "rain", "open-meteo")], AT)).toBeNull();
  });

  it("fills a key that is there with no value and no source", () => {
    const gaps = day("climb: null\nweight_lb: null\nsleep_h:\n");
    expect(syncPatch(gaps, [want("weight_lb", 171.1), want("sleep_h", 7.7)], AT)).toEqual({
      values: { weight_lb: 171.1, sleep_h: 7.7 },
      sources: { weight_lb: "intervals", sleep_h: "intervals" },
      syncedAt: AT,
    });
  });

  it("brings its own earlier values up to date, and only those that differ", () => {
    const synced = day("run: false\nsleep_h: 7.7\nhrv: 69\nweather_high_f: 50\n_sources:\n  run: intervals\n  sleep_h: intervals\n  hrv: intervals\n  weather_high_f: open-meteo\n");
    const wants = [want("run", true), want("sleep_h", 7.7), want("hrv", 69), want("weather_high_f", 47, "open-meteo")];
    expect(syncPatch(synced, wants, AT)).toEqual({
      values: { run: true, weather_high_f: 47 },
      sources: { run: "intervals", weather_high_f: "open-meteo" },
      syncedAt: AT,
    });
  });

  it("changes nothing, not even the sync time, when everything is already there", () => {
    const synced = day("run: true\nsleep_h: 7.7\n_sources:\n  run: intervals\n  sleep_h: intervals\n_synced_at: 2026-11-16T06:00:00-08:00\n");
    expect(syncPatch(synced, [want("run", true), want("sleep_h", 7.7)], AT)).toBeNull();
    expect(syncPatch(synced, [], AT)).toBeNull();
    expect(syncPatch(day(""), [], AT)).toBeNull();
  });

  it("leaves a value another source put there", () => {
    const mixed = day("morning_pages_words: 812\nsleep_h: 7\n_sources:\n  morning_pages_words: morning_pages\n  sleep_h: open-meteo\n");
    expect(syncPatch(mixed, [want("morning_pages_words", 5), want("sleep_h", 7.7)], AT)).toBeNull();
  });

  it("treats a key named like part of an object as a key", () => {
    const patch = syncPatch(day(""), [want("__proto__", 1), want("constructor", 2)], AT)!;
    expect(Object.keys(patch.values!)).toEqual(["__proto__", "constructor"]);
    const text = updateDayFile(null, DAY, patch);
    const written = parseDay(text, DAY);
    expect(Object.entries(written.values)).toEqual([["__proto__", 1], ["constructor", 2]]);
    expect(Object.entries(written.sources)).toEqual([["__proto__", "intervals"], ["constructor", "intervals"]]);
    expect(syncPatch(written, [want("__proto__", 1), want("constructor", 2)], AT)).toBeNull();
  });
});
