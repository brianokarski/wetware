import { useEffect, useState } from "react";
import { Choice, Mono, Row, Table } from "../components/primitives";
import type { Settings as SettingsData } from "../data";
import { intervalsKey } from "../platform/tauri";

interface Props {
  dataRoot: string | null;
  suggestedRoot: string;
  settings: SettingsData | null;
  pagesGoal: number | null;
  onChooseFolder: () => void;
  onUseSuggested: () => void;
  onSave: (patch: Partial<SettingsData>) => void;
  onPagesGoal: (goal: number) => void;
}

function numberOrNull(text: string): number | null {
  const n = Number(text);
  return text.trim() === "" || Number.isNaN(n) ? null : n;
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
          <ApiKeyRow />
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
                  options={["lb", "kg"] as const}
                  onChange={(weight) => props.onSave({ units: { ...settings.units, weight } })}
                />
              </Row>
              <Row label="Temperature">
                <Choice
                  label="Temperature unit"
                  value={settings.units.temperature}
                  options={["F", "C"] as const}
                  onChange={(temperature) =>
                    props.onSave({ units: { ...settings.units, temperature } })
                  }
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
                    const goal = numberOrNull(text);
                    if (goal !== null && goal > 0) props.onPagesGoal(Math.round(goal));
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

/** Text field that saves on blur or Enter, and reverts on Escape. */
function CommitField(props: {
  label: string;
  value: string;
  placeholder?: string;
  short?: boolean;
  inputMode?: "numeric" | "decimal";
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);

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
      onBlur={() => text !== props.value && props.onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(props.value);
      }}
    />
  );
}

function LocationRows(props: {
  settings: SettingsData;
  onSave: (patch: Partial<SettingsData>) => void;
}) {
  const { location } = props.settings;
  const save = (patch: Partial<SettingsData["location"]>) =>
    props.onSave({ location: { ...location, ...patch } });

  return (
    <>
      <Row label="City">
        <CommitField
          label="City"
          placeholder="Name, for your own reference"
          value={location.name}
          onCommit={(name) => save({ name: name.trim() })}
        />
      </Row>
      <Row label="Latitude">
        <CommitField
          label="Latitude"
          short
          inputMode="decimal"
          placeholder="00.00"
          value={location.latitude === null ? "" : String(location.latitude)}
          onCommit={(text) => save({ latitude: numberOrNull(text) })}
        />
      </Row>
      <Row label="Longitude">
        <CommitField
          label="Longitude"
          short
          inputMode="decimal"
          placeholder="00.00"
          value={location.longitude === null ? "" : String(location.longitude)}
          onCommit={(text) => save({ longitude: numberOrNull(text) })}
        />
      </Row>
    </>
  );
}

function ApiKeyRow() {
  const [stored, setStored] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    intervalsKey.exists().then(setStored, (e) => setError(String(e)));
  useEffect(() => void refresh(), []);

  const run = (task: Promise<void>) =>
    task.then(
      () => {
        setDraft("");
        setError(null);
        return refresh();
      },
      (e) => setError(String(e)),
    );

  return (
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
  );
}
