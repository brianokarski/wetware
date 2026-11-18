import { describe, expect, it } from "vitest";
import { cellNoticeKey, currentNotice, dayNoticeKey, reason, withNotice, withoutNotices, type Notice } from "../src/data";

describe("notices", () => {
  const meditate = cellNoticeKey("2026-11-17", "meditate");
  const travel = cellNoticeKey("2026-11-17", "travel");

  it("shows the newest, and keeps the others behind it", () => {
    let list: Notice[] = [];
    expect(currentNotice(list)).toBeNull();
    list = withNotice(list, meditate, "Meditate was not saved.");
    list = withNotice(list, "settings", "Settings were not saved.");
    expect(currentNotice(list)).toEqual({ key: "settings", text: "Settings were not saved." });
    list = withoutNotices(list, ["settings"]);
    expect(currentNotice(list)).toEqual({ key: meditate, text: "Meditate was not saved." });
  });

  it("a later success elsewhere doesn't clear a failure (M2 review SF-2)", () => {
    let list = withNotice([], meditate, "Meditate was not saved.");
    // Travel on the same day saves: only Travel's key is settled.
    list = withoutNotices(list, [travel]);
    expect(currentNotice(list)?.key).toBe(meditate);
    list = withoutNotices(list, [dayNoticeKey("2026-11-17"), "settings", "month"]);
    expect(list).toHaveLength(1);
    // Meditate itself saving does.
    expect(withoutNotices(list, [meditate])).toEqual([]);
  });

  it("a new notice about the same thing replaces the old one and moves to the front", () => {
    let list = withNotice([], meditate, "first");
    list = withNotice(list, travel, "other");
    list = withNotice(list, meditate, "second");
    expect(list).toEqual([{ key: travel, text: "other" }, { key: meditate, text: "second" }]);
  });

  it("returns the same list when there is nothing to remove, so nothing re-renders", () => {
    const list = withNotice([], meditate, "x");
    expect(withoutNotices(list, [travel])).toBe(list);
    expect(withoutNotices(list, [])).toBe(list);
  });

  it("gives each cell and each day its own key", () => {
    expect(meditate).not.toBe(travel);
    expect(cellNoticeKey("2026-11-16", "meditate")).not.toBe(meditate);
    expect(dayNoticeKey("2026-11-17")).not.toBe(meditate);
  });

  it("says what went wrong without the error class", () => {
    expect(reason(new RangeError("too big"))).toBe("too big");
    expect(reason("No space left on device (os error 28)")).toBe("No space left on device (os error 28)");
  });
});
