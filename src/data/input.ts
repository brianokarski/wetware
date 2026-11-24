/**
 * Turning what was typed into a settings field into a value that may be
 * saved. `ok: false` means the input is invalid: nothing is written and the
 * field goes back to the saved value.
 */
import { isLatitude, isLongitude } from "./settings";

export type Parsed<T> = { ok: true; value: T } | { ok: false };

const INVALID = { ok: false } as const;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** A plain decimal number. No exponents, hex, `Infinity` or stray characters. */
function decimal(text: string): number | null {
  const trimmed = text.trim();
  return DECIMAL.test(trimmed) ? Number(trimmed) : null;
}

/** Latitude or longitude in degrees. An empty field clears the coordinate. */
export function parseCoordinate(text: string, kind: "latitude" | "longitude"): Parsed<number | null> {
  if (text.trim() === "") return { ok: true, value: null };
  const value = decimal(text);
  const valid = kind === "latitude" ? isLatitude(value) : isLongitude(value);
  return value !== null && valid ? { ok: true, value } : INVALID;
}

/** Morning pages word goal: rounded to a whole number first, which must then be 1 or more. */
export function parseWordGoal(text: string): Parsed<number> {
  const value = decimal(text);
  if (value === null) return INVALID;
  const goal = Math.round(value);
  return goal >= 1 && Number.isSafeInteger(goal) ? { ok: true, value: goal } : INVALID;
}
