import { describe, expect, it } from "vitest";
import {
  addMonths, dateKey, daysInMonth, longDate, monthAndDay, monthDates, monthKey, monthName, monthOf, nextMonth,
  parseDateKey, previousMonth, sameMonth, weekday, weekdayInitial, weekdayName,
} from "../src/data";

/**
 * Runs `check` with the process in another time zone, and puts the zone back
 * after. An unset TZ has to be deleted, not assigned: assigning undefined
 * sets the text "undefined", which Node reads as UTC.
 */
function inZone(zone: string, check: () => void): void {
  const before = process.env.TZ;
  process.env.TZ = zone;
  try {
    // Guard against a zone name that silently falls back to UTC.
    if (zone !== "UTC") expect(new Date(2026, 5, 1).getTimezoneOffset()).not.toBe(0);
    check();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

/** West of UTC, far east of it (the calendar day differs from UTC for most of the day), and a half-hour offset. */
const ZONES = ["America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata", "UTC"];

describe("date keys are local calendar days", () => {
  it("uses the local date parts, not UTC", () => {
    // Late evening and just after midnight, local time: toISOString() would name the wrong day
    // for one of these in any time zone that isn't UTC.
    expect(dateKey(new Date(2026, 10, 17, 23, 59, 59))).toBe("2026-11-17");
    expect(dateKey(new Date(2026, 10, 17, 0, 0, 1))).toBe("2026-11-17");
    expect(dateKey(new Date(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
    expect(dateKey(new Date(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
  });

  it.each(ZONES)("names the local day in %s", (zone) => {
    inZone(zone, () => {
      const lateEvening = new Date(2026, 10, 17, 23, 30);
      const earlyMorning = new Date(2026, 10, 17, 0, 30);
      expect(dateKey(lateEvening)).toBe("2026-11-17");
      expect(dateKey(earlyMorning)).toBe("2026-11-17");
      if (zone !== "UTC") {
        // The mistake this guards against: the UTC day differs for one of the two.
        const utcDays = [lateEvening, earlyMorning].map((d) => d.toISOString().slice(0, 10));
        expect(utcDays).not.toEqual(["2026-11-17", "2026-11-17"]);
      }
    });
  });

  it("leaves the time zone as it found it", () => {
    const before = process.env.TZ;
    const offset = new Date(2026, 5, 1).getTimezoneOffset();
    inZone("Pacific/Kiritimati", () => expect(new Date(2026, 5, 1).getTimezoneOffset()).toBe(-840));
    expect(process.env.TZ).toBe(before);
    expect("TZ" in process.env).toBe(before !== undefined);
    expect(new Date(2026, 5, 1).getTimezoneOffset()).toBe(offset);
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

  // Run in zones either side of UTC: a weekday read from a UTC date, or from a date parsed
  // as UTC, is a day out in one of them.
  it.each(ZONES)("knows the weekday of a date in %s", (zone) => {
    inZone(zone, () => {
      expect(weekday("2026-11-01")).toBe(0);
      expect(weekday("2026-11-17")).toBe(2);
      expect(weekday("2027-02-28")).toBe(0);
      expect(weekday("2026-12-31")).toBe(4);
      expect(weekday("2027-01-01")).toBe(5);
      expect(weekday("2028-02-29")).toBe(2);
      // The days the clocks change in Los Angeles.
      expect(weekday("2026-03-08")).toBe(0);
      expect(weekday("2026-11-01")).toBe(0);
      expect(weekdayInitial("2026-11-17")).toBe("T");
      expect(weekdayInitial("2026-11-01")).toBe("S");
      expect(weekdayName("2026-11-01")).toBe("Sunday");
      expect(weekdayName("2026-11-17")).toBe("Tuesday");
      expect(longDate("2026-11-17")).toBe("Tuesday, November 17, 2026");
      expect(longDate("2026-01-01")).toBe("Thursday, January 1, 2026");
      expect(monthAndDay("2026-11-17")).toBe("November 17");
      expect(monthAndDay("2027-01-01")).toBe("January 1");
      expect(monthName({ year: 2026, month: 11 })).toBe("November");
      expect(monthName({ year: 2027, month: 1 })).toBe("January");
      // Every day of a month falls on the weekday after the one before it.
      const days = monthDates({ year: 2026, month: 11 }).map(weekday);
      expect(days).toEqual(days.map((_, i) => i % 7));
    });
  });

});
