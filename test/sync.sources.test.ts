/** Reading what intervals.icu and Open-Meteo send. */
import { describe, expect, it } from "vitest";
import {
  asProblem, condition, CONDITIONS, hasDeviceData, readActivities, reading, readWeather, readWellness,
  SourceShapeError, summariseActivities, SyncFailure,
} from "../src/sync";
import { activitiesJson, berlinJson, wellnessJson } from "./syncFixtures";

describe("intervals.icu wellness records", () => {
  it("are keyed by the local day in their id", () => {
    const { wellness: byDay, unreadable } = readWellness(wellnessJson());
    expect(byDay.size).toBe(24);
    expect(unreadable).toBe(0);
    expect([...byDay.keys()][0]).toBe("2026-10-25");
    expect(byDay.get("2026-11-17")).toMatchObject({ sleepSecs: 27720, hrv: 69, restingHR: 52, sleepScore: 82 });
  });

  it("count the records that name no day and leave them out, and refuse a response that isn't a list", () => {
    const odd = [{ id: "2026-11-17", hrv: 60 }, { id: "2026-11-31" }, { id: "2026-11-16T00:00:00" }, { id: 20261115 }, { hrv: 50 }, null, "2026-11-14", []];
    const read = readWellness(odd);
    expect([...read.wellness.keys()]).toEqual(["2026-11-17"]);
    expect(read.unreadable).toBe(7);
    // Every record in another date format: none is kept, and all are counted, so the sync can say so.
    const slashed = wellnessJson().map((record) => ({ ...record, id: String(record.id).replaceAll("-", "/") }));
    expect(readWellness(slashed)).toEqual({ wellness: new Map(), unreadable: 24 });
    expect(readWellness([])).toEqual({ wellness: new Map(), unreadable: 0 });
    for (const notAList of [null, undefined, {}, { id: "2026-11-17" }, "[]", 4]) {
      expect(() => readWellness(notAList)).toThrow(SourceShapeError);
    }
  });

  it("read a value only when it is a measurement", () => {
    const record = { sleepSecs: 27720, hrv: 68.4, sleepScore: null, steps: 0, restingHR: -1, spO2: "97", respiration: NaN };
    expect(reading(record, "sleepSecs")).toBe(27720);
    expect(reading(record, "hrv")).toBe(68.4);
    for (const field of ["sleepScore", "steps", "restingHR", "spO2", "respiration", "missing", "constructor", "__proto__"]) {
      expect(reading(record, field), field).toBeNull();
    }
  });

  it("don't take a value carried over from the athlete's settings for a measurement", () => {
    const carried = { weight: 77.9, tempWeight: true, restingHR: 50, tempRestingHR: true };
    expect(reading(carried, "weight")).toBeNull();
    expect(reading(carried, "restingHR")).toBeNull();
    const measured = { weight: 77.9, tempWeight: false, restingHR: 50 };
    expect(reading(measured, "weight")).toBe(77.9);
    expect(reading(measured, "restingHR")).toBe(50);
    // One flag doesn't speak for the other value.
    expect(reading({ weight: 77.9, restingHR: 50, tempRestingHR: true }, "weight")).toBe(77.9);
  });

  it("show a device was alive only by something a device measures", () => {
    expect(hasDeviceData({ id: "2026-11-07", ctl: 42.3, atl: 40.1, rampRate: 0.6, updated: "2026-11-07T14:00:00Z" })).toBe(false);
    expect(hasDeviceData({ ctl: 42.3, restingHR: 50, tempRestingHR: true })).toBe(false);
    expect(hasDeviceData({ mood: 3, soreness: 2, weight: 77.6, comments: "typed in" })).toBe(false);
    // What a person rates, as against what a device measures.
    expect(hasDeviceData({ sleepQuality: 2, readiness: 71, fatigue: 2, stress: 1, motivation: 3 })).toBe(false);
    for (const field of ["sleepSecs", "sleepScore", "avgSleepingHR", "restingHR", "hrv", "hrvSDNN", "spO2", "respiration", "steps", "floorsClimbed"]) {
      expect(hasDeviceData({ [field]: 42 }), field).toBe(true);
    }
    expect(hasDeviceData({ sleepSecs: null, hrv: null, steps: 0 })).toBe(false);
    expect(hasDeviceData({ steps: 8421 })).toBe(true);
    expect(hasDeviceData({ restingHR: 50 })).toBe(true);
    expect(hasDeviceData({ sleepSecs: 27000 })).toBe(true);
    const byDay = readWellness(wellnessJson()).wellness;
    expect(hasDeviceData(byDay.get("2026-11-07")!)).toBe(false);
    expect(hasDeviceData(byDay.get("2026-11-05")!)).toBe(true);
  });
});

describe("intervals.icu activities", () => {
  it("belong to the local day they started on, whatever day that was in UTC", () => {
    const { activities } = readActivities([
      { type: "Run", start_date_local: "2026-11-16T23:40:00", start_date: "2026-11-17T07:40:00Z", elapsed_time: 1800 },
      { type: "Run", start_date_local: "2026-11-17T00:05:00", start_date: "2026-11-16T15:05:00Z", elapsed_time: 1800 },
    ]);
    expect([...activities.keys()]).toEqual(["2026-11-16", "2026-11-17"]);
    // The fixture's climb started at 18:05 local, which is the next day in UTC.
    const climb = readActivities(activitiesJson()).activities.get("2026-11-15")!;
    expect(climb).toEqual([{ date: "2026-11-15", type: "RockClimbing", minutes: 95 }]);
  });

  it("take the longer of elapsed and moving time as the length", () => {
    const minutes = (item: object) => readActivities([{ type: "Run", start_date_local: "2026-11-17T06:00:00", ...item }]).activities.get("2026-11-17")![0].minutes;
    expect(minutes({ elapsed_time: 3120, moving_time: 1716 })).toBe(52);
    expect(minutes({ elapsed_time: 600, moving_time: 900 })).toBe(15);
    expect(minutes({ moving_time: 900 })).toBe(15);
    expect(minutes({ elapsed_time: 0, moving_time: null })).toBe(0);
    expect(minutes({})).toBeNull();
    expect(minutes({ elapsed_time: "3120", moving_time: -5 })).toBeNull();
  });

  it("count the ones that came through Strava and leave them out", () => {
    const { activities, withheld, unreadable, unreadableDays } = readActivities(activitiesJson());
    expect(withheld).toBe(2);
    expect(unreadable).toBe(0);
    expect([...unreadableDays].sort()).toEqual(["2026-11-08", "2026-11-12"]);
    // The Strava stub is the only thing on the 8th; a run is on the 12th beside the other.
    expect(activities.has("2026-11-08")).toBe(false);
    expect(activities.get("2026-11-12")!.map((a) => a.type)).toEqual(["Run"]);
    // Through Strava is what its `source` says, with a type or without, and nothing else.
    const stubs = [
      { id: "1", start_date_local: "2026-11-17T06:00:00", source: "STRAVA", _note: "STRAVA activities are not available via the API" },
      { id: "2", start_date_local: "2026-11-16T07:00:00", source: "STRAVA", type: "Run", elapsed_time: 1800 },
      { id: "3", source: "STRAVA" },
    ];
    expect(readActivities(stubs)).toEqual({
      activities: new Map(), withheld: 3, unreadable: 0, unreadableDays: new Set(["2026-11-17", "2026-11-16"]), undatedTypes: [],
    });
  });

  it("count one with no type from anywhere else as unreadable, not as through Strava", () => {
    const typeless = [
      {},
      { id: "3", start_date_local: "2026-11-17T08:00:00", source: "GARMIN_CONNECT", type: "  " },
      { id: "4", start_date_local: "2026-11-15T09:00:00", type: null },
      { id: "5", start_date_local: "2026-11-15T10:00:00", source: "strava" },
    ];
    // There is still no saying what was done on those days.
    expect(readActivities(typeless)).toEqual({
      activities: new Map(), withheld: 0, unreadable: 4, unreadableDays: new Set(["2026-11-17", "2026-11-15"]), undatedTypes: [],
    });
  });

  it("count what has no day to belong to and leave it out, and refuse a response that isn't a list", () => {
    const odd = [
      { type: "Run" }, { type: "Run", start_date_local: "yesterday" }, { type: "Yoga", start_date_local: "2026-02-30T06:00:00" },
      { type: "Run", start_date_local: 20261117 }, { type: "Run", start_date_local: "2026-11-17 06:12:44" }, null, 7, "Run",
    ];
    expect(readActivities(odd)).toEqual({
      activities: new Map(), withheld: 0, unreadable: 8, unreadableDays: new Set(), undatedTypes: ["Run", "Run", "Yoga", "Run", "Run"],
    });
    for (const notAList of [null, undefined, {}, { type: "Run" }, "[]"]) {
      expect(() => readActivities(notAList)).toThrow(SourceShapeError);
    }
  });

  it("are summed up by type, as intervals.icu spells it, most frequent first", () => {
    expect(summariseActivities(activitiesJson())).toEqual({
      types: [
        { type: "Run", count: 12 },
        { type: "WeightTraining", count: 5 },
        { type: "RockClimbing", count: 2 },
        { type: "Walk", count: 1 },
      ],
      total: 20,
      withheld: 2,
      unreadable: 0,
    });
    const tied = ["Yoga", "Hike", "Run", "Hike", "Yoga"].map((type) => ({ type, start_date_local: "2026-11-17T06:00:00" }));
    expect(summariseActivities(tied).types.map((t) => `${t.type} ${t.count}`)).toEqual(["Hike 2", "Yoga 2", "Run 1"]);
    expect(summariseActivities([])).toEqual({ types: [], total: 0, withheld: 0, unreadable: 0 });
  });

  it("are listed by type even when their start can't be read, and those are counted", () => {
    // Every start in a form this app doesn't expect: the types are still there to choose from.
    const spaced = activitiesJson().map((activity) => ({ ...activity, start_date_local: String(activity.start_date_local).replace("T", " ") }));
    const summary = summariseActivities(spaced);
    expect(summary.types.map((t) => `${t.type} ${t.count}`)).toEqual(["Run 12", "WeightTraining 5", "RockClimbing 2", "Walk 1"]);
    expect(summary).toMatchObject({ total: 20, withheld: 2, unreadable: 20 });
    expect(summariseActivities([{ type: "Yoga", start_date_local: "17/11/2026" }, { start_date_local: "2026-11-17T06:00:00" }, 7])).toEqual({
      types: [{ type: "Yoga", count: 1 }], total: 1, withheld: 0, unreadable: 3,
    });
  });
});

describe("Open-Meteo daily weather", () => {
  it("is read from a real response, one entry a day", () => {
    const days = readWeather(berlinJson());
    expect(days.size).toBe(24);
    expect(days.get("2026-10-25")).toEqual({ high: 13.7, low: 7.3, precipitation: 7.5, code: 63 });
    expect(days.get("2026-11-17")).toEqual({ high: 8.5, low: 4.7, precipitation: 6.7, code: 80 });
    expect(days.get("2026-11-09")).toEqual({ high: 3.5, low: 0.3, precipitation: 0, code: 51 });
  });

  it("keeps a missing value missing, and lines each series up with its day", () => {
    const days = readWeather({
      daily: {
        time: ["2026-11-15", "2026-11-16", "not a day", "2026-11-17"],
        temperature_2m_max: [10.1, null, 99, 12.3],
        temperature_2m_min: [1.5, 2.5],
        precipitation_sum: [null, 0, 99, "0.4"],
      },
    });
    expect([...days]).toEqual([
      ["2026-11-15", { high: 10.1, low: 1.5, precipitation: null, code: null }],
      ["2026-11-16", { high: null, low: 2.5, precipitation: 0, code: null }],
      ["2026-11-17", { high: 12.3, low: null, precipitation: null, code: null }],
    ]);
    expect(readWeather({ daily: { time: [] } }).size).toBe(0);
  });

  it("refuses a response with no days, or in units that weren't asked for", () => {
    for (const bad of [null, [], {}, { daily: null }, { daily: {} }, { daily: { time: "2026-11-17" } }, { error: true, reason: "Latitude must be in range of -90 to 90°." }]) {
      expect(() => readWeather(bad)).toThrow(SourceShapeError);
    }
    const fahrenheit = berlinJson();
    (fahrenheit.daily_units as Record<string, string>).temperature_2m_max = "°F";
    expect(() => readWeather(fahrenheit)).toThrow(/temperature_2m_max was not in °C/);
    const inches = berlinJson();
    (inches.daily_units as Record<string, string>).precipitation_sum = "inch";
    expect(() => readWeather(inches)).toThrow(/precipitation_sum was not in mm/);
  });

  it("puts every WMO weather code Open-Meteo documents into a word", () => {
    const documented: Record<string, number[]> = {
      clear: [0, 1],
      cloudy: [2, 3],
      fog: [45, 48],
      drizzle: [51, 53, 55, 56, 57],
      rain: [61, 63, 65, 66, 67, 80, 81, 82],
      snow: [71, 73, 75, 77, 85, 86],
      storm: [95, 96, 99],
    };
    expect(Object.keys(documented)).toEqual([...CONDITIONS]);
    for (const [word, codes] of Object.entries(documented)) {
      for (const code of codes) expect(condition(code), `code ${code}`).toBe(word);
    }
    const known = new Set(Object.values(documented).flat());
    for (let code = -1; code <= 120; code++) {
      if (!known.has(code)) expect(condition(code), `code ${code}`).toBeNull();
    }
    expect(condition(63.5)).toBeNull();
  });
});

describe("what a fetch was rejected with", () => {
  it("is taken as the shell sends it", () => {
    expect(asProblem({ kind: "no_key" })).toEqual({ kind: "no_key" });
    expect(asProblem({ kind: "key_rejected" })).toEqual({ kind: "key_rejected" });
    expect(asProblem({ kind: "offline" })).toEqual({ kind: "offline" });
    expect(asProblem({ kind: "rate_limited", retry_after_secs: 120 })).toEqual({ kind: "rate_limited", retry_after_secs: 120 });
    expect(asProblem({ kind: "rate_limited", retry_after_secs: null })).toEqual({ kind: "rate_limited", retry_after_secs: null });
    expect(asProblem({ kind: "unexpected", detail: "HTTP 500" })).toEqual({ kind: "unexpected", detail: "HTTP 500" });
    expect(asProblem(new SyncFailure({ kind: "offline" }))).toEqual({ kind: "offline" });
  });

  it("is unexpected when it is anything else, and carries nothing along that wasn't asked for", () => {
    expect(asProblem("Unknown command")).toEqual({ kind: "unexpected", detail: "Unknown command" });
    expect(asProblem(new SourceShapeError("the activities were not a list"))).toEqual({ kind: "unexpected", detail: "the activities were not a list" });
    expect(asProblem({ kind: "teapot" })).toEqual({ kind: "unexpected", detail: "no detail given" });
    expect(asProblem(undefined)).toEqual({ kind: "unexpected", detail: "no detail given" });
    expect(asProblem({ kind: "rate_limited", retry_after_secs: "soon" })).toEqual({ kind: "rate_limited", retry_after_secs: null });
    // Only the fields a problem has: whatever else was on the object stays behind.
    expect(asProblem({ kind: "key_rejected", body: "secret", headers: { authorization: "Basic abc" } })).toEqual({ kind: "key_rejected" });
    expect(asProblem({ kind: "unexpected", detail: { body: "secret" } })).toEqual({ kind: "unexpected", detail: "no detail given" });
  });
});
