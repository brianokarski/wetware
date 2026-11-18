import { useCallback, useEffect, useRef, useState } from "react";
import { Mono } from "./components/primitives";
import {
  currentNotice, HABITS_FILE, loadHabitsFile, loadSettings, morningPagesGoal, reason, saveSettings, setMorningPagesGoal,
  SETTINGS_FILE, weekdayName, withNotice, withoutNotices,
  type Habit, type Notice, type Settings as SettingsData, type SkippedHabit,
} from "./data";
import { now, useToday } from "./platform/clock";
import {
  chooseDataRoot, getDataRoot, suggestedDataRoot, syncSources, tauriFs, adoptSuggestedDataRoot,
} from "./platform/tauri";
import { useSync } from "./platform/useSync";
import { testConnection } from "./sync";
import { Grid } from "./screens/Grid";
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

/** One line for the habits in habits.yaml that couldn't be used. They stay in the file as they are. */
function skippedNotice(skipped: SkippedHabit[]): string {
  const each = skipped.map((entry) => `Habit ${entry.index + 1}${entry.id === null ? "" : ` (${entry.id})`} ${entry.reason}.`);
  const count = skipped.length === 1 ? "1 habit is" : `${skipped.length} habits are`;
  return `${HABITS_FILE}: ${count} not shown. ${each.join(" ")}`;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState<Screen>("month");
  const [dataRoot, setRoot] = useState<string | null>(null);
  const [suggestedRoot, setSuggestedRoot] = useState("");
  const [habits, setHabits] = useState<Habit[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  /** Counts the times a data folder has loaded in full. */
  const [loads, setLoads] = useState(0);
  /** Whether the folder now open has had the sync that runs when a folder opens. */
  const syncedOnOpen = useRef(false);
  const today = useToday();

  /** Puts a notice on the message line. It stays until `settle` is called with its key, or it is dismissed. */
  const notify = useCallback((key: string, text: string) => setNotices((list) => withNotice(list, key, text)), []);
  /** Takes notices off the line: what they were about has gone right. */
  const settle = useCallback((...keys: string[]) => setNotices((list) => withoutNotices(list, keys)), []);

  const sync = useSync({ fs: tauriFs, sources: syncSources, habits, settings: dataRoot ? settings : null, notify, settle });

  /** Read (and on first use, seed) the data folder. */
  const loadFolder = useCallback(async () => {
    // If this folder fails to load, nothing from the one open before may stay on screen under its path.
    setHabits([]);
    setSettings(null);
    settle("habits");
    const named = (file: string) => (e: unknown) => {
      throw new Error(`${file} could not be loaded. ${reason(e)}`);
    };
    const file = await loadHabitsFile(tauriFs).catch(named(HABITS_FILE));
    setHabits(file.habits);
    if (file.skipped.length > 0) notify("habits", skippedNotice(file.skipped));
    setSettings(await loadSettings(tauriFs).catch(named(SETTINGS_FILE)));
    settle("folder");
    setLoads((count) => count + 1);
  }, [notify, settle]);

  // Sync runs when a folder opens: once its habits and settings are in, and once per folder.
  const { run: runSync } = sync;
  useEffect(() => {
    if (loads === 0 || syncedOnOpen.current) return;
    syncedOnOpen.current = true;
    void runSync(false);
  }, [loads, runSync]);

  useEffect(() => {
    (async () => {
      setSuggestedRoot(await suggestedDataRoot());
      const root = await getDataRoot();
      setRoot(root);
      if (root) await loadFolder();
      else setScreen("settings");
    })()
      .catch((e) => notify("folder", reason(e)))
      .finally(() => setReady(true));
  }, [loadFolder, notify]);

  /** The shell has already switched folders by the time it reports the path. Null: cancelled. */
  const openFolder = async (path: string | null) => {
    if (!path) return;
    setRoot(path);
    sync.forget();
    syncedOnOpen.current = false;
    await loadFolder();
  };
  /**
   * Before the shell is asked to change folders, a sync under way is called
   * off: what it fetched was worked out for the folder it started on, and
   * must not be written into another.
   */
  const changeFolder = (choose: () => Promise<string | null>) => {
    sync.stop();
    return choose().then(openFolder).catch(failed("folder"));
  };

  /** For a promise's catch: puts what went wrong on the message line, under `key`. */
  const failed = (key: string, what = "") => (e: unknown) => notify(key, `${what} ${reason(e)}`.trim());
  /** For a promise's then: takes the result, and settles any earlier failure of the same thing. */
  const saved = <T,>(key: string, take: (value: T) => void) => (value: T) => {
    take(value);
    settle(key);
  };

  /** The day panel arrives in Milestone 4. Until then a day header has nothing to open. */
  const openDay = useCallback((_date: string) => {}, []);

  if (!ready) return null;
  const notice = currentNotice(notices);

  return (
    <div className="app">
      <header className="meta-row">
        <Mono>Wetware</Mono>
        <Mono>{weekdayName(today)}</Mono>
        <Mono>{today}</Mono>
        <Mono muted>{dataRoot ? "Local files" : "No data folder"}</Mono>
      </header>

      {/* The message line. It has a place of its own in the gap under the header, so nothing below moves when a message comes or goes. */}
      <div className="notices">
        <p className="notice mono" role="alert" title={notice?.text}>
          {notice?.text}
        </p>
        {notice && (
          <button type="button" className="notice-dismiss choice mono" onClick={() => settle(notice.key)}>
            Dismiss{notices.length > 1 ? ` (1 of ${notices.length})` : ""}
          </button>
        )}
      </div>

      <main className="app-main">
        {screen === "month" && dataRoot && (
          <Grid
            key={dataRoot}
            fs={tauriFs}
            habits={habits}
            today={today}
            onOpenDay={openDay}
            notify={notify}
            settle={settle}
            sync={sync}
            onSync={() => void sync.run(true)}
          />
        )}
        {screen === "settings" && (
          <Settings
            dataRoot={dataRoot}
            suggestedRoot={suggestedRoot}
            settings={dataRoot ? settings : null}
            habits={habits}
            pagesGoal={morningPagesGoal(habits)}
            withheld={sync.withheld}
            onTestConnection={() => testConnection(syncSources, now())}
            onChooseFolder={() => changeFolder(chooseDataRoot)}
            onUseSuggested={() => changeFolder(adoptSuggestedDataRoot)}
            onSave={(patch) => saveSettings(tauriFs, patch).then(saved("settings", setSettings)).catch(failed("settings", "Settings were not saved."))}
            onPagesGoal={(goal) => setMorningPagesGoal(tauriFs, goal).then(saved("goal", setHabits)).catch(failed("goal", "The word goal was not saved."))}
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
