import { describe, expect, it } from "vitest";
import {
  cellPatch, cellSource, cellState, cellValue, DayFileError, dayTags, describeCell, habitHint, loadMonth, memoryFs, monthCount,
  parseCellInput, parseDay, parseHabits, shortNumber, withPatch, writeCell, type Day, type Habit,
} from "../src/data";

const TODAY = "2026-11-17";
const PAST = "2026-11-10";
const FUTURE = "2026-11-20";

const habits = parseHabits(`habits:
  - { id: weight, type: number, unit: lb }
  - { id: run, type: check, source: intervals }
  - { id: sleep, type: number, unit: h, source: intervals }
  - { id: morning_pages, type: progress, unit: words, goal: 750, source: morning_pages }
  - { id: meditate, type: check }
  - { id: mood, type: scale }
  - { id: stretch, type: duration, unit: min }
  - { id: travel, type: tag }
  - { id: temp, type: number, unit: f, source: weather }
  - { id: pages_free, type: progress, unit: words }
`);
const habit = (id: string): Habit => habits.find((h) => h.id === id)!;
const day = (date: string, frontmatter = ""): Day => parseDay(`---\ndate: ${date}\n${frontmatter}---\n`, date);
const state = (id: string, date: string, frontmatter = "") => cellState(habit(id), day(date, frontmatter), TODAY);

describe("where a cell's value lives", () => {
  it("reads the key with the unit suffix, and tags from the tags list", () => {
    const d = day(PAST, "weight_lb: 171.2\nrun: true\nstretch_min: 15\ntags: [travel, sick]\nweight: 1\ntravel: true\n");
    expect(cellValue(habit("weight"), d)).toBe(171.2);
    expect(cellValue(habit("run"), d)).toBe(true);
    expect(cellValue(habit("stretch"), d)).toBe(15);
    expect(cellValue(habit("travel"), d)).toBe(true);
    expect(cellValue(habit("travel"), day(PAST, "travel: true\n"))).toBeNull();
    expect(dayTags(d)).toEqual(["travel", "sick"]);
  });

  it("reads tags written as a block list or a single word", () => {
    expect(dayTags(day(PAST, "tags:\n  - travel\n  - sick\n"))).toEqual(["travel", "sick"]);
    expect(dayTags(day(PAST, "tags: travel\n"))).toEqual(["travel"]);
    expect(dayTags(day(PAST, "tags:\n"))).toEqual([]);
    expect(dayTags(day(PAST))).toEqual([]);
    expect(dayTags(day(PAST, "tags: {a: 1}\n"))).toEqual([]);
  });

  it.each([
    ["check", "run", "true", true],
    ["check false", "run", "false", null],
    ["check null", "run", "null", null],
    ["check text", "run", "yes", null],
    ["check number", "run", "1", null],
    ["number", "weight", "171.2", 171.2],
    ["number zero", "weight", "0", 0],
    ["number negative", "temp", "-4.5", -4.5],
    ["number as text", "weight", '"171"', null],
    ["number null", "weight", "null", null],
    ["number not finite", "weight", ".inf", null],
    ["number nan", "weight", ".nan", null],
    ["scale", "mood", "4", 4],
    ["duration", "stretch", "15", 15],
    ["duration zero", "stretch", "0", 0],
    ["progress", "morning_pages", "300", 300],
    ["progress zero", "morning_pages", "0", null],
    ["progress negative", "morning_pages", "-5", null],
    ["a list where a number goes", "weight", "[1]", null],
  ])("has a value, by type: %s", (_name, id, yaml, expected) => {
    const h = habit(id);
    const key = h.unit ? `${h.id}_${h.unit}` : h.id;
    expect(cellValue(h, day(PAST, `${key}: ${yaml}\n`))).toBe(expected);
  });
});

describe("cell state (SPEC 5.3)", () => {
  it("a value is done on any day, past, today or future", () => {
    for (const date of [PAST, TODAY, FUTURE]) {
      expect(state("run", date, "run: true\n")).toEqual({ state: "done", value: true, met: true });
      expect(state("weight", date, "weight_lb: 171.2\n")).toEqual({ state: "done", value: 171.2, met: true });
      expect(state("travel", date, "tags: [travel]\n")).toEqual({ state: "done", value: true, met: true });
    }
  });

  it("no value after today is future, and today is pending, whatever the source", () => {
    for (const id of ["run", "weight", "sleep", "morning_pages", "travel", "mood", "temp"]) {
      expect(state(id, FUTURE).state).toBe("future");
      expect(state(id, "2026-12-01").state).toBe("future");
      expect(state(id, "2027-01-01").state).toBe("future");
      expect(state(id, TODAY).state).toBe("pending");
    }
    expect(state("run", FUTURE, "run: false\n").state).toBe("future");
    expect(state("run", TODAY, "run: false\n").state).toBe("pending");
  });

  it("a past day with no value is missed for a manual habit and no_data for a synced one", () => {
    expect(state("weight", PAST)).toEqual({ state: "missed", value: null, met: false });
    expect(state("meditate", PAST).state).toBe("missed");
    expect(state("mood", PAST).state).toBe("missed");
    expect(state("travel", PAST).state).toBe("missed");
    expect(state("run", PAST)).toEqual({ state: "no_data", value: null, met: false });
    expect(state("sleep", PAST).state).toBe("no_data");
    expect(state("temp", PAST).state).toBe("no_data");
    expect(state("run", "2026-10-31").state).toBe("no_data");
    expect(state("run", "2025-12-31").state).toBe("no_data");
    expect(state("run", "2026-11-16").state).toBe("no_data");
  });

  it("a night with no sleep data is no_data even when the day has a run", () => {
    expect(state("sleep", PAST, "run: true\n_sources:\n  run: intervals\n").state).toBe("no_data");
    expect(state("sleep", PAST, "run: true\nsleep_h: null\n_sources:\n  run: intervals\n").state).toBe("no_data");
  });

  it("the recorded source wins over the habit's: a synced cell cleared by hand is missed", () => {
    const cleared = "sleep_h: null\n_sources:\n  sleep_h: manual\n";
    expect(cellSource(habit("sleep"), day(PAST, cleared))).toBe("manual");
    expect(state("sleep", PAST, cleared).state).toBe("missed");
    expect(state("run", PAST, "run: null\n_sources:\n  run: manual\n").state).toBe("missed");
    // And the other way round: a manual habit whose value a source once wrote.
    expect(state("weight", PAST, "weight_lb: null\n_sources:\n  weight_lb: intervals\n").state).toBe("no_data");
    expect(state("temp", PAST, "temp_f: null\n_sources:\n  temp_f: open-meteo\n").state).toBe("no_data");
    expect(cellSource(habit("sleep"), day(PAST))).toBe("intervals");
    // The source recorded under another key doesn't count.
    expect(state("sleep", PAST, "_sources:\n  sleep: manual\n  run: manual\n").state).toBe("no_data");
  });

  it("morning pages count as manual: an empty past day is a miss", () => {
    expect(state("morning_pages", PAST).state).toBe("missed");
    expect(state("morning_pages", PAST, "morning_pages_words: 0\n").state).toBe("missed");
  });

  it("an explicit false on a check habit is an empty box, never no_data", () => {
    expect(state("run", PAST, "run: false\n")).toEqual({ state: "missed", value: null, met: false });
    expect(state("run", PAST, "run: false\n_sources:\n  run: intervals\n").state).toBe("missed");
    expect(state("meditate", PAST, "meditate: false\n").state).toBe("missed");
    // Only a real false: other types don't get this treatment.
    expect(state("sleep", PAST, "sleep_h: false\n").state).toBe("no_data");
  });

  it("progress carries how far along it is and is only met at or past the goal", () => {
    expect(state("morning_pages", PAST, "morning_pages_words: 300\n")).toEqual({ state: "done", value: 300, met: false, fraction: 0.4 });
    expect(state("morning_pages", PAST, "morning_pages_words: 749\n").met).toBe(false);
    expect(state("morning_pages", PAST, "morning_pages_words: 750\n")).toEqual({ state: "done", value: 750, met: true, fraction: 1 });
    expect(state("morning_pages", TODAY, "morning_pages_words: 812\n")).toEqual({ state: "done", value: 812, met: true, fraction: 1 });
    // No goal: any amount above 0 counts.
    expect(state("pages_free", PAST, "pages_free_words: 5\n")).toEqual({ state: "done", value: 5, met: true, fraction: 1 });
  });

  it("a day file that is missing altogether behaves like an empty one", () => {
    const missing = parseDay(null, PAST);
    expect(cellState(habit("run"), missing, TODAY).state).toBe("no_data");
    expect(cellState(habit("weight"), missing, TODAY).state).toBe("missed");
    expect(cellState(habit("weight"), parseDay(null, TODAY), TODAY).state).toBe("pending");
  });
});

describe("monthly count", () => {
  const november = { year: 2026, month: 11 };
  const days = [
    day("2026-11-01", "run: true\nweight_lb: 171\nmood: 3\nstretch_min: 10\nmorning_pages_words: 812\ntags: [travel]\npages_free_words: 1\n"),
    day("2026-11-02", "run: false\nweight_lb: null\nmood: 5\nstretch_min: 0\nmorning_pages_words: 749\ntags: [sick]\npages_free_words: 0\n"),
    day("2026-11-03", "run: true\nmorning_pages_words: 750\ntags: [sick, travel]\n"),
    day("2026-11-04"),
    day("2026-11-29", "run: true\nweight_lb: 170.5\n"),
  ];
  const count = (id: string) => monthCount(habit(id), days, november);

  it("counts by type, out of the days in the month", () => {
    expect(count("run")).toEqual({ done: 3, total: 30 });
    expect(count("weight")).toEqual({ done: 2, total: 30 });
    expect(count("mood")).toEqual({ done: 2, total: 30 });
    expect(count("stretch")).toEqual({ done: 2, total: 30 });
    expect(count("morning_pages")).toEqual({ done: 2, total: 30 });
    expect(count("pages_free")).toEqual({ done: 1, total: 30 });
    expect(count("travel")).toEqual({ done: 2, total: 30 });
    expect(count("meditate")).toEqual({ done: 0, total: 30 });
  });

  it("uses the month's own length", () => {
    expect(monthCount(habit("run"), [], { year: 2027, month: 2 })).toEqual({ done: 0, total: 28 });
    expect(monthCount(habit("run"), [], { year: 2028, month: 2 })).toEqual({ done: 0, total: 29 });
    expect(monthCount(habit("run"), [], { year: 2026, month: 12 })).toEqual({ done: 0, total: 31 });
  });
});

describe("parsing what was typed into a cell", () => {
  it.each([
    ["number", "171.2", 171.2], ["number", " 171 ", 171], ["number", "-4.5", -4.5], ["number", ".5", 0.5], ["number", "0", 0],
    ["scale", "1", 1], ["scale", "5", 5], ["scale", " 3 ", 3],
    ["duration", "45", 45], ["duration", "0", 0], ["progress", "812", 812], ["progress", "0", 0], ["progress", "+5", 5],
  ] as const)("%s accepts %s", (type, text, value) => {
    expect(parseCellInput(type, text)).toEqual({ ok: true, value });
  });

  it.each([
    ["number", "abc"], ["number", "1e3"], ["number", "Infinity"], ["number", "NaN"], ["number", "171,2"], ["number", "0x10"],
    ["number", "1 2"], ["number", "--1"], ["number", "."],
    ["scale", "0"], ["scale", "6"], ["scale", "3.5"], ["scale", "-1"], ["scale", "three"], ["scale", "33"],
    ["duration", "7.5"], ["duration", "-5"], ["duration", "1e2"], ["duration", "ten"], ["duration", "99999999999999999999"],
    ["progress", "300.5"], ["progress", "-1"], ["progress", "lots"],
    ["check", "true"], ["check", "1"], ["tag", "travel"],
  ] as const)("%s rejects %s", (type, text) => {
    expect(parseCellInput(type, text)).toEqual({ ok: false });
  });

  it("caps what can be typed at six digits, either side of zero (review N-4)", () => {
    expect(parseCellInput("number", "999999")).toEqual({ ok: true, value: 999999 });
    expect(parseCellInput("number", "-999999")).toEqual({ ok: true, value: -999999 });
    expect(parseCellInput("number", "999999.5")).toEqual({ ok: false });
    expect(parseCellInput("number", "1000000")).toEqual({ ok: false });
    expect(parseCellInput("number", "-1000000")).toEqual({ ok: false });
    expect(parseCellInput("number", "99999999999999999999")).toEqual({ ok: false });
    expect(parseCellInput("number", "9".repeat(400))).toEqual({ ok: false });
    expect(parseCellInput("duration", "999999")).toEqual({ ok: true, value: 999999 });
    expect(parseCellInput("duration", "1000000")).toEqual({ ok: false });
    expect(parseCellInput("progress", "1000000")).toEqual({ ok: false });
  });

  it("an empty field clears the cell, for the types that are typed", () => {
    for (const type of ["number", "scale", "duration", "progress"] as const) {
      expect(parseCellInput(type, "")).toEqual({ ok: true, value: null });
      expect(parseCellInput(type, "   ")).toEqual({ ok: true, value: null });
    }
  });
});

describe("writing a cell", () => {
  const FILE = "days/2026-11-17.md";
  const BASE = [
    "---",
    "date: 2026-11-17",
    "run: true",
    "sleep_h: 7.7 # watch",
    "# a comment Brian left by hand",
    "caffeine_mg: 180",
    "big: 12345678901234567890",
    "tags: [sick] # why",
    "_sources:",
    "  run: intervals",
    "  sleep_h: intervals",
    "_synced_at: 2026-11-17T06:30:00-08:00",
    "---",
    "",
    "Felt foggy until ~11am.  ",
    "",
  ].join("\n");
  const write = async (id: string, value: boolean | number | null, raw: string | null = BASE) => {
    const fs = memoryFs(raw === null ? {} : { [FILE]: raw });
    const saved = await writeCell(fs, habit(id), TODAY, value);
    return { text: fs.files.get(FILE)!, saved };
  };
  /** BASE with `line` put in before `_sources`, and `source` added to the end of `_sources`. */
  const withLine = (line: string, source: string) =>
    BASE.replace("_sources:\n", `${line}\n_sources:\n`).replace("_synced_at", `  ${source}: manual\n_synced_at`);

  it("ticks a check habit and records it as manual, touching nothing else", async () => {
    const { text, saved } = await write("meditate", true);
    expect(text).toBe(withLine("meditate: true", "meditate"));
    expect(saved.values.meditate).toBe(true);
    expect(saved.sources.meditate).toBe("manual");
  });

  it("un-ticking a check writes false, and takes over a synced value's source", async () => {
    const { text } = await write("run", false);
    expect(text).toBe(BASE.replace("run: true", "run: false").replace("run: intervals", "run: manual"));
    expect(cellState(habit("run"), parseDay(text, PAST), TODAY).state).toBe("missed");
  });

  it("writes a number, a scale, a duration and a progress value", async () => {
    expect((await write("weight", 171.4)).text).toBe(withLine("weight_lb: 171.4", "weight_lb"));
    expect((await write("mood", 4)).text).toBe(withLine("mood: 4", "mood"));
    expect((await write("stretch", 15)).text).toBe(withLine("stretch_min: 15", "stretch_min"));
    expect((await write("morning_pages", 400)).text).toBe(withLine("morning_pages_words: 400", "morning_pages_words"));
  });

  it("changing a synced number keeps the comment beside it", async () => {
    const { text } = await write("sleep", 6.5);
    expect(text).toBe(BASE.replace("sleep_h: 7.7 # watch", "sleep_h: 6.5 # watch").replace("sleep_h: intervals", "sleep_h: manual"));
  });

  it("clearing writes null, still as manual, so a synced cell becomes a miss", async () => {
    const { text } = await write("sleep", null);
    expect(text).toBe(BASE.replace("sleep_h: 7.7 # watch", "sleep_h: null # watch").replace("sleep_h: intervals", "sleep_h: manual"));
    expect(cellState(habit("sleep"), parseDay(text, PAST), TODAY).state).toBe("missed");
    expect((await write("weight", null)).text).toBe(withLine("weight_lb: null", "weight_lb"));
  });

  it("a tag habit adds its id to tags, keeps the others, and records no source", async () => {
    const { text, saved } = await write("travel", true);
    expect(text).toBe(BASE.replace("tags: [sick] # why", "tags: [sick, travel] # why"));
    expect(dayTags(saved)).toEqual(["sick", "travel"]);
    expect(saved.sources).toEqual({ run: "intervals", sleep_h: "intervals" });
  });

  it("a tag habit removes only its own id", async () => {
    const on = BASE.replace("tags: [sick] # why", "tags: [travel, sick, travel] # why");
    expect((await write("travel", false, on)).text).toBe(BASE);
    expect((await write("travel", false)).text).toBe(BASE);
    expect((await write("travel", true, on)).text).toBe(on);
  });

  it("a tag habit works with tags written as a block list, a single word, empty, or missing", async () => {
    const block = BASE.replace("tags: [sick] # why", "tags:\n  - sick # why\n  - home");
    expect((await write("travel", true, block)).text).toBe(block.replace("  - home", "  - home\n  - travel"));
    expect((await write("travel", false, block.replace("  - home", "  - travel\n  - home"))).text).toBe(block);

    const word = BASE.replace("tags: [sick] # why", "tags: sick # why");
    expect((await write("travel", true, word)).text).toBe(BASE.replace("[sick]", "[sick, travel]"));
    expect((await write("travel", false, word)).text).toBe(word);

    const empty = BASE.replace("tags: [sick] # why", "tags: # why");
    expect((await write("travel", true, empty)).text).toBe(BASE.replace("[sick]", "[travel]"));

    const none = BASE.replace("tags: [sick] # why\n", "");
    expect((await write("travel", true, none)).text).toBe(none.replace("_sources:\n", "tags: [travel]\n_sources:\n"));
    expect((await write("travel", false, none)).text).toBe(none);
  });

  it("the last tag leaves an empty list", async () => {
    const only = BASE.replace("tags: [sick] # why", "tags: [travel] # why");
    const { text, saved } = await write("travel", false, only);
    expect(text).toBe(BASE.replace("[sick]", "[]"));
    expect(dayTags(saved)).toEqual([]);
  });

  it("tags stay tags: [..] through on, off and on again (review N-2)", async () => {
    const fs = memoryFs({ [FILE]: BASE.replace("tags: [sick] # why\n", "") });
    const line = () => fs.files.get(FILE)!.split("\n").filter((l) => l.startsWith("tags") || l.startsWith("  -"));
    await writeCell(fs, habit("travel"), TODAY, true);
    expect(line()).toEqual(["tags: [travel]"]);
    await writeCell(fs, habit("travel"), TODAY, false);
    expect(line()).toEqual(["tags: []"]);
    await writeCell(fs, habit("travel"), TODAY, true);
    expect(line()).toEqual(["tags: [travel]"]);
    await writeCell(fs, habit("travel"), TODAY, false);
    await writeCell(fs, habit("travel"), TODAY, true);
    expect(fs.files.get(FILE)).toBe(BASE.replace("tags: [sick] # why", "tags: [travel]"));
  });

  it("removing the last item of a list written over lines leaves tags: [], and the next add stays in brackets", async () => {
    const block = BASE.replace("tags: [sick] # why", "tags: # why\n  - travel");
    const off = await write("travel", false, block);
    expect(off.text).toBe(BASE.replace("tags: [sick] # why", "tags: [] # why"));
    expect((await write("travel", true, off.text)).text).toBe(BASE.replace("tags: [sick] # why", "tags: [travel] # why"));
    // A list with other items in it keeps its shape.
    const two = BASE.replace("tags: [sick] # why", "tags:\n  - sick # why\n  - travel");
    expect((await write("travel", false, two)).text).toBe(BASE.replace("tags: [sick] # why", "tags:\n  - sick # why"));
  });

  it("refuses a tags value that is a map, leaving the file as it was (review N-3)", async () => {
    const map = BASE.replace("tags: [sick] # why", "tags:\n  travel: true\n  note: keep me");
    const flowMap = BASE.replace("tags: [sick] # why", "tags: {travel: true, note: keep me}");
    for (const raw of [map, flowMap]) {
      const fs = memoryFs({ [FILE]: raw });
      await expect(writeCell(fs, habit("travel"), TODAY, true)).rejects.toThrow(DayFileError);
      await expect(writeCell(fs, habit("travel"), TODAY, false)).rejects.toThrow(/tags has to be a list/);
      expect(fs.files.get(FILE)).toBe(raw);
      // Everything else on that day can still be written.
      await writeCell(fs, habit("meditate"), TODAY, true);
      expect(fs.files.get(FILE)).toContain("meditate: true");
      expect(fs.files.get(FILE)).toContain("note: keep me");
    }
    expect(dayTags(parseDay(map, TODAY))).toEqual([]);
  });

  it("creates the day file when there isn't one", async () => {
    expect((await write("meditate", true, null)).text).toBe("---\ndate: 2026-11-17\nmeditate: true\n_sources:\n  meditate: manual\n---\n");
    expect((await write("travel", true, null)).text).toBe("---\ndate: 2026-11-17\ntags: [travel]\n---\n");
    expect((await write("weight", 171.2, null)).text).toBe("---\ndate: 2026-11-17\nweight_lb: 171.2\n_sources:\n  weight_lb: manual\n---\n");
  });

  it("refuses values that don't fit the habit's type, writing nothing", async () => {
    const fs = memoryFs({ [FILE]: BASE });
    const attempts: [string, boolean | number | null][] = [
      ["mood", 6], ["mood", 0], ["mood", 2.5], ["stretch", -1], ["stretch", 1.5], ["morning_pages", -3],
      ["weight", NaN], ["weight", Infinity], ["weight", true], ["run", 1], ["run", null], ["travel", null], ["travel", 1],
      ["weight", 1000000], ["weight", -1e21], ["stretch", 1000000], ["morning_pages", 1e9],
    ];
    for (const [id, value] of attempts) {
      await expect(writeCell(fs, habit(id), TODAY, value)).rejects.toThrow(RangeError);
    }
    expect(fs.files.get(FILE)).toBe(BASE);
  });

  it("the preview of a patch matches what gets written", async () => {
    const before = parseDay(BASE, TODAY);
    const cases: [string, boolean | number | null][] = [
      ["meditate", true], ["run", false], ["weight", 171.4], ["sleep", null], ["mood", 4], ["travel", true], ["stretch", 0],
    ];
    for (const [id, value] of cases) {
      const { saved } = await write(id, value);
      const preview = withPatch(before, cellPatch(habit(id), value));
      expect(preview.values).toEqual(saved.values);
      expect(preview.sources).toEqual(saved.sources);
      expect(preview.body).toBe(saved.body);
    }
    const untagged = withPatch(parseDay(BASE.replace("[sick]", "[sick, travel]"), TODAY), cellPatch(habit("travel"), false));
    expect(dayTags(untagged)).toEqual(["sick"]);
    // The original is not modified.
    expect(before.values).not.toHaveProperty("meditate");
    expect(dayTags(before)).toEqual(["sick"]);
  });
});

describe("loading a month", () => {
  it("returns every day of the month, reading only the files that exist", async () => {
    const fs = memoryFs({
      "days/2026-11-01.md": "---\ndate: 2026-11-01\nrun: true\n---\n\nnotes\n",
      "days/2026-11-30.md": "---\nmood: 2\n---\n",
      "days/2026-10-31.md": "---\nrun: true\n---\n",
      "days/2026-12-01.md": "---\nrun: true\n---\n",
      "days/notes.md": "not a day",
      "days/2026-11-02.txt": "not a day either",
      "habits.yaml": "",
    });
    const reads: string[] = [];
    const read = fs.read;
    fs.read = (path) => (reads.push(path), read(path));

    const month = await loadMonth(fs, { year: 2026, month: 11 });
    expect(Object.keys(month)).toHaveLength(30);
    expect(Object.keys(month)[0]).toBe("2026-11-01");
    expect(month["2026-11-01"].values).toEqual({ run: true });
    expect(month["2026-11-01"].notes).toBe("notes\n");
    expect(month["2026-11-30"].values).toEqual({ mood: 2 });
    expect(month["2026-11-15"]).toMatchObject({ date: "2026-11-15", values: {}, sources: {}, body: "", error: null });
    expect(reads.sort()).toEqual(["days/2026-11-01.md", "days/2026-11-30.md"]);
  });

  it("works when there is no days folder yet", async () => {
    const month = await loadMonth(memoryFs(), { year: 2027, month: 2 });
    expect(Object.keys(month)).toHaveLength(28);
    expect(Object.values(month).every((d) => Object.keys(d.values).length === 0)).toBe(true);
  });

  it("a day file that can't be read doesn't stop the month (review SF-3)", async () => {
    const fs = memoryFs({
      "days/2026-11-04.md": "---\nmood: 2\n---\n",
      "days/2026-11-05.md": "\uFFFD not text",
      "days/2026-11-06.md": "---\nmood: 3\n---\n",
      "days/2026-11-07.md": "also not text",
    });
    const read = fs.read;
    fs.read = async (path) => {
      if (path === "days/2026-11-05.md") throw "stream did not contain valid UTF-8";
      if (path === "days/2026-11-07.md") throw new Error("Permission denied (os error 13)");
      return read(path);
    };
    const month = await loadMonth(fs, { year: 2026, month: 11 });
    expect(Object.keys(month)).toHaveLength(30);
    expect(month["2026-11-04"].values).toEqual({ mood: 2 });
    expect(month["2026-11-06"].values).toEqual({ mood: 3 });
    expect(month["2026-11-05"]).toMatchObject({
      date: "2026-11-05", values: {}, sources: {}, body: "",
      error: "The file could not be read: stream did not contain valid UTF-8.",
    });
    expect(month["2026-11-07"].error).toBe("The file could not be read: Permission denied (os error 13).");
    // Nothing is written over a file that couldn't be read.
    await expect(writeCell(fs, habit("mood"), "2026-11-05", 4)).rejects.toBe("stream did not contain valid UTF-8");
    expect(fs.files.get("days/2026-11-05.md")).toBe("\uFFFD not text");
  });

  it("still fails when the folder itself can't be listed", async () => {
    const fs = memoryFs();
    fs.list = async () => {
      throw "Permission denied (os error 13)";
    };
    await expect(loadMonth(fs, { year: 2026, month: 11 })).rejects.toBe("Permission denied (os error 13)");
  });

  it("reports a day file that needs fixing without failing the month", async () => {
    const fs = memoryFs({ "days/2026-11-05.md": "---\nmood: 1\nmood: 2\n---\n", "days/2026-11-06.md": "---\nmood: 3\n---\n" });
    const month = await loadMonth(fs, { year: 2026, month: 11 });
    expect(month["2026-11-05"].error).toMatch(/unique/);
    expect(month["2026-11-05"].values).toEqual({});
    expect(month["2026-11-06"].values).toEqual({ mood: 3 });
  });
});

describe("showing a cell", () => {
  it("shortens numbers to fit a narrow cell", () => {
    const cases: [number, string][] = [
      [7.7, "7.7"], [171, "171"], [171.2, "171"], [171.25, "171"], [7.75, "7.75"], [17.75, "17.8"], [0, "0"], [812, "812"], [1034, "1034"],
      [12345, "12k"], [1234.5, "1235"], [-4.5, "-4.5"], [-12.5, "-12"], [-12.75, "-13"], [99999, "100k"], [2500000, "2.5M"], [0.125, "0.1"],
      [999999, "1M"], [-12345, "-12k"], [123456789, "123M"], [5e9, "5B"], [7.2e12, "7T"], [7.4e12, "7.4T"], [1.5e12, "1.5T"],
    ];
    for (const [value, text] of cases) expect(shortNumber(value)).toBe(text);
    expect(shortNumber(171.25, 6)).toBe("171.25");
  });

  it("never shows a number that is far from the real one, even when nothing honest fits (review N-4)", () => {
    // Too long for three characters: the shortest honest form, one character over.
    expect(shortNumber(100000, 3)).toBe("100k");
    expect(shortNumber(500000, 3)).toBe("500k");
    expect(shortNumber(1100, 3)).toBe("1100");
    expect(shortNumber(1500000, 3)).toBe("1.5M");
    // Close enough to round.
    expect(shortNumber(999999, 3)).toBe("1M");
    // A thousand thousands is a million at any width that can't hold the number itself (M3 review N-4).
    expect(shortNumber(999999, 5)).toBe("1M");
    expect(shortNumber(999999, 4)).toBe("1M");
    expect(shortNumber(999999, 6)).toBe("999999");
    expect(shortNumber(999499, 5)).toBe("999k");
    expect(shortNumber(-999999, 5)).toBe("-1M");
    expect(shortNumber(999999999, 5)).toBe("1B");
    expect(shortNumber(1049, 3)).toBe("1k");
    expect(shortNumber(172.4, 3)).toBe("172");
    // Far beyond anything a habit holds: still a number, not a row of zeros.
    expect(shortNumber(1e21, 3)).toBe("1e21");
    expect(shortNumber(1e21)).toBe("1e21");
    expect(shortNumber(99999999999999999999, 3)).toBe("1e20");
    expect(shortNumber(-3e15, 4)).toBe("-3e15");

    // Whatever the value and width, what is shown is within 5% of it or is its plain rounding.
    const read = (text: string) => {
      const [, number, unit] = /^(-?[\d.]+(?:e-?\d+)?)([kMBT]?)$/.exec(text)!;
      return Number(number) * { "": 1, k: 1e3, M: 1e6, B: 1e9, T: 1e12 }[unit]!;
    };
    for (const value of [0, 1, 9.99, 99.95, 999.5, 1234, 4999, 5000, 50000, 94999, 100000, 250000, 999999, 1e7, 123456789012, 1e15, 1e21, 1e-7, 0.04]) {
      for (const sign of [1, -1]) {
        for (const width of [3, 4, 5]) {
          const shown = read(shortNumber(sign * value, width));
          expect(Math.abs(shown - sign * value)).toBeLessThanOrEqual(Math.max(0.5, value * 0.05));
        }
      }
    }
  });

  it("describes a cell in words for its label, with the full value", () => {
    const say = (id: string, date: string, frontmatter = "") => describeCell(habit(id), state(id, date, frontmatter));
    expect(say("run", PAST, "run: true\n")).toBe("done");
    expect(say("travel", PAST, "tags: [travel]\n")).toBe("tagged");
    expect(say("weight", PAST, "weight_lb: 171.25\n")).toBe("171.25 lb");
    expect(say("mood", PAST, "mood: 4\n")).toBe("4 of 5");
    expect(say("stretch", PAST, "stretch_min: 15\n")).toBe("15 min");
    expect(say("morning_pages", PAST, "morning_pages_words: 300\n")).toBe("300 of 750 words");
    expect(say("morning_pages", PAST, "morning_pages_words: 812\n")).toBe("812 of 750 words, goal met");
    expect(say("pages_free", PAST, "pages_free_words: 5\n")).toBe("5 words");
    expect(say("weight", PAST)).toBe("empty");
    expect(say("run", PAST)).toBe("no data");
    expect(say("weight", TODAY)).toBe("not filled in yet");
    expect(say("weight", FUTURE)).toBe("not here yet");
  });

  it("gives each habit its small print", () => {
    expect(habits.map(habitHint)).toEqual(["lb", "", "h", "750 words", "", "1–5", "min", "", "f", "words"]);
  });
});
