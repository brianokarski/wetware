import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import {
  countWords, dayKey, longDate, monthAndDay, pageLine, PagesChangedError, PagesCountError, pagesNoticeKey, pagesPath, pageStarts,
  readDay, reason, roomKeepsCount, savePages, valueText, weekdayName, wordLine,
  type DataFs, type Habit,
} from "../data";
// The one place the text of the pages is read. Nothing else in the app imports this.
import { readPages } from "../data/pages";
import { useAutosave } from "../platform/useAutosave";

interface Props {
  fs: DataFs;
  /** The habit the room feeds, whose goal it writes toward and whose count it keeps. Null if there is none. */
  habit: Habit | null;
  /** The day whose pages these are. Never a day after today. */
  date: string;
  /** What the room has had to say about these pages and not yet taken back. It is said here, quietly. */
  notice: string | null;
  /**
   * Set here to a check the app makes before it leaves the room. It answers
   * false while the pages can't be saved and the user hasn't said what to do.
   */
  leaveGuard: MutableRefObject<(() => boolean) | null>;
  /** Out of the room, back to the month. */
  onLeave: () => void;
  notify: (key: string, text: string) => void;
  settle: (...keys: string[]) => void;
}

/** Where a page begins, measured against the text: how far down its first line starts, in CSS pixels. */
interface Mark {
  page: number;
  top: number;
}

const sameMarks = (a: Mark[], b: Mark[]) => a.length === b.length && a.every((mark, i) => mark.page === b[i].page && mark.top === b[i].top);

/**
 * The writing room: one day's morning pages and nothing else. No navigation,
 * no message line, no grid: the date, how far along the writing is, and the
 * text. Escape, or Leave, goes back to the month.
 *
 * The text is one field, so undo, selection and typing are the browser's
 * own. Pages are marks in the margin: every 250 words a new page begins,
 * and its number is set beside the line it begins on.
 *
 * What is typed is saved under the app's one save policy (a moment after
 * typing stops, every few seconds while it doesn't, and whenever the field,
 * the window or the room is left), to the day's file in the pages folder
 * and nowhere else. Only the word count goes anywhere: to the day file.
 *
 * A save is only written over the text it was typed from. If the file has
 * been changed by something else since, nothing is written: the typing stays
 * here, unsaved, and the user is asked which to keep.
 */
export function MorningPages({ fs, habit, date, notice, leaveGuard, onLeave, notify, settle }: Props) {
  /** `loading` until the file is read; `unreadable` if it can't be, and then nothing can be typed over it. */
  const [stage, setStage] = useState<"loading" | "ready" | "unreadable">("loading");
  const [text, setText] = useState("");
  /** The file's text is no longer what the typing started from, and the user hasn't chosen yet. */
  const [asked, setAsked] = useState(false);
  /** The day file's count, as written there, when it was set by hand and is not the room's to change. */
  const [byHand, setByHand] = useState<string | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);

  /** What the file is known to hold: what was last read from it or written to it. Saves are checked against it, and move it on. */
  const base = useRef({ text: "" }).current;
  /** The text of the last save asked for, while it is on its way or has landed. Null once it has failed. */
  const asking = useRef<string | null>(null);
  /** The text is on disk and its count is not: the next save has the count to write. */
  const uncounted = useRef(false);
  /** What this render has, for the saves and checks that run after it. */
  const latest = useRef({ stage, text, asked });
  latest.current = { stage, text, asked };

  const field = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const keep = useRef<HTMLButtonElement>(null);

  const key = pagesNoticeKey(date);
  const file = pagesPath(date);
  const goal = habit?.goal ?? null;

  const ask = useCallback(() => {
    latest.current.asked = true;
    setAsked(true);
    notify(key, `${file} was changed outside Wetware while it was open here. What is typed here has not been saved. Choose whether to keep it or take the file's text.`);
  }, [notify, key, file]);

  /** How the day file's count stands: the room's to keep, or someone's own. */
  const readCount = useCallback(async () => {
    if (!habit) return null;
    const day = await readDay(fs, date);
    if (day.error || roomKeepsCount(habit, day)) return null;
    return valueText(day.values[dayKey(habit)] ?? null);
  }, [fs, date, habit]);

  // The pages are read once, when the room opens.
  useEffect(() => {
    let stale = false;
    let unread = false;
    readPages(fs, date).then(
      (onDisk) => {
        if (stale) return;
        base.text = onDisk;
        setText(onDisk);
        setStage("ready");
      },
      (e) => {
        if (stale) return;
        unread = true;
        setStage("unreadable");
        notify(key, `${file} could not be read, so nothing can be written here. ${reason(e)}`);
      },
    );
    // A day file that can't be read says nothing here: saving will, when it has a count to write.
    readCount().then((held) => !stale && setByHand(held), () => {});
    return () => {
      stale = true;
      // That the file can't be read is about this room. Out of it, there is nothing left to say.
      if (unread) settle(key);
    };
  }, [fs, date, base, file, key, notify, settle, readCount]);

  const save = useCallback(() => {
    const { stage, text, asked } = latest.current;
    // Nothing is saved while the question is open.
    if (stage !== "ready" || asked) return;
    // Nor what is already saved, or already on its way.
    if (text === (asking.current ?? base.text) && !uncounted.current) return;
    asking.current = text;
    // It takes its turn at once, behind any save still on its way, and is checked against what that one wrote.
    savePages(fs, date, text, base, habit).then(
      (saved) => {
        uncounted.current = false;
        settle(key);
        if (saved.count === "by_hand") void readCount().then(setByHand, () => {});
        else setByHand(null);
      },
      (e) => {
        // Whatever went wrong, this text can be asked for again.
        if (asking.current === text) asking.current = null;
        if (e instanceof PagesChangedError) {
          ask();
        } else if (e instanceof PagesCountError) {
          // The text is on disk. The count is tried again with the next save.
          uncounted.current = true;
          notify(key, `The pages are saved. ${reason(e)}`);
        } else {
          // Not on disk: the next save, on the next keystroke or on leaving, tries again.
          notify(key, `The pages for ${monthAndDay(date)} were not saved. ${reason(e)}`);
        }
      },
    );
  }, [fs, date, habit, base, key, notify, settle, ask, readCount]);
  const saver = useAutosave(save);

  // The file may have been changed in another app while this one was in the background. Coming back to
  // the window, it is read again: taken as it is if nothing unsaved is typed here, asked about if there is.
  useEffect(() => {
    const check = () => {
      if (latest.current.stage !== "ready") return;
      readPages(fs, date).then(
        (onDisk) => {
          // This reading took its turn behind every save asked for before it, so `base` is what those wrote.
          const { text, asked } = latest.current;
          if (onDisk === base.text) {
            // What the room knows the file to hold, or back to it: there is nothing to ask, or no longer anything.
            if (asked) {
              latest.current.asked = false;
              setAsked(false);
              settle(key);
              saver.now();
            }
          } else if (text === base.text) {
            // Changed outside, with nothing unsaved typed here: the room takes the file's text, and that is all.
            base.text = onDisk;
            asking.current = null;
            setText(onDisk);
          } else if (!asked) {
            ask();
          }
        },
        // A file that can't be read just now is left for the next save to speak of.
        () => {},
      );
    };
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [fs, date, base, key, settle, ask, saver]);

  /** Answers the question with the file's text read afresh: it is what the typing stands on from here. */
  const answer = (take: boolean) => {
    if (!latest.current.asked) return;
    readPages(fs, date).then(
      (onDisk) => {
        base.text = onDisk;
        asking.current = null;
        latest.current.asked = false;
        setAsked(false);
        settle(key);
        if (take) {
          latest.current.text = onDisk;
          setText(onDisk);
        } else {
          saver.now();
        }
        field.current?.focus();
      },
      (e) => notify(key, `${file} could not be read. ${reason(e)} What is typed here is still not saved.`),
    );
  };

  // While the question is open the room can't be left: what is typed would be lost without a word.
  useEffect(() => {
    leaveGuard.current = () => {
      if (!latest.current.asked) return true;
      notify(key, `${file} is not saved: it was changed outside Wetware. Before leaving, choose whether to keep what is typed here or take the file's text.`);
      keep.current?.focus();
      return false;
    };
    return () => {
      leaveGuard.current = null;
    };
  }, [leaveGuard, notify, key, file]);

  // Escape leaves, from anywhere in the room. Not while a character is being composed: there it belongs to the input method.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented) onLeave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onLeave]);

  // The room has the whole window, edge to edge, for as long as it is open.
  useEffect(() => {
    document.documentElement.dataset.room = "";
    return () => {
      delete document.documentElement.dataset.room;
    };
  }, []);

  // The writing goes on where it left off: the keyboard is in the text, at its end.
  useEffect(() => {
    if (stage !== "ready") return;
    const area = field.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    end.current?.scrollIntoView({ block: "nearest" });
  }, [stage]);

  // ── Pages: where each begins, measured against the text as it is set. ──

  /** The first page begins where the text does and needs no mark. Every page after it gets one. */
  const starts = useMemo(() => pageStarts(text).slice(1), [text]);

  const measure = useCallback(() => {
    const copy = mirror.current;
    if (!copy) return;
    const frame = copy.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(copy).lineHeight);
    const next = [...copy.querySelectorAll<HTMLElement>("[data-page]")].map((word) => {
      const box = word.getClientRects()[0] ?? word.getBoundingClientRect();
      // The top of the line the page's first word is on.
      const top = (box.top + box.bottom) / 2 - frame.top - line / 2;
      return { page: Number(word.dataset.page), top: Math.round(top) };
    });
    setMarks((now) => (sameMarks(now, next) ? now : next));
  }, []);
  useLayoutEffect(measure, [measure, text, stage]);
  useEffect(() => {
    const copy = mirror.current;
    if (!copy) return;
    const resized = new ResizeObserver(measure);
    resized.observe(copy);
    void document.fonts.ready.then(measure);
    return () => resized.disconnect();
  }, [measure, stage]);

  /**
   * The text again, out of sight, set exactly as the field sets it, with the
   * first word of each page marked so that its line can be found. It also
   * gives the field its height: the page scrolls, not the field.
   */
  const copy: ReactNode[] = [];
  let at = 0;
  for (const start of starts) {
    const rest = text.slice(start.offset).search(/\s/);
    const wordEnd = rest < 0 ? text.length : start.offset + rest;
    copy.push(text.slice(at, start.offset));
    copy.push(
      <span key={start.page} data-page={start.page}>
        {text.slice(start.offset, wordEnd)}
      </span>,
    );
    at = wordEnd;
  }
  copy.push(text.slice(at));

  const words = countWords(text);

  return (
    <section className="room" aria-label={`Morning pages for ${longDate(date)}`}>
      <header className="room-head">
        <div className="room-strip mono">
          <span>
            {weekdayName(date)}, {monthAndDay(date)}
          </span>
          <span className="room-progress" role="status">
            {stage === "ready" && pageLine(words, goal)}
          </span>
          <span className="room-count">{stage === "ready" && wordLine(words, goal)}</span>
          <button type="button" className="room-leave" aria-label="Leave the writing room" onClick={onLeave}>
            Leave
          </button>
        </div>

        {/* What the room has to say: a save that failed, a file changed elsewhere. Said here, in the room's own voice. */}
        <div className="room-said mono">
          <p className="room-notice" role="alert">
            {notice}
          </p>
          {asked && (
            <span className="room-choices">
              <button ref={keep} type="button" className="room-action" onClick={() => answer(false)}>
                Keep what is typed here
              </button>
              <button type="button" className="room-action" onClick={() => answer(true)}>
                Take the file's text
              </button>
            </span>
          )}
          {notice && !asked && stage === "ready" && (
            <button type="button" className="room-action" onClick={() => settle(key)}>
              Dismiss
            </button>
          )}
        </div>
      </header>

      {stage === "ready" && (
        <div className="room-sheet">
          <div className="room-page">
            <div ref={mirror} className="room-text room-copy" aria-hidden="true">
              {copy}
              {/* Keeps the last line its height when the text ends in a line break. */}
              {"\u200b"}
            </div>
            <textarea
              ref={field}
              className="room-text room-field"
              aria-label={`Morning pages for ${longDate(date)}`}
              placeholder="Start anywhere."
              rows={1}
              spellCheck
              value={text}
              onChange={(e) => {
                const area = e.currentTarget;
                setText(area.value);
                saver.touched();
                // Writing at the end: the line being written stays clear of the window's edge.
                if (area.selectionEnd === area.value.length) requestAnimationFrame(() => end.current?.scrollIntoView({ block: "nearest" }));
              }}
              onBlur={saver.now}
            />
            {marks.map((mark) => (
              <span key={mark.page} className="room-mark mono" data-page={mark.page} style={{ "--at": mark.top } as CSSProperties} aria-hidden="true">
                {mark.page}
              </span>
            ))}
          </div>
          <div ref={end} className="room-end" aria-hidden="true" />
          <p className="room-foot mono">
            Kept in {file} and nowhere else.{" "}
            {byHand === null
              ? habit && "Only the word count goes to the day file."
              : `The day file's count (${byHand}) was set by hand, so the room leaves it as it is.`}
          </p>
        </div>
      )}
    </section>
  );
}
