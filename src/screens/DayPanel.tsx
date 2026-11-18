import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { Mono, Row, Table } from "../components/primitives";
import {
  addDays, cellNoticeKey, cellPatch, cellState, dayKey, dayParts, dayPath, describeCell, habitHint, longDate, monthAndDay,
  NotesChangedError, PAGES_SOURCE, pagesWords, parseCellInput, parseDay, readDay, reason, roomKeepsCount, shortDate, takeRoomCount,
  TYPED_INPUT, unreadableValue, useSyncedPatch, valueSource, valueText, weatherLine, weekdayName, withPatch, writeDay, writeNotes,
  type Cell, type CellValue, type DataFs, type Day, type DayPatch, type Habit, type NotesBase, type Units,
} from "../data";
import { useAutosave } from "../platform/useAutosave";
import { handBack, handBackNote } from "../sync";

/** The three ways about the day view's header: the day before, back to the month, the day after. */
export type DayNav = "previous" | "month" | "next";

interface Props {
  fs: DataFs;
  habits: Habit[];
  /** The day shown. Never a day after today. */
  date: string;
  today: string;
  /** The unit the weather is shown in, when the file has it in that unit. */
  temperature: Units["temperature"];
  /** Counts up each time a sync has written day files: the day is read again. */
  revision: number;
  /** Which of the header's controls has the keyboard when the day opens: the one that was used to get here. */
  arrive: DayNav;
  /**
   * Set here to a check the app makes before it leaves this day by any road.
   * It answers false, and says why on the message line, while the notes
   * can't be saved and the user hasn't said what to do about it.
   */
  leaveGuard: MutableRefObject<(() => boolean) | null>;
  /** Back to the month. */
  onClose: () => void;
  /** To the day before or after, without going back to the month. */
  onGo: (date: string, via: DayNav) => void;
  notify: (key: string, text: string) => void;
  settle: (...keys: string[]) => void;
}

const notesNoticeKey = (date: string) => `notes:${date}`;

/**
 * One day: every habit's value, editable as in the grid, with where it came
 * from; what the app logged by itself; whatever else the file holds; and the
 * day's notes. It takes the place of the month grid, and Escape goes back.
 */
export function DayPanel({ fs, habits, date, today, temperature, revision, arrive, leaveGuard, onClose, onGo, notify, settle }: Props) {
  const [day, setDay] = useState<Day | null>(null);
  /** How many words this day's morning pages hold. A number is all this view is given of them. */
  const [pagesHeld, setPagesHeld] = useState(0);
  const nav = useRef<HTMLSpanElement>(null);
  /** Changes made here so far, and how many are still on their way to disk. */
  const edits = useRef({ count: 0, inFlight: 0 });

  /** Reads the day from disk. What is read is shown unless a change was made here meanwhile: that one is newer. */
  const read = useCallback(() => {
    const began = edits.current.count;
    const unread = (e: unknown): Day => ({ ...parseDay(null, date), error: `The file could not be read: ${reason(e)}.` });
    // Whether the day has pages decides whether a count set by hand can be handed back to the writing room.
    pagesWords(fs, date).then(setPagesHeld, () => setPagesHeld(0));
    return readDay(fs, date)
      .catch(unread)
      .then((loaded) => {
        if (edits.current.count === began && edits.current.inFlight === 0) setDay(loaded);
      });
  }, [fs, date]);

  useEffect(() => void read(), [read, revision]);
  // The file may have been changed in another app while this one was in the background. Coming back
  // to the window, the day is read again, so that what is on screen is what is on disk.
  useEffect(() => {
    const onFocus = () => void read();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [read]);
  // The keyboard starts on the control that brought the day up, where it can be seen and used again.
  useEffect(() => nav.current?.querySelector<HTMLElement>(`[data-nav="${arrive}"]`)?.focus(), [arrive]);

  /** Counts a write to the day in and out, so that a reading of the file never lands over it. */
  const tracked = <T,>(write: Promise<T>): Promise<T> => {
    edits.current.count++;
    edits.current.inFlight++;
    return write.finally(() => void edits.current.inFlight--);
  };
  const idle = () => edits.current.inFlight === 0;

  /** Shows a change at once, writes it, and follows the file once every change has landed. */
  const change = (patch: DayPatch, notice: string, what: string) => {
    if (!day || day.error) return;
    setDay(withPatch(day, patch));
    tracked(writeDay(fs, date, patch)).then(
      (saved) => {
        if (idle()) setDay(saved);
        settle(notice);
      },
      (e) => {
        notify(notice, `${what} on ${monthAndDay(date)} was not saved. ${reason(e)}`);
        // Put back what the file says.
        if (idle()) void read();
      },
    );
  };

  const setValue = (habit: Habit, value: CellValue) => change(cellPatch(habit, value), cellNoticeKey(date, habit.id), habit.name);

  /** Hands the Morning pages count back to the writing room: it becomes what the day's pages hold, and the room keeps it. */
  const useRoomCount = (habit: Habit) => {
    if (!day || day.error) return;
    const notice = cellNoticeKey(date, habit.id);
    tracked(takeRoomCount(fs, date, habit)).then(
      (saved) => {
        if (idle()) setDay(saved);
        settle(notice);
      },
      (e) => {
        notify(notice, `${habit.name} on ${monthAndDay(date)} was not changed. ${reason(e)}`);
        if (idle()) void read();
      },
    );
  };

  // Escape goes back to the month from anywhere in the view, and from nowhere in particular too. A field
  // with typing to take back takes it back first, and says so by marking the key as dealt with.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const previous = addDays(date, -1);
  const next = addDays(date, 1);
  const weather = day && !day.error ? weatherLine(day, temperature) : null;
  const rows = habits.filter((habit) => !habit.archived);
  const parts = day && !day.error ? dayParts(habits, day) : null;

  return (
    <section className="day" aria-label={longDate(date)}>
      <header className="meta-row">
        <Mono>{weekdayName(date)}</Mono>
        <span className="mono">{weather ?? <span className="muted">No weather logged</span>}</span>
        <span className="mono muted selectable">{dayPath(date)}</span>
        <span ref={nav} className="month-nav mono">
          <button
            type="button"
            className="choice"
            data-nav="previous"
            aria-label={`Previous day, ${longDate(previous)}`}
            onClick={() => onGo(previous, "previous")}
          >
            ← {shortDate(previous)}
          </button>
          <button type="button" className="choice" data-nav="month" onClick={onClose}>
            Month
          </button>
          {/* Not `disabled` on the last day there is: that would drop it from the tab order and move what follows. */}
          <button
            type="button"
            className="choice"
            data-nav="next"
            aria-label={`Next day, ${longDate(next)}`}
            aria-disabled={next > today || undefined}
            onClick={() => onGo(next, "next")}
          >
            {shortDate(next)} →
          </button>
        </span>
      </header>

      <h1 className="display">{monthAndDay(date)}</h1>

      {day?.error && (
        <Table label="This day's file needs fixing by hand">
          <Row label="File">
            <span className="mono selectable">{dayPath(date)}</span>
          </Row>
          <Row label="Problem">
            <span className="grow selectable">{day.error}</span>
            <span className="row-note">
              <Mono muted>Nothing here can be changed until the file is put right in a text editor. It has been left exactly as it is.</Mono>
            </span>
          </Row>
        </Table>
      )}

      {day && !day.error && parts && (
        <div className="day-columns">
          <div className="stack">
            <Table label="Habits">
              {rows.map((habit) => (
                <HabitRow
                  key={habit.id}
                  habit={habit}
                  day={day}
                  today={today}
                  onSet={(value) => setValue(habit, value)}
                  onUseSynced={() => change(useSyncedPatch(habit), cellNoticeKey(date, habit.id), habit.name)}
                  roomWords={habit.source === PAGES_SOURCE && !roomKeepsCount(habit, day) ? pagesHeld : 0}
                  onUseRoomCount={() => useRoomCount(habit)}
                  onRejected={(text) =>
                    notify(cellNoticeKey(date, habit.id), `${habit.name} takes ${TYPED_INPUT[habit.type]}. "${text.trim()}" was not saved for ${monthAndDay(date)}.`)
                  }
                />
              ))}
              {rows.length === 0 && (
                <Row label="None">
                  <Mono muted>Habits are listed in habits.yaml, in the data folder.</Mono>
                </Row>
              )}
            </Table>

            {parts.logged.length > 0 && (
              <Table label="Also logged">
                {parts.logged.map((entry) => (
                  <Row key={entry.key} label={entry.label}>
                    <span className="mono selectable">
                      {valueText(entry.value)}
                      {entry.unit && <span className="muted"> {entry.unit}</span>}
                    </span>
                    <SourceLabel source={entry.source ?? "unrecorded"} />
                  </Row>
                ))}
              </Table>
            )}

            {parts.other.length > 0 && (
              <Table label="Other properties">
                {parts.other.map((entry) => (
                  <div key={entry.key} className="row mono">
                    <div className="selectable">{entry.key}</div>
                    <div className="row-value selectable">{entry.text}</div>
                  </div>
                ))}
              </Table>
            )}
          </div>

          <Notes
            date={date}
            notes={day.notes}
            leaveGuard={leaveGuard}
            onWrite={(text, base) => tracked(writeNotes(fs, date, text, base))}
            onSaved={(saved) => idle() && setDay(saved)}
            notify={(text) => notify(notesNoticeKey(date), text)}
            settle={() => settle(notesNoticeKey(date))}
          />
        </div>
      )}
    </section>
  );
}

/** One habit on one day: its name, its value in the input its type takes, and where the value came from. */
function HabitRow(props: {
  habit: Habit;
  day: Day;
  today: string;
  onSet: (value: CellValue) => void;
  onUseSynced: () => void;
  /**
   * For the habit the writing room feeds, on a day whose count was set by
   * hand: how many words the day's pages hold. 0 for every other row, and
   * when there are no pages to count.
   */
  roomWords: number;
  onUseRoomCount: () => void;
  onRejected: (text: string) => void;
}) {
  const { habit, day, today } = props;
  const cell = cellState(habit, day, today);
  const source = valueSource(habit, day);
  const toggled = habit.type === "check" || habit.type === "tag";
  const hint = habitHint(habit);
  const label = `${habit.name}, ${longDate(day.date)}`;
  /** What the file holds under this habit's key, when it isn't something the habit can hold. */
  const odd = unreadableValue(habit, day);
  /** What keeps sync from this value, where handing it back would let a sync fill it. */
  const hold = handBack(habit, day, today);
  const row = useRef<HTMLDivElement>(null);
  /** The action is gone once it is used. The keyboard goes to the value it was about, not nowhere. */
  const useSynced = () => {
    props.onUseSynced();
    row.current?.querySelector<HTMLElement>("input, .day-box")?.focus();
  };
  const useRoomCount = () => {
    props.onUseRoomCount();
    row.current?.querySelector<HTMLElement>("input, .day-box")?.focus();
  };

  return (
    <div ref={row} className="row" data-habit={habit.id} data-state={cell.state}>
      <div>{habit.name}</div>
      <div className="row-value">
        {toggled ? (
          <button
            type="button"
            className="day-box"
            aria-pressed={cell.value !== null}
            aria-label={`${label}: ${odd === null ? describeCell(habit, cell) || "empty" : `not readable, the file has ${odd}`}`}
            onClick={() => props.onSet(cell.value === null)}
          >
            {/* A value that can't be read is shown beside the box, as written. The box itself says nothing of it. */}
            {odd === null && <BoxMark habit={habit} cell={cell} />}
          </button>
        ) : (
          <ValueField
            label={odd === null ? label : `${label}: not readable, the file has ${odd}`}
            value={cell.value === null ? "" : String(cell.value)}
            decimal={habit.type === "number"}
            onCommit={(text) => {
              const parsed = parseCellInput(habit.type, text);
              if (!parsed.ok) {
                props.onRejected(text);
                return false;
              }
              // A value the file holds in a form that can't be read is replaced by whatever is entered.
              if (parsed.value !== cell.value || odd !== null) props.onSet(parsed.value);
              return true;
            }}
          />
        )}
        {odd !== null && <span className="day-raw mono selectable">{odd}</span>}
        {hint && <Mono muted>{hint}</Mono>}
        <SourceLabel source={odd !== null ? "not readable" : (source ?? (cell.state === "no_data" ? "no data" : ""))} />
        {odd !== null && (
          <span className="row-note">
            <Mono muted>
              The file has this under {dayKey(habit)}, and it is not {toggled ? "true or false" : TYPED_INPUT[habit.type]}. It stays
              as it is until a value is {toggled ? "set" : "entered"} here.
            </Mono>
          </span>
        )}
        {hold !== null && (
          <>
            <button type="button" className="action mono" onClick={useSynced}>
              Use synced value
            </button>
            <span className="row-note">
              <Mono muted>{handBackNote(hold)}</Mono>
            </span>
          </>
        )}
        {props.roomWords > 0 && (
          <>
            <button type="button" className="action mono" onClick={useRoomCount}>
              Use the room's count
            </button>
            <span className="row-note">
              <Mono muted>
                Set by hand, so the writing room leaves it alone. This day's pages hold {props.roomWords}{" "}
                {props.roomWords === 1 ? "word" : "words"}. Use the room's count puts that here, and the room keeps it from then on.
              </Mono>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/** What this app says of a value that has no entry in the day's `_sources`, in full. */
const UNRECORDED = "The file has no _sources entry for this value. Sync treats it as typed by hand and leaves it alone.";

/** Where a value came from, at the end of its row. */
function SourceLabel({ source }: { source: string }) {
  return (
    <span className="day-source mono muted" title={source === "unrecorded" ? UNRECORDED : undefined}>
      {source}
    </span>
  );
}

/** What a check or tag box holds: the same marks as a box of the month grid. */
function BoxMark({ habit, cell }: { habit: Habit; cell: Cell }) {
  if (cell.state === "no_data") return <span className="mark mark-none" />;
  if (cell.value === null) return null;
  return <span className={habit.type === "tag" ? "mark mark-tag" : "mark mark-x"} />;
}

/**
 * A typed value. Enter, or leaving the field, enters what was typed; Escape
 * takes it back, and with nothing typed is left for the view, which goes
 * back to the month. `onCommit` says whether the text was taken.
 *
 * While something is being typed, the field is the user's: a new value
 * arriving from the file (a sync landing, the day read again) does not
 * replace it. It is shown once the typing is entered or taken back.
 */
function ValueField(props: { label: string; value: string; decimal: boolean; onCommit: (text: string) => boolean }) {
  const [text, setText] = useState(props.value);
  /** What the field showed when typing began. Null when nothing is being typed. */
  const typing = useRef<string | null>(null);
  useEffect(() => {
    if (typing.current === null) setText(props.value);
  }, [props.value]);

  const finish = (enter: boolean) => {
    const from = typing.current;
    typing.current = null;
    // Typed and put back as it was is not an entry, whatever has arrived underneath meanwhile.
    if (enter && from !== null && text.trim() !== from) props.onCommit(text);
    // What the file has now. If the entry was taken, the new value follows at once.
    setText(props.value);
  };

  return (
    <input
      className="field field-short"
      aria-label={props.label}
      inputMode={props.decimal ? "decimal" : "numeric"}
      autoComplete="off"
      spellCheck={false}
      value={text}
      onChange={(e) => {
        typing.current ??= props.value;
        setText(e.target.value);
      }}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape" && typing.current !== null) {
          finish(false);
          e.preventDefault();
        }
      }}
    />
  );
}

/**
 * The day's notes: the body of its file, as plain text. Markdown is not
 * rendered. What is typed is saved under the app's save policy (a moment
 * after typing stops, every few seconds while it doesn't, and whenever the
 * field, the window or the day is left). Notes that were not changed are
 * not saved at all.
 *
 * A save is only ever written over the notes it was typed from. If the
 * file's notes have been changed by something else since, nothing is
 * written: the typing stays in the field, unsaved, and the user is asked
 * which to keep. Until they say, nothing is saved and the day can't be left.
 */
function Notes(props: {
  date: string;
  /** The notes as the file has them, as last read or written. */
  notes: string;
  leaveGuard: MutableRefObject<(() => boolean) | null>;
  /**
   * Writes `text` over the notes `base` says the file holds, and moves `base` on when it lands. Rejects with
   * `NotesChangedError` if the file holds something else.
   */
  onWrite: (text: string, base: NotesBase) => Promise<Day>;
  onSaved: (day: Day) => void;
  notify: (text: string) => void;
  settle: () => void;
}) {
  const [text, setText] = useState(props.notes);
  /** The file's notes, when they are not the ones the typing started from and the user hasn't chosen yet. */
  const [theirs, setTheirs] = useState<string | null>(null);
  /**
   * What the file's notes are known to be: what was last read or written. Every save is checked against it
   * inside its own turn at the file, and moves it on when it lands, so a save asked for while another is
   * still on its way is checked against that one's text and not taken for a change made elsewhere.
   */
  const base = useRef<NotesBase>({ text: props.notes }).current;
  /** The text of the last save asked for, while it is on its way or has landed. Null once it has failed. */
  const asking = useRef<string | null>(null);
  /** What this render has, for the saves and checks that run after it. */
  const latest = useRef({ text, theirs, props });
  latest.current = { text, theirs, props };
  const keep = useRef<HTMLButtonElement>(null);
  const day = monthAndDay(props.date);

  const ask = (fileNotes: string) => {
    setTheirs(fileNotes);
    latest.current.props.notify(
      `The notes for ${day} were changed outside Wetware while they were open here. What is typed here has not been saved. Beside the notes, choose whether to keep it or take the file's text.`,
    );
  };

  const save = useCallback(() => {
    const { text, theirs, props } = latest.current;
    // Nothing is saved while the question is open, and nothing that is already saved or on its way.
    if (theirs !== null || text === (asking.current ?? base.text)) return;
    asking.current = text;
    // It takes its turn at once, behind any save still on its way, and is checked against what that one wrote.
    props.onWrite(text, base).then(
      (saved) => {
        props.onSaved(saved);
        props.settle();
      },
      (e) => {
        // Whatever went wrong, this text can be asked for again.
        if (asking.current === text) asking.current = null;
        if (e instanceof NotesChangedError) ask(e.day.notes);
        // Not on disk: the next save, on the next keystroke or on leaving, tries again.
        else props.notify(`The notes for ${day} were not saved. ${reason(e)}`);
      },
    );
  }, []);
  const saver = useAutosave(save);

  // The file's notes as read again (the window came back to the front, a sync landed, a value was saved).
  useEffect(() => {
    const { text, theirs } = latest.current;
    // What the file is known to hold (this field's own save arriving by another road, as often as not): nothing new.
    if (props.notes === base.text) {
      // And if they are back to what the typing stands on, there is no longer anything to ask,
      // and what is typed can be saved after all.
      if (theirs !== null) {
        latest.current.theirs = null;
        setTheirs(null);
        props.settle();
        saver.now();
      }
      return;
    }
    if (text === base.text) {
      // Changed outside, with nothing typed here: the field takes the file's text, and that is all.
      base.text = props.notes;
      asking.current = null;
      setText(props.notes);
      setTheirs(null);
    } else if (theirs !== props.notes) {
      // Changed outside under unsaved typing. Neither is thrown away without being asked.
      ask(props.notes);
    }
  }, [props.notes]);

  /** Keeps what is typed: from here on it is typed over the file's text, and is saved over it. */
  const keepMine = () => {
    if (theirs === null) return;
    base.text = theirs;
    asking.current = null;
    latest.current.theirs = null;
    setTheirs(null);
    props.settle();
    saver.now();
  };
  /** Takes the file's text in place of what is typed. */
  const takeTheirs = () => {
    if (theirs === null) return;
    base.text = theirs;
    asking.current = null;
    setText(theirs);
    setTheirs(null);
    props.settle();
  };

  // While the question is open the day can't be left: what is typed would be lost without a word.
  useEffect(() => {
    props.leaveGuard.current = () => {
      if (latest.current.theirs === null) return true;
      latest.current.props.notify(
        `The notes for ${day} are not saved: they were changed outside Wetware. Before leaving this day, choose beside the notes whether to keep what is typed here or take the file's text.`,
      );
      keep.current?.focus();
      return false;
    };
    return () => {
      props.leaveGuard.current = null;
    };
  }, [props.leaveGuard, day]);

  return (
    <Table label="Notes">
      {theirs !== null && (
        <Row label="Changed outside">
          <button ref={keep} type="button" className="action" onClick={keepMine}>
            Keep what is typed here
          </button>
          <button type="button" className="action" onClick={takeTheirs}>
            Take the file's text
          </button>
          <span className="row-note">
            <Mono muted>
              The file's notes were changed while these were open. Nothing is saved until one is chosen. Keeping writes this text over the
              file's; taking puts the file's text here in its place.
            </Mono>
          </span>
        </Row>
      )}
      <textarea
        className="day-notes mono"
        aria-label={`Notes for ${longDate(props.date)}`}
        placeholder="Notes for the day. Plain text or markdown, kept in the day's file."
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          saver.touched();
        }}
        onBlur={saver.now}
      />
    </Table>
  );
}
