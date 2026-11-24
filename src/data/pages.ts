/**
 * Morning pages: the one module that reads and writes their text.
 *
 * The text lives in `pages/YYYY-MM-DD.md` and nowhere else (SPEC §2,
 * principle 4). Only its word count leaves: as the Morning pages habit's
 * value in the day file, with the source `morning_pages`.
 *
 * To keep that structural and not just careful:
 *
 * - `readPages` is the only function here that hands the text to a caller,
 *   and only the writing room calls it. Neither it nor `pagesPath`, which
 *   says where a day's pages are, is re-exported from `data/index.ts`: the
 *   room imports them from here. `test/pages.privacy.test.ts` holds what
 *   this module exports, and what the front door passes on, to exact lists,
 *   and fails if anything else in `src/` names the pages folder, in any
 *   case, or reaches into this module.
 * - Nothing else here returns, throws or keeps the text. What other screens
 *   need of a day's pages is a number (`pagesWords`). An error about a pages
 *   file names the file and never quotes it, and carries no copy of it.
 */
import { dropStubDay, writeDay, type Day, type DayPatch } from "./dayFile";
import type { DataFs } from "./fs";
import { dayKey, type Habit } from "./habits";
import { reason } from "./notices";
import { inTurn } from "./queue";
import { detectEol } from "./yamlPatch";

const PAGES_DIR = "pages";

/** The file a day's pages are kept in. For the room, to say where the text is; nothing else needs to know. */
export const pagesPath = (date: string): string => `${PAGES_DIR}/${date}.md`;

/** What the day file's `_sources` says of a count the room wrote. */
export const PAGES_SOURCE = "morning_pages";

/** About 250 words fill a page (SPEC §5.4, §8.4). */
export const WORDS_PER_PAGE = 250;

/** The notice key for what the room has to say about one day's pages. */
export const pagesNoticeKey = (date: string) => `pages:${date}`;

// ---------------------------------------------------------------------------
// Counting. Pure: text in, numbers out.
// ---------------------------------------------------------------------------

const WORD = /\S+/g;

/**
 * How many words a text holds: it is split on whitespace, and what is left
 * is counted. Punctuation, hyphens and apostrophes don't split a word, and a
 * mark standing alone ("—", "...") is one. Writing that puts no spaces
 * between words counts by its runs of characters, not its words.
 */
export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

export interface PageStart {
  /** 1 for the first page. */
  page: number;
  /** Where in the text the page's first word begins. */
  offset: number;
}

/**
 * Where each page begins: the first word, and every `perPage` words after
 * it. A text with no words has no pages begun.
 */
export function pageStarts(text: string, perPage = WORDS_PER_PAGE): PageStart[] {
  const starts: PageStart[] = [];
  let word = 0;
  for (const match of text.matchAll(WORD)) {
    if (word % perPage === 0) starts.push({ page: word / perPage + 1, offset: match.index });
    word++;
  }
  return starts;
}

/** The page the writing has reached: 1 until the first is full, then the one the last word is on. */
export function currentPage(words: number, perPage = WORDS_PER_PAGE): number {
  return Math.max(1, Math.ceil(words / perPage));
}

/** How many pages the goal comes to, or null with no goal. 750 words are 3. */
export function goalPages(goal: number | null, perPage = WORDS_PER_PAGE): number | null {
  return goal === null || !(goal > 0) ? null : Math.ceil(goal / perPage);
}

/** "page 2 of 3". Past the goal's last page, or with no goal, just "page 4". */
export function pageLine(words: number, goal: number | null, perPage = WORDS_PER_PAGE): string {
  const page = currentPage(words, perPage);
  const pages = goalPages(goal, perPage);
  return pages === null || page > pages ? `page ${page}` : `page ${page} of ${pages}`;
}

/** "412 / 750 words", or "412 words" with no goal. */
export function wordLine(words: number, goal: number | null): string {
  return goal === null || !(goal > 0) ? `${words} ${words === 1 ? "word" : "words"}` : `${words} / ${goal} words`;
}

// ---------------------------------------------------------------------------
// The count in the day file
// ---------------------------------------------------------------------------

const own = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);

/** Whether `_sources` says the room wrote the day's count. */
function roomWroteCount(habit: Habit, day: Day): boolean {
  const key = dayKey(habit);
  return own(day.sources, key) && day.sources[key] === PAGES_SOURCE;
}

/**
 * Whether the day's count is the room's to set. It is when there is no
 * count: an empty one is nobody's, whatever `_sources` says of it (a count
 * cleared in the grid is marked `manual`, and is still empty). And it is
 * when `_sources` says the room wrote the one that is there. A count that
 * holds a value `_sources` calls `manual` (typed into the grid or the day
 * view), or anything else, is someone's own, and so is one with no entry
 * there at all: typed into the file by hand, as far as the app can tell.
 * Those are left as they are.
 */
export function roomKeepsCount(habit: Habit, day: Day): boolean {
  const key = dayKey(habit);
  if (!own(day.values, key) || day.values[key] === null) return true;
  return roomWroteCount(habit, day);
}

/**
 * The patch that makes the day's count `words`, as the room's own, whoever
 * set the count that is there: for a count that is the room's to keep, and
 * for one handed back to it. Null if the file already says exactly that.
 * Pages with no words in them leave no count behind: what the room wrote,
 * the key and its source entry, is taken out again, and `_sources` with it
 * if that was all it held.
 */
export function roomCountPatch(habit: Habit, day: Day, words: number): DayPatch | null {
  const key = dayKey(habit);
  const held = own(day.values, key) ? day.values[key] : undefined;
  // No prototype, so a key such as `__proto__` is a key like any other.
  const values: Record<string, number | undefined> = Object.create(null);
  const sources: Record<string, string | undefined> = Object.create(null);
  if (words === 0) {
    // Nothing is there to take out: no key and no entry.
    if (held === undefined && !own(day.sources, key)) return null;
    values[key] = undefined;
    sources[key] = undefined;
    return { values, sources, tidy: true };
  }
  if (held === words && roomWroteCount(habit, day)) return null;
  values[key] = words;
  sources[key] = PAGES_SOURCE;
  return { values, sources };
}

/**
 * The day-file patch that records how many words the day's pages hold, or
 * null if there is nothing to change: the count is already that, or it was
 * set by hand. With no words there is nothing to record: a count the room
 * wrote is taken out, and an empty one that someone else left is left.
 */
export function pagesCountPatch(habit: Habit, day: Day, words: number): DayPatch | null {
  if (!roomKeepsCount(habit, day)) return null;
  if (words === 0 && !roomWroteCount(habit, day)) return null;
  return roomCountPatch(habit, day, words);
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

const BOM = "\uFEFF";

/** A pages file as the room shows it: no byte order mark, `\n` line endings. */
function shown(raw: string | null): string {
  const text = raw ?? "";
  return (text.startsWith(BOM) ? text.slice(BOM.length) : text).replace(/\r\n/g, "\n");
}

/** What is written for `text`: in the line endings the file already uses, behind its byte order mark if it has one. */
function written(text: string, raw: string | null): string {
  if (text === "") return "";
  const eol = detectEol(raw ?? "") ?? "\n";
  return (raw?.startsWith(BOM) ? BOM : "") + text.replace(/\n/g, eol);
}

/**
 * The text of a day's pages, or the empty string if none have been written.
 * For the writing room and nothing else: see the note at the top of this file.
 */
export function readPages(fs: DataFs, date: string): Promise<string> {
  const path = pagesPath(date);
  return inTurn(fs, path, async () => shown(await fs.read(path)));
}

/**
 * The pages on disk are not the ones the writing started from: something
 * else has changed the file since. Nothing was written. The error says
 * which file and carries none of its text.
 */
export class PagesChangedError extends Error {
  constructor(date: string) {
    super(`${pagesPath(date)} was changed outside the app`);
    this.name = "PagesChangedError";
  }
}

/** The pages were saved, and their word count could not be written to the day file. */
export class PagesCountError extends Error {
  constructor(date: string, cause: unknown) {
    super(`The word count could not be written to days/${date}.md. ${reason(cause)}`);
    this.name = "PagesCountError";
  }
}

/** What became of the word count when pages were saved. */
export type CountOutcome =
  /** The day file now says how many words there are (or already did). */
  | "kept"
  /** The day file's count was set by hand, and was left as it is. */
  | "by_hand"
  /** No habit is fed by the room, so there is nowhere to keep a count. */
  | "no_habit";

export interface PagesSaved {
  words: number;
  count: CountOutcome;
}

/**
 * The text a pages file is known to hold: what the room last read from it,
 * or last wrote to it. Every save is checked against it, and moves it on.
 */
export interface PagesBase {
  text: string;
}

/**
 * Saves a day's pages, and then their word count.
 *
 * The text is only ever written over text the room has seen. `base` holds
 * what the file was last known to hold; if the file holds anything else
 * when this write's turn comes, nothing is written and it rejects with
 * `PagesChangedError`: the app never writes over text it hasn't shown. A
 * save that lands moves `base` on to what it wrote, there and then, so a
 * second save asked for while the first is on its way is checked against
 * the first one's text when its own turn comes. Text that is already what
 * the file holds is known to be there without being written, and no file
 * is made for pages that were never written.
 *
 * A save that is given up on (the folder gave no answer in time) writes
 * nothing it had not already asked the shell for, and does not move `base`
 * if that write lands after all: by then a later save may have landed.
 *
 * The count goes to the day file through the same queue as every other
 * change to it, as the value of `habit` with the source `morning_pages`,
 * unless the count there was set by hand. If the text is saved and the
 * count can't be, it rejects with `PagesCountError`.
 */
export async function savePages(fs: DataFs, date: string, text: string, base: PagesBase, habit: Habit | null): Promise<PagesSaved> {
  const path = pagesPath(date);
  await inTurn(fs, path, async (turn) => {
    const raw = await fs.read(path);
    // Given up on while the file was being read: later saves are running, and this one writes nothing.
    if (!turn.live()) return;
    const held = shown(raw);
    if (held !== text) {
      if (held !== base.text) throw new PagesChangedError(date);
      await fs.write(path, written(text, raw));
    }
    if (turn.live()) base.text = text;
  });

  const words = countWords(text);
  if (habit === null) return { words, count: "no_habit" };
  let count: CountOutcome = "kept";
  let taken = false;
  try {
    await writeDay(fs, date, (day) => {
      if (!roomKeepsCount(habit, day)) count = "by_hand";
      const patch = pagesCountPatch(habit, day, words);
      taken = patch !== null && words === 0;
      return patch;
    });
    // The count was the one thing in a day file the app made: the file goes with it.
    if (taken) await dropStubDay(fs, date);
  } catch (e) {
    throw new PagesCountError(date, e);
  }
  return { words, count };
}

/**
 * How many words a day's pages hold: 0 if there are none. A number, and
 * nothing of the text. For a screen other than the room that needs to know
 * whether a day has pages.
 */
export function pagesWords(fs: DataFs, date: string): Promise<number> {
  const path = pagesPath(date);
  return inTurn(fs, path, async () => countWords(shown(await fs.read(path))));
}

/**
 * Hands a day's count back to the room: whatever the day file says, and
 * whoever set it, the count becomes the number of words the day's pages
 * hold, as the room's own, which the room keeps from then on. Resolves to
 * the day as saved.
 */
export async function takeRoomCount(fs: DataFs, date: string, habit: Habit): Promise<Day> {
  const words = await pagesWords(fs, date);
  const day = await writeDay(fs, date, (now) => roomCountPatch(habit, now, words));
  if (words === 0) await dropStubDay(fs, date);
  return day;
}

/** The habit the writing room feeds: the first on show whose source is `morning_pages`. Null if there is none. */
export function pagesHabit(habits: Habit[]): Habit | null {
  return habits.find((habit) => habit.source === PAGES_SOURCE && !habit.archived) ?? null;
}
