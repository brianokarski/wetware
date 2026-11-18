import { useCallback, useEffect, useState } from "react";
import { Mono } from "./components/primitives";
import {
  loadHabits, loadSettings, morningPagesGoal, saveSettings, setMorningPagesGoal,
  type Habit, type Settings as SettingsData,
} from "./data";
import {
  chooseDataRoot, getDataRoot, setDataRoot, suggestedDataRoot, tauriFs,
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
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = new Date();

  const fail = (e: unknown) => setError(String(e));

  /** Read (and on first use, seed) the data folder. */
  const loadFolder = useCallback(async () => {
    setHabits(await loadHabits(tauriFs));
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

  const useFolder = async (path: string | null) => {
    if (!path) return;
    await setDataRoot(path);
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
        {screen === "month" && dataRoot && <Home habits={habits} today={today} />}
        {screen === "settings" && (
          <Settings
            dataRoot={dataRoot}
            suggestedRoot={suggestedRoot}
            settings={dataRoot ? settings : null}
            pagesGoal={morningPagesGoal(habits)}
            onChooseFolder={() => chooseDataRoot(dataRoot).then(useFolder).catch(fail)}
            onUseSuggested={() => useFolder(suggestedRoot).catch(fail)}
            onSave={(patch) => saveSettings(tauriFs, patch).then(setSettings).catch(fail)}
            onPagesGoal={(goal) => setMorningPagesGoal(tauriFs, goal).then(setHabits).catch(fail)}
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
