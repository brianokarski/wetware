/** S8: read-modify-write helpers must not interleave on one file. */
import { describe, expect, it, vi } from "vitest";
import {
  archiveHabit, drained, FILE_TIME_LIMIT_MS, FileTimeoutError, HABITS_FILE, loadHabits, loadMonth, memoryFs, NotesChangedError, readDay, saveSettings, setMorningPagesGoal, SETTINGS_FILE,
  writeDay, writeNotes, type DataFs,
} from "../src/data";
import { inTurn } from "../src/data/queue";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** What a day's notes were last known to be, for a save that stands alone. */
const at = (text: string) => ({ text });

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

describe("notes written only over the notes they were written from", () => {
  const path = "days/2026-11-10.md";
  const file = "---\ndate: 2026-11-10\nmood: 2\n---\n\nSlept badly.\n";

  it("writes when the file's notes are the ones the edit started from", async () => {
    const fs = slowFs({ [path]: file });
    const saved = await writeNotes(fs, "2026-11-10", "Slept badly.\nTyped in Wetware.\n", at("Slept badly.\n"));
    expect(saved.notes).toBe("Slept badly.\nTyped in Wetware.\n");
    expect(fs.files.get(path)).toBe("---\ndate: 2026-11-10\nmood: 2\n---\n\nSlept badly.\nTyped in Wetware.\n");
    // And again from there, and on a day with no file, whose notes are empty.
    await writeNotes(fs, "2026-11-10", "All new.\n", at("Slept badly.\nTyped in Wetware.\n"));
    await writeNotes(fs, "2026-11-09", "First.", at(""));
    expect(fs.files.get("days/2026-11-09.md")).toBe("---\ndate: 2026-11-09\n---\n\nFirst.");
  });

  it("writes nothing over notes that were changed in the file meanwhile, and hands back the day as it is", async () => {
    const outside = `${file}Second line from Obsidian.\n`;
    const fs = slowFs({ [path]: outside });
    const refused = writeNotes(fs, "2026-11-10", "Slept badly.\nTyped in Wetware.\n", at("Slept badly.\n"));
    await expect(refused).rejects.toBeInstanceOf(NotesChangedError);
    const error = (await refused.catch((e) => e)) as NotesChangedError;
    expect(error.day.notes).toBe("Slept badly.\nSecond line from Obsidian.\n");
    expect(fs.files.get(path)).toBe(outside);
    expect(fs.writes).toBe(0);
    // Having seen them, the edit can be written over them.
    await writeNotes(fs, "2026-11-10", "Slept badly.\nTyped in Wetware.\n", at(error.day.notes));
    expect(fs.files.get(path)).toBe(`${file}Typed in Wetware.\n`);
  });

  it("compares inside the write's turn: a change that lands just before it is seen", async () => {
    const fs = slowFs({ [path]: file });
    // Another write to the body is already queued when the notes save is asked for.
    const first = writeDay(fs, "2026-11-10", { notes: "Changed by something else.\n" });
    const second = writeNotes(fs, "2026-11-10", "Typed in Wetware.\n", at("Slept badly.\n"));
    await first;
    await expect(second).rejects.toBeInstanceOf(NotesChangedError);
    expect(fs.files.get(path)).toBe("---\ndate: 2026-11-10\nmood: 2\n---\n\nChanged by something else.\n");
  });

  it("is not put off by a change to the frontmatter, or by how the body's line ends and leading blank line are written", async () => {
    const fs = slowFs({ [path]: file.replace("mood: 2", "mood: 5\nadded_outside: yes") });
    await writeNotes(fs, "2026-11-10", "New.\n", at("Slept badly.\n"));
    expect(fs.files.get(path)).toBe("---\ndate: 2026-11-10\nmood: 5\nadded_outside: yes\n---\n\nNew.\n");
    const crlf = slowFs({ [path]: "---\r\ndate: 2026-11-10\r\n---\r\n\r\nOne.\r\nTwo.\r\n" });
    await writeNotes(crlf, "2026-11-10", "One.\nTwo.\nThree.\n", at("One.\nTwo.\n"));
    expect(crlf.files.get(path)).toBe("---\r\ndate: 2026-11-10\r\n---\r\n\r\nOne.\r\nTwo.\r\nThree.\r\n");
  });

  it("takes a file that was deleted, or emptied, for a change too", async () => {
    const gone = slowFs();
    await expect(writeNotes(gone, "2026-11-10", "Typed.\n", at("Slept badly.\n"))).rejects.toBeInstanceOf(NotesChangedError);
    expect(gone.files.size).toBe(0);
  });

  it("a save asked for while one is on its way is checked against what that one wrote, not taken for a change made elsewhere", async () => {
    const fs = slowFs({ [path]: file });
    // One notes field, one notion of what the file holds. Three saves asked for at once, as on a slow disk.
    const base = at("Slept badly.\n");
    const saves = Promise.all([
      writeNotes(fs, "2026-11-10", "Slept badly.\nOne.", base),
      writeNotes(fs, "2026-11-10", "Slept badly.\nOne. Two.", base),
      writeNotes(fs, "2026-11-10", "Slept badly.\nOne. Two. Three.", base),
    ]);
    // Nothing has landed yet, and what the file is known to hold has not moved.
    expect(base.text).toBe("Slept badly.\n");
    expect((await saves).map((day) => day.notes)).toEqual(["Slept badly.\nOne.", "Slept badly.\nOne. Two.", "Slept badly.\nOne. Two. Three."]);
    expect(fs.files.get(path)).toBe("---\ndate: 2026-11-10\nmood: 2\n---\n\nSlept badly.\nOne. Two. Three.");
    expect(base.text).toBe("Slept badly.\nOne. Two. Three.");
    expect(fs.writes).toBe(3);
  });

  it("a save that fails does not move what the file is known to hold, and the one behind it is not refused for it", async () => {
    const inner = slowFs({ [path]: file });
    let full = true;
    const fs: DataFs = { ...inner, write: (p, text) => (full ? Promise.reject(new Error("No space left on device")) : inner.write(p, text)) };
    const base = at("Slept badly.\n");
    const first = writeNotes(fs, "2026-11-10", "Slept badly.\nOne.", base).catch((e) => e);
    const second = writeNotes(fs, "2026-11-10", "Slept badly.\nOne. Two.", base).catch((e) => e);
    expect((await first).message).toBe("No space left on device");
    expect(await second).not.toBeInstanceOf(NotesChangedError);
    expect(base.text).toBe("Slept badly.\n");
    full = false;
    await writeNotes(fs, "2026-11-10", "Slept badly.\nOne. Two.", base);
    expect(base.text).toBe("Slept badly.\nOne. Two.");
    // A refusal for a change made elsewhere doesn't move it either.
    inner.files.set(path, `${file}From elsewhere.\n`);
    await expect(writeNotes(fs, "2026-11-10", "Mine.", base)).rejects.toBeInstanceOf(NotesChangedError);
    expect(base.text).toBe("Slept badly.\nOne. Two.");
  });

  it("notes that are already what the file holds are known to be there without being written", async () => {
    const fs = slowFs({ [path]: `${file}Landed late.\n` });
    // A save that was given up on landed after all. The field still thinks the file holds the older notes.
    const base = at("Slept badly.\n");
    const saved = await writeNotes(fs, "2026-11-10", "Slept badly.\nLanded late.\n", base);
    expect(saved.notes).toBe("Slept badly.\nLanded late.\n");
    expect(base.text).toBe("Slept badly.\nLanded late.\n");
    expect(fs.writes).toBe(0);
  });
});

describe("a file operation that never comes back", () => {
  const never = () => new Promise<never>(() => {});

  it("is given up on after its time limit, with the file named, and the queue moves on", async () => {
    vi.useFakeTimers();
    try {
      const fs = {};
      const hung = inTurn(fs, "days/2026-11-16.md", never);
      const next = inTurn(fs, "days/2026-11-16.md", async () => "after");
      const failed = expect(hung).rejects.toThrow("No answer from the data folder for days/2026-11-16.md after 30 seconds");
      let done = false;
      void next.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(FILE_TIME_LIMIT_MS - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      await expect(hung).rejects.toBeInstanceOf(FileTimeoutError);
      expect(await next).toBe("after");
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't hold up the month, another day, or the same day once its time is up", async () => {
    vi.useFakeTimers();
    try {
      const inner = memoryFs({ "days/2026-11-15.md": "---\ndate: 2026-11-15\nmood: 4\n---\n", "days/2026-11-16.md": "---\ndate: 2026-11-16\nmood: 3\n---\n" });
      const fs: DataFs = { ...inner, write: (p, text) => (p.includes("2026-11-16") ? never() : inner.write(p, text)) };
      const hung = writeDay(fs, "2026-11-16", { values: { mood: 5 } });
      const failed = expect(hung).rejects.toBeInstanceOf(FileTimeoutError);
      // Another day is not behind it.
      await expect(writeDay(fs, "2026-11-15", { values: { mood: 1 } })).resolves.toMatchObject({ values: { mood: 1 } });
      // The month waits for it, and no longer than the limit.
      const month = loadMonth(fs, { year: 2026, month: 11 });
      const read = readDay(fs, "2026-11-16");
      await vi.advanceTimersByTimeAsync(FILE_TIME_LIMIT_MS);
      await failed;
      expect((await month)["2026-11-16"].values.mood).toBe(3);
      expect((await month)["2026-11-15"].values.mood).toBe(1);
      expect((await read).values.mood).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a task when it has been given up on", async () => {
    vi.useFakeTimers();
    try {
      const fs = {};
      const seen: boolean[] = [];
      let finish!: () => void;
      const slow = inTurn(fs, "pages/2026-11-17.md", async (turn) => {
        seen.push(turn.live());
        await new Promise<void>((resolve) => (finish = resolve));
        seen.push(turn.live());
      });
      const failed = expect(slow).rejects.toBeInstanceOf(FileTimeoutError);
      await vi.advanceTimersByTimeAsync(FILE_TIME_LIMIT_MS);
      await failed;
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual([true, false]);
      // One that finishes in time is live to the end.
      const quick = await inTurn(fs, "pages/2026-11-17.md", async (turn) => turn.live());
      expect(quick).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a change given up on while its file was being read writes nothing when the read comes back", async () => {
    vi.useFakeTimers();
    try {
      const inner = memoryFs({ "days/2026-11-16.md": "---\ndate: 2026-11-16\nmood: 3\n---\n\nNotes.\n" });
      const answers: (() => void)[] = [];
      let stuck = true;
      const writes: string[] = [];
      const fs: DataFs = {
        ...inner,
        read: (p) => (stuck ? new Promise<void>((resolve) => answers.push(resolve)).then(() => inner.read(p)) : inner.read(p)),
        write: (p, text) => (writes.push(text), inner.write(p, text)),
      };
      const base = at("Notes.\n");
      const value = writeDay(fs, "2026-11-16", { values: { mood: 1 } }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(FILE_TIME_LIMIT_MS);
      const notes = writeNotes(fs, "2026-11-16", "Notes.\nGiven up on.", base).catch((e) => e);
      await vi.advanceTimersByTimeAsync(FILE_TIME_LIMIT_MS);
      expect(await value).toBeInstanceOf(FileTimeoutError);
      expect(await notes).toBeInstanceOf(FileTimeoutError);
      // A newer change lands while those two reads are still out.
      stuck = false;
      await writeDay(fs, "2026-11-16", { values: { mood: 5 } });
      await writeNotes(fs, "2026-11-16", "Notes.\nNewer.", base);
      expect(writes.length).toBe(2);
      // Now the stuck reads come back. Neither goes on to write what it was asked to, over the newer change.
      expect(answers.length).toBe(2);
      for (const answer of answers) answer();
      await vi.advanceTimersByTimeAsync(0);
      expect(writes.length).toBe(2);
      expect(inner.files.get("days/2026-11-16.md")).toBe("---\ndate: 2026-11-16\nmood: 5\n---\n\nNotes.\nNewer.");
      expect(base.text).toBe("Notes.\nNewer.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a notes save given up on that lands after all does not move what the file is known to hold", async () => {
    vi.useFakeTimers();
    try {
      const path = "days/2026-11-16.md";
      const inner = memoryFs({ [path]: "---\ndate: 2026-11-16\n---\n\nOne.\n" });
      // Writes wait to be let through, one after another, in the order they were asked for: as the shell keeps them.
      const waiting: (() => void)[] = [];
      let before: Promise<void> = Promise.resolve();
      const fs: DataFs = {
        ...inner,
        write: (p, text) => {
          const gate = new Promise<void>((resolve) => waiting.push(resolve));
          before = Promise.all([before, gate]).then(() => inner.write(p, text));
          return before;
        },
      };
      const base = at("One.\n");
      const stuck = writeNotes(fs, "2026-11-16", "One.\nTwo.", base).catch((e) => e);
      await vi.advanceTimersByTimeAsync(FILE_TIME_LIMIT_MS);
      expect(await stuck).toBeInstanceOf(FileTimeoutError);
      // A newer save is asked for. Its own check is made against what the file holds now, which is still "One.".
      const newer = writeNotes(fs, "2026-11-16", "One.\nTwo. Three.", base);
      await vi.advanceTimersByTimeAsync(10);
      // The stuck write lands at last. It was given up on: it says nothing about what the file holds now.
      waiting[0]();
      await vi.advanceTimersByTimeAsync(10);
      expect(inner.files.get(path)).toBe("---\ndate: 2026-11-16\n---\n\nOne.\nTwo.");
      expect(base.text).toBe("One.\n");
      // The newer one lands after it, and what the file is known to hold is what that one wrote.
      waiting[1]();
      await vi.advanceTimersByTimeAsync(10);
      expect((await newer).notes).toBe("One.\nTwo. Three.");
      expect(inner.files.get(path)).toBe("---\ndate: 2026-11-16\n---\n\nOne.\nTwo. Three.");
      expect(base.text).toBe("One.\nTwo. Three.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the folder is drained once nothing is queued and nothing more is being queued by what just finished", async () => {
    const fs = slowFs();
    let both = false;
    // A save in two steps: one file, and then, once that has landed, another.
    void writeDay(fs, "2026-11-16", { values: { mood: 1 } })
      .then(() => writeDay(fs, "2026-11-17", { values: { mood: 2 } }))
      .then(() => (both = true));
    await drained(fs);
    expect(both).toBe(true);
    expect(fs.files.has("days/2026-11-17.md")).toBe(true);
    // With nothing queued it resolves at once, and a failed write doesn't hold it up.
    await drained(fs);
    await drained({});
    const failing: DataFs = { ...memoryFs(), write: () => Promise.reject(new Error("No space left")) };
    void writeDay(failing, "2026-11-16", { values: { mood: 1 } }).catch(() => {});
    await drained(failing);
  });

  it("leaves an operation that does come back alone, and sets no timer loose", async () => {
    vi.useFakeTimers();
    try {
      const fs = {};
      const quick = inTurn(fs, "a", async () => "done");
      await vi.advanceTimersByTimeAsync(0);
      expect(await quick).toBe("done");
      expect(vi.getTimerCount()).toBe(0);
      const failing = inTurn(fs, "a", async () => Promise.reject(new Error("No space left")));
      await expect(failing).rejects.toThrow("No space left");
      expect(vi.getTimerCount()).toBe(0);
      // A shorter limit can be given.
      const brief = inTurn(fs, "a", never, 50);
      const failed = expect(brief).rejects.toThrow("after 0 seconds");
      await vi.advanceTimersByTimeAsync(50);
      await failed;
    } finally {
      vi.useRealTimers();
    }
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
