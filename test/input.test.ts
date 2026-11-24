/** S5: what the Settings screen may save. Invalid input is `ok: false` and the field reverts. */
import { describe, expect, it } from "vitest";
import { parseCoordinate, parseWordGoal } from "../src/data";

describe("coordinates", () => {
  it("accepts plain decimals inside the range", () => {
    expect(parseCoordinate("37.8", "latitude")).toEqual({ ok: true, value: 37.8 });
    expect(parseCoordinate(" -122.27 ", "longitude")).toEqual({ ok: true, value: -122.27 });
    expect(parseCoordinate("90", "latitude")).toEqual({ ok: true, value: 90 });
    expect(parseCoordinate("-180", "longitude")).toEqual({ ok: true, value: -180 });
    expect(parseCoordinate("+.5", "latitude")).toEqual({ ok: true, value: 0.5 });
    expect(parseCoordinate("120", "longitude")).toEqual({ ok: true, value: 120 });
  });

  it.each(["37.8a", "abc", "500", "90.01", "-91", "Infinity", "-Infinity", "NaN", "1e2", "0x10", "37,8", "3 7", "--5", "."])(
    "rejects %s as a latitude",
    (text) => expect(parseCoordinate(text, "latitude")).toEqual({ ok: false }),
  );

  it.each(["180.5", "-181", "Infinity", "12e1", "west"])("rejects %s as a longitude", (text) =>
    expect(parseCoordinate(text, "longitude")).toEqual({ ok: false }),
  );

  it("treats an emptied field as clearing the coordinate", () => {
    expect(parseCoordinate("", "latitude")).toEqual({ ok: true, value: null });
    expect(parseCoordinate("   ", "longitude")).toEqual({ ok: true, value: null });
  });
});

describe("morning pages word goal", () => {
  it("rounds first, then needs 1 or more", () => {
    expect(parseWordGoal("750")).toEqual({ ok: true, value: 750 });
    expect(parseWordGoal("749.6")).toEqual({ ok: true, value: 750 });
    expect(parseWordGoal("0.5")).toEqual({ ok: true, value: 1 });
    expect(parseWordGoal(" 1 ")).toEqual({ ok: true, value: 1 });
  });

  it.each(["0.4", "0", "-3", "", "  ", "abc", "750 words", "Infinity", "1e3", "1e400"])("rejects %s", (text) =>
    expect(parseWordGoal(text)).toEqual({ ok: false }),
  );
});
