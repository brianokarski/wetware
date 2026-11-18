/** S8: read-modify-write helpers must not interleave on one file. */
import { describe, expect, it } from "vitest";
import {
  archiveHabit, HABITS_FILE, loadHabits, loadMonth, memoryFs, readDay, saveSettings, setMorningPagesGoal, SETTINGS_FILE,
  writeDay, type DataFs,
} from "../src/data";
import { inTurn } from "../src/data/queue";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An fs whose reads and writes take a while, so unserialised edits would
 * overlap. `busiest` is the most read-modify-write cycles seen in flight at
 * once: a cycle runs from a read of a path to the next write of it.
 */
function slowFs(initial: Record<string, string> = {}) {
  const inner = memoryFs(initial);
  let open = 0;
  const fs: DataFs & { files: Map<string, string>; writes: number; busiest: number } = {
    files: inner.files,
    writes: 0,
    busiest: 0,
    async read(path) {
      fs.busiest = Math.max(fs.busiest, ++open);
      await wait(5);
      const text = await inner.read(path);
      await wait(5);
      return text;
    },
    async write(path, text) {
      await wait(10);
      fs.writes++;
      await inner.write(path, text);
      open--;
    },
    list: (dir) => inner.list(dir),
  };
  return fs;
}

describe("writes to one file run one at a time", () => {
  it("two quick edits to one day both land", async () => {
    const fs = slowFs({ "days/2026-11-17.md": "---\ndate: 2026-11-17\nrun: true # keep\n---\n\nnotes\n" });
    await Promise.all([
      writeDay(fs, "2026-11-17", { values: { meditate: true } }),
      writeDay(fs, "2026-11-17", { values: { mood: 4 } }),
      writeDay(fs, "2026-11-17", { values: { brain_fog: 2 }, sources: { brain_fog: "manual" } }),
    ]);
    expect(fs.files.get("days/2026-11-17.md")).toBe(
      "---\ndate: 2026-11-17\nrun: true # keep\nmeditate: true\nmood: 4\nbrain_fog: 2\n_sources:\n  brain_fog: manual\n---\n\nnotes\n",
    );
    expect(fs.busiest).toBe(1);
  });

  it("many toggles of a new day file end with every value", async () => {
    const fs = slowFs();
    const keys = Array.from({ length: 12 }, (_, i) => `habit_${i}`);
    await Promise.all(keys.map((key) => writeDay(fs, "2026-11-18", { values: { [key]: true } })));
    const day = await readDay(fs, "2026-11-18");
    expect(Object.keys(day.values)).toEqual(keys);
  });

  it("different days don't wait for each other", async () => {
    const fs = slowFs();
    await Promise.all(["01", "02", "03", "04"].map((d) => writeDay(fs, `2026-11-${d}`, { values: { a: 1 } })));
    expect(fs.files.size).toBe(4);
    expect(fs.busiest).toBe(4);
  });

  it("settings saved in quick succession all land", async () => {
    const fs = slowFs({ [SETTINGS_FILE]: "# mine\n" });
    await Promise.all([
      saveSettings(fs, { location: { name: "Oakland" } }),
      saveSettings(fs, { location: { latitude: 37.8 } }),
      saveSettings(fs, { units: { weight: "kg" } }),
    ]);
    expect(fs.files.get(SETTINGS_FILE)).toBe("# mine\nlocation:\n  name: Oakland\n  latitude: 37.8\nunits:\n  weight: kg\n");
  });

  it("habit changes in quick succession all land, and the seed is written once", async () => {
    const fs = slowFs();
    const [first, second] = await Promise.all([loadHabits(fs), loadHabits(fs)]);
    expect(first).toEqual(second);
    expect(fs.writes).toBe(1);
    await Promise.all([setMorningPagesGoal(fs, 500), archiveHabit(fs, "mood"), archiveHabit(fs, "run")]);
    const habits = await loadHabits(fs);
    expect(habits.find((h) => h.id === "morning_pages")!.goal).toBe(500);
    expect(habits.filter((h) => h.archived).map((h) => h.id)).toEqual(["run", "mood"]);
    expect(fs.files.get(HABITS_FILE)).toContain("goal: 500");
  });

  it("a failed edit doesn't block or undo the ones around it", async () => {
    const fs = slowFs({ "days/2026-11-17.md": "---\ndate: 2026-11-17\n---\n" });
    const results = await Promise.allSettled([
      writeDay(fs, "2026-11-17", { values: { a: 1 } }),
      writeDay(fs, "2026-11-17", { body: "x", notes: "x" }),
      writeDay(fs, "2026-11-17", { values: { b: 2 } }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(fs.files.get("days/2026-11-17.md")).toBe("---\ndate: 2026-11-17\na: 1\nb: 2\n---\n");
  });
});

describe("a change worked out from the day as it is on disk", () => {
  const path = "days/2026-11-17.md";

  it("sees an edit that was queued before it, however long the read takes", async () => {
    const fs = slowFs({ [path]: "---\ndate: 2026-11-17\n---\n" });
    const seen: unknown[] = [];
    await Promise.all([
      writeDay(fs, "2026-11-17", { values: { sleep_h: 5 }, sources: { sleep_h: "manual" } }),
      writeDay(fs, "2026-11-17", (day) => {
        seen.push(day.values.sleep_h, day.sources.sleep_h);
        return day.sources.sleep_h === "manual" ? null : { values: { sleep_h: 7.7 }, sources: { sleep_h: "intervals" } };
      }),
    ]);
    expect(seen).toEqual([5, "manual"]);
    expect(fs.files.get(path)).toBe("---\ndate: 2026-11-17\nsleep_h: 5\n_sources:\n  sleep_h: manual\n---\n");
    expect(fs.writes).toBe(1);
    expect(fs.busiest).toBe(1);
  });

  it("doesn't write a file whose text the change leaves as it was", async () => {
    const text = "---\ndate: 2026-11-17\nmood: 4\n_sources:\n  mood: manual\n---\n\nnotes\n";
    const fs = slowFs({ [path]: text });
    // The same value, the same source, the same notes: as a patch and as a function.
    await writeDay(fs, "2026-11-17", { values: { mood: 4 }, sources: { mood: "manual" } });
    await writeDay(fs, "2026-11-17", () => ({ values: { mood: 4 } }));
    await writeDay(fs, "2026-11-17", { notes: "notes\n" });
    await writeDay(fs, "2026-11-17", {});
    expect(fs.writes).toBe(0);
    expect(fs.files.get(path)).toBe(text);
    // One that does change it is written once.
    await writeDay(fs, "2026-11-17", { values: { mood: 5 } });
    expect(fs.writes).toBe(1);
    // And a day with no file gets none from notes that are still empty, or from no change at all.
    await writeDay(fs, "2026-11-18", { notes: "" });
    await writeDay(fs, "2026-11-18", {});
    expect(fs.writes).toBe(1);
    expect(fs.files.has("days/2026-11-18.md")).toBe(false);
  });

  it("writes nothing and creates no file when the change is null", async () => {
    const fs = slowFs();
    const day = await writeDay(fs, "2026-11-17", () => null);
    expect(day).toMatchObject({ date: "2026-11-17", values: {}, error: null });
    expect(fs.files.size).toBe(0);
    expect(fs.writes).toBe(0);
  });

  it("is given an empty day when there is no file, and the file as it reads when there is", async () => {
    const fs = slowFs({ [path]: "---\nmood: 4\ncaffeine_mg: 180\n---\n\nnotes\n" });
    await writeDay(fs, "2026-11-17", (day) => {
      expect(day.values).toEqual({ mood: 4, caffeine_mg: 180 });
      expect(day.notes).toBe("notes\n");
      return { values: { run: true } };
    });
    await writeDay(fs, "2026-11-18", (day) => {
      expect(day).toMatchObject({ values: {}, sources: {}, body: "" });
      return { values: { run: true } };
    });
    expect(fs.files.get(path)).toBe("---\ndate: 2026-11-17\nmood: 4\ncaffeine_mg: 180\nrun: true\n---\n\nnotes\n");
    expect(fs.files.get("days/2026-11-18.md")).toBe("---\ndate: 2026-11-18\nrun: true\n---\n");
  });

  it("leaves a file that needs fixing alone, and the next change still runs", async () => {
    const broken = "---\nmood: 1\nmood: 2\n---\n";
    const fs = slowFs({ [path]: broken });
    await expect(writeDay(fs, "2026-11-17", (day) => {
      expect(day.error).toMatch(/Map keys must be unique/);
      return { values: { run: true } };
    })).rejects.toThrow(/Map keys must be unique/);
    expect(fs.files.get(path)).toBe(broken);
    await expect(writeDay(fs, "2026-11-17", () => null)).resolves.toMatchObject({ date: "2026-11-17" });
  });
});

describe("reading after a write that was asked for a moment before", () => {
  it("a day read behind a slow write sees what it wrote", async () => {
    const fs = slowFs({ "days/2026-11-17.md": "---\ndate: 2026-11-17\n---\n" });
    const writing = writeDay(fs, "2026-11-17", { notes: "Typed just before leaving.\n" });
    // Asked for at once, as the grid does when the day view closes on unsaved notes.
    const read = await readDay(fs, "2026-11-17");
    expect(read.notes).toBe("Typed just before leaving.\n");
    await writing;
    expect(fs.busiest).toBe(1);
  });

  it("a month loaded behind the making of a day file has that day in it", async () => {
    const fs = slowFs({ "days/2026-11-16.md": "---\ndate: 2026-11-16\nmood: 4\n---\n" });
    const making = writeDay(fs, "2026-11-09", { notes: "Rest day." });
    const clearing = writeDay(fs, "2026-11-16", { values: { mood: null } });
    const month = await loadMonth(fs, { year: 2026, month: 11 });
    expect(month["2026-11-09"].notes).toBe("Rest day.");
    expect(month["2026-11-16"].values.mood).toBeNull();
    await Promise.all([making, clearing]);
  });

  it("a write that fails doesn't hold up the reading that follows", async () => {
    const inner = slowFs();
    const fs: DataFs = { ...inner, write: () => Promise.reject(new Error("No space left on device")) };
    const failing = writeDay(fs, "2026-11-09", { notes: "Rest day." });
    const month = await loadMonth(fs, { year: 2026, month: 11 });
    expect(month["2026-11-09"]).toMatchObject({ notes: "", error: null });
    await expect(failing).rejects.toThrow("No space left");
  });
});

describe("inTurn", () => {
  it("runs tasks for one path in the order they were queued", async () => {
    const fs = {};
    const seen: number[] = [];
    await Promise.all(
      [30, 1, 10].map((ms, i) =>
        inTurn(fs, "a", async () => {
          await wait(ms);
          seen.push(i);
        }),
      ),
    );
    expect(seen).toEqual([0, 1, 2]);
  });

  it("passes results and errors through to the caller", async () => {
    const fs = {};
    const failing = inTurn(fs, "a", async () => {
      throw new Error("no");
    });
    const next = inTurn(fs, "a", async () => 42);
    await expect(failing).rejects.toThrow("no");
    await expect(next).resolves.toBe(42);
  });
});
