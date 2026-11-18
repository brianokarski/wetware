import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryFs, parseDay, readDay, splitFrontmatter, updateDayFile, writeDay } from "../src/data";

const DATE = "2026-11-17";
const fixture = readFileSync(new URL("./fixtures/2026-11-17.md", import.meta.url), "utf8");

describe("day file round trip", () => {
  it("reads values, sources and body", () => {
    const day = parseDay(fixture, DATE);
    expect(day.values.run).toBe(true);
    expect(day.values.climb).toBeNull();
    expect(day.values.sleep_h).toBe(7.7);
    expect(day.values.tags).toEqual(["travel"]);
    expect(day.values).not.toHaveProperty("date");
    expect(day.sources).toEqual({ run: "intervals", sleep_h: "intervals", brain_fog: "manual" });
    expect(day.syncedAt).toBe("2026-11-17T06:30:00-08:00");
    expect(day.body.startsWith("\nDay notes go here")).toBe(true);
  });

  it("an empty patch rewrites the file byte for byte", () => {
    expect(updateDayFile(fixture, DATE, {})).toBe(fixture);
  });

  it("keeps unknown keys, comments and the body when values change", () => {
    const next = updateDayFile(fixture, DATE, {
      values: { mood: 4, lift: true, weight_lb: 171.2 },
      sources: { mood: "manual", lift: "manual" },
    });
    const before = splitFrontmatter(fixture);
    const after = splitFrontmatter(next);

    expect(after.body).toBe(before.body);
    expect(after.yaml).toContain("# a comment Brian left by hand");
    expect(after.yaml).toContain("caffeine_mg: 180");
    expect(after.yaml).toContain('obsidian_alias: "Tuesday: long one"');
    expect(after.yaml).toContain("tags: [travel]");
    expect(after.yaml).toContain("date: 2026-11-17\n");

    // Only the patched lines differ.
    const changed = after.yaml.split("\n").filter((line) => !before.yaml.split("\n").includes(line));
    expect(changed.sort()).toEqual(
      ["  lift: manual", "  mood: manual", "lift: true", "mood: 4", "weight_lb: 171.2"].sort(),
    );

    const day = parseDay(next, DATE);
    expect(day.values.caffeine_mg).toBe(180);
    expect(day.sources.lift).toBe("manual");
    expect(day.sources.run).toBe("intervals");
  });

  it("null means no value, undefined removes the key", () => {
    const next = updateDayFile(fixture, DATE, { values: { run: null, lift: undefined } });
    const day = parseDay(next, DATE);
    expect(day.values.run).toBeNull();
    expect(day.values).not.toHaveProperty("lift");
  });

  it("replaces the body only when asked, leaving frontmatter alone", () => {
    const next = updateDayFile(fixture, DATE, { body: "New notes.\n" });
    expect(splitFrontmatter(next).yaml).toBe(splitFrontmatter(fixture).yaml);
    expect(splitFrontmatter(next).body).toBe("\nNew notes.\n");
  });

  it("creates a new file with date first", () => {
    const next = updateDayFile(null, DATE, { values: { meditate: true }, sources: { meditate: "manual" } });
    expect(next).toBe("---\ndate: 2026-11-17\nmeditate: true\n_sources:\n  meditate: manual\n---\n");
  });

  it("adds frontmatter to a hand-written note without touching it", () => {
    const note = "Just some notes, no frontmatter.\n";
    const next = updateDayFile(note, DATE, { values: { mood: 3 } });
    expect(next).toBe(`---\ndate: 2026-11-17\nmood: 3\n---\n${note}`);
  });

  it("preserves CRLF bodies", () => {
    const crlf = "---\r\ndate: 2026-11-17\r\nmood: 2\r\n---\r\nline one\r\nline two\r\n";
    const next = updateDayFile(crlf, DATE, { values: { mood: 5 } });
    expect(splitFrontmatter(next).body).toBe("line one\r\nline two\r\n");
    expect(parseDay(next, DATE).values.mood).toBe(5);
  });

  it("writes through the fs to days/", async () => {
    const fs = memoryFs({ "days/2026-11-17.md": fixture });
    await writeDay(fs, DATE, { values: { meditate: true } });
    const day = await readDay(fs, DATE);
    expect(day.values.meditate).toBe(true);
    expect(day.values.caffeine_mg).toBe(180);
    expect(day.body).toBe(splitFrontmatter(fixture).body);
  });
});
