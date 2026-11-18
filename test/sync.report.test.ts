/** What a sync says on the message line and in the grid header. */
import { describe, expect, it } from "vitest";
import { lastSyncedLabel, problemText, reachedASource, syncMessage, type SyncReport } from "../src/sync";

const report = (fields: Partial<SyncReport> = {}): SyncReport => ({
  range: { oldest: "2026-10-25", newest: "2026-11-17" },
  syncedAt: "2026-11-17T09:41:07-08:00",
  changed: [],
  intervals: { status: "synced" },
  weather: { status: "synced" },
  withheld: 0,
  unwritten: [],
  stopped: false,
  ...fields,
});

const OPENED = { asked: false, tellNotConnected: false };
const ASKED = { asked: true, tellNotConnected: false };
const NOT_SET_UP = { status: "not_set_up" } as const;

describe("the line a sync leaves", () => {
  it("says how many days changed", () => {
    expect(syncMessage(report({ changed: ["2026-11-16", "2026-11-17", "2026-11-09"] }), OPENED)).toBe("Sync: 3 days updated.");
    expect(syncMessage(report({ changed: ["2026-11-17"] }), OPENED)).toBe("Sync: 1 day updated.");
    expect(syncMessage(report({ changed: ["2026-11-17"] }), ASKED)).toBe("Sync: 1 day updated.");
  });

  it("says nothing when it ran by itself and changed nothing, and says so when it was asked for", () => {
    expect(syncMessage(report(), OPENED)).toBeNull();
    expect(syncMessage(report(), ASKED)).toBe("Sync: nothing new.");
  });

  it("doesn't treat a source that isn't set up as a problem", () => {
    const neither = report({ intervals: NOT_SET_UP, weather: NOT_SET_UP });
    expect(syncMessage(neither, OPENED)).toBeNull();
    expect(syncMessage(report({ intervals: NOT_SET_UP, changed: ["2026-11-17"] }), OPENED)).toBe("Sync: 1 day updated.");
    expect(syncMessage(report({ weather: NOT_SET_UP }), OPENED)).toBeNull();
  });

  it("says once, unasked, that intervals.icu isn't connected, and where to connect it", () => {
    const once = { asked: false, tellNotConnected: true };
    expect(syncMessage(report({ intervals: NOT_SET_UP }), once)).toBe(
      "Sync: intervals.icu isn't connected, so runs and sleep don't fill in. Add an API key in Settings.",
    );
    expect(syncMessage(report({ intervals: NOT_SET_UP, changed: ["2026-11-17"] }), once)).toBe(
      "Sync: 1 day updated. intervals.icu isn't connected, so runs and sleep don't fill in. Add an API key in Settings.",
    );
    // Connected: there is nothing to tell.
    expect(syncMessage(report(), once)).toBeNull();
  });

  it("says what isn't set up when the user asked for the sync", () => {
    expect(syncMessage(report({ intervals: NOT_SET_UP, weather: NOT_SET_UP }), ASKED)).toBe(
      "Sync: intervals.icu isn't connected, so runs and sleep don't fill in. Add an API key in Settings. Weather isn't logged until a latitude and longitude are set in Settings.",
    );
    expect(syncMessage(report({ weather: NOT_SET_UP }), ASKED)).toBe(
      "Sync: nothing new. Weather isn't logged until a latitude and longitude are set in Settings.",
    );
  });

  it("says what went wrong and what to do about it, whoever started the sync", () => {
    const failed = (problem: Parameters<typeof problemText>[1]) => ({ status: "failed", problem }) as const;
    expect(syncMessage(report({ intervals: failed({ kind: "key_rejected" }) }), OPENED)).toBe(
      "Sync: intervals.icu did not accept the API key. Paste it again in Settings; it is under Developer Settings on intervals.icu.",
    );
    expect(syncMessage(report({ intervals: failed({ kind: "offline" }), weather: failed({ kind: "offline" }) }), OPENED)).toBe(
      "Sync: intervals.icu could not be reached. Check the internet connection, then sync again. Open-Meteo could not be reached. Check the internet connection, then sync again.",
    );
    expect(syncMessage(report({ changed: ["2026-11-17"], intervals: failed({ kind: "rate_limited", retry_after_secs: 90 }) }), ASKED)).toBe(
      "Sync: 1 day updated. intervals.icu is limiting requests. Sync again in a few minutes.",
    );
    expect(syncMessage(report({ weather: failed({ kind: "unexpected", detail: "HTTP 502" }) }), ASKED)).toBe(
      "Sync: nothing new. Open-Meteo sent something this app can't use (HTTP 502). Sync again later.",
    );
    // Nothing was reached: no "nothing new", which would suggest it looked.
    expect(syncMessage(report({ intervals: failed({ kind: "offline" }), weather: NOT_SET_UP }), ASKED)).toBe(
      "Sync: intervals.icu could not be reached. Check the internet connection, then sync again. Weather isn't logged until a latitude and longitude are set in Settings.",
    );
  });

  it("names a day file it had to leave alone", () => {
    const one = report({ changed: ["2026-11-17"], unwritten: [{ date: "2026-11-12", reason: "Frontmatter: Invalid YAML: Map keys must be unique (line 4)." }] });
    expect(syncMessage(one, OPENED)).toBe(
      "Sync: 1 day updated. days/2026-11-12.md left as it is: Frontmatter: Invalid YAML: Map keys must be unique (line 4).",
    );
    const three = report({ unwritten: ["2026-11-03", "2026-11-04", "2026-11-12"].map((date) => ({ date, reason: "No space left on device (os error 28)" })) });
    expect(syncMessage(three, OPENED)).toBe(
      "Sync: days/2026-11-03.md and 2 more left as they are: No space left on device (os error 28).",
    );
  });

  it("never mentions a streak, in any message it can produce", () => {
    const failed = (problem: Parameters<typeof problemText>[1]) => ({ status: "failed", problem }) as const;
    const problems = [{ kind: "no_key" }, { kind: "key_rejected" }, { kind: "offline" }, { kind: "rate_limited", retry_after_secs: null }, { kind: "unexpected", detail: "HTTP 500" }] as const;
    const lines = problems.flatMap((problem) => [
      problemText("intervals.icu", problem),
      problemText("Open-Meteo", problem),
      syncMessage(report({ intervals: failed(problem), weather: NOT_SET_UP, changed: ["2026-11-17"] }), ASKED)!,
    ]);
    for (const line of lines) expect(line).not.toMatch(/streak|in a row|chain/i);
  });
});

describe("the last-synced time", () => {
  const today = "2026-11-17";

  it("is the time of day when it was today", () => {
    expect(lastSyncedLabel(new Date(2026, 10, 17, 6, 27, 59), today)).toBe("Last synced 06:27");
    expect(lastSyncedLabel(new Date(2026, 10, 17, 0, 5), today)).toBe("Last synced 00:05");
    expect(lastSyncedLabel(new Date(2026, 10, 17, 23, 59), today)).toBe("Last synced 23:59");
  });

  it("has the day in front when it was another day", () => {
    expect(lastSyncedLabel(new Date(2026, 10, 16, 21, 5), today)).toBe("Last synced Nov 16, 21:05");
    expect(lastSyncedLabel(new Date(2025, 11, 31, 23, 59), today)).toBe("Last synced Dec 31, 23:59");
    // Left open past midnight: the sync of a moment ago was yesterday.
    expect(lastSyncedLabel(new Date(2026, 10, 17, 23, 59), "2026-11-18")).toBe("Last synced Nov 17, 23:59");
  });

  it("says so when there hasn't been one", () => {
    expect(lastSyncedLabel(null, today)).toBe("Not synced yet");
  });

  it("is only remembered for a sync that reached a source", () => {
    expect(reachedASource(report())).toBe(true);
    expect(reachedASource(report({ intervals: NOT_SET_UP }))).toBe(true);
    expect(reachedASource(report({ intervals: { status: "failed", problem: { kind: "offline" } }, weather: NOT_SET_UP }))).toBe(false);
    expect(reachedASource(report({ intervals: NOT_SET_UP, weather: NOT_SET_UP }))).toBe(false);
  });
});
