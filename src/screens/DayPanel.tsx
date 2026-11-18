import { useCallback, useEffect, useRef, useState } from "react";
import { Mono, Row, Table } from "../components/primitives";
import {
  addDays, cellNoticeKey, cellPatch, cellState, dayParts, dayPath, describeCell, habitHint, holdsBackSync,
  isSynced, longDate, monthAndDay, parseCellInput, parseDay, readDay, reason, shortDate, TYPED_INPUT, useSyncedPatch,
  valueSource, weatherLine, weekdayName, withPatch, writeDay,
  type Cell, type CellValue, type DataFs, type Day, type DayPatch, type Habit, type Units,
} from "../data";

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
  /** Back to the month. */
  onClose: () => void;
  /** To another day, without going back to the month. */
  onGo: (date: string) => void;
  notify: (key: string, text: string) => void;
  settle: (...keys: string[]) => void;
}

/** How long after the last keystroke the notes are saved. They are also saved when the field is left. */
const NOTES_SAVE_MS = 800;
const notesNoticeKey = (date: string) => `notes:${date}`;

/**
 * One day: every habit's value, editable as in the grid, with where it came
 * from; what the app logged by itself; whatever else the file holds; and the
 * day's notes. It takes the place of the month grid, and Escape goes back.
 */
export function DayPanel({ fs, habits, date, today, temperature, revision, onClose, onGo, notify, settle }: Props) {
  const [day, setDay] = useState<Day | null>(null);
  const view = useRef<HTMLElement>(null);
  /** Changes made here so far, and how many are still on their way to disk. */
  const edits = useRef({ count: 0, inFlight: 0 });

  /** Reads the day from disk. What is read is shown unless a change was made here meanwhile: that one is newer. */
  const read = useCallback(() => {
    const began = edits.current.count;
    const unread = (e: unknown): Day => ({ ...parseDay(null, date), error: `The file could not be read: ${reason(e)}.` });
    return readDay(fs, date)
      .catch(unread)
      .then((loaded) => {
        if (edits.current.count === began && edits.current.inFlight === 0) setDay(loaded);
      });
  }, [fs, date]);

  useEffect(() => void read(), [read, revision]);
  // The view has the keyboard from the start: Tab goes to the first value, Escape goes back.
  useEffect(() => view.current?.focus(), []);

  /** Shows a change at once, writes it, and follows the file once every change has landed. */
  const change = (patch: DayPatch, notice: string, what: string) => {
    if (!day || day.error) return;
    setDay(withPatch(day, patch));
    edits.current.count++;
    edits.current.inFlight++;
    const landed = () => --edits.current.inFlight === 0;
    writeDay(fs, date, patch).then(
      (saved) => {
        if (landed()) setDay(saved);
        settle(notice);
      },
      (e) => {
        notify(notice, `${what} on ${monthAndDay(date)} was not saved. ${reason(e)}`);
        // Put back what the file says.
        if (landed()) void read();
      },
    );
  };

  /** Writes the notes, and only the notes: the frontmatter is not part of the patch. */
  const saveNotes = (text: string): Promise<void> => {
    edits.current.count++;
    edits.current.inFlight++;
    const landed = () => --edits.current.inFlight === 0;
    return writeDay(fs, date, { notes: text }).then(
      (saved) => {
        if (landed()) setDay(saved);
        settle(notesNoticeKey(date));
      },
      (e) => {
        landed();
        notify(notesNoticeKey(date), `The notes for ${monthAndDay(date)} were not saved. ${reason(e)}`);
        throw e;
      },
    );
  };

  const setValue = (habit: Habit, value: CellValue) => change(cellPatch(habit, value), cellNoticeKey(date, habit.id), habit.name);

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
    <section ref={view} className="day" tabIndex={-1} aria-label={longDate(date)}>
      <header className="meta-row">
        <Mono>{weekdayName(date)}</Mono>
        <span className="mono">{weather ?? <span className="muted">No weather logged</span>}</span>
        <span className="mono muted selectable">{dayPath(date)}</span>
        <span className="month-nav mono">
          <button type="button" className="choice" aria-label={`Previous day, ${longDate(previous)}`} onClick={() => onGo(previous)}>
            ← {shortDate(previous)}
          </button>
          <button type="button" className="choice" onClick={onClose}>
            Month
          </button>
          {/* Not `disabled` on the last day there is: that would drop it from the tab order and move what follows. */}
          <button
            type="button"
            className="choice"
            aria-label={`Next day, ${longDate(next)}`}
            aria-disabled={next > today || undefined}
            onClick={() => next <= today && onGo(next)}
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
                    <span className="mono">
                      {String(entry.value)}
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

          <Table label="Notes">
            <Notes date={date} notes={day.notes} onSave={saveNotes} />
          </Table>
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
  onRejected: (text: string) => void;
}) {
  const { habit, day, today } = props;
  const cell = cellState(habit, day, today);
  const source = valueSource(habit, day);
  const toggled = habit.type === "check" || habit.type === "tag";
  const hint = habitHint(habit);
  const label = `${habit.name}, ${longDate(day.date)}`;
  const row = useRef<HTMLDivElement>(null);
  /** The action is gone once it is used. The keyboard goes to the value it was about, not nowhere. */
  const useSynced = () => {
    props.onUseSynced();
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
            aria-label={`${label}: ${describeCell(habit, cell) || "empty"}`}
            onClick={() => props.onSet(cell.value === null)}
          >
            <BoxMark habit={habit} cell={cell} />
          </button>
        ) : (
          <ValueField
            label={label}
            value={cell.value === null ? "" : String(cell.value)}
            decimal={habit.type === "number"}
            onCommit={(text) => {
              const parsed = parseCellInput(habit.type, text);
              if (!parsed.ok) {
                props.onRejected(text);
                return false;
              }
              if (parsed.value !== cell.value) props.onSet(parsed.value);
              return true;
            }}
          />
        )}
        {hint && <Mono muted>{hint}</Mono>}
        <SourceLabel source={source ?? (cell.state === "no_data" ? "no data" : "")} />
        {holdsBackSync(habit, day) && (
          <>
            <button type="button" className="action mono" onClick={useSynced}>
              Use synced value
            </button>
            <span className="row-note">
              <Mono muted>
                Set by hand, so sync leaves it alone. Use synced value clears it, and the next sync fills it in again
                {isSynced(habit) ? ` from ${habit.source === "weather" ? "Open-Meteo" : "intervals.icu"}` : ""}.
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
 * A typed value. Saves on Enter or when the field is left; Escape puts back
 * what was there, if anything was typed, and otherwise is left for the view,
 * which goes back to the month. `onCommit` says whether the text was taken.
 */
function ValueField(props: { label: string; value: string; decimal: boolean; onCommit: (text: string) => boolean }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    if (text.trim() !== props.value && !props.onCommit(text)) setText(props.value);
  };

  return (
    <input
      className="field field-short"
      aria-label={props.label}
      inputMode={props.decimal ? "decimal" : "numeric"}
      autoComplete="off"
      spellCheck={false}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape" && text !== props.value) {
          setText(props.value);
          e.preventDefault();
        }
      }}
    />
  );
}

/**
 * The day's notes: the body of its file, as plain text. Markdown is not
 * rendered. What is typed is saved shortly after typing stops, when the
 * field is left, and when the view closes. Notes that were not changed are
 * not saved at all.
 */
function Notes(props: {
  date: string;
  /** The notes as the file has them. */
  notes: string;
  /** Writes the notes to the day's file. Rejects if they could not be written. */
  onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(props.notes);
  /** The notes as last known to be on disk, and the text of a save under way. */
  const onDisk = useRef(props.notes);
  const saving = useRef<string | null>(null);
  /** What the field holds now, for a save that runs after this render is gone. */
  const latest = useRef({ text, onSave: props.onSave });
  latest.current = { text, onSave: props.onSave };
  const timer = useRef<number | undefined>(undefined);

  // The file's notes changed under the view: take them, unless there is typing here that isn't saved, which is newer.
  useEffect(() => {
    if (props.notes === onDisk.current) return;
    setText((current) => (current === onDisk.current ? props.notes : current));
    onDisk.current = props.notes;
  }, [props.notes]);

  const save = useCallback(() => {
    window.clearTimeout(timer.current);
    const { text, onSave } = latest.current;
    if (text === onDisk.current || text === saving.current) return;
    saving.current = text;
    const done = () => {
      if (saving.current === text) saving.current = null;
    };
    onSave(text).then(
      () => {
        onDisk.current = text;
        done();
      },
      // Not on disk: the next save, on the next keystroke or on leaving, tries again.
      done,
    );
  }, []);
  // Leaving the day by any road saves what was typed.
  useEffect(() => save, [save]);

  return (
    <textarea
      className="day-notes mono"
      aria-label={`Notes for ${longDate(props.date)}`}
      placeholder="Notes for the day. Plain text or markdown, kept in the day's file."
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(save, NOTES_SAVE_MS);
      }}
      onBlur={save}
    />
  );
}
