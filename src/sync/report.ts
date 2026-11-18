/** What a sync has to say for itself, in plain words, for the message line and the grid header. */
import { dateKey, dayPath, shortDate } from "../data";
import type { SourceOutcome, SyncReport } from "./run";
import type { SyncProblem } from "./problems";

export type SourceName = "intervals.icu" | "Open-Meteo";

/** What went wrong with a source and what to do about it. */
export function problemText(source: SourceName, problem: SyncProblem): string {
  switch (problem.kind) {
    case "no_key":
      return "intervals.icu isn't connected. Add an API key in Settings.";
    case "key_rejected":
      return "intervals.icu did not accept the API key. Paste it again in Settings; it is under Developer Settings on intervals.icu.";
    case "rate_limited":
      return `${source} is limiting requests. Sync again in a few minutes.`;
    case "offline":
      return `${source} could not be reached. Check the internet connection, then sync again.`;
    case "unexpected":
      return `${source} sent something this app can't use (${problem.detail}). Sync again later.`;
  }
}

const NOT_CONNECTED = "intervals.icu isn't connected, so runs and sleep don't fill in. Add an API key in Settings.";
const NO_LOCATION = "Weather isn't logged until a latitude and longitude are set in Settings.";

export interface MessageOptions {
  /** The user pressed Sync, as opposed to the sync that runs when the app opens. */
  asked: boolean;
  /** Say that intervals.icu isn't connected, even though nobody asked: this is the one time it is said. */
  tellNotConnected: boolean;
}

const ran = (outcome: SourceOutcome) => outcome.status === "synced";

/**
 * The line a sync leaves on the message line, or null if it has nothing to
 * say. A sync that ran by itself and changed nothing says nothing, and a
 * source that isn't set up is not a problem: it is only mentioned when the
 * user asked for the sync, or the once that `tellNotConnected` allows.
 */
export function syncMessage(report: SyncReport, { asked, tellNotConnected }: MessageOptions): string | null {
  const parts: string[] = [];
  const count = report.changed.length;
  if (count > 0) parts.push(`${count} ${count === 1 ? "day" : "days"} updated.`);
  else if (asked && (ran(report.intervals) || ran(report.weather))) parts.push("nothing new.");

  if (report.intervals.status === "failed") parts.push(problemText("intervals.icu", report.intervals.problem));
  else if (report.intervals.status === "not_set_up" && (asked || tellNotConnected)) parts.push(NOT_CONNECTED);

  if (report.weather.status === "failed") parts.push(problemText("Open-Meteo", report.weather.problem));
  else if (report.weather.status === "not_set_up" && asked) parts.push(NO_LOCATION);

  if (report.unwritten.length > 0) {
    const [first, ...rest] = report.unwritten;
    const others = rest.length === 0 ? "" : ` and ${rest.length} more`;
    parts.push(`${dayPath(first.date)}${others} left as ${rest.length === 0 ? "it is" : "they are"}: ${first.reason.replace(/\.$/, "")}.`);
  }
  return parts.length > 0 ? `Sync: ${parts.join(" ")}` : null;
}

/** Whether a sync reached at least one source: the moment to remember as "last synced". */
export function reachedASource(report: SyncReport): boolean {
  return ran(report.intervals) || ran(report.weather);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "Last synced 06:27", with the day in front if it wasn't today. `today` is a date key. */
export function lastSyncedLabel(at: Date | null, today: string): string {
  if (at === null) return "Not synced yet";
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = dateKey(at);
  return day === today ? `Last synced ${time}` : `Last synced ${shortDate(day)}, ${time}`;
}
