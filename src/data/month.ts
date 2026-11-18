/**
 * Calendar months and days. A day is the user's local calendar day, named by
 * a `YYYY-MM-DD` key. Keys are built from local date parts and never from
 * `toISOString()`, which is in UTC and names the wrong day near midnight.
 */

export interface YearMonth {
  year: number;
  /** 1 to 12. */
  month: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The local calendar day of `date`, as `YYYY-MM-DD`. */
export function dateKey(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The parts of a `YYYY-MM-DD` key, or null if it doesn't name a real day. */
export function parseDateKey(key: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth({ year, month })) return null;
  return { year, month, day };
}

/** Local midnight at the start of a day. Only for asking the calendar about that day. */
function localDate(key: string): Date {
  const parts = parseDateKey(key);
  if (!parts) throw new RangeError(`Not a date: ${key}`);
  const date = new Date(parts.year, parts.month - 1, parts.day);
  // Years 0 to 99 would otherwise be read as 1900 to 1999.
  date.setFullYear(parts.year);
  return date;
}

export function monthOf(key: string): YearMonth {
  const parts = parseDateKey(key);
  if (!parts) throw new RangeError(`Not a date: ${key}`);
  return { year: parts.year, month: parts.month };
}

/** `YYYY-MM`, as used for the roll-up file names. */
export function monthKey({ year, month }: YearMonth): string {
  return `${pad(year, 4)}-${pad(month)}`;
}

export function daysInMonth({ year, month }: YearMonth): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** The date key of every day in the month, in order. */
export function monthDates(ym: YearMonth): string[] {
  return Array.from({ length: daysInMonth(ym) }, (_, i) => `${monthKey(ym)}-${pad(i + 1)}`);
}

/** The month `count` months after `ym` (before it, if negative), across year ends. */
export function addMonths({ year, month }: YearMonth, count: number): YearMonth {
  const index = year * 12 + (month - 1) + count;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

export const previousMonth = (ym: YearMonth) => addMonths(ym, -1);
export const nextMonth = (ym: YearMonth) => addMonths(ym, 1);
export const sameMonth = (a: YearMonth, b: YearMonth) => a.year === b.year && a.month === b.month;

/** The day `count` days after `key` (before it, if negative). Calendar arithmetic only: no clock, no time zone. */
export function addDays(key: string, count: number): string {
  const parts = parseDateKey(key);
  if (!parts) throw new RangeError(`Not a date: ${key}`);
  const date = new Date(0);
  // Sets the year as given (years 0 to 99 included) and carries days over month and year ends.
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day + count);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Every day from `oldest` to `newest`, both included, in order. Empty if `newest` is the earlier one. */
export function datesBetween(oldest: string, newest: string): string[] {
  const dates: string[] = [];
  for (let date = oldest; date <= newest; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/**
 * A moment as local time with its offset from UTC, to the second:
 * `2026-11-17T06:30:00-08:00`. This is how `_synced_at` is written (SPEC §6.2).
 */
export function localTimestamp(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const zone = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => pad(n)).join(":");
  return `${dateKey(date)}T${time}${zone}`;
}

/** 0 for Sunday to 6 for Saturday. */
export function weekday(key: string): number {
  return localDate(key).getDay();
}

const LOCALE = "en-US";

/** "November" */
export function monthName(ym: YearMonth): string {
  return localDate(`${monthKey(ym)}-01`).toLocaleDateString(LOCALE, { month: "long" });
}

/** "T" for a Tuesday. */
export function weekdayInitial(key: string): string {
  return localDate(key).toLocaleDateString(LOCALE, { weekday: "narrow" });
}

/** "Tuesday" */
export function weekdayName(key: string): string {
  return localDate(key).toLocaleDateString(LOCALE, { weekday: "long" });
}

/** "November 17" */
export function monthAndDay(key: string): string {
  return localDate(key).toLocaleDateString(LOCALE, { month: "long", day: "numeric" });
}

/** "Tuesday, November 17, 2026" */
export function longDate(key: string): string {
  return localDate(key).toLocaleDateString(LOCALE, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}
