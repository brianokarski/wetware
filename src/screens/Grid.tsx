import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Mono } from "../components/primitives";
import {
  cellNoticeKey, cellPatch, cellState, dayNoticeKey, dayPath, daysInMonth, describeCell, habitHint, loadMonth, longDate,
  monthAndDay, monthCount, monthDates, monthKey, monthName, monthOf, nextMonth, parseCellInput, previousMonth, readDay,
  reason, sameMonth, shortNumber, weekdayInitial, withPatch, writeCell,
  type Cell, type CellValue, type DataFs, type Day, type Habit, type YearMonth,
} from "../data";

interface Props {
  fs: DataFs;
  habits: Habit[];
  /** Today's date key. */
  today: string;
  /** Opens the day panel. It arrives in Milestone 4; until then the hook does nothing. */
  onOpenDay: (date: string) => void;
  /**
   * Puts something on the message line: a failed save, input that wasn't
   * accepted, a file that needs fixing. `key` says what it is about.
   */
  notify: (key: string, text: string) => void;
  /** Takes notices off the message line once what they were about has gone right. */
  settle: (...keys: string[]) => void;
}

/** The notice key for a month that couldn't be loaded. */
const MONTH_NOTICE = "month";

/** Where keyboard focus sits in the grid. Row -1 is the row of day headers. */
interface Position {
  row: number;
  col: number;
}

const HEADER_ROW = -1;
/**
 * Most characters a value gets in its box: when the boxes are wide enough to
 * set that many legibly, and when they aren't. The full value is always in
 * the cell's label.
 */
const VALUE_WIDTH = 5;
const VALUE_WIDTH_NARROW = 3;
const TYPED = new Set(["number", "scale", "duration", "progress"]);
/** Types whose cells show the number itself. A progress cell shows a fill instead. */
const SHOWS_NUMBER = new Set(["number", "scale", "duration"]);

/** What each type of habit accepts, said plainly, for when input is turned down. */
const ACCEPTS: Record<string, string> = {
  number: "a number",
  scale: "a whole number from 1 to 5",
  duration: "a whole number, 0 or more",
  progress: "a whole number, 0 or more",
};

/**
 * The month as a typographic table: habits down the left, a column for each
 * day, a count at the right edge. One tab stop; arrow keys move between cells.
 */
export function Grid({ fs, habits, today, onOpenDay, notify, settle }: Props) {
  const [month, setMonth] = useState<YearMonth>(() => monthOf(today));
  const [days, setDays] = useState<Record<string, Day> | null>(null);
  const [wanted, setFocus] = useState<Position>(() => ({ row: 0, col: Number(today.slice(8)) - 1 }));
  /** The open editor. `replace`: the text is selected when it opens, so typing replaces it. */
  const [editing, setEditing] = useState<(Position & { text: string; replace: boolean }) | null>(null);
  const table = useRef<HTMLTableElement>(null);
  /** Writes still on their way to disk, per date. The screen follows the file once they have all landed. */
  const inFlight = useRef(new Map<string, number>());
  /** Set when the keyboard closes an editor, so focus goes back to the cell it was in. */
  const refocus = useRef(false);

  const dates = monthDates(month);
  const rows = habits.filter((habit) => !habit.archived);
  // Where focus is, kept inside the grid as it is now: with no habits, that is the row of day headers.
  const focus = { row: Math.min(wanted.row, rows.length - 1), col: Math.min(wanted.col, dates.length - 1) };
  const isCurrent = sameMonth(month, monthOf(today));
  const key = monthKey(month);
  const when = isCurrent ? `Day ${Number(today.slice(8))}` : key < today.slice(0, 7) ? "Past" : "Ahead";

  useEffect(() => {
    let stale = false;
    setDays(null);
    setEditing(null);
    loadMonth(fs, month).then(
      (loaded) => {
        if (stale) return;
        setDays(loaded);
        // The month is here, and so is every day in it that could be read.
        const readable = Object.values(loaded).filter((day) => !day.error);
        settle(MONTH_NOTICE, ...readable.map((day) => dayNoticeKey(day.date)));
      },
      (e) => !stale && notify(MONTH_NOTICE, `${monthName(month)} could not be loaded. ${reason(e)}`),
    );
    return () => {
      stale = true;
    };
    // `month` is a new object on every render; its key says whether it is a different month.
  }, [fs, key]);

  const element = (at: Position) =>
    table.current?.querySelector<HTMLElement>(`[data-row="${at.row}"][data-col="${at.col}"]`) ?? null;

  const moveTo = useCallback(
    (at: Position) => {
      const next = {
        row: Math.max(HEADER_ROW, Math.min(rows.length - 1, at.row)),
        col: Math.max(0, Math.min(dates.length - 1, at.col)),
      };
      setFocus(next);
      table.current?.querySelector<HTMLElement>(`[data-row="${next.row}"][data-col="${next.col}"]`)?.focus();
    },
    [rows.length, dates.length],
  );

  useEffect(() => {
    if (editing === null && refocus.current) {
      refocus.current = false;
      element(focus)?.focus();
    }
  });

  const showMonth = (next: YearMonth) => {
    setMonth(next);
    // Keep the row; stay inside a shorter month.
    setFocus((at) => ({ row: at.row, col: Math.min(at.col, daysInMonth(next) - 1) }));
  };

  /** Shows the change at once, writes the file after, and follows the file once the write is done. */
  const setCell = (habit: Habit, date: string, value: CellValue) => {
    const before = days?.[date];
    if (!before) return;
    const show = (day: Day) => setDays((shown) => (shown && date in shown ? { ...shown, [date]: day } : shown));
    show(withPatch(before, cellPatch(habit, value)));

    const count = inFlight.current;
    count.set(date, (count.get(date) ?? 0) + 1);
    const landed = () => {
      count.set(date, (count.get(date) ?? 1) - 1);
      return count.get(date) === 0;
    };
    // A failure stays on the message line until this same cell saves, or it is dismissed.
    const notice = cellNoticeKey(date, habit.id);
    writeCell(fs, habit, date, value).then(
      (saved) => {
        if (landed()) show(saved);
        settle(notice);
      },
      (e) => {
        notify(notice, `${habit.name} on ${monthAndDay(date)} was not saved. ${reason(e)}`);
        // Put back what the file says, which is what was there before.
        if (landed()) readDay(fs, date).then(show, () => show(before));
      },
    );
  };

  const cellAt = (at: Position) => {
    const habit = rows[at.row];
    const day = days?.[dates[at.col]];
    return habit && day ? { habit, day, cell: cellState(habit, day, today) } : null;
  };

  /** Whether the cell can be changed. Says why not when the day file is the reason. */
  const editable = (day: Day): boolean => {
    if (day.date > today) return false;
    if (day.error) {
      notify(dayNoticeKey(day.date), `${dayPath(day.date)} needs fixing by hand before it can be changed. ${day.error}`);
      return false;
    }
    return true;
  };

  const activate = (at: Position, startWith?: string) => {
    const found = cellAt(at);
    if (!found || !editable(found.day)) return;
    const { habit, day, cell } = found;
    if (TYPED.has(habit.type)) {
      // Opened on a value, the value is selected; opened by typing, the typed character starts the entry.
      setEditing({ ...at, text: startWith ?? (cell.value === null ? "" : String(cell.value)), replace: startWith === undefined });
    } else {
      setCell(habit, day.date, cell.value === null);
    }
  };

  /** Sets a typed cell, unless that would change nothing. */
  const put = (at: Position, value: number | null) => {
    const found = cellAt(at);
    if (!found || !editable(found.day) || found.cell.value === value) return;
    setCell(found.habit, found.day.date, value);
  };

  const clear = (at: Position) => {
    const found = cellAt(at);
    if (!found || found.cell.value === null || !editable(found.day)) return;
    setCell(found.habit, found.day.date, TYPED.has(found.habit.type) ? null : false);
  };

  const closeEditor = (save: boolean, byKeyboard: boolean) => {
    if (!editing) return;
    const habit = rows[editing.row];
    setEditing(null);
    refocus.current = byKeyboard;
    if (!save || !habit) return;
    const parsed = parseCellInput(habit.type, editing.text);
    if (parsed.ok) put(editing, parsed.value);
    else {
      const date = dates[editing.col];
      notify(
        cellNoticeKey(date, habit.id),
        `${habit.name} takes ${ACCEPTS[habit.type]}. "${editing.text.trim()}" was not saved for ${monthAndDay(date)}.`,
      );
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (editing || event.altKey) return;
    const { row, col } = focus;
    const jump = event.ctrlKey || event.metaKey;
    const moves: Record<string, Position> = {
      ArrowLeft: { row, col: col - 1 },
      ArrowRight: { row, col: col + 1 },
      ArrowUp: { row: row - 1, col },
      ArrowDown: { row: row + 1, col },
      Home: { row: jump ? 0 : row, col: 0 },
      End: { row: jump ? rows.length - 1 : row, col: dates.length - 1 },
    };
    if (event.key in moves) {
      event.preventDefault();
      moveTo(moves[event.key]);
      return;
    }
    // The day headers are buttons: Enter and Space already press them.
    if (row === HEADER_ROW || jump) return;
    const type = rows[row]?.type;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(focus);
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      clear(focus);
    } else if (type === "scale" && /^[1-5]$/.test(event.key)) {
      event.preventDefault();
      put(focus, Number(event.key));
    } else if (type !== "scale" && TYPED.has(type ?? "") && /^[0-9.-]$/.test(event.key)) {
      // Typing a number starts an entry with it, as in a spreadsheet.
      event.preventDefault();
      activate(focus, event.key);
    }
  };

  return (
    <section className="month" aria-label={`${monthName(month)} ${month.year}`}>
      <header className="meta-row">
        <Mono>{month.year}</Mono>
        <Mono>{dates.length} days</Mono>
        <Mono muted>{when}</Mono>
        <span className="month-nav mono">
          <button type="button" className="choice" onClick={() => showMonth(previousMonth(month))}>
            ← {monthName(previousMonth(month))}
          </button>
          <button
            type="button"
            className="choice"
            aria-pressed={isCurrent}
            onClick={() => {
              setMonth(monthOf(today));
              setFocus((at) => ({ row: at.row, col: Number(today.slice(8)) - 1 }));
            }}
          >
            Today
          </button>
          <button type="button" className="choice" onClick={() => showMonth(nextMonth(month))}>
            {monthName(nextMonth(month))} →
          </button>
        </span>
      </header>

      <h1 className="display">{monthName(month)}</h1>

      <table
        ref={table}
        className="grid"
        role="grid"
        aria-label={`${monthName(month)} ${month.year}, habits by day`}
        aria-busy={days === null}
        aria-rowcount={rows.length + 1}
        aria-colcount={dates.length + 2}
        style={{ "--days": dates.length } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        <colgroup>
          <col className="grid-col-habit" />
          {dates.map((date) => (
            <col
              key={date}
              className={days?.[date]?.error ? "grid-col-unread" : date === today ? "grid-col-today" : undefined}
            />
          ))}
          <col className="grid-col-count" />
        </colgroup>
        <thead>
          <tr role="row">
            <th role="columnheader" scope="col" className="grid-corner">
              <Mono muted>Habit</Mono>
            </th>
            {dates.map((date, col) => {
              const day = days?.[date];
              const hasNotes = !!day && day.notes.trim() !== "";
              const facts = [longDate(date), date === today && "today", hasNotes && "has notes", day?.error && "file needs fixing"];
              return (
                <th
                  key={date}
                  role="columnheader"
                  scope="col"
                  className="grid-day"
                  data-today={date === today || undefined}
                  data-future={date > today || undefined}
                  aria-current={date === today ? "date" : undefined}
                >
                  <button
                    type="button"
                    className="grid-day-button mono"
                    data-row={HEADER_ROW}
                    data-col={col}
                    data-date={date}
                    tabIndex={focus.row === HEADER_ROW && focus.col === col ? 0 : -1}
                    aria-label={facts.filter(Boolean).join(", ")}
                    title={day?.error ? `${dayPath(date)}: ${day.error}` : undefined}
                    onFocus={() => setFocus({ row: HEADER_ROW, col })}
                    onClick={() => onOpenDay(date)}
                  >
                    <span className="grid-weekday" aria-hidden="true">{weekdayInitial(date)}</span>
                    <span aria-hidden="true">{Number(date.slice(8))}</span>
                    {day?.error ? (
                      <span className="grid-flag" aria-hidden="true">!</span>
                    ) : (
                      hasNotes && <span className="grid-notes" aria-hidden="true" />
                    )}
                  </button>
                </th>
              );
            })}
            <th role="columnheader" scope="col" className="grid-count">
              <Mono muted>Days</Mono>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((habit, row) => {
            const count = days ? monthCount(habit, Object.values(days), month) : null;
            // The row's longest value, in full and shortened, sets the size all its values are shown at.
            const texts = SHOWS_NUMBER.has(habit.type)
              ? dates.map((date) => valueTexts(days?.[date] && !days[date].error ? cellState(habit, days[date], today) : null))
              : [];
            const widest = (which: 0 | 1) => Math.max(1, ...texts.map((pair) => pair[which].length));
            return (
              <tr key={habit.id} role="row" style={{ "--chars": widest(0), "--chars-short": widest(1) } as CSSProperties}>
                <th role="rowheader" scope="row">
                  <div className="grid-habit">
                    <span className="grid-habit-name">{habit.name}</span>
                    <span className="grid-habit-hint mono muted">{habitHint(habit)}</span>
                  </div>
                </th>
                {dates.map((date, col) => {
                  const day = days?.[date];
                  // A day whose file can't be read shows nothing: its values aren't known.
                  const cell = day && !day.error ? cellState(habit, day, today) : null;
                  const isEditing = editing?.row === row && editing.col === col;
                  const description = !day ? "loading" : cell ? describeCell(habit, cell) : "file needs fixing";
                  return (
                    <td
                      key={date}
                      role="gridcell"
                      className="grid-cell"
                      data-row={row}
                      data-col={col}
                      data-habit={habit.id}
                      data-date={date}
                      data-type={habit.type}
                      data-state={cell?.state}
                      data-future={date > today || undefined}
                      data-unread={day?.error ? true : undefined}
                      tabIndex={focus.row === row && focus.col === col && !isEditing ? 0 : -1}
                      aria-label={`${habit.name}, ${longDate(date)}: ${description}`}
                      aria-disabled={date > today || undefined}
                      title={cell?.value != null && typeof cell.value === "number" ? describeCell(habit, cell) : undefined}
                      onFocus={() => setFocus({ row, col })}
                      onClick={() => !isEditing && activate({ row, col })}
                    >
                      {isEditing ? (
                        <input
                          className="grid-input mono"
                          aria-label={`${habit.name}, ${longDate(date)}`}
                          inputMode={habit.type === "number" ? "decimal" : "numeric"}
                          autoComplete="off"
                          spellCheck={false}
                          autoFocus
                          onFocus={(e) => editing.replace && e.currentTarget.select()}
                          value={editing.text}
                          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                          onBlur={() => closeEditor(true, false)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") closeEditor(true, true);
                            if (e.key === "Escape") closeEditor(false, true);
                          }}
                        />
                      ) : (
                        cell && <CellMark habit={habit} cell={cell} />
                      )}
                    </td>
                  );
                })}
                <td role="gridcell" className="grid-count" aria-label={count ? `${habit.name}: ${count.done} of ${count.total} days` : undefined}>
                  {count && (
                    <>
                      {count.done}
                      <span className="muted">/{count.total}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <Mono muted>No habits to show. They are listed in habits.yaml, in the data folder.</Mono>}
    </section>
  );
}

/** A numeric cell's value as shown in a wide box and in a narrow one. Empty strings if it shows no number. */
function valueTexts(cell: Cell | null): [string, string] {
  if (!cell || typeof cell.value !== "number") return ["", ""];
  return [shortNumber(cell.value, VALUE_WIDTH), shortNumber(cell.value, VALUE_WIDTH_NARROW)];
}

/** What a cell shows. Empty for a missed, pending or future day: the empty box is the whole statement. */
function CellMark({ habit, cell }: { habit: Habit; cell: Cell }) {
  if (cell.state === "no_data") return <span className="mark mark-none" />;
  if (cell.value === null) return null;
  if (habit.type === "tag") return <span className="mark mark-tag" />;
  if (habit.type === "check" || (habit.type === "progress" && cell.met)) return <span className="mark mark-x" />;
  if (habit.type === "progress") {
    return <span className="mark mark-fill" style={{ "--fill": cell.fraction ?? 0 } as CSSProperties} />;
  }
  const [full, short] = valueTexts(cell);
  if (full === short) return <span className="grid-value mono">{full}</span>;
  // Both are in the page; the stylesheet shows the one that fits the width of a day's box.
  return (
    <>
      <span className="grid-value-full mono">{full}</span>
      <span className="grid-value-short mono">{short}</span>
    </>
  );
}
