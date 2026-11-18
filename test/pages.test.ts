/** Morning pages: counting words, where pages begin, the count in the day file, and saving. */
import { describe, expect, it } from "vitest";
import {
  countWords, currentPage, goalPages, memoryFs, pageLine, PagesChangedError, pagesCountPatch, PagesCountError, pagesHabit,
  pagesNoticeKey, pagesPath, pageStarts, parseDay, parseHabits, roomKeepsCount, savePages, SEED_HABITS, updateDayFile,
  wordLine, writeDay, type DataFs, type Habit,
} from "../src/data";
import { readPages } from "../src/data/pages";

const DATE = "2026-11-17";
const PAGES = "pages/2026-11-17.md";
const DAY = "days/2026-11-17.md";
const pages = SEED_HABITS.find((habit) => habit.id === "morning_pages")!;
const habit = (fields: Partial<Habit> & Pick<Habit, "id">): Habit => parseHabits(`habits:\n  - ${JSON.stringify(fields)}\n`)[0];
const day = (frontmatter: string) => parseDay(`---\n${frontmatter}---\n`, DATE);
/** `count` made-up words, "w1 w2 w3 ...", ten to a line. */
const words = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `w${from + i}${(i + 1) % 10 === 0 ? "\n" : " "}`).join("").trimEnd();

/** The text a pages file was last known to hold, for a save that stands alone. */
const at = (text: string) => ({ text });

/** A memory folder that counts its writes. */
function folder(files: Record<string, string> = {}) {
  const fs = memoryFs(files);
  const written: string[] = [];
  const write = fs.write.bind(fs);
  fs.write = async (path, text) => {
    written.push(path);
    await write(path, text);
  };
  return Object.assign(fs, { written });
}

describe("counting words", () => {
  it("splits on whitespace and counts what is left", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t  \r\n ")).toBe(0);
    expect(countWords("one")).toBe(1);
    expect(countWords("  one  ")).toBe(1);
    expect(countWords("one two\tthree\nfour\r\nfive\n\n\nsix")).toBe(6);
    expect(countWords("so    many      spaces")).toBe(3);
  });

  it("does not split a word at punctuation, a hyphen or an apostrophe", () => {
    expect(countWords("Hello, world!")).toBe(2);
    expect(countWords("well-being is a state-of-the-art word")).toBe(5);
    expect(countWords("don't it's o'clock rock'n'roll the dogs' bowls")).toBe(7);
    expect(countWords("mother-in-law's")).toBe(1);
    expect(countWords("(parenthetical) \"quoted\" [bracketed] end.")).toBe(4);
    expect(countWords("1,000.50 3/4 10:30 a.m.")).toBe(4);
    expect(countWords("no.space.after.the.stop")).toBe(1);
  });

  it("counts a mark standing alone as a word, since it is what is left", () => {
    expect(countWords("this — that")).toBe(3);
    expect(countWords("this—that")).toBe(1);
    expect(countWords("well ... yes")).toBe(3);
    expect(countWords("- [ ] a task")).toBe(5);
  });

  it("takes every kind of white space as a break: no-break and wide spaces, line and paragraph separators", () => {
    expect(countWords("a\u00a0b")).toBe(2);
    expect(countWords("a\u2003b\u2009c")).toBe(3);
    expect(countWords("a\u2028b\u2029c")).toBe(3);
    expect(countWords("你好\u3000世界")).toBe(2);
  });

  it("counts words in other scripts by their spaces, and writing without spaces by its runs", () => {
    expect(countWords("über naïve café señor")).toBe(4);
    expect(countWords("Привет, мир! Как дела?")).toBe(4);
    expect(countWords("مرحبا بالعالم")).toBe(2);
    expect(countWords("😀 👍🏽 two")).toBe(3);
    // No spaces between the words, so there is one run. The count is honest about what it counts.
    expect(countWords("これは日本語の文章です。")).toBe(1);
    expect(countWords("今天早上 我写了 三页")).toBe(3);
  });
});

describe("pages", () => {
  it("begin at the first word and every 250 words after it", () => {
    expect(pageStarts("")).toEqual([]);
    expect(pageStarts(" \n ")).toEqual([]);
    expect(pageStarts("one")).toEqual([{ page: 1, offset: 0 }]);
    expect(pageStarts("\n\n  one two")).toEqual([{ page: 1, offset: 4 }]);
    expect(pageStarts(words(250)).map((start) => start.page)).toEqual([1]);

    const text = words(760);
    const starts = pageStarts(text);
    expect(starts.map((start) => start.page)).toEqual([1, 2, 3, 4]);
    // Each page starts exactly at its first word: the 1st, 251st, 501st and 751st.
    expect(starts.map((start) => text.slice(start.offset).split(/\s/)[0])).toEqual(["w1", "w251", "w501", "w751"]);
    expect(starts.map((start) => countWords(text.slice(0, start.offset)))).toEqual([0, 250, 500, 750]);
    expect(pageStarts(words(750)).map((start) => start.page)).toEqual([1, 2, 3]);
    expect(pageStarts(words(751)).map((start) => start.page)).toEqual([1, 2, 3, 4]);
  });

  it("can be any length", () => {
    expect(pageStarts("a b c d e", 2)).toEqual([{ page: 1, offset: 0 }, { page: 2, offset: 4 }, { page: 3, offset: 8 }]);
    expect(pageStarts("a b c d", 2).length).toBe(2);
  });

  it("say which one the writing has reached, against how many the goal comes to", () => {
    expect([0, 1, 250, 251, 500, 501, 750, 751, 1000, 1001].map((count) => currentPage(count))).toEqual([1, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
    expect([750, 751, 1, 250, 800, 100].map((goal) => goalPages(goal))).toEqual([3, 4, 1, 1, 4, 1]);
    expect([null, 0, -5, NaN].map((goal) => goalPages(goal))).toEqual([null, null, null, null]);

    expect(pageLine(0, 750)).toBe("page 1 of 3");
    expect(pageLine(250, 750)).toBe("page 1 of 3");
    expect(pageLine(251, 750)).toBe("page 2 of 3");
    expect(pageLine(750, 750)).toBe("page 3 of 3");
    // Past the goal there is no "of": the fourth of three would be a score.
    expect(pageLine(751, 750)).toBe("page 4");
    expect(pageLine(300, null)).toBe("page 2");

    expect(wordLine(0, 750)).toBe("0 / 750 words");
    expect(wordLine(812, 750)).toBe("812 / 750 words");
    expect(wordLine(1, null)).toBe("1 word");
    expect(wordLine(2, null)).toBe("2 words");
  });
});

describe("the count in the day file", () => {
  it("is written as the habit's value, with morning_pages as its source", () => {
    expect(pagesCountPatch(pages, parseDay(null, DATE), 412)).toEqual({
      values: { morning_pages_words: 412 },
      sources: { morning_pages_words: "morning_pages" },
    });
    // The key is the habit's own, whatever it is called and whatever its unit.
    const other = habit({ id: "journal", type: "progress", goal: 500, source: "morning_pages" });
    expect(pagesCountPatch(other, parseDay(null, DATE), 3)).toEqual({ values: { journal: 3 }, sources: { journal: "morning_pages" } });
  });

  it("fills a gap, and follows a count the room wrote before", () => {
    const patch = { values: { morning_pages_words: 500 }, sources: { morning_pages_words: "morning_pages" } };
    expect(pagesCountPatch(pages, day("morning_pages_words: null\n"), 500)).toEqual(patch);
    expect(pagesCountPatch(pages, day("morning_pages_words: 120\n_sources:\n  morning_pages_words: morning_pages\n"), 500)).toEqual(patch);
    // Already that, by the room: nothing to write.
    expect(pagesCountPatch(pages, day("morning_pages_words: 500\n_sources:\n  morning_pages_words: morning_pages\n"), 500)).toBeNull();
  });

  it("is left alone when it was set by hand", () => {
    const manual = day("morning_pages_words: 750\n_sources:\n  morning_pages_words: manual\n");
    expect(roomKeepsCount(pages, manual)).toBe(false);
    expect(pagesCountPatch(pages, manual, 12)).toBeNull();
    expect(pagesCountPatch(pages, manual, 0)).toBeNull();
    // Cleared by hand is set by hand too.
    const cleared = day("morning_pages_words: null\n_sources:\n  morning_pages_words: manual\n");
    expect(pagesCountPatch(pages, cleared, 12)).toBeNull();
    // No source on record: typed into the file, as far as the app can tell.
    const unrecorded = day("morning_pages_words: 420\n");
    expect(roomKeepsCount(pages, unrecorded)).toBe(false);
    expect(pagesCountPatch(pages, unrecorded, 12)).toBeNull();
    // Any source that isn't the room's.
    expect(pagesCountPatch(pages, day("morning_pages_words: 420\n_sources:\n  morning_pages_words: intervals\n"), 12)).toBeNull();
    expect(roomKeepsCount(pages, parseDay(null, DATE))).toBe(true);
  });

  it("is taken out again, with its source, when the pages have no words left", () => {
    const written = "---\ndate: 2026-11-17\nmood: 3\nmorning_pages_words: 12\n_sources:\n  mood: manual\n  morning_pages_words: morning_pages\n---\n\nnotes\n";
    const patch = pagesCountPatch(pages, parseDay(written, DATE), 0)!;
    expect(updateDayFile(written, DATE, patch)).toBe("---\ndate: 2026-11-17\nmood: 3\n_sources:\n  mood: manual\n---\n\nnotes\n");
    // Nothing of the room's there: nothing to take out, and no file to make.
    expect(pagesCountPatch(pages, parseDay(null, DATE), 0)).toBeNull();
    expect(pagesCountPatch(pages, day("morning_pages_words: null\n"), 0)).toBeNull();
  });

  it("goes to the habit the room feeds: the first on show with morning_pages as its source", () => {
    expect(pagesHabit(SEED_HABITS)?.id).toBe("morning_pages");
    expect(pagesHabit(SEED_HABITS.filter((h) => h.id !== "morning_pages"))).toBeNull();
    expect(pagesHabit(SEED_HABITS.map((h) => (h.id === "morning_pages" ? { ...h, archived: true } : h)))).toBeNull();
  });
});

describe("saving pages", () => {
  it("writes the text to pages/ and the count to the day file, and nothing else", async () => {
    const before = "---\ndate: 2026-11-17\nsleep_h: 7.7 # kept\n_sources:\n  sleep_h: intervals\n---\n\nDay notes.\n";
    const fs = folder({ [DAY]: before, "habits.yaml": "habits: []\n" });
    const saved = await savePages(fs, DATE, "Three words here.", at(""), pages);
    expect(saved).toEqual({ words: 3, count: "kept" });
    expect(fs.files.get(PAGES)).toBe("Three words here.");
    expect(fs.files.get(DAY)).toBe(
      "---\ndate: 2026-11-17\nsleep_h: 7.7 # kept\nmorning_pages_words: 3\n_sources:\n  sleep_h: intervals\n  morning_pages_words: morning_pages\n---\n\nDay notes.\n",
    );
    expect(fs.written).toEqual([PAGES, DAY]);
    expect([...fs.files.keys()].sort()).toEqual([DAY, "habits.yaml", PAGES]);
    expect(await readPages(fs, DATE)).toBe("Three words here.");
  });

  it("makes the day file when there is none, holding the date and the count", async () => {
    const fs = folder();
    await savePages(fs, DATE, "one two", at(""), pages);
    expect(fs.files.get(DAY)).toBe("---\ndate: 2026-11-17\nmorning_pages_words: 2\n_sources:\n  morning_pages_words: morning_pages\n---\n");
  });

  it("writes the text exactly as typed: no line added at the end, none taken away", async () => {
    for (const text of ["no newline", "one newline\n", "two\n\n", "  leading and trailing  ", "\n\nblank lines first", "---\nlooks: like frontmatter\n---\n"]) {
      const fs = folder();
      await savePages(fs, DATE, text, at(""), pages);
      expect(fs.files.get(PAGES)).toBe(text);
      expect(await readPages(fs, DATE)).toBe(text);
    }
  });

  it("writes nothing for pages that were only looked at, and makes no file for pages never written", async () => {
    const fs = folder();
    expect(await savePages(fs, DATE, "", at(""), pages)).toEqual({ words: 0, count: "kept" });
    expect(fs.written).toEqual([]);
    expect([...fs.files.keys()]).toEqual([]);

    const kept = folder({ [PAGES]: "Already here.\n", [DAY]: "---\nmood: 3\n---\n" });
    // Looked at and left: the room does not even ask for a save. If it did, the text would not be written again.
    await savePages(kept, DATE, "Already here.\n", at("Already here.\n"), pages);
    expect(kept.written).toEqual([DAY]);
    await savePages(kept, DATE, "Already here.\n", at("Already here.\n"), pages);
    expect(kept.written).toEqual([DAY]);
  });

  it("only ever writes over the text it was typed from", async () => {
    const fs = folder({ [PAGES]: "Written this morning.", [DAY]: "---\nmood: 3\n---\n" });
    // The room opened on the morning's text; something else has added to the file since.
    fs.files.set(PAGES, "Written this morning. And a line from another app.");
    const refused = await savePages(fs, DATE, "Written this morning. Typed in the room.", at("Written this morning."), pages).catch((e) => e);
    expect(refused).toBeInstanceOf(PagesChangedError);
    expect(fs.written).toEqual([]);
    expect(fs.files.get(PAGES)).toBe("Written this morning. And a line from another app.");
    expect(fs.files.get(DAY)).toBe("---\nmood: 3\n---\n");
    // A file that has appeared, or gone, since the room opened is a change too.
    const appeared = folder({ [PAGES]: "Made elsewhere." });
    expect(await savePages(appeared, DATE, "Typed.", at(""), pages).catch((e) => e)).toBeInstanceOf(PagesChangedError);
    const gone = folder();
    expect(await savePages(gone, DATE, "Typed more.", at("Typed."), pages).catch((e) => e)).toBeInstanceOf(PagesChangedError);
    expect(gone.written).toEqual([]);
    // Once the room has taken the file's text as what it is typing over, the save goes through.
    await savePages(fs, DATE, "Both.", at("Written this morning. And a line from another app."), pages);
    expect(fs.files.get(PAGES)).toBe("Both.");
  });

  it("saves the text and leaves a count that was set by hand", async () => {
    const manual = "---\ndate: 2026-11-17\nmorning_pages_words: 750\n_sources:\n  morning_pages_words: manual\n---\n";
    const fs = folder({ [DAY]: manual });
    expect(await savePages(fs, DATE, "Only four words here", at(""), pages)).toEqual({ words: 4, count: "by_hand" });
    expect(fs.files.get(PAGES)).toBe("Only four words here");
    expect(fs.files.get(DAY)).toBe(manual);
    expect(fs.written).toEqual([PAGES]);

    const unrecorded = folder({ [DAY]: "---\nmorning_pages_words: 420\n---\n" });
    expect((await savePages(unrecorded, DATE, "two words", at(""), pages)).count).toBe("by_hand");
    expect(unrecorded.files.get(DAY)).toBe("---\nmorning_pages_words: 420\n---\n");
  });

  it("follows the text as it grows and shrinks, and takes the count out when the text is emptied", async () => {
    const fs = folder({ [DAY]: "---\ndate: 2026-11-17\nmood: 3\n---\n" });
    await savePages(fs, DATE, words(10), at(""), pages);
    await savePages(fs, DATE, words(760), at(words(10)), pages);
    expect(parseDay(fs.files.get(DAY)!, DATE).values.morning_pages_words).toBe(760);
    await savePages(fs, DATE, words(5), at(words(760)), pages);
    expect(parseDay(fs.files.get(DAY)!, DATE).values.morning_pages_words).toBe(5);
    expect(await savePages(fs, DATE, "", at(words(5)), pages)).toEqual({ words: 0, count: "kept" });
    expect(fs.files.get(PAGES)).toBe("");
    expect(fs.files.get(DAY)).toBe("---\ndate: 2026-11-17\nmood: 3\n_sources:\n---\n");
    // Only white space is no words either.
    await savePages(fs, DATE, "  \n ", at(""), pages);
    expect(fs.files.get(PAGES)).toBe("  \n ");
    expect(parseDay(fs.files.get(DAY)!, DATE).values).toEqual({ mood: 3 });
  });

  it("keeps the file's line endings and byte order mark, and shows the text without them", async () => {
    const fs = folder({ [PAGES]: "\uFEFFline one\r\nline two\r\n" });
    expect(await readPages(fs, DATE)).toBe("line one\nline two\n");
    // Looked at and left: not rewritten, though what is shown is not byte for byte what is on disk.
    await savePages(fs, DATE, "line one\nline two\n", at("line one\nline two\n"), null);
    expect(fs.written).toEqual([]);
    await savePages(fs, DATE, "line one\nline two\nline three\n", at("line one\nline two\n"), null);
    expect(fs.files.get(PAGES)).toBe("\uFEFFline one\r\nline two\r\nline three\r\n");
    // Emptied, the file is empty: not a byte order mark with nothing behind it.
    await savePages(fs, DATE, "", at("line one\nline two\nline three\n"), null);
    expect(fs.files.get(PAGES)).toBe("");
  });

  it("keeps the text even when there is no habit to count it for", async () => {
    const fs = folder();
    expect(await savePages(fs, DATE, "some words", at(""), null)).toEqual({ words: 2, count: "no_habit" });
    expect([...fs.files.keys()]).toEqual([PAGES]);
  });

  it("says so when the text is saved and the count can't be", async () => {
    const broken = "---\nmood: 1\nmood: 2\n---\n";
    const fs = folder({ [DAY]: broken });
    const failed = await savePages(fs, DATE, "The text is safe.", at(""), pages).catch((e) => e);
    expect(failed).toBeInstanceOf(PagesCountError);
    expect(failed.message).toBe("The word count could not be written to days/2026-11-17.md. Frontmatter: Invalid YAML: Map keys must be unique (line 3).");
    expect(fs.files.get(PAGES)).toBe("The text is safe.");
    expect(fs.files.get(DAY)).toBe(broken);
    // The next save has no text to write and tries the count again.
    fs.files.set(DAY, "---\nmood: 1\n---\n");
    expect(await savePages(fs, DATE, "The text is safe.", at("The text is safe."), pages)).toEqual({ words: 4, count: "kept" });
    expect(parseDay(fs.files.get(DAY)!, DATE).values.morning_pages_words).toBe(4);
  });

  it("takes its turn with other changes to the day file", async () => {
    const fs = folder({ [DAY]: "---\ndate: 2026-11-17\n---\n" });
    await Promise.all([
      writeDay(fs, DATE, { values: { mood: 4 }, sources: { mood: "manual" } }),
      savePages(fs, DATE, "a b c", at(""), pages),
      writeDay(fs, DATE, { notes: "Day notes." }),
    ]);
    const saved = parseDay(fs.files.get(DAY)!, DATE);
    expect(saved.values).toEqual({ mood: 4, morning_pages_words: 3 });
    expect(saved.sources).toEqual({ mood: "manual", morning_pages_words: "morning_pages" });
    expect(saved.notes).toBe("Day notes.");
  });

  it("saves asked for while one is on its way land one after another, each over the last", async () => {
    const fs = folder();
    // One room, one notion of what the file holds. Three saves asked for at once, as on a slow disk.
    const base = { text: "" };
    const first = savePages(fs, DATE, "one", base, pages);
    const second = savePages(fs, DATE, "one two", base, pages);
    const third = savePages(fs, DATE, "one two three", base, pages);
    expect(base.text).toBe("");
    expect(await Promise.all([first, second, third])).toEqual([
      { words: 1, count: "kept" },
      { words: 2, count: "kept" },
      { words: 3, count: "kept" },
    ]);
    expect(fs.files.get(PAGES)).toBe("one two three");
    expect(base.text).toBe("one two three");
    expect(parseDay(fs.files.get(DAY)!, DATE).values.morning_pages_words).toBe(3);
    expect(fs.written.filter((path) => path === PAGES).length).toBe(3);
  });

  it("a save that fails leaves what the file is known to hold as it was, so the next one is not taken for an outside change", async () => {
    const fs = folder({ [PAGES]: "kept" });
    const write = fs.write.bind(fs);
    let full = true;
    fs.write = async (path, text) => {
      if (full && path === PAGES) throw new Error("No space left on device (os error 28)");
      await write(path, text);
    };
    const base = { text: "kept" };
    const failed = savePages(fs, DATE, "kept, and more", base, pages).catch((e) => e);
    const next = savePages(fs, DATE, "kept, and more still", base, pages).catch((e) => e);
    expect((await failed).message).toBe("No space left on device (os error 28)");
    // The second is behind the first on the same full disk, and fails the same way: not as a change made elsewhere.
    expect((await next).message).toBe("No space left on device (os error 28)");
    expect(base.text).toBe("kept");
    expect(fs.files.get(PAGES)).toBe("kept");
    full = false;
    expect(await savePages(fs, DATE, "kept, and more still", base, pages)).toEqual({ words: 4, count: "kept" });
    expect(base.text).toBe("kept, and more still");
  });

  it("a save refused for a change made elsewhere does not move what the file is known to hold", async () => {
    const fs = folder({ [PAGES]: "theirs" });
    const base = { text: "mine" };
    await savePages(fs, DATE, "mine, and more", base, pages).catch(() => {});
    expect(base.text).toBe("mine");
    // And text that is already what the file holds is known to be there without being written.
    const same = { text: "theirs" };
    await savePages(fs, DATE, "theirs", same, null);
    expect(same.text).toBe("theirs");
    expect(fs.written).toEqual([]);
  });
});

describe("what an error about pages says", () => {
  const SECRET = "the marmalade phrase nobody else should read";
  /** Everything an error carries that could be shown, logged or sent anywhere. */
  const everything = (error: Error) => [error.message, error.name, error.stack ?? "", JSON.stringify(error), JSON.stringify(Object.getOwnPropertyNames(error).map((name) => (error as never)[name]))].join("\n");

  it("names the file and never quotes it", async () => {
    const changed = folder({ [PAGES]: `${SECRET} on disk` });
    const refused: Error = await savePages(changed, DATE, `${SECRET} typed`, at(`${SECRET} at first`), pages).catch((e) => e);
    expect(refused.message).toBe("pages/2026-11-17.md was changed outside the app");
    expect(everything(refused)).not.toContain("marmalade");

    const full: DataFs = { ...folder(), write: async () => Promise.reject("No space left on device (os error 28)") };
    const unsaved = await savePages(full, DATE, SECRET, at(""), pages).catch((e) => e);
    expect(String(unsaved)).toBe("No space left on device (os error 28)");

    const broken = folder({ [DAY]: "---\nmood: [\n---\n" });
    const uncounted: Error = await savePages(broken, DATE, SECRET, at(""), pages).catch((e) => e);
    expect(uncounted).toBeInstanceOf(PagesCountError);
    expect(everything(uncounted)).not.toContain("marmalade");
    expect(uncounted.message).toContain("days/2026-11-17.md");
  });

  it("is filed under a key that holds the date and nothing of the text", () => {
    expect(pagesNoticeKey(DATE)).toBe("pages:2026-11-17");
    expect(pagesPath(DATE)).toBe(PAGES);
  });
});
