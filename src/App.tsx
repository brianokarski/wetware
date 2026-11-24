import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mono } from "./components/primitives";
import {
  currentNotice, dateKey, drained, HABITS_FILE, loadHabitsFile, loadSettings, morningPagesGoal, pagesHabit, pagesNoticeKey, reason,
  saveSettings, setMorningPagesGoal, SETTINGS_FILE, weekdayName, withNotice, withoutNotices,
  type DataFs, type Habit, type Notice, type Settings as SettingsData, type SkippedHabit,
} from "./data";
import { now, useToday } from "./platform/clock";
import {
  adoptSuggestedDataRoot, chooseDataRoot, folderFs, getDataRoot, onFlushAsked, suggestedDataRoot, syncSources, type OpenFolder,
} from "./platform/tauri";
import { FLUSH_EVENT } from "./platform/useAutosave";
import { useSync } from "./platform/useSync";
import { testConnection } from "./sync";
import { DayPanel, type DayNav } from "./screens/DayPanel";
import { Grid, type GridPlace } from "./screens/Grid";
import { MorningPages } from "./screens/MorningPages";
import { Settings } from "./screens/Settings";

/** `room` is the writing room for morning pages, which takes the whole window. */
type Screen = "month" | "room" | "settings";

/** Later milestones fill these in; shown disabled so the map is visible. */
const NAV: { id: Screen | null; label: string }[] = [
  { id: "month", label: "Month" },
  { id: null, label: "Calendar" },
  { id: "room", label: "Pages" },
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
  /** The data folder now open, with the number the shell gave this opening of it. */
  const [folder, setFolder] = useState<OpenFolder | null>(null);
  const [suggestedRoot, setSuggestedRoot] = useState("");
  const [habits, setHabits] = useState<Habit[]>([]);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  /** Counts the times a data folder has loaded in full. */
  const [loads, setLoads] = useState(0);
  /** Whether the folder now open has had the sync that runs when a folder opens. */
  const syncedOnOpen = useRef(false);
  /** The day open in the day view, in place of the month grid. Null: the grid is showing. */
  const [day, setDay] = useState<string | null>(null);
  /**
   * Where the grid opens next, with the keyboard there: the header of the day
   * the day view was showing when it closed, or the Morning pages box of the
   * day the writing room was open on. Used once: it is cleared as soon as the
   * grid has opened there, so another month, or another screen and back, is
   * not pulled back to it.
   */
  const [returnTo, setReturnTo] = useState<GridPlace | null>(null);
  /** The day whose morning pages are open in the writing room. Null: the room is shut. */
  const [pagesDate, setPagesDate] = useState<string | null>(null);
  /** Which control of the day view's header has the keyboard when a day opens. */
  const [dayArrive, setDayArrive] = useState<DayNav>("month");
  /** The say of the day view, or of the writing room, on whether it can be left. Null when neither is open. */
  const leaveGuard = useRef<(() => boolean) | null>(null);
  const today = useToday();

  /** Puts a notice on the message line. It stays until `settle` is called with its key, or it is dismissed. */
  const notify = useCallback((key: string, text: string) => setNotices((list) => withNotice(list, key, text)), []);
  /** Takes notices off the line: what they were about has gone right. */
  const settle = useCallback((...keys: string[]) => setNotices((list) => withoutNotices(list, keys)), []);

  const dataRoot = folder?.path ?? null;
  /** File access to this opening of the folder. The shell refuses it once another folder is open. */
  const fs = useMemo(() => (folder ? folderFs(folder.id) : null), [folder]);
  const sync = useSync({ folder: folder?.id ?? null, fs, sources: syncSources, habits, settings, notify, settle });

  /** Read (and on first use, seed) the data folder. */
  const loadFolder = useCallback(async (fs: DataFs) => {
    // If this folder fails to load, nothing from the one open before may stay on screen under its path.
    setHabits([]);
    setSettings(null);
    settle("habits");
    const named = (file: string) => (e: unknown) => {
      throw new Error(`${file} could not be loaded. ${reason(e)}`);
    };
    const file = await loadHabitsFile(fs).catch(named(HABITS_FILE));
    setHabits(file.habits);
    if (file.skipped.length > 0) notify("habits", skippedNotice(file.skipped));
    setSettings(await loadSettings(fs).catch(named(SETTINGS_FILE)));
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
      const opened = await getDataRoot();
      setFolder(opened);
      if (opened) await loadFolder(folderFs(opened.id));
      else setScreen("settings");
    })()
      .catch((e) => notify("folder", reason(e)))
      .finally(() => setReady(true));
  }, [loadFolder, notify]);

  /**
   * The shell has already opened the folder by the time it reports it. From
   * that moment it refuses whatever still carries the last folder's number,
   * a sync under way included. Null: the picker was cancelled, nothing has
   * changed, and whatever was running goes on.
   */
  const openFolder = async (opened: OpenFolder | null) => {
    if (!opened) return;
    setFolder(opened);
    setDay(null);
    setReturnTo(null);
    syncedOnOpen.current = false;
    await loadFolder(folderFs(opened.id));
  };
  const changeFolder = (choose: () => Promise<OpenFolder | null>) => choose().then(openFolder).catch(failed("folder"));

  /** For a promise's catch: puts what went wrong on the message line, under `key`. */
  const failed = (key: string, what = "") => (e: unknown) => notify(key, `${what} ${reason(e)}`.trim());
  /** For a promise's then: takes the result, and settles any earlier failure of the same thing. */
  const saved = <T,>(key: string, take: (value: T) => void) => (value: T) => {
    take(value);
    settle(key);
  };

  // The shell holds a close or a quit until what is typed is on disk. When it asks, every field that saves as
  // it is typed in is told to save now, and the shell is answered once the folder has nothing left on its way.
  const flushing = useRef<DataFs | null>(null);
  flushing.current = fs;
  useEffect(
    () =>
      onFlushAsked(async () => {
        window.dispatchEvent(new Event(FLUSH_EVENT));
        if (flushing.current) await drained(flushing.current);
      }),
    [],
  );

  /** Whether the day view, if one is open, can be left. It says why on the message line when it can't. */
  const mayLeave = useCallback(() => leaveGuard.current === null || leaveGuard.current(), []);
  /**
   * Opens a day in place of the month, or in place of the day now open. A
   * day that hasn't come yet has nothing to open: this is the one place that
   * is decided. `via` is the control used, which has the keyboard in the day that opens.
   */
  const openDay = useCallback(
    (date: string, via: DayNav = "month") => {
      if (date > dateKey(now()) || !mayLeave()) return;
      setDayArrive(via);
      setDay(date);
    },
    [mayLeave],
  );
  /** Back to the month, with the keyboard on the header of the day that was open. */
  const closeDay = useCallback(() => {
    if (!mayLeave()) return;
    if (day !== null) setReturnTo({ date: day });
    setDay(null);
  }, [day, mayLeave]);
  /**
   * Opens the writing room on a day's morning pages, in place of everything
   * else. A day that hasn't come yet has no pages to write.
   */
  const openPages = useCallback(
    (date: string) => {
      if (date > dateKey(now()) || !mayLeave()) return;
      setDay(null);
      setPagesDate(date);
      setScreen("room");
    },
    [mayLeave],
  );
  /** Out of the writing room, to the month its day is in, with the keyboard on that day's Morning pages box. */
  const leavePages = useCallback(() => {
    if (!mayLeave()) return;
    if (pagesDate !== null) setReturnTo({ date: pagesDate, habit: pagesHabit(habits)?.id });
    setPagesDate(null);
    setScreen("month");
  }, [pagesDate, habits, mayLeave]);
  /**
   * Today's pages: for the ways in that mean "today" and name no day. The
   * clock is asked at the moment of asking. The `today` on screen can be a
   * few seconds behind just after midnight, and the writing must not land
   * in yesterday's file.
   */
  const writeToday = useCallback(() => openPages(dateKey(now())), [openPages]);
  /** The grid has opened where it was asked to. From here on it opens where it always does. */
  const arrived = useCallback(() => setReturnTo(null), []);

  if (!ready) return null;
  const notice = currentNotice(notices);

  // The writing room is bare: no header, no message line, no navigation. What it has to say, it says itself.
  if (screen === "room" && folder && fs && pagesDate !== null) {
    return (
      <MorningPages
        key={`${folder.id} ${pagesDate}`}
        fs={fs}
        habit={pagesHabit(habits)}
        date={pagesDate}
        notice={notices.find((said) => said.key === pagesNoticeKey(pagesDate))?.text ?? null}
        leaveGuard={leaveGuard}
        onLeave={leavePages}
        notify={notify}
        settle={settle}
      />
    );
  }

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
        {screen === "month" && folder && fs && day !== null && (
          <DayPanel
            key={`${folder.id} ${day}`}
            fs={fs}
            habits={habits}
            date={day}
            today={today}
            temperature={settings?.units.temperature ?? "F"}
            revision={sync.revision}
            arrive={dayArrive}
            leaveGuard={leaveGuard}
            onClose={closeDay}
            onGo={openDay}
            notify={notify}
            settle={settle}
          />
        )}
        {screen === "month" && folder && fs && day === null && (
          <Grid
            key={folder.id}
            fs={fs}
            habits={habits}
            today={today}
            openAt={returnTo}
            onArrive={arrived}
            onOpenDay={openDay}
            onOpenPages={openPages}
            onWriteToday={writeToday}
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
            settings={fs ? settings : null}
            habits={habits}
            pagesGoal={morningPagesGoal(habits)}
            withheld={sync.withheld}
            unreadable={sync.unreadable}
            onTestConnection={() => testConnection(syncSources, now())}
            onChooseFolder={() => changeFolder(chooseDataRoot)}
            onUseSuggested={() => changeFolder(adoptSuggestedDataRoot)}
            onSave={(patch) => fs && saveSettings(fs, patch).then(saved("settings", setSettings)).catch(failed("settings", "Settings were not saved."))}
            onPagesGoal={(goal) => fs && setMorningPagesGoal(fs, goal).then(saved("goal", setHabits)).catch(failed("goal", "The word goal was not saved."))}
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
              disabled={item.id === null || (item.id !== "settings" && !dataRoot)}
              onClick={() => {
                if (!item.id || !mayLeave()) return;
                // The way to the writing room is today's pages.
                if (item.id === "room") return writeToday();
                // "Month" is the month: from a day, it goes back to the grid.
                if (item.id === "month") closeDay();
                setScreen(item.id);
              }}
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
