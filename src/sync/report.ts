/** What a sync has to say for itself, in plain words, for the message line and the grid header. */
import { dateKey, dayPath, shortDate } from "../data";
import type { SourceOutcome, SyncReport } from "./run";
import type { SyncProblem } from "./problems";

export type SourceName = "intervals.icu" | "Open-Meteo";

/** "a", "a and b", "a, b and c". */
function listed(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** How long a server asked to be left alone, in round words. */
function waitText(seconds: number | null): string {
  if (seconds === null) return "in a few minutes";
  if (seconds <= 60) return "in a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  return hours <= 1 ? "in about an hour" : `in about ${hours} hours`;
}

/**
 * What went wrong and what to do about it. `source` can be both sources at
 * once, for when they fail the same way.
 */
export function problemText(source: SourceName | SourceName[], problem: SyncProblem): string {
  const names = Array.isArray(source) ? source : [source];
  const who = listed(names);
  switch (problem.kind) {
    case "no_key":
      return "intervals.icu isn't connected. Add an API key in Settings.";
    case "key_rejected":
      return "intervals.icu did not accept the API key. Paste it again in Settings; it is under Developer Settings on intervals.icu.";
    case "rate_limited":
      return `${who} ${names.length === 1 ? "is" : "are"} limiting requests. Try again ${waitText(problem.retry_after_secs)}.`;
    case "offline":
      return `${who} could not be reached. Check the internet connection, then try again.`;
    case "unexpected":
      return `${who} sent something this app can't use (${problem.detail}). Try again later.`;
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

/** Whether two problems would be put in the same words, the source's name apart. */
function alike(a: SyncProblem, b: SyncProblem): boolean {
  if (a.kind === "rate_limited" && b.kind === "rate_limited") return a.retry_after_secs === b.retry_after_secs;
  if (a.kind === "unexpected" && b.kind === "unexpected") return a.detail === b.detail;
  return a.kind === b.kind && a.kind !== "key_rejected" && a.kind !== "no_key";
}

/** The shell's words for a file it won't replace because it is marked read-only. */
const READ_ONLY = /\bread-only\b/;

/**
 * The day files a sync had something for and left alone, every one of them
 * named, said once for each reason. A read-only file is called that, with
 * what to do about it.
 */
export function unwrittenText(unwritten: SyncReport["unwritten"]): string[] {
  const byReason = new Map<string, string[]>();
  for (const { date, reason } of unwritten) {
    const why = READ_ONLY.test(reason) ? "read-only" : reason.replace(/\.$/, "");
    byReason.set(why, [...(byReason.get(why) ?? []), dayPath(date)]);
  }
  return [...byReason].map(([why, files]) => {
    const one = files.length === 1;
    if (why === "read-only") {
      return `${listed(files)} ${one ? "is" : "are"} read-only, so ${one ? "it was" : "they were"} left as ${one ? "it is" : "they are"}. Unlock ${one ? "it" : "them"} in Finder (Get Info), then sync again.`;
    }
    return `${listed(files)} left as ${one ? "it is" : "they are"}: ${why}.`;
  });
}

/** That some of what intervals.icu sent couldn't be used, or null if all of it could. */
export function unreadableText(count: number): string | null {
  if (count === 0) return null;
  return `${count} ${count === 1 ? "record" : "records"} from intervals.icu could not be read and ${count === 1 ? "was" : "were"} left out.`;
}

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

  const { intervals, weather } = report;
  if (intervals.status === "failed" && weather.status === "failed" && alike(intervals.problem, weather.problem)) {
    // The same trouble with both: said once.
    parts.push(problemText(["intervals.icu", "Open-Meteo"], intervals.problem));
  } else {
    if (intervals.status === "failed") parts.push(problemText("intervals.icu", intervals.problem));
    else if (intervals.status === "not_set_up" && (asked || tellNotConnected)) parts.push(NOT_CONNECTED);

    if (weather.status === "failed") parts.push(problemText("Open-Meteo", weather.problem));
    else if (weather.status === "not_set_up" && asked) parts.push(NO_LOCATION);
  }

  const unreadable = unreadableText(report.unreadable);
  if (unreadable) parts.push(unreadable);
  parts.push(...unwrittenText(report.unwritten));
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
