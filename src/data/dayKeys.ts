/**
 * The frontmatter keys of a day file that belong to the app, in one place.
 *
 * A habit's values live under its own key (`dayKey(habit)`). These keys are
 * the app's: no habit may use one, or it would overwrite what the app keeps
 * there. Sync adds the keys it logs by itself (HRV, resting heart rate,
 * weather and so on) to `APP_DAY_KEYS` when it arrives.
 */

/** The file's own bookkeeping. Never part of a day's values, never set through a values patch. */
export const STRUCTURE_KEYS = ["date", "_sources", "_synced_at"] as const;

/** The key new values are written ahead of, so the bookkeeping stays at the end. */
export const TAIL_KEYS = ["_sources", "_synced_at"] as const;

/** The list that `tag` habits switch their ids on and off in (SPEC §6.2). */
export const TAGS_KEY = "tags";

/** Every key the app owns. A habit whose day key is one of these can't be used. */
export const APP_DAY_KEYS: readonly string[] = [...STRUCTURE_KEYS, TAGS_KEY];
