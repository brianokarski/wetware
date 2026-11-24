/** When typing is saved: a moment after it stops, never later than the cap, and at once when asked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autosave, SAVE_POLICY } from "../src/data";

describe("the save policy", () => {
  let saves: number[];
  let began: number;
  const save = () => void saves.push(Date.now() - began);

  beforeEach(() => {
    vi.useFakeTimers();
    saves = [];
    began = Date.now();
  });
  afterEach(() => vi.useRealTimers());

  it("is 0.8 seconds after typing stops and never more than 3 seconds after it starts", () => {
    expect(SAVE_POLICY).toEqual({ idleMs: 800, maxWaitMs: 3000 });
  });

  it("saves once, a moment after the last keystroke", () => {
    const saver = autosave(save);
    saver.touched();
    vi.advanceTimersByTime(500);
    saver.touched();
    vi.advanceTimersByTime(799);
    expect(saves).toEqual([]);
    expect(saver.waiting()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(saves).toEqual([1300]);
    expect(saver.waiting()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(saves).toEqual([1300]);
  });

  it("doesn't let typing that never pauses put the save off past the cap", () => {
    const saver = autosave(save);
    // A key every 150 ms for six seconds: there is never a pause of 0.8 s.
    for (let at = 0; at < 6000; at += 150) {
      saver.touched();
      vi.advanceTimersByTime(150);
    }
    expect(saves).toEqual([3000, 6000]);
    // The cap runs from the first keystroke after a save, not from the last save.
    vi.advanceTimersByTime(5000);
    expect(saves).toEqual([3000, 6000]);
    saver.touched();
    vi.advanceTimersByTime(800);
    expect(saves).toEqual([3000, 6000, 11800]);
  });

  it("saves at once when flushed, and only if something is waiting", () => {
    const saver = autosave(save);
    saver.flush();
    expect(saves).toEqual([]);
    saver.touched();
    vi.advanceTimersByTime(100);
    saver.flush();
    expect(saves).toEqual([100]);
    // The timers that were running are gone with it.
    vi.advanceTimersByTime(10_000);
    saver.flush();
    expect(saves).toEqual([100]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can forget what is waiting without saving it", () => {
    const saver = autosave(save);
    saver.touched();
    saver.cancel();
    expect(saver.waiting()).toBe(false);
    vi.advanceTimersByTime(10_000);
    saver.flush();
    expect(saves).toEqual([]);
  });

  it("takes another policy, for a room that wants one", () => {
    const saver = autosave(save, { idleMs: 100, maxWaitMs: 250 });
    for (let i = 0; i < 10; i++) {
      saver.touched();
      vi.advanceTimersByTime(50);
    }
    expect(saves).toEqual([250, 500]);
  });
});
