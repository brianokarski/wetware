/** S8: read-modify-write helpers must not interleave on one file. */
import { describe, expect, it } from "vitest";
import {
  archiveHabit, HABITS_FILE, loadHabits, memoryFs, readDay, saveSettings, setMorningPagesGoal, SETTINGS_FILE,
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
