import { useEffect, useMemo, useRef } from "react";
import { autosave, SAVE_POLICY, type SavePolicy } from "../data";

/**
 * Saves text as it is typed, under the app's one save policy: a moment after
 * typing stops, never later than the policy's cap while it goes on, and at
 * once when the text is about to be left behind. That is when the window
 * loses focus, is hidden or is asked to close, and when the screen using
 * this goes away.
 *
 * `save` is called with nothing: it reads what there is to save, and does
 * nothing if there is nothing new. Call `touched()` on every change, and
 * `now()` for a save on the spot (the field losing focus, say).
 */
export function useAutosave(save: () => void, policy: SavePolicy = SAVE_POLICY) {
  const latest = useRef(save);
  latest.current = save;
  const saver = useMemo(() => autosave(() => latest.current(), policy), [policy]);
  /** Not `flush`: a save that failed is no longer waiting, and leaving is the time to try it again. */
  const now = useMemo(
    () => () => {
      saver.cancel();
      latest.current();
    },
    [saver],
  );

  useEffect(() => {
    const hidden = () => document.visibilityState === "hidden" && now();
    window.addEventListener("blur", now);
    window.addEventListener("pagehide", now);
    window.addEventListener("beforeunload", now);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("blur", now);
      window.removeEventListener("pagehide", now);
      window.removeEventListener("beforeunload", now);
      document.removeEventListener("visibilitychange", hidden);
      now();
    };
  }, [now]);

  return { touched: saver.touched, now };
}
