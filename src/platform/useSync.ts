import { useCallback, useEffect, useRef, useState } from "react";
import { FolderChangedError, reason, type DataFs, type Habit, type Settings } from "../data";
import { reachedASource, runSync, syncMessage, type SyncSources } from "../sync";
import { now } from "./clock";
import { syncStateOf, type SyncState } from "./tauri";

/** The notice key for what a sync has to say. One line: the next sync replaces or clears it. */
const SYNC_NOTICE = "sync";

export interface SyncView {
  /** A sync is under way. */
  running: boolean;
  /** When a sync last reached a source. Null: not yet, on this data folder. */
  lastSynced: Date | null;
  /** Counts up each time a sync has written day files, so a screen showing them reads them again. */
  revision: number;
  /** Activities the last sync couldn't read because they came through Strava. */
  withheld: number;
  /** Records the last sync couldn't use: no day or start it could read, or no type. */
  unreadable: number;
}

interface Options {
  /** The number of the folder now open, and file access to it. Null while none is. */
  folder: number | null;
  fs: DataFs | null;
  sources: SyncSources;
  habits: Habit[];
  /** Null until the folder's settings are loaded: there is nothing to sync into. */
  settings: Settings | null;
  notify: (key: string, text: string) => void;
  settle: (...keys: string[]) => void;
}

const NOTHING_YET = { lastSynced: null, withheld: 0, unreadable: 0 };

/**
 * Runs syncs, one at a time, and keeps what the screens show about them.
 * `run(asked)` starts one: `asked` is false for the sync that runs when a
 * folder opens, which keeps quiet unless something changed or went wrong.
 *
 * A sync belongs to the folder that was open when it began. If another is
 * opened while it runs, the shell refuses it any further access, it stops,
 * and nothing it found is shown. Nothing else stops one: not opening the
 * folder picker, and not cancelling it.
 */
export function useSync({ folder, fs, sources, habits, settings, notify, settle }: Options) {
  const [view, setView] = useState<SyncView>({ running: false, revision: 0, ...NOTHING_YET });
  /** The folder the sync under way is for, or null when none is. */
  const busy = useRef<number | null>(null);
  /** A sync asked for while one for a folder since left was still winding down. It runs next. */
  const waiting = useRef<boolean | null>(null);
  /** What a sync starts from, as it is at that moment, without restarting anything when it changes. */
  const latest = useRef({ folder, fs, habits, settings });
  useEffect(() => {
    latest.current = { folder, fs, habits, settings };
  });
  // What is shown is about the folder now open. Another folder starts from nothing.
  useEffect(() => setView((v) => ({ ...v, ...NOTHING_YET })), [folder]);

  const run = useCallback(
    async (asked: boolean) => {
      const { folder, fs, habits, settings } = latest.current;
      if (folder === null || !fs || !settings) return;
      if (busy.current !== null) {
        // One at a time. A second request is dropped, unless the one under way is for a folder no longer open.
        if (busy.current !== folder) waiting.current = asked;
        return;
      }
      busy.current = folder;
      const record = syncStateOf(folder);
      try {
        const before = await record.get();
        const at = now();
        setView((v) => ({ ...v, running: true, lastSynced: before.last_synced_ms === null ? null : new Date(before.last_synced_ms) }));
        const report = await runSync({ fs, sources, habits, settings, now: at });
        // The folder was changed under it. What it found is for a folder no longer open, and is not shown.
        if (report.stopped) return;

        // Not connected is said once, unasked. Connecting a key and removing it again earns it one more time.
        const notConnected = report.intervals.status === "not_set_up";
        let message = syncMessage(report, { asked, tellNotConnected: notConnected && !before.intervals_hint_shown });
        const reached = reachedASource(report);
        const after: SyncState = {
          last_synced_ms: reached ? at.getTime() : before.last_synced_ms,
          intervals_hint_shown: notConnected,
        };
        if (after.last_synced_ms !== before.last_synced_ms || after.intervals_hint_shown !== before.intervals_hint_shown) {
          // Recorded before anything is shown: the shell refuses this too if the folder has changed.
          await record.set(after).catch((e) => {
            if (e instanceof FolderChangedError) throw e;
            // The sync itself is done and its files are written. Only the app's memory of it is at stake.
            message = `${message ?? "Sync: done."} The time of this sync could not be kept. ${reason(e)}`;
          });
        }
        if (message) notify(SYNC_NOTICE, message);
        else settle(SYNC_NOTICE);
        setView((v) => ({
          ...v,
          lastSynced: reached ? at : v.lastSynced,
          revision: report.changed.length > 0 ? v.revision + 1 : v.revision,
          withheld: report.withheld,
          unreadable: report.unreadable,
        }));
      } catch (e) {
        // Sources and day files failing are in the report. This is the shell itself: refusing a folder
        // that was left, which is no news to the user, or not answering, which is.
        if (!(e instanceof FolderChangedError)) notify(SYNC_NOTICE, `Sync did not finish. ${reason(e)}`);
      } finally {
        busy.current = null;
        setView((v) => ({ ...v, running: false }));
        const next = waiting.current;
        waiting.current = null;
        if (next !== null) void run(next);
      }
    },
    [sources, notify, settle],
  );

  return { ...view, run };
}
