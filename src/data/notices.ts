/**
 * Things the app has to tell the user: a save that failed, input that wasn't
 * accepted, a file that needs fixing. Each has a key saying what it is about.
 * A notice stays until the thing it is about goes right (it is settled by
 * its key) or the user dismisses it. Something else going right doesn't
 * clear it.
 */
export interface Notice {
  key: string;
  text: string;
}

/** Adds a notice, newest last. One about the same thing replaces the old one. */
export function withNotice(notices: Notice[], key: string, text: string): Notice[] {
  return [...notices.filter((notice) => notice.key !== key), { key, text }];
}

/** Removes the notices with these keys. Returns the same list if none of them is there. */
export function withoutNotices(notices: Notice[], keys: readonly string[]): Notice[] {
  return notices.some((notice) => keys.includes(notice.key))
    ? notices.filter((notice) => !keys.includes(notice.key))
    : notices;
}

/** The notice to show: the newest. */
export function currentNotice(notices: Notice[]): Notice | null {
  return notices.length > 0 ? notices[notices.length - 1] : null;
}

/** What went wrong, without the name of the error class in front. */
export function reason(problem: unknown): string {
  return problem instanceof Error ? problem.message : String(problem);
}

/** The notice key for one cell of the grid, and for one day's file. */
export const cellNoticeKey = (date: string, habitId: string) => `cell:${date}:${habitId}`;
export const dayNoticeKey = (date: string) => `day:${date}`;
