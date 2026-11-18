/** The failing inputs from the Milestone 1 review for habits.yaml and settings.yaml (S4, S6, S7, N3). */
import { describe, expect, it } from "vitest";
import {
  addHabit, archiveHabit, HABITS_FILE, HabitsError, loadHabits, loadHabitsFile, loadSettings, memoryFs,
  morningPagesGoal, parseHabits, parseHabitsFile, parseSettings, reorderHabits, saveHabits, saveSettings,
  SEED_HABITS, serializeHabits, setMorningPagesGoal, SETTINGS_FILE, SettingsError, updateHabit, YamlPatchError,
} from "../src/data";

const COMMENTED = "# my comment\nhabits:\n  - id: mp\n    source: morning_pages\n    goal: 750 # words\n  - id: run\n";
const habitsFs = (raw: string) => memoryFs({ [HABITS_FILE]: raw });
const habitsText = (fs: ReturnType<typeof memoryFs>) => fs.files.get(HABITS_FILE)!;

describe("S4: habits.yaml is patched in place", () => {
  it("changing the word goal changes that number and nothing else", async () => {
    const fs = habitsFs(COMMENTED);
    const habits = await setMorningPagesGoal(fs, 500);
    expect(habitsText(fs)).toBe(COMMENTED.replace("750", "500"));
    expect(morningPagesGoal(habits)).toBe(500);
  });

  it("never writes a default the user didn't set", async () => {
    const fs = habitsFs(COMMENTED);
    await setMorningPagesGoal(fs, 500);
    await saveHabits(fs, await loadHabits(fs));
    await archiveHabit(fs, "run", false);
    await reorderHabits(fs, ["mp", "run"]);
    for (const word of ["type", "color", "order", "name", "direction", "archived", "unit", "show_on_calendar"]) {
      expect(habitsText(fs)).not.toContain(word);
    }
    expect(habitsText(fs)).toBe(COMMENTED.replace("750", "500"));
  });

  it("doesn't write at all when nothing changes", async () => {
    const fs = habitsFs(COMMENTED);
    let writes = 0;
    const write = fs.write;
    fs.write = (path, text) => (writes++, write(path, text));
    await setMorningPagesGoal(fs, 750);
    await saveHabits(fs, await loadHabits(fs));
    expect(writes).toBe(0);
  });

  it("the seed file reads back the same after a round trip through save", async () => {
    const fs = memoryFs();
    const seeded = await loadHabits(fs);
    const text = habitsText(fs);
    await saveHabits(fs, seeded);
    expect(habitsText(fs)).toBe(text);
  });

  it("refuses a goal that isn't a whole number of 1 or more, and a file with no pages habit", async () => {
    const fs = habitsFs(COMMENTED);
    for (const goal of [0, -5, 0.4, NaN, Infinity]) {
      await expect(setMorningPagesGoal(fs, goal)).rejects.toThrow(HabitsError);
    }
    await expect(setMorningPagesGoal(habitsFs("habits:\n  - id: run\n"), 500)).rejects.toThrow(HabitsError);
    expect(habitsText(fs)).toBe(COMMENTED);
  });
});

describe("habit patch operations", () => {
  it("archives by adding one line, and unarchives by changing it", async () => {
    const fs = habitsFs(COMMENTED);
    const habits = await archiveHabit(fs, "mp");
    expect(habitsText(fs)).toBe(COMMENTED.replace("goal: 750 # words\n", "goal: 750 # words\n    archived: true\n"));
    expect(habits.find((h) => h.id === "mp")!.archived).toBe(true);
    await archiveHabit(fs, "mp", false);
    expect(habitsText(fs)).toBe(COMMENTED.replace("goal: 750 # words\n", "goal: 750 # words\n    archived: false\n"));
  });

  it("adds a habit at the end, writing only the fields given", async () => {
    const fs = habitsFs(COMMENTED);
    const habits = await addHabit(fs, { id: "stretch", name: "Stretch", type: "check", color: "#3A7D44" });
    expect(habitsText(fs)).toBe(COMMENTED + '  - id: stretch\n    name: Stretch\n    type: check\n    color: "#3A7D44"\n');
    expect(habits.map((h) => h.id)).toEqual(["mp", "run", "stretch"]);
    expect(habits[2]).toMatchObject({ source: "manual", archived: false, order: 3 });
  });

  it("adds after habits that were given higher order numbers", async () => {
    const fs = habitsFs("habits:\n  - id: a\n    order: 20\n  - id: b\n    order: 10\n");
    const habits = await addHabit(fs, { id: "c" });
    expect(habitsText(fs)).toBe("habits:\n  - id: a\n    order: 20\n  - id: b\n    order: 10\n  - id: c\n    order: 21\n");
    expect(habits.map((h) => h.id)).toEqual(["b", "a", "c"]);
  });

  it("adds to a file with no habits yet", async () => {
    for (const raw of ["", "# mine\n", "habits:\n", "habits: []\n"]) {
      const fs = habitsFs(raw);
      expect((await addHabit(fs, { id: "a" })).map((h) => h.id)).toEqual(["a"]);
      expect(habitsText(fs).startsWith(raw.replace(/habits:.*\n/, ""))).toBe(true);
    }
  });

  it("seeds first when the folder is new", async () => {
    const fs = memoryFs();
    const habits = await addHabit(fs, { id: "stretch" });
    expect(habits).toHaveLength(SEED_HABITS.length + 1);
    expect(habitsText(fs)).toBe(serializeHabits(SEED_HABITS) + "  - id: stretch\n");
  });

  it("refuses a duplicate id, a missing id and fields of the wrong type", async () => {
    const fs = habitsFs(COMMENTED);
    await expect(addHabit(fs, { id: "run" })).rejects.toThrow(HabitsError);
    await expect(addHabit(fs, { id: "" })).rejects.toThrow(HabitsError);
    await expect(addHabit(fs, { id: "x", type: "streak" as never })).rejects.toThrow(HabitsError);
    await expect(updateHabit(fs, "run", { order: "first" as never })).rejects.toThrow(HabitsError);
    await expect(updateHabit(fs, "run", { id: "jog" })).rejects.toThrow(HabitsError);
    await expect(updateHabit(fs, "nope", { name: "x" })).rejects.toThrow(HabitsError);
    expect(habitsText(fs)).toBe(COMMENTED);
  });

  it("reorders by writing order only where it changes", async () => {
    const fs = habitsFs("habits:\n  - id: a # first\n  - id: b\n    order: 2\n  - id: c\n");
    const habits = await reorderHabits(fs, ["c", "a"]);
    expect(habits.map((h) => h.id)).toEqual(["c", "a", "b"]);
    expect(habitsText(fs)).toBe("habits:\n  - id: a # first\n    order: 2\n  - id: b\n    order: 3\n  - id: c\n    order: 1\n");
    await reorderHabits(fs, ["c", "a", "b"]);
    expect(habitsText(fs)).toBe("habits:\n  - id: a # first\n    order: 2\n  - id: b\n    order: 3\n  - id: c\n    order: 1\n");
    await expect(reorderHabits(fs, ["zzz"])).rejects.toThrow(HabitsError);
  });

  it("updates nested values and unknown keys without touching the rest", async () => {
    const raw = "habits:\n  - id: run # the main one\n    source_rule:\n      activity_types: [Run]\n      min_minutes: 0 # any\n    emoji: shoe\n";
    const fs = habitsFs(raw);
    await updateHabit(fs, "run", { emoji: "boot", source_rule: { activity_types: ["Run"], min_minutes: 0 } });
    expect(habitsText(fs)).toBe(raw.replace("shoe", "boot"));
  });

  it("saveHabits adds habits the file doesn't have, without their defaults", async () => {
    const fs = habitsFs(COMMENTED);
    const current = await loadHabits(fs);
    const extra = { ...SEED_HABITS[6], order: 3 };
    await saveHabits(fs, [...current, extra]);
    expect(habitsText(fs)).toBe(COMMENTED + '  - id: meditate\n    name: Meditate\n    color: "#7A4FA3"\n    show_on_calendar: true\n');
  });
});

describe("N3: habit fields are normalised on read", () => {
  it("ids and names are text, order is a number, booleans are booleans", () => {
    const { habits, skipped } = parseHabitsFile(
      "habits:\n  - id: 5\n    name: 2024\n    order: '2'\n    archived: yes\n    show_on_calendar: 'true'\n    goal: '750'\n  - id: y\n    order: 1\n    archived: Off\n",
    );
    expect(skipped).toEqual([]);
    expect(habits.map((h) => h.id)).toEqual(["y", "5"]);
    expect(habits[1]).toMatchObject({ id: "5", name: "2024", order: 2, archived: true, show_on_calendar: true, goal: 750 });
    expect(habits[0]).toMatchObject({ name: "y", archived: false, type: "check", source: "manual" });
  });

  it.each([
    ["no id", "name: no id", /no id/],
    ["an empty id", "id: ''", /no id/],
    ["an id that is a list", "id: [a]", /id is not text/],
    ["an order that isn't a number", "id: x\n    order: first", /order is not a number/],
    ["a flag that isn't true or false", "id: x\n    archived: maybe", /archived is not true or false/],
    ["an unknown type", "id: x\n    type: streak", /type is not one of/],
    ["an unknown source", "id: x\n    source: strava", /source is not one of/],
    ["an unknown direction", "id: x\n    direction: up", /direction is not one of/],
    ["a goal that isn't a number", "id: x\n    goal: lots", /goal is not a number/],
    ["a name that is a map", "id: x\n    name: {a: 1}", /name is not text/],
    ["a unit that is a number", "id: x\n    unit: 5", /unit is not text/],
    ["a source rule that is text", "id: x\n    source_rule: Run", /source_rule/],
  ])("skips and reports a habit with %s", (_name, entry, reason) => {
    const { habits, skipped } = parseHabitsFile(`habits:\n  - id: ok\n  - ${entry}\n  - id: also_ok\n`);
    expect(habits.map((h) => h.id)).toEqual(["ok", "also_ok"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].index).toBe(1);
    expect(skipped[0].reason).toMatch(reason);
  });

  it("skips entries that aren't maps and ids used twice", () => {
    const { habits, skipped } = parseHabitsFile("habits:\n  - just text\n  - id: a\n  - id: a\n    name: Again\n");
    expect(habits).toHaveLength(1);
    expect(habits[0].name).toBe("a");
    expect(skipped.map((s) => [s.index, s.id])).toEqual([[0, null], [2, "a"]]);
  });

  it("a skipped entry stays in the file and isn't patched by mistake", async () => {
    const raw = "habits:\n  - id: bad\n    order: first # fix me\n  - id: mp\n    source: morning_pages\n    goal: 750\n";
    const fs = habitsFs(raw);
    expect((await loadHabitsFile(fs)).skipped).toEqual([{ index: 0, id: "bad", reason: "order is not a number" }]);
    await setMorningPagesGoal(fs, 500);
    expect(habitsText(fs)).toBe(raw.replace("750", "500"));
    await expect(addHabit(fs, { id: "bad" })).rejects.toThrow(HabitsError);
  });

  it("reads an empty file as no habits and refuses one it couldn't save to", () => {
    expect(parseHabits("")).toEqual([]);
    expect(parseHabits("habits:\n")).toEqual([]);
    expect(() => parseHabits("habits: 3")).toThrow(HabitsError);
    expect(() => parseHabits("- a\n- b\n")).toThrow(HabitsError);
    expect(() => parseHabits("habits: [oops")).toThrow(YamlPatchError);
  });
});

describe("S6: parseSettings checks every field", () => {
  const defaults = { location: { name: "", latitude: null, longitude: null }, units: { weight: "lb", temperature: "F" } };

  it.each([
    ["latitude: abc", "location:\n  latitude: abc\n"],
    ["weight: stone", "units:\n  weight: stone\n"],
    ["latitude out of range", "location:\n  latitude: 500\n  longitude: -181\n"],
    ["infinite coordinates", "location:\n  latitude: .inf\n  longitude: .nan\n"],
    ["numbers as text", "location:\n  latitude: '37.8'\n  name: 5\n"],
    ["location that isn't a map", "location: 5\nunits: [lb]\n"],
    ["temperature: K", "units:\n  temperature: K\n"],
    ["an empty file", ""],
  ])("falls back to the default for %s", (_name, raw) => {
    expect(parseSettings(raw)).toEqual(defaults);
  });

  it("keeps valid fields next to invalid ones, and the limits themselves", () => {
    expect(parseSettings("location:\n  name: Oakland\n  latitude: 91\n  longitude: -122.27\nunits:\n  weight: kg\n  temperature: X\n")).toEqual({
      location: { name: "Oakland", latitude: null, longitude: -122.27 },
      units: { weight: "kg", temperature: "F" },
    });
    expect(parseSettings("location:\n  latitude: -90\n  longitude: 180\n").location).toMatchObject({ latitude: -90, longitude: 180 });
  });

  it("refuses a file it couldn't save to", () => {
    expect(() => parseSettings("- 1\n")).toThrow(SettingsError);
    expect(() => parseSettings("bad: [x")).toThrow(YamlPatchError);
  });

  it("saveSettings refuses values that aren't valid, leaving the file as it was", async () => {
    const raw = "location:\n  latitude: 37.8\n";
    const fs = memoryFs({ [SETTINGS_FILE]: raw });
    for (const patch of [
      { location: { latitude: 500 } },
      { location: { latitude: Infinity } },
      { location: { longitude: NaN } },
      { location: { longitude: -180.5 } },
      { location: { latitude: "37.8a" as never } },
      { location: { name: 5 as never } },
      { units: { weight: "stone" as never } },
      { units: { temperature: "K" as never } },
    ]) {
      await expect(saveSettings(fs, patch)).rejects.toThrow(SettingsError);
    }
    expect(fs.files.get(SETTINGS_FILE)).toBe(raw);
  });
});

describe("S7: settings are patched one value at a time", () => {
  const raw = "# mine\ntheme: paper\nlocation:\n  name: Oakland # home\n  latitude: 37.8\n  extra: keep\n";

  it("a comment beside a value that didn't change stays", async () => {
    const fs = memoryFs({ [SETTINGS_FILE]: raw });
    const saved = await saveSettings(fs, { location: { name: "Oakland", latitude: 1, longitude: 2 } });
    expect(fs.files.get(SETTINGS_FILE)).toBe(raw.replace("latitude: 37.8", "latitude: 1").replace("  extra: keep\n", "  extra: keep\n  longitude: 2\n"));
    expect(saved.location).toEqual({ name: "Oakland", latitude: 1, longitude: 2 });
  });

  it("a comment beside a value that did change stays too", async () => {
    const fs = memoryFs({ [SETTINGS_FILE]: raw });
    await saveSettings(fs, { location: { name: "Berkeley" } });
    expect(fs.files.get(SETTINGS_FILE)).toBe(raw.replace("Oakland", "Berkeley"));
  });

  it("defaults the user didn't set are not written", async () => {
    const fs = memoryFs({ [SETTINGS_FILE]: raw });
    const current = await loadSettings(fs);
    await saveSettings(fs, { location: { ...current.location }, units: { ...current.units, weight: "kg" } });
    expect(fs.files.get(SETTINGS_FILE)).toBe(raw + "units:\n  weight: kg\n");
  });

  it("clearing a coordinate writes null in place; clearing one that was never set writes nothing", async () => {
    const fs = memoryFs({ [SETTINGS_FILE]: raw });
    await saveSettings(fs, { location: { latitude: null, longitude: null } });
    expect(fs.files.get(SETTINGS_FILE)).toBe(raw.replace("latitude: 37.8", "latitude: null"));
  });

  it("replaces a value of the wrong type when a valid one is saved", async () => {
    const fs = memoryFs({ [SETTINGS_FILE]: "units:\n  weight: stone # ?\nlocation: 5\n" });
    await saveSettings(fs, { units: { weight: "kg" }, location: { name: "Oakland" } });
    expect(fs.files.get(SETTINGS_FILE)).toBe("units:\n  weight: kg # ?\nlocation:\n  name: Oakland\n");
  });

  it("creates the file on first save", async () => {
    const fs = memoryFs();
    await saveSettings(fs, { units: { temperature: "C" } });
    expect(fs.files.get(SETTINGS_FILE)).toBe("units:\n  temperature: C\n");
  });
});
