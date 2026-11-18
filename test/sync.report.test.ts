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
  unreadable: 0,
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
    expect(syncMessage(report({ changed: ["2026-11-17"], intervals: failed({ kind: "rate_limited", retry_after_secs: null }) }), ASKED)).toBe(
      "Sync: 1 day updated. intervals.icu is limiting requests. Try again in a few minutes.",
    );
    expect(syncMessage(report({ weather: failed({ kind: "unexpected", detail: "HTTP 502" }) }), ASKED)).toBe(
      "Sync: nothing new. Open-Meteo sent something this app can't use (HTTP 502). Try again later.",
    );
    // Nothing was reached: no "nothing new", which would suggest it looked.
    expect(syncMessage(report({ intervals: failed({ kind: "offline" }), weather: NOT_SET_UP }), ASKED)).toBe(
      "Sync: intervals.icu could not be reached. Check the internet connection, then try again. Weather isn't logged until a latitude and longitude are set in Settings.",
    );
  });

  it("gives the wait the server asked for when it limits requests", () => {
    const limited = (secs: number | null) => problemText("intervals.icu", { kind: "rate_limited", retry_after_secs: secs });
    expect(limited(null)).toBe("intervals.icu is limiting requests. Try again in a few minutes.");
    expect(limited(0)).toBe("intervals.icu is limiting requests. Try again in a minute.");
    expect(limited(60)).toBe("intervals.icu is limiting requests. Try again in a minute.");
    expect(limited(61)).toBe("intervals.icu is limiting requests. Try again in about 2 minutes.");
    expect(limited(90)).toBe("intervals.icu is limiting requests. Try again in about 2 minutes.");
    expect(limited(600)).toBe("intervals.icu is limiting requests. Try again in about 10 minutes.");
    expect(limited(3540)).toBe("intervals.icu is limiting requests. Try again in about 59 minutes.");
    expect(limited(3600)).toBe("intervals.icu is limiting requests. Try again in about an hour.");
    expect(limited(5000)).toBe("intervals.icu is limiting requests. Try again in about an hour.");
    expect(limited(7200)).toBe("intervals.icu is limiting requests. Try again in about 2 hours.");
    expect(limited(86400)).toBe("intervals.icu is limiting requests. Try again in about 24 hours.");
  });

  it("says a trouble both sources share once, and troubles that differ each in turn", () => {
    const failed = (problem: Parameters<typeof problemText>[1]) => ({ status: "failed", problem }) as const;
    const both = (a: Parameters<typeof problemText>[1], b = a) => syncMessage(report({ intervals: failed(a), weather: failed(b) }), OPENED);
    expect(both({ kind: "offline" })).toBe(
      "Sync: intervals.icu and Open-Meteo could not be reached. Check the internet connection, then try again.",
    );
    expect(both({ kind: "rate_limited", retry_after_secs: 600 })).toBe(
      "Sync: intervals.icu and Open-Meteo are limiting requests. Try again in about 10 minutes.",
    );
    expect(both({ kind: "unexpected", detail: "HTTP 503" })).toBe(
      "Sync: intervals.icu and Open-Meteo sent something this app can't use (HTTP 503). Try again later.",
    );
    // Not the same: different waits, different details, different kinds.
    expect(both({ kind: "rate_limited", retry_after_secs: 600 }, { kind: "rate_limited", retry_after_secs: 30 })).toBe(
      "Sync: intervals.icu is limiting requests. Try again in about 10 minutes. Open-Meteo is limiting requests. Try again in a minute.",
    );
    expect(both({ kind: "unexpected", detail: "HTTP 500" }, { kind: "unexpected", detail: "HTTP 503" })).toBe(
      "Sync: intervals.icu sent something this app can't use (HTTP 500). Try again later. Open-Meteo sent something this app can't use (HTTP 503). Try again later.",
    );
    expect(both({ kind: "key_rejected" }, { kind: "offline" })).toBe(
      "Sync: intervals.icu did not accept the API key. Paste it again in Settings; it is under Developer Settings on intervals.icu. Open-Meteo could not be reached. Check the internet connection, then try again.",
    );
  });

  it("says how many records it couldn't read", () => {
    expect(syncMessage(report({ unreadable: 1 }), OPENED)).toBe("Sync: 1 record from intervals.icu could not be read and was left out.");
    expect(syncMessage(report({ unreadable: 44 }), ASKED)).toBe("Sync: nothing new. 44 records from intervals.icu could not be read and were left out.");
    expect(syncMessage(report({ unreadable: 3, changed: ["2026-11-17"] }), OPENED)).toBe(
      "Sync: 1 day updated. 3 records from intervals.icu could not be read and were left out.",
    );
  });

  it("names every day file it had to leave alone, grouped by why", () => {
    const yaml = "Frontmatter: Invalid YAML: Map keys must be unique (line 4).";
    const one = report({ changed: ["2026-11-17"], unwritten: [{ date: "2026-11-12", reason: yaml }] });
    expect(syncMessage(one, OPENED)).toBe(
      "Sync: 1 day updated. days/2026-11-12.md left as it is: Frontmatter: Invalid YAML: Map keys must be unique (line 4).",
    );
    const full = report({ unwritten: ["2026-11-03", "2026-11-04", "2026-11-12"].map((date) => ({ date, reason: "No space left on device (os error 28)" })) });
    expect(syncMessage(full, OPENED)).toBe(
      "Sync: days/2026-11-03.md, days/2026-11-04.md and days/2026-11-12.md left as they are: No space left on device (os error 28).",
    );
    // The review's case: a duplicate key, a file that isn't text, and a read-only file.
    const mixed = report({
      unwritten: [
        { date: "2026-11-05", reason: yaml },
        { date: "2026-11-06", reason: "stream did not contain valid UTF-8" },
        { date: "2026-11-10", reason: "2026-11-10.md is read-only, so it was not changed" },
      ],
    });
    expect(syncMessage(mixed, OPENED)).toBe(
      "Sync: days/2026-11-05.md left as it is: Frontmatter: Invalid YAML: Map keys must be unique (line 4). " +
        "days/2026-11-06.md left as it is: stream did not contain valid UTF-8. " +
        "days/2026-11-10.md is read-only, so it was left as it is. Unlock it in Finder (Get Info), then sync again.",
    );
    const locked = report({
      unwritten: ["2026-11-10", "2026-11-11"].map((date) => ({ date, reason: `${date}.md is read-only, so it was not changed` })),
    });
    expect(syncMessage(locked, OPENED)).toBe(
      "Sync: days/2026-11-10.md and days/2026-11-11.md are read-only, so they were left as they are. Unlock them in Finder (Get Info), then sync again.",
    );
    // Two reasons, several files each: each file is under its own reason, in the order they came.
    const grouped = report({
      unwritten: [
        { date: "2026-11-03", reason: "A" }, { date: "2026-11-04", reason: "B." }, { date: "2026-11-05", reason: "A." }, { date: "2026-11-06", reason: "B" },
      ],
    });
    expect(syncMessage(grouped, OPENED)).toBe(
      "Sync: days/2026-11-03.md and days/2026-11-05.md left as they are: A. days/2026-11-04.md and days/2026-11-06.md left as they are: B.",
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
