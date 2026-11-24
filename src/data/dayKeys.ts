/**
 * The frontmatter keys of a day file that belong to the app, in one place.
 *
 * A habit's values live under its own key (`dayKey(habit)`). These keys are
 * the app's: no habit may use one, or it would overwrite what the app keeps
 * there. That includes what sync logs by itself each day, beside the habits:
 * HRV, resting heart rate, sleep score and the weather.
 */

/** The file's own bookkeeping. Never part of a day's values, never set through a values patch. */
export const STRUCTURE_KEYS = ["date", "_sources", "_synced_at"] as const;

/** The key new values are written ahead of, so the bookkeeping stays at the end. */
export const TAIL_KEYS = ["_sources", "_synced_at"] as const;

/** The list that `tag` habits switch their ids on and off in (SPEC §6.2). */
export const TAGS_KEY = "tags";

/** Logged by sync from intervals.icu wellness records (SPEC §5.4, §6.2). */
export const VITALS_KEYS = { hrv: "hrv", restingHr: "resting_hr", sleepScore: "sleep_score" } as const;

export interface WeatherKeys {
  high: string;
  low: string;
  precipitation: string;
  condition: string;
}

/**
 * Logged by sync from Open-Meteo. Temperatures carry their unit, as in the
 * day file of SPEC §6.2; precipitation is in inches beside °F and millimetres
 * beside °C.
 */
export const WEATHER_KEYS: Record<"F" | "C", WeatherKeys> = {
  F: { high: "weather_high_f", low: "weather_low_f", precipitation: "weather_precip_in", condition: "weather_condition" },
  C: { high: "weather_high_c", low: "weather_low_c", precipitation: "weather_precip_mm", condition: "weather_condition" },
};

/** Every key the app owns. A habit whose day key is one of these can't be used. */
export const APP_DAY_KEYS: readonly string[] = [
  ...new Set([
    ...STRUCTURE_KEYS,
    TAGS_KEY,
    ...Object.values(VITALS_KEYS),
    ...Object.values(WEATHER_KEYS.F),
    ...Object.values(WEATHER_KEYS.C),
  ]),
];
