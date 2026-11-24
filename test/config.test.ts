import { describe, expect, it } from "vitest";
import {
  dayKey, HABITS_FILE, loadHabits, loadSettings, memoryFs, parseHabits, saveHabits,
  saveSettings, SEED_HABITS, SETTINGS_FILE,
} from "../src/data";

describe("habits.yaml", () => {
  it("seeds on first run and reads the same habits back", async () => {
    const fs = memoryFs();
    const first = await loadHabits(fs);
    expect(fs.files.has(HABITS_FILE)).toBe(true);
    expect(first.map((h) => h.id)).toEqual([
      "weight", "run", "lift", "climb", "sleep", "morning_pages", "meditate", "brain_fog", "mood",
    ]);
    expect(await loadHabits(fs)).toEqual(SEED_HABITS);
  });

  it("never reseeds over an existing file", async () => {
    const fs = memoryFs({ [HABITS_FILE]: "habits:\n  - id: stretch\n    name: Stretch\n    type: check\n" });
    const habits = await loadHabits(fs);
    expect(habits).toHaveLength(1);
    expect(habits[0]).toMatchObject({ id: "stretch", source: "manual", archived: false, order: 1 });
  });

  it("carries unknown habit keys through a save", async () => {
    const fs = memoryFs({ [HABITS_FILE]: "habits:\n  - id: run\n    name: Run\n    type: check\n    emoji: shoe\n" });
    await saveHabits(fs, await loadHabits(fs));
    expect(parseHabits(fs.files.get(HABITS_FILE)!)[0].emoji).toBe("shoe");
  });

  it("builds frontmatter keys with unit suffixes", () => {
    const keys = Object.fromEntries(SEED_HABITS.map((h) => [h.id, dayKey(h)]));
    expect(keys).toMatchObject({
      weight: "weight_lb", sleep: "sleep_h", morning_pages: "morning_pages_words", run: "run", brain_fog: "brain_fog",
    });
  });
});

describe("settings.yaml", () => {
  it("returns defaults when missing", async () => {
    expect(await loadSettings(memoryFs())).toEqual({
      location: { name: "", latitude: null, longitude: null },
      units: { weight: "lb", temperature: "F" },
    });
  });

  it("saves a patch and keeps hand-added keys and comments", async () => {
    const fs = memoryFs({ [SETTINGS_FILE]: "# mine\ntheme: paper\nunits:\n  weight: lb\n  temperature: F\n" });
    const saved = await saveSettings(fs, { location: { name: "Oakland", latitude: 37.8, longitude: -122.27 } });
    expect(saved.location.name).toBe("Oakland");
    const raw = fs.files.get(SETTINGS_FILE)!;
    expect(raw).toContain("# mine");
    expect(raw).toContain("theme: paper");
    expect((await loadSettings(fs)).units.weight).toBe("lb");
  });
});

describe("morning pages goal", () => {
  it("is stored on the habit, not duplicated in settings", async () => {
    const { morningPagesGoal, setMorningPagesGoal } = await import("../src/data");
    const fs = memoryFs();
    expect(morningPagesGoal(await loadHabits(fs))).toBe(750);
    await setMorningPagesGoal(fs, 500);
    expect(morningPagesGoal(await loadHabits(fs))).toBe(500);
    expect(fs.files.has(SETTINGS_FILE)).toBe(false);
  });
});
