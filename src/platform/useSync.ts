import { useCallback, useEffect, useRef, useState } from "react";
import { reason, type DataFs, type Habit, type Settings } from "../data";
import { reachedASource, runSync, syncMessage, type SyncSources } from "../sync";
import { now } from "./clock";
import { syncState, type SyncState } from "./tauri";

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
}

interface Options {
  fs: DataFs;
  sources: SyncSources;
  habits: Habit[];
  /** Null while no data folder is loaded: there is nothing to sync into. */
  settings: Settings | null;
  notify: (key: string, text: string) => void;
  settle: (...keys: string[]) => void;
}

/**
 * Runs syncs, one at a time, and keeps what the screens show about them.
 * `run(asked)` starts one: `asked` is false for the sync that runs when a
 * folder opens, which keeps quiet unless something changed or went wrong.
 * `stop()` calls off a sync that is under way, before the data folder is
 * changed; `forget()` clears what is shown, once it has been.
 */
export function useSync({ fs, sources, habits, settings, notify, settle }: Options) {
  const [view, setView] = useState<SyncView>({ running: false, lastSynced: null, revision: 0, withheld: 0 });
  /** Which data folder a sync belongs to. `stop()` moves on to the next. */
  const epoch = useRef(0);
  /** The epoch of the sync under way, or null when none is. */
  const busy = useRef<number | null>(null);
  /** A sync asked for while one that has been called off was still winding down. It runs next. */
  const waiting = useRef<boolean | null>(null);
  /** The habits and settings as they are when a sync starts, without restarting anything when they change. */
  const latest = useRef({ habits, settings });
  useEffect(() => {
    latest.current = { habits, settings };
  });

  const run = useCallback(
    async (asked: boolean) => {
      const { habits, settings } = latest.current;
      if (!settings) return;
      if (busy.current !== null) {
        // One at a time. A second request is dropped, unless the one under way is for a folder no longer open.
        if (busy.current !== epoch.current) waiting.current = asked;
        return;
      }
      const mine = epoch.current;
      busy.current = mine;
      const current = () => epoch.current === mine;
      try {
        const before = await syncState.get();
        if (!current()) return;
        const at = now();
        setView((v) => ({ ...v, running: true, lastSynced: before.last_synced_ms === null ? null : new Date(before.last_synced_ms) }));
        const report = await runSync({ fs, sources, habits, settings, now: at, stillWanted: current });
        // Called off: the folder it was for is no longer the one open. Nothing it found is shown.
        if (report.stopped || !current()) return;

        // Not connected is said once, unasked. Connecting a key and removing it again earns it one more time.
        const notConnected = report.intervals.status === "not_set_up";
        const message = syncMessage(report, { asked, tellNotConnected: notConnected && !before.intervals_hint_shown });
        if (message) notify(SYNC_NOTICE, message);
        else settle(SYNC_NOTICE);

        const reached = reachedASource(report);
        const after: SyncState = {
          last_synced_ms: reached ? at.getTime() : before.last_synced_ms,
          intervals_hint_shown: notConnected,
        };
        setView((v) => ({
          ...v,
          lastSynced: reached ? at : v.lastSynced,
          revision: report.changed.length > 0 ? v.revision + 1 : v.revision,
          withheld: report.withheld,
        }));
        if (after.last_synced_ms !== before.last_synced_ms || after.intervals_hint_shown !== before.intervals_hint_shown) {
          await syncState.set(after);
        }
      } catch (e) {
        // Sources and day files failing are in the report. This is the shell itself not answering.
        if (current()) notify(SYNC_NOTICE, `Sync did not finish. ${reason(e)}`);
      } finally {
        busy.current = null;
        setView((v) => ({ ...v, running: false }));
        const next = waiting.current;
        waiting.current = null;
        if (next !== null) void run(next);
      }
    },
    [fs, sources, notify, settle],
  );

  const stop = useCallback(() => void epoch.current++, []);
  const forget = useCallback(() => setView((v) => ({ ...v, lastSynced: null, withheld: 0 })), []);

  return { ...view, run, stop, forget };
}
