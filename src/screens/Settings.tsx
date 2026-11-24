import { useEffect, useState } from "react";
import { Choice, Mono, Row, Table } from "../components/primitives";
import {
  parseCoordinate, parseWordGoal, TEMPERATURE_UNITS, WEIGHT_UNITS,
  type Habit, type Settings as SettingsData, type SettingsPatch,
} from "../data";
import { intervalsKey } from "../platform/tauri";
import { asProblem, CONNECTION_TEST_DAYS, habitsNotSetUp, problemText, type ActivitySummary } from "../sync";

interface Props {
  dataRoot: string | null;
  suggestedRoot: string;
  settings: SettingsData | null;
  habits: Habit[];
  pagesGoal: number | null;
  /** Activities the last sync couldn't read because they came through Strava. */
  withheld: number;
  /** Records the last sync couldn't use: no day or start it could read, or no type. */
  unreadable: number;
  /** Asks intervals.icu for the last 90 days of activities. Rejects with what went wrong. */
  onTestConnection: () => Promise<ActivitySummary>;
  onChooseFolder: () => void;
  onUseSuggested: () => void;
  onSave: (patch: SettingsPatch) => void;
  onPagesGoal: (goal: number) => void;
}

export function Settings(props: Props) {
  const { dataRoot, settings } = props;

  return (
    <>
      <h1 className="display">Settings</h1>
      <div className="stack">
        <Table label="Data">
          <Row label="Folder">
            <span className={dataRoot ? "grow selectable" : "grow muted"}>
              {dataRoot ?? "Not chosen yet"}
            </span>
            <button type="button" className="action" onClick={props.onChooseFolder}>
              Choose
            </button>
            {!dataRoot && (
              <button type="button" className="action" onClick={props.onUseSuggested}>
                Use {props.suggestedRoot.replace(/^\/Users\/[^/]+/, "~")}
              </button>
            )}
            <span className="row-note">
              <Mono muted>
                Plain markdown and YAML. Can live inside an Obsidian vault.
              </Mono>
            </span>
          </Row>
        </Table>

        <Table label="intervals.icu">
          <IntervalsRows habits={props.habits} withheld={props.withheld} unreadable={props.unreadable} onTest={props.onTestConnection} />
        </Table>

        {settings && (
          <>
            <Table label="Weather">
              <LocationRows settings={settings} onSave={props.onSave} />
            </Table>

            <Table label="Units">
              <Row label="Weight">
                <Choice
                  label="Weight unit"
                  value={settings.units.weight}
                  options={WEIGHT_UNITS}
                  onChange={(weight) => props.onSave({ units: { weight } })}
                />
              </Row>
              <Row label="Temperature">
                <Choice
                  label="Temperature unit"
                  value={settings.units.temperature}
                  options={TEMPERATURE_UNITS}
                  onChange={(temperature) => props.onSave({ units: { temperature } })}
                />
              </Row>
              <Row label="Sleep">
                <span className="muted">hours</span>
              </Row>
            </Table>

            <Table label="Morning pages">
              <Row label="Word goal">
                <CommitField
                  label="Morning pages word goal"
                  short
                  inputMode="numeric"
                  value={props.pagesGoal === null ? "" : String(props.pagesGoal)}
                  onCommit={(text) => {
                    const goal = parseWordGoal(text);
                    if (!goal.ok) return null;
                    props.onPagesGoal(goal.value);
                    return String(goal.value);
                  }}
                />
                <Mono muted>words / about 250 to a page</Mono>
              </Row>
            </Table>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Text field that saves on blur or Enter, and reverts on Escape. `onCommit`
 * returns the text as saved, or null if the input is invalid: nothing is
 * saved then and the field goes back to the saved value.
 */
function CommitField(props: {
  label: string;
  value: string;
  placeholder?: string;
  short?: boolean;
  inputMode?: "numeric" | "decimal";
  onCommit: (text: string) => string | null;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    if (text !== props.value) setText(props.onCommit(text) ?? props.value);
  };

  return (
    <input
      className={props.short ? "field field-short" : "field"}
      aria-label={props.label}
      placeholder={props.placeholder}
      inputMode={props.inputMode}
      spellCheck={false}
      autoComplete="off"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(props.value);
      }}
    />
  );
}

function LocationRows(props: {
  settings: SettingsData;
  onSave: (patch: SettingsPatch) => void;
}) {
  const { location } = props.settings;
  const shown = (degrees: number | null) => (degrees === null ? "" : String(degrees));
  /** An emptied field clears the coordinate. Anything else has to be a number in range. */
  const commit = (kind: "latitude" | "longitude") => (text: string) => {
    const degrees = parseCoordinate(text, kind);
    if (!degrees.ok) return null;
    props.onSave({ location: { [kind]: degrees.value } });
    return shown(degrees.value);
  };

  return (
    <>
      <Row label="City">
        <CommitField
          label="City"
          placeholder="Name, for your own reference"
          value={location.name}
          onCommit={(text) => {
            const name = text.trim();
            props.onSave({ location: { name } });
            return name;
          }}
        />
      </Row>
      <Row label="Latitude">
        <CommitField
          label="Latitude"
          short
          inputMode="decimal"
          placeholder="00.00"
          value={shown(location.latitude)}
          onCommit={commit("latitude")}
        />
      </Row>
      <Row label="Longitude">
        <CommitField
          label="Longitude"
          short
          inputMode="decimal"
          placeholder="00.00"
          value={shown(location.longitude)}
          onCommit={commit("longitude")}
        />
      </Row>
      <Row label="Source">
        <span>Open-Meteo</span>
        <span className="row-note">
          <Mono muted>
            {location.latitude === null || location.longitude === null
              ? "No weather is logged until a latitude and longitude are set."
              : "Each day's high, low, precipitation and conditions. No account or key."}
          </Mono>
        </span>
      </Row>
    </>
  );
}

/** Where a connection test stands. */
type Test =
  | { status: "idle" }
  | { status: "running" }
  | { status: "connected"; summary: ActivitySummary }
  | { status: "failed"; text: string };

/** "Lift", "Lift and Climb", "Lift, Climb and Row". */
function listed(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The API key, a test of it, and what the test found: the activity types in
 * the user's own data, which is where the names for a habit's
 * `activity_types` come from.
 */
function IntervalsRows(props: { habits: Habit[]; withheld: number; unreadable: number; onTest: () => Promise<ActivitySummary> }) {
  const [stored, setStored] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<Test>({ status: "idle" });

  const refresh = () =>
    intervalsKey.exists().then(setStored, (e) => setError(String(e)));
  useEffect(() => void refresh(), []);

  const run = (task: Promise<void>) =>
    task.then(
      () => {
        setDraft("");
        setError(null);
        // What an earlier test found was about the key as it was.
        setTest({ status: "idle" });
        return refresh();
      },
      (e) => setError(String(e)),
    );

  const runTest = () => {
    setTest({ status: "running" });
    props.onTest().then(
      (summary) => setTest({ status: "connected", summary }),
      (e) => setTest({ status: "failed", text: problemText("intervals.icu", asProblem(e)) }),
    );
  };

  const summary = test.status === "connected" ? test.summary : null;
  const unset = habitsNotSetUp(props.habits).map((habit) => habit.name);
  // From the test if there has been one, else from the last sync.
  const withheld = summary ? summary.withheld : props.withheld;
  const unreadable = summary ? summary.unreadable : props.unreadable;

  return (
    <>
      <Row label="API key">
        <input
          className="field"
          type="password"
          aria-label="intervals.icu API key"
          placeholder={stored ? "Stored in Keychain" : "Paste key"}
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) void run(intervalsKey.set(draft));
          }}
        />
        <button
          type="button"
          className="action"
          disabled={!draft.trim()}
          onClick={() => void run(intervalsKey.set(draft))}
        >
          Save
        </button>
        {stored && (
          <button
            type="button"
            className="action"
            aria-disabled={test.status === "running" || undefined}
            onClick={() => test.status !== "running" && runTest()}
          >
            Test connection
          </button>
        )}
        {stored && (
          <button type="button" className="action" onClick={() => void run(intervalsKey.delete())}>
            Remove
          </button>
        )}
        <span className="row-note">
          <Mono muted>
            {error ??
              (stored === null
                ? "Checking Keychain"
                : stored
                  ? "Kept in the macOS Keychain. Never written to the data folder."
                  : "Not set. intervals.icu / Settings / Developer Settings.")}
          </Mono>
        </span>
      </Row>

      {test.status !== "idle" && (
        <Row label="Connection">
          <span role="status">
            {test.status === "running" && <span className="muted">Asking intervals.icu</span>}
            {test.status === "failed" && test.text}
            {summary &&
              (summary.total + summary.withheld + summary.unreadable > 0
                ? "Connected"
                : `Connected. No activities in the last ${CONNECTION_TEST_DAYS} days.`)}
          </span>
        </Row>
      )}

      {summary && summary.types.length > 0 && (
        <Row label="Activity types">
          <span className="mono selectable">
            {summary.types.map(({ type, count }, i) => (
              <span key={type}>
                {type} <span className="muted">{count}</span>
                {i < summary.types.length - 1 && <span className="muted">, </span>}
              </span>
            ))}
          </span>
          <span className="row-note">
            <Mono muted>
              As intervals.icu names them, with how many of each in the last {CONNECTION_TEST_DAYS} days.
            </Mono>
          </span>
        </Row>
      )}

      {unset.length > 0 && (
        <Row label="Not set up">
          <span>{listed(unset)}</span>
          <span className="row-note">
            <Mono muted>
              No activity types yet, so sync leaves {unset.length === 1 ? "it" : "them"} alone. In habits.yaml, list the types
              that count under source_rule / activity_types. Test connection shows the names in use.
            </Mono>
          </span>
        </Row>
      )}

      {unreadable > 0 && (
        <Row label="Unreadable">
          <span>
            {unreadable} {unreadable === 1 ? "record" : "records"} can't be read
          </span>
          <span className="row-note">
            <Mono muted>
              {unreadable === 1 ? "Its" : "Their"} date or type isn't in the form this app expects, so sync leaves{" "}
              {unreadable === 1 ? "it" : "them"} out. If this is most of what intervals.icu has, the app needs fixing, not the data.
            </Mono>
          </span>
        </Row>
      )}

      {withheld > 0 && (
        <Row label="Strava">
          <span>
            {withheld} {withheld === 1 ? "activity" : "activities"} can't be read
          </span>
          <span className="row-note">
            <Mono muted>
              {withheld === 1 ? "It" : "They"} reached intervals.icu through Strava, which doesn't pass activities on. Is your
              device connected to intervals.icu directly, not through Strava?
            </Mono>
          </span>
        </Row>
      )}
    </>
  );
}
