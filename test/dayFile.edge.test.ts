/**
 * The failing inputs from the Milestone 1 review (B1, B2, S1, S2, S3, N1).
 * Each asserts the whole output, so any byte that moves outside the patched
 * entry fails the test.
 */
import { describe, expect, it } from "vitest";
import { DayFileError, memoryFs, parseDay, readDay, updateDayFile, writeDay } from "../src/data";

const DATE = "2026-11-17";
const mood4 = { values: { mood: 4 } };
/** Frontmatter with `mood: 1` among `lines`, patched to 4: nothing else may change. */
function expectOnlyMoodChanges(lines: string, eol = "\n") {
  const raw = `---${eol}date: 2026-11-17${eol}${lines}---${eol}body${eol}`;
  expect(raw).toContain("mood: 1");
  expect(updateDayFile(raw, DATE, mood4)).toBe(raw.replace("mood: 1", "mood: 4"));
}

describe("B1: byte order mark and near-miss frontmatter", () => {
  it("patches frontmatter behind a BOM and writes the BOM back", () => {
    const raw = "\uFEFF---\ndate: 2026-11-17\nmood: 1\n---\nbody\n";
    expect(updateDayFile(raw, DATE, mood4)).toBe("\uFEFF---\ndate: 2026-11-17\nmood: 4\n---\nbody\n");
    const day = parseDay(raw, DATE);
    expect(day.values).toEqual({ mood: 1 });
    expect(day.body).toBe("body\n");
    expect(day.error).toBeNull();
  });

  it("keeps the BOM first when adding frontmatter to a note that has none", () => {
    expect(updateDayFile("\uFEFFjust notes\n", DATE, mood4)).toBe("\uFEFF---\ndate: 2026-11-17\nmood: 4\n---\njust notes\n");
  });

  it.each([
    ["a blank line above the fence", "\n---\ndate: 2026-11-17\nmood: 1\n---\nbody\n"],
    ["several blank lines and spaces above the fence", "\n  \n---\ndate: 2026-11-17\n---\nbody\n"],
    ["a BOM and then a blank line", "\uFEFF\n---\ndate: 2026-11-17\n---\nbody\n"],
    ["---yaml as the opening line", "---yaml\nmood: 1\n---\nb\n"],
    ["CRLF with a blank line above", "\r\n---\r\nmood: 1\r\n---\r\nb\r\n"],
  ])("refuses to stack a second block on %s", (_name, raw) => {
    expect(() => updateDayFile(raw, DATE, mood4)).toThrow(DayFileError);
    const day = parseDay(raw, DATE);
    expect(day.error).toMatch(/first line/);
    expect(day.values).toEqual({});
  });

  it("refuses through writeDay too, leaving the file as it was", async () => {
    const raw = "\n---\ndate: 2026-11-17\nmood: 1\n---\nbody\n";
    const fs = memoryFs({ "days/2026-11-17.md": raw });
    await expect(writeDay(fs, DATE, mood4)).rejects.toThrow(DayFileError);
    expect(fs.files.get("days/2026-11-17.md")).toBe(raw);
  });

  it.each([
    ["--- on its own", "---\n"],
    ["--- with nothing closing it", "---\nsome text\nmore\n"],
    ["a rule lower down, never closed", "\n---\nsome text\n"],
    ["a longer rule", "----\ntext\n---\nmore\n"],
  ])("treats %s as body, and the result is stable", (_name, raw) => {
    const once = updateDayFile(raw, DATE, mood4);
    expect(once).toBe(`---\ndate: 2026-11-17\nmood: 4\n---\n${raw}`);
    expect(parseDay(once, DATE)).toMatchObject({ values: { mood: 4 }, body: raw, error: null });
    expect(updateDayFile(once, DATE, { values: { mood: 5 } })).toBe(once.replace("mood: 4", "mood: 5"));
  });
});

describe("B2: patching one key leaves every other byte alone", () => {
  it("a large integer keeps every digit", () => expectOnlyMoodChanges("big: 12345678901234567890\nmood: 1\n"));
  it("hex, octal, exponent and trailing-zero numbers keep their form", () =>
    expectOnlyMoodChanges("hex: 0x1F\noct: 0o17\nexp: 1e3\nf: 1.50\nmood: 1\n"));
  it("a folded string keeps its line breaks", () => expectOnlyMoodChanges("folded: >-\n  a\n  b\nmood: 1\nnote: |\n  line1\n  line2\n"));
  it("a list that isn't indented stays that way", () => expectOnlyMoodChanges("aliases:\n- x\nlist:\n  - a\n  - b\nmood: 1\n"));
  it("trailing spaces and blank lines stay", () => expectOnlyMoodChanges("\nmood: 1   \n\n"));
  it("no blank line appears before a closing comment", () => expectOnlyMoodChanges("mood: 1 # inline\n# end comment\n"));
  it("a tab inside a quoted string stays a tab", () => expectOnlyMoodChanges('note:\t"a\tb"\nmood: 1\n'));
  it("anchors, odd keys and YAML 1.1 words stay", () =>
    expectOnlyMoodChanges("base: &b {a: 1}\nother: *b\n'odd key': 1\n\"x: y\": 2\na: no\nb: yes\nc: ~\nd: on\nmood: 1\n"));
  it("Obsidian dates stay as written", () => expectOnlyMoodChanges("created: 2026-11-17T08:00\nupdated: 2026-11-17 08:00:00\nmood: 1\n"));

  it("adding a key inserts one line and changes nothing else", () => {
    const raw = "---\ndate: 2026-11-17\nbig: 12345678901234567890\nhex: 0x1F\nfolded: >-\n  a\n  b\naliases:\n- x\n\nnote:\t\"a\tb\"   \n# end comment\n---\nbody\n";
    expect(updateDayFile(raw, DATE, { values: { lift: true } })).toBe(raw.replace('"a\tb"   \n', '"a\tb"   \nlift: true\n'));
  });

  it("new value keys go before _sources and _synced_at", () => {
    const raw = "---\ndate: 2026-11-17\nrun: true\n_sources:\n  run: intervals\n_synced_at: 2026-11-17T06:30:00-08:00\n---\n";
    expect(updateDayFile(raw, DATE, { values: { mood: 4 }, sources: { mood: "manual" }, syncedAt: "2026-11-18T07:00:00-08:00" }))
      .toBe("---\ndate: 2026-11-17\nrun: true\nmood: 4\n_sources:\n  run: intervals\n  mood: manual\n_synced_at: 2026-11-18T07:00:00-08:00\n---\n");
  });

  it("puts _sources before _synced_at when it has to add it", () => {
    const raw = "---\ndate: 2026-11-17\n_synced_at: x\n---\n";
    expect(updateDayFile(raw, DATE, { values: { mood: 4 }, sources: { mood: "manual" } }))
      .toBe("---\ndate: 2026-11-17\nmood: 4\n_sources:\n  mood: manual\n_synced_at: x\n---\n");
  });

  it("removing a key removes its line only", () => {
    const raw = "---\ndate: 2026-11-17\nhex: 0x1F\nlift: false # typo\n\nmood: 1   \n---\nbody\n";
    expect(updateDayFile(raw, DATE, { values: { lift: undefined } })).toBe(raw.replace("lift: false # typo\n", ""));
  });

  it("adds a missing date first and keeps one that disagrees with the file name", () => {
    expect(updateDayFile("---\n# mine\nmood: 1\n---\n", DATE, {})).toBe("---\n# mine\ndate: 2026-11-17\nmood: 1\n---\n");
    expect(updateDayFile("---\n---\nbody\n", DATE, mood4)).toBe("---\ndate: 2026-11-17\nmood: 4\n---\nbody\n");
    const other = "---\ndate: 2026-11-18\n---\nb\n";
    expect(updateDayFile(other, DATE, {})).toBe(other);
    expect(parseDay(other, DATE).date).toBe(DATE);
  });

  it("works when the closing fence ends the file", () => {
    expect(updateDayFile("---\ndate: 2026-11-17\nmood: 1\n---", DATE, mood4)).toBe("---\ndate: 2026-11-17\nmood: 4\n---");
    expect(updateDayFile("---\ndate: 2026-11-17\n---", DATE, { body: "notes\n" })).toBe("---\ndate: 2026-11-17\n---\n\nnotes\n");
  });
});

describe("S1: CRLF frontmatter stays CRLF", () => {
  it("when a value changes", () => expectOnlyMoodChanges("# c\r\nx: 1\r\nmood: 1\r\n", "\r\n"));

  it("when keys and sources are added", () => {
    const raw = "---\r\ndate: 2026-11-17\r\nmood: 2\r\n---\r\nbody\r\n";
    expect(updateDayFile(raw, DATE, { values: { lift: true }, sources: { lift: "manual" } }))
      .toBe("---\r\ndate: 2026-11-17\r\nmood: 2\r\nlift: true\r\n_sources:\r\n  lift: manual\r\n---\r\nbody\r\n");
  });

  it("when frontmatter is added to a CRLF note", () => {
    expect(updateDayFile("line one\r\nline two\r\n", DATE, mood4))
      .toBe("---\r\ndate: 2026-11-17\r\nmood: 4\r\n---\r\nline one\r\nline two\r\n");
  });
});

describe("S2: an unusable _sources is replaced, and nothing else", () => {
  it.each([
    ["empty", "_sources:\n", "_sources:\n  mood: manual\n"],
    ["plain text", "_sources: oops\n", "_sources:\n  mood: manual\n"],
    ["a block list", "_sources:\n  - a\n  - b\n", "_sources:\n  mood: manual\n"],
    ["a flow list (it stays flow style)", "_sources: [a, b]\n", "_sources: {mood: manual}\n"],
  ])("%s", (_name, line, replaced) => {
    const raw = `---\ndate: 2026-11-17\nhex: 0x1F # keep\n${line}_synced_at: x\n---\nb\n`;
    const next = updateDayFile(raw, DATE, { sources: { mood: "manual" } });
    expect(next).toBe(raw.replace(line, replaced));
    expect(parseDay(next, DATE).sources).toEqual({ mood: "manual" });
  });

  it("reads an unusable _sources as no sources", () => {
    expect(parseDay("---\n_sources: oops\n---\n", DATE)).toMatchObject({ sources: {}, error: null });
    expect(parseDay("---\n_sources:\n  run: intervals\n  odd: 5\n---\n", DATE).sources).toEqual({ run: "intervals" });
  });

  it("keeps a flow-style _sources in flow style", () => {
    const raw = "---\ndate: 2026-11-17\n_sources: {run: intervals}\n---\nb\n";
    expect(updateDayFile(raw, DATE, { sources: { mood: "manual" } })).toBe(raw.replace("{run: intervals}", "{run: intervals, mood: manual}"));
  });

  it("removing a source that isn't there changes nothing", () => {
    const raw = "---\ndate: 2026-11-17\n_sources: oops\n---\nb\n";
    expect(updateDayFile(raw, DATE, { sources: { mood: undefined } })).toBe(raw);
  });
});

describe("S3: the body round trip", () => {
  it.each([
    ["no blank line after the fence", "---\ndate: 2026-11-17\n---\nnotes\n"],
    ["a blank line after the fence", "---\ndate: 2026-11-17\n---\n\nnotes\n"],
    ["two blank lines", "---\ndate: 2026-11-17\n---\n\n\nnotes\n"],
    ["CRLF", "---\r\ndate: 2026-11-17\r\n---\r\n\r\nnotes\r\nmore\r\n"],
    ["no body", "---\ndate: 2026-11-17\n---\n"],
    ["no frontmatter", "notes\n"],
  ])("writing back the body or notes that were read reproduces the file: %s", (_name, raw) => {
    const day = parseDay(raw, DATE);
    const withDate = updateDayFile(raw, DATE, {});
    expect(updateDayFile(raw, DATE, { body: day.body })).toBe(withDate);
    expect(updateDayFile(raw, DATE, { notes: day.notes })).toBe(withDate);
    if (raw.startsWith("---")) expect(withDate).toBe(raw);
  });

  it("notes are the body without its one leading blank line, with \\n line endings", () => {
    expect(parseDay("---\ndate: 2026-11-17\n---\n\nnotes\n", DATE).notes).toBe("notes\n");
    expect(parseDay("---\ndate: 2026-11-17\n---\n\n\nnotes\n", DATE).notes).toBe("\nnotes\n");
    expect(parseDay("---\ndate: 2026-11-17\n---\nnotes\n", DATE).notes).toBe("notes\n");
    expect(parseDay("---\r\ndate: 2026-11-17\r\n---\r\n\r\na\r\nb\r\n", DATE).notes).toBe("a\nb\n");
    expect(parseDay(null, DATE)).toMatchObject({ body: "", notes: "", values: {}, error: null });
  });

  it("edited notes get the blank line back, in the file's line endings", () => {
    expect(updateDayFile("---\ndate: 2026-11-17\n---\n\nold\n", DATE, { notes: "new\n" })).toBe("---\ndate: 2026-11-17\n---\n\nnew\n");
    expect(updateDayFile("---\r\ndate: 2026-11-17\r\n---\r\n\r\nold\r\n", DATE, { notes: "new\nlines\n" }))
      .toBe("---\r\ndate: 2026-11-17\r\n---\r\n\r\nnew\r\nlines\r\n");
  });

  it("first notes get a blank line; notes in a file that had none don't gain one", () => {
    expect(updateDayFile("---\ndate: 2026-11-17\n---\n", DATE, { notes: "first\n" })).toBe("---\ndate: 2026-11-17\n---\n\nfirst\n");
    expect(updateDayFile(null, DATE, { notes: "first\n" })).toBe("---\ndate: 2026-11-17\n---\n\nfirst\n");
    expect(updateDayFile("---\ndate: 2026-11-17\n---\nold\n", DATE, { notes: "new\n" })).toBe("---\ndate: 2026-11-17\n---\nnew\n");
  });

  it("emptied notes leave no body", () => {
    expect(updateDayFile("---\ndate: 2026-11-17\n---\n\nold\n", DATE, { notes: "" })).toBe("---\ndate: 2026-11-17\n---\n");
    expect(updateDayFile("---\ndate: 2026-11-17\n---\nold\n", DATE, { body: "" })).toBe("---\ndate: 2026-11-17\n---\n");
  });

  it("won't take body and notes in one patch", () => {
    expect(() => updateDayFile(null, DATE, { body: "a", notes: "a" })).toThrow(TypeError);
  });
});

describe("N1: a file that can't be written isn't quietly read", () => {
  it.each([
    ["duplicate keys", "---\ndate: 2026-11-17\nmood: 1\nmood: 2\n---\nbody\n", /Map keys must be unique \(line 4\)/],
    ["an unclosed list", "---\ndate: 2026-11-17\nfoo: [unclosed\n---\nbody\n", /Invalid YAML/],
    ["tab indentation", "---\ndate: 2026-11-17\nx:\n\ty: 1\n---\nbody\n", /Invalid YAML/],
    ["frontmatter that is a list", "---\n- a\n- b\n---\nbody\n", /key: value/],
    ["frontmatter that is plain text", "---\nhr\n---\nmore\n", /key: value/],
  ])("%s: parseDay reports it and returns no values; writes throw", async (_name, raw, message) => {
    const day = parseDay(raw, DATE);
    expect(day.error).toMatch(message);
    expect(day.values).toEqual({});
    expect(day.sources).toEqual({});
    expect(() => updateDayFile(raw, DATE, mood4)).toThrow(DayFileError);
    expect(() => updateDayFile(raw, DATE, {})).toThrow(DayFileError);

    const fs = memoryFs({ "days/2026-11-17.md": raw });
    expect((await readDay(fs, DATE)).error).toMatch(message);
    await expect(writeDay(fs, DATE, mood4)).rejects.toThrow(DayFileError);
    expect(fs.files.get("days/2026-11-17.md")).toBe(raw);
  });

  it("reads keys named like Object.prototype members as plain values", () => {
    const day = parseDay("---\ntoString: 1\n__proto__: 2\nconstructor: x\n---\n", DATE);
    expect(Object.entries(day.values)).toEqual([["toString", 1], ["__proto__", 2], ["constructor", "x"]]);
    expect(Object.getPrototypeOf(day.values)).toBe(Object.prototype);
  });

  it("a readable file has no error", () => {
    expect(parseDay("---\ndate: 2026-11-17\nmood: 1\n---\n", DATE).error).toBeNull();
    expect(parseDay("no frontmatter\n", DATE).error).toBeNull();
  });
});
