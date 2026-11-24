import { useCallback, useEffect, useState } from "react";
import { Mono } from "./components/primitives";
import {
  HABITS_FILE, loadHabitsFile, loadSettings, morningPagesGoal, saveSettings, setMorningPagesGoal,
  type Habit, type Settings as SettingsData, type SkippedHabit,
} from "./data";
import {
  chooseDataRoot, getDataRoot, suggestedDataRoot, tauriFs, adoptSuggestedDataRoot,
} from "./platform/tauri";
import { Home } from "./screens/Home";
import { Settings } from "./screens/Settings";

type Screen = "month" | "settings";

/** Later milestones fill these in; shown disabled so the map is visible. */
const NAV: { id: Screen | null; label: string }[] = [
  { id: "month", label: "Month" },
  { id: null, label: "Calendar" },
  { id: null, label: "Pages" },
  { id: null, label: "Habits" },
  { id: "settings", label: "Settings" },
];

export default function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>("month");
  const [dataRoot, setRoot] = useState<string | null>(null);
  const [suggestedRoot, setSuggestedRoot] = useState("");
  const [habits, setHabits] = useState<Habit[]>([]);
  const [skipped, setSkipped] = useState<SkippedHabit[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = new Date();

  const fail = (e: unknown) => setError(String(e));
  /** Takes a result and clears the error line: whatever went wrong before, this worked. */
  const done = <T,>(take: (value: T) => void) => (value: T) => {
    take(value);
    setError(null);
  };

  /** Read (and on first use, seed) the data folder. */
  const loadFolder = useCallback(async () => {
    // If this folder fails to load, nothing from the one open before may stay on screen under its path.
    setHabits([]);
    setSkipped([]);
    setSettings(null);
    const file = await loadHabitsFile(tauriFs);
    setHabits(file.habits);
    setSkipped(file.skipped);
    setSettings(await loadSettings(tauriFs));
    setError(null);
  }, []);

  useEffect(() => {
    (async () => {
      setSuggestedRoot(await suggestedDataRoot());
      const root = await getDataRoot();
      setRoot(root);
      if (root) await loadFolder();
      else setScreen("settings");
    })()
      .catch(fail)
      .finally(() => setReady(true));
  }, [loadFolder]);

  /** The shell has already switched folders by the time it reports the path. Null: cancelled. */
  const openFolder = async (path: string | null) => {
    if (!path) return;
    setRoot(path);
    await loadFolder();
  };

  if (!ready) return null;

  return (
    <div className="app">
      <header className="meta-row">
        <Mono>Wetware</Mono>
        <Mono>{today.toLocaleDateString("en-US", { weekday: "long" })}</Mono>
        <Mono>{today.toLocaleDateString("en-CA")}</Mono>
        <Mono muted>{dataRoot ? "Local files" : "No data folder"}</Mono>
      </header>

      <main className="app-main">
        {error && <Mono>{error}</Mono>}
        {skipped.map((entry) => (
          <Mono key={entry.index}>
            {HABITS_FILE}: habit {entry.index + 1}
            {entry.id === null ? "" : ` (${entry.id})`} is not shown: {entry.reason}.
          </Mono>
        ))}
        {screen === "month" && dataRoot && <Home habits={habits} today={today} />}
        {screen === "settings" && (
          <Settings
            dataRoot={dataRoot}
            suggestedRoot={suggestedRoot}
            settings={dataRoot ? settings : null}
            pagesGoal={morningPagesGoal(habits)}
            onChooseFolder={() => chooseDataRoot().then(openFolder).catch(fail)}
            onUseSuggested={() => adoptSuggestedDataRoot().then(openFolder).catch(fail)}
            onSave={(patch) => saveSettings(tauriFs, patch).then(done(setSettings)).catch(fail)}
            onPagesGoal={(goal) => setMorningPagesGoal(tauriFs, goal).then(done(setHabits)).catch(fail)}
          />
        )}
      </main>

      <nav className="nav headline" aria-label="Screens">
        {NAV.map((item, i) => (
          <span key={item.label}>
            <button
              type="button"
              className="nav-item"
              aria-current={item.id === screen ? "page" : undefined}
              disabled={item.id === null || (item.id === "month" && !dataRoot)}
              onClick={() => item.id && setScreen(item.id)}
            >
              {item.label}
            </button>
            {i < NAV.length - 1 && <span className="muted">,</span>}
          </span>
        ))}
      </nav>
    </div>
  );
}
