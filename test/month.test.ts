import { describe, expect, it } from "vitest";
import {
  addMonths, dateKey, daysInMonth, longDate, monthDates, monthKey, monthName, monthOf, nextMonth,
  parseDateKey, previousMonth, sameMonth, weekday, weekdayInitial, weekdayName,
} from "../src/data";

describe("date keys are local calendar days", () => {
  it("uses the local date parts, not UTC", () => {
    // Late evening and just after midnight, local time: toISOString() would name the wrong day
    // for one of these in any time zone that isn't UTC.
    expect(dateKey(new Date(2026, 10, 17, 23, 59, 59))).toBe("2026-11-17");
    expect(dateKey(new Date(2026, 10, 17, 0, 0, 1))).toBe("2026-11-17");
    expect(dateKey(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
    expect(dateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
  });

  it.each(["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata", "UTC"])("names the local day in %s", (zone) => {
    const before = process.env.TZ;
    process.env.TZ = zone;
    try {
      const lateEvening = new Date(2026, 10, 17, 23, 30);
      const earlyMorning = new Date(2026, 10, 17, 0, 30);
      expect(dateKey(lateEvening)).toBe("2026-11-17");
      expect(dateKey(earlyMorning)).toBe("2026-11-17");
      if (zone !== "UTC") {
        // The mistake this guards against: the UTC day differs for one of the two.
        const utcDays = [lateEvening, earlyMorning].map((d) => d.toISOString().slice(0, 10));
        expect(utcDays).not.toEqual(["2026-11-17", "2026-11-17"]);
      }
    } finally {
      process.env.TZ = before;
    }
  });

  it("pads months, days and early years", () => {
    expect(dateKey(new Date(2027, 1, 3, 12))).toBe("2027-02-03");
    const early = new Date(2000, 0, 5, 12);
    early.setFullYear(987);
    expect(dateKey(early)).toBe("0987-01-05");
  });

  it("only accepts keys that name a real day", () => {
    expect(parseDateKey("2026-11-17")).toEqual({ year: 2026, month: 11, day: 17 });
    expect(parseDateKey("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-11-31", "2026-11-00", "2026-1-5", "20261117", "", "2026-11-17T00:00"]) {
      expect(parseDateKey(bad)).toBeNull();
    }
    expect(() => monthOf("2026-02-30")).toThrow(RangeError);
  });
});

describe("months", () => {
  it("knows how many days each has, leap years included", () => {
    const lengths = Array.from({ length: 12 }, (_, i) => daysInMonth({ year: 2026, month: i + 1 }));
    expect(lengths).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2100, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2000, month: 2 })).toBe(29);
  });

  it("lists its dates in order", () => {
    const november = monthDates({ year: 2026, month: 11 });
    expect(november).toHaveLength(30);
    expect(november[0]).toBe("2026-11-01");
    expect(november[29]).toBe("2026-11-30");
    expect(monthDates({ year: 2027, month: 2 })).toHaveLength(28);
    expect(monthDates({ year: 2026, month: 12 })[30]).toBe("2026-12-31");
  });

  it("steps across year boundaries in both directions", () => {
    expect(nextMonth({ year: 2026, month: 12 })).toEqual({ year: 2027, month: 1 });
    expect(previousMonth({ year: 2027, month: 1 })).toEqual({ year: 2026, month: 12 });
    expect(nextMonth({ year: 2026, month: 11 })).toEqual({ year: 2026, month: 12 });
    expect(previousMonth({ year: 2026, month: 11 })).toEqual({ year: 2026, month: 10 });
    expect(addMonths({ year: 2026, month: 11 }, 14)).toEqual({ year: 2028, month: 1 });
    expect(addMonths({ year: 2026, month: 11 }, -23)).toEqual({ year: 2024, month: 12 });
    expect(addMonths({ year: 2026, month: 11 }, 0)).toEqual({ year: 2026, month: 11 });
    let ym = { year: 2026, month: 11 };
    for (let i = 0; i < 30; i++) ym = nextMonth(ym);
    for (let i = 0; i < 30; i++) ym = previousMonth(ym);
    expect(ym).toEqual({ year: 2026, month: 11 });
  });

  it("names and compares", () => {
    expect(monthOf("2026-11-17")).toEqual({ year: 2026, month: 11 });
    expect(monthKey({ year: 2026, month: 3 })).toBe("2026-03");
    expect(monthName({ year: 2026, month: 11 })).toBe("November");
    expect(monthName({ year: 2027, month: 2 })).toBe("February");
    expect(sameMonth({ year: 2026, month: 11 }, monthOf("2026-11-30"))).toBe(true);
    expect(sameMonth({ year: 2026, month: 11 }, { year: 2027, month: 11 })).toBe(false);
  });

  it("knows the weekday of a date", () => {
    expect(weekday("2026-11-01")).toBe(0);
    expect(weekday("2026-11-17")).toBe(2);
    expect(weekdayInitial("2026-11-17")).toBe("T");
    expect(weekdayName("2026-11-01")).toBe("Sunday");
    expect(longDate("2026-11-17")).toBe("Tuesday, November 17, 2026");
    expect(weekday("2027-02-28")).toBe(0);
  });
});
