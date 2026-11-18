import { useEffect, useState } from "react";
import { dateKey } from "../data";

/**
 * The app's idea of "now". Everything that needs the current time asks here,
 * so the screenshot harness can pin it and get the same picture on every run.
 */
let source: () => Date = () => new Date();

export const now = (): Date => source();

export function setClock(next: () => Date): void {
  source = next;
}

const CHECK_EVERY_MS = 30_000;

/** Today's date key. Re-renders when the local day changes, so an app left open rolls over at midnight. */
export function useToday(): string {
  const [today, setToday] = useState(() => dateKey(now()));
  useEffect(() => {
    const check = () => setToday(dateKey(now()));
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    // A laptop opened in the morning with the app still in front gets no focus event, but the page is shown again.
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);
  return today;
}
