import { STRUCTURE_KEYS, TAGS_KEY, TAIL_KEYS } from "./dayKeys";
import type { DataFs } from "./fs";
import { inTurn } from "./queue";
import { detectEol, isDict, patchYaml, readYaml, YamlPatchError, type Eol, type YamlOp } from "./yamlPatch";

export type DayValue = boolean | number | string | string[] | null;

export interface Day {
  date: string;
  /** Every frontmatter key except date, _sources and _synced_at. */
  values: Record<string, DayValue>;
  sources: Record<string, string>;
  syncedAt: string | null;
  /** Everything after the frontmatter, exactly as it is on disk. */
  body: string;
  /**
   * The body as a notes editor should show it: without the one blank line
   * that follows the frontmatter, and with `\n` line endings.
   */
  notes: string;
  /**
   * Set when the file can't be read or written safely and needs fixing by
   * hand. `values` and `sources` are empty then, and writes will throw.
   */
  error: string | null;
}

export interface DayPatch {
  /** `undefined` removes the key; `null` records "no value". */
  values?: Record<string, DayValue | undefined>;
  sources?: Record<string, string | undefined>;
  syncedAt?: string;
  /**
   * Tags to add to or take out of the `tags` list. The other tags, and how
   * the list is written, are left as they are. Use this or `values.tags`.
   */
  tags?: { add?: string[]; remove?: string[] };
  /**
   * Raw body. Leave out to keep the body untouched. Writing back the `body`
   * that was read changes nothing; a different one gets a blank line between
   * it and the frontmatter if it doesn't start with one.
   */
  body?: string;
  /** Edited notes: the counterpart of `Day.notes`. Use this or `body`, not both. */
  notes?: string;
}

/** The day file exists but can't be written without risking what's in it. */
export class DayFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DayFileError";
  }
}

const BOM = "\uFEFF";
const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /---[ \t]*(?:\r?\n|$)/y;
/** A line that was probably meant to open frontmatter: `---`, or `---yaml`. */
const NEAR_OPEN = /^---\w*[ \t]*$/;
const RESERVED = new Set<string>(STRUCTURE_KEYS);
const TAIL: readonly string[] = TAIL_KEYS;

/** The folder of day files inside the data folder. */
export const DAYS_DIR = "days";

export function dayPath(date: string): string {
  return `${DAYS_DIR}/${date}.md`;
}

interface Parts {
  /** A byte order mark, if the file starts with one. It is kept at the very start. */
  bom: string;
  /** The opening `---` line, with its line break. Empty if there's no frontmatter. */
  open: string;
  /** YAML between the fences, including its final line break. */
  yaml: string;
  /** The closing `---` line. */
  close: string;
  body: string;
}

/** Offset of the first `---` line at or after `from`, and that line's text. */
function findClose(text: string, from: number): { at: number; line: string } | null {
  let pos = from;
  while (pos < text.length) {
    CLOSE.lastIndex = pos;
    const match = CLOSE.exec(text);
    if (match) return { at: pos, line: match[0] };
    const next = text.indexOf("\n", pos);
    if (next < 0) break;
    pos = next + 1;
  }
  return null;
}

function split(raw: string): Parts & { nearMiss: boolean } {
  const bom = raw.startsWith(BOM) ? BOM : "";
  const text = raw.slice(bom.length);
  const none = { bom, open: "", yaml: "", close: "", body: text, nearMiss: false };

  const open = OPEN.exec(text);
  if (open) {
    const close = findClose(text, open[0].length);
    // `---` with nothing closing it is a horizontal rule, and the file is all body.
    if (!close) return none;
    return {
      bom,
      open: open[0],
      yaml: text.slice(open[0].length, close.at),
      close: close.line,
      body: text.slice(close.at + close.line.length),
      nearMiss: false,
    };
  }

  // Not frontmatter, but is it meant to be? Blank lines above the fence, or
  // `---yaml`, would make us stack a second block on top of the first.
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first >= 0 && NEAR_OPEN.test(lines[first].replace(/\r$/, ""))) {
    const after = lines.slice(0, first + 1).join("\n").length + 1;
    if (findClose(text, after)) return { ...none, nearMiss: true };
  }
  return none;
}

/** The YAML between the fences. Kept for callers that compare frontmatter text. */
export function splitFrontmatter(raw: string): { yaml: string; body: string } {
  const { yaml, body } = split(raw);
  return { yaml: yaml.replace(/\r?\n$/, ""), body };
}

interface Inspected {
  parts: Parts;
  data: Record<string, unknown>;
  error: string | null;
}

/** One reading of the file for both `parseDay` and `updateDayFile`, so they agree on what's broken. */
function inspect(raw: string): Inspected {
  const { nearMiss, ...parts } = split(raw);
  const broken = (error: string): Inspected => ({ parts, data: {}, error });
  if (nearMiss) {
    return broken("Frontmatter has to start on the first line. Remove what's above the first --- line.");
  }
  let data: unknown;
  try {
    data = readYaml(parts.yaml);
  } catch (e) {
    if (!(e instanceof YamlPatchError)) throw e;
    // Line 1 of the file is the opening fence.
    const where = e.line === undefined ? "" : ` (line ${e.line + 1})`;
    return broken(`Frontmatter: ${e.message}${where}.`);
  }
  if (data === null || data === undefined) return { parts, data: {}, error: null };
  if (!isDict(data)) return broken("Frontmatter has to be a list of key: value lines.");
  return { parts, data, error: null };
}

/**
 * The tags on a day, from the `tags` value of its frontmatter. A list is read
 * as it is; a single word (`tags: travel`) is one tag.
 */
export function tagList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim())
    .filter((tag) => tag !== "");
}

/**
 * Operations that add and remove tags, touching only those items of the list.
 * A list the app writes itself is `tags: [..]`, as SPEC §6.2 shows it, and
 * stays that way down to `tags: []`; a list written out over lines by hand
 * stays as it is until its last item goes.
 */
function tagOps(current: unknown, { add = [], remove = [] }: NonNullable<DayPatch["tags"]>): YamlOp[] {
  // A map isn't a list of tags that got mangled; it is something else the user keeps there.
  if (isDict(current)) throw new DayFileError("tags has to be a list, like tags: [travel], before a tag can be changed.");
  const gone = (item: unknown) => tagList(item).some((tag) => remove.includes(tag));
  const before = tagList(current);
  const after = before.filter((tag) => !remove.includes(tag));
  for (const tag of add) if (!after.includes(tag)) after.push(tag);
  const whole: YamlOp[] = [{ op: "set", path: [TAGS_KEY], value: after, before: TAIL, flow: true }];

  if (!Array.isArray(current)) {
    // No list yet, or a single word: write the list. Nothing to write if no tag changes.
    const same = after.length === before.length && after.every((tag, i) => tag === before[i]);
    return same ? [] : whole;
  }
  if (after.length === 0) return current.length === 0 ? [] : whole;

  const ops: YamlOp[] = [];
  // Last first, so taking one out doesn't move the ones still to go.
  for (let i = current.length - 1; i >= 0; i--) {
    if (gone(current[i])) ops.push({ op: "delete", path: [TAGS_KEY, i] });
  }
  const kept = tagList(current.filter((item) => !gone(item)));
  for (const tag of add) {
    if (kept.includes(tag)) continue;
    kept.push(tag);
    ops.push({ op: "append", path: [TAGS_KEY], value: tag, flow: true });
  }
  return ops;
}

/** Plain assignment, except that a key called `__proto__` is stored like any other. */
function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
}

const toNotes = (body: string) => body.replace(/^\r?\n/, "").replace(/\r\n/g, "\n");

export function parseDay(raw: string | null, date: string): Day {
  const { parts, data, error } = inspect(raw ?? "");
  const values: Record<string, DayValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!RESERVED.has(key)) put(values, key, value as DayValue);
  }
  const sources: Record<string, string> = {};
  if (isDict(data._sources)) {
    for (const [key, source] of Object.entries(data._sources)) {
      if (typeof source === "string") put(sources, key, source);
    }
  }
  return {
    date,
    values,
    sources,
    syncedAt: typeof data._synced_at === "string" ? data._synced_at : null,
    body: parts.body,
    notes: toNotes(parts.body),
    error,
  };
}

function nextBody(current: string, patch: DayPatch, eol: Eol): string {
  if (patch.body !== undefined && patch.notes !== undefined) {
    throw new TypeError("Patch a day's body or its notes, not both");
  }
  if (patch.body !== undefined) {
    const asGiven = patch.body === current || patch.body === "" || /^\r?\n/.test(patch.body);
    return asGiven ? patch.body : eol + patch.body;
  }
  if (patch.notes === undefined || patch.notes === toNotes(current)) return current;
  if (patch.notes === "") return "";
  // Put back the blank line the notes view hides. A first note gets one too,
  // and so do notes that begin with a blank line of their own: without it,
  // their first line break would read back as the hidden one.
  const startsBlank = /^\r?\n/.test(patch.notes);
  const blank = /^\r?\n/.exec(current)?.[0] ?? (current === "" || startsBlank ? eol : "");
  return blank + patch.notes.replace(/\r?\n/g, eol);
}

/**
 * Returns the new file text for a day. Only the keys named in the patch
 * change: every other byte of the frontmatter and the body is carried over as
 * it was. Throws `DayFileError` if the file needs fixing by hand first.
 */
export function updateDayFile(raw: string | null, date: string, patch: DayPatch): string {
  const { parts, data, error } = inspect(raw ?? "");
  if (error) throw new DayFileError(error);
  const eol = detectEol(raw ?? "") ?? "\n";

  const ops: YamlOp[] = [];
  // The file name says which day this is. A `date` key that disagrees is kept as the user wrote it.
  // A file that has none is given one when it is created or when its frontmatter is changed anyway.
  // A change to the notes alone leaves the frontmatter, or the lack of one, exactly as it is.
  const inFrontmatter = [patch.values, patch.sources, patch.tags].some((part) => part !== undefined) || patch.syncedAt !== undefined;
  const body = nextBody(parts.body, patch, eol);
  const created = (raw ?? "") === "" && body !== "";
  if (!Object.prototype.hasOwnProperty.call(data, "date") && (created || inFrontmatter)) {
    ops.push({ op: "set", path: ["date"], value: date, first: true });
  }

  for (const [key, value] of Object.entries(patch.values ?? {})) {
    if (RESERVED.has(key)) continue;
    if (value === undefined) ops.push({ op: "delete", path: [key] });
    else ops.push({ op: "set", path: [key], value, before: TAIL });
  }
  if (patch.tags) {
    if (patch.values && TAGS_KEY in patch.values) throw new TypeError("Patch a day's tags or values.tags, not both");
    ops.push(...tagOps(data[TAGS_KEY], patch.tags));
  }
  for (const [key, source] of Object.entries(patch.sources ?? {})) {
    if (source === undefined) ops.push({ op: "delete", path: ["_sources", key] });
    // A `_sources` that is missing, empty or a plain value is replaced by a map.
    // One that is a list written out over lines is refused instead.
    else ops.push({ op: "set", path: ["_sources", key], value: source, before: ["_synced_at"] });
  }
  if (patch.syncedAt !== undefined) ops.push({ op: "set", path: ["_synced_at"], value: patch.syncedAt });

  let yaml: string;
  try {
    yaml = patchYaml(parts.yaml, ops, { eol });
  } catch (e) {
    if (e instanceof YamlPatchError) throw new DayFileError(e.message);
    throw e;
  }

  // No frontmatter before and none to write: the file stays the plain text it was.
  if (parts.open === "" && yaml === "") return parts.bom + body;
  const open = parts.open || `---${eol}`;
  let close = parts.close || `---${eol}`;
  if (body !== "" && !close.endsWith("\n")) close += eol;
  return parts.bom + open + yaml + close + body;
}

/**
 * Reads one day. It takes its turn behind any write to that day already
 * asked for, so what it returns is never older than a change made just before.
 */
export function readDay(fs: DataFs, date: string): Promise<Day> {
  const path = dayPath(date);
  return inTurn(fs, path, async () => parseDay(await fs.read(path), date));
}

/**
 * A change to a day: a patch, or a function that works the patch out from the
 * day as it is on disk at the moment of writing. The function form is for a
 * change that depends on what is there, such as sync, which must not write
 * over a value set by hand a moment before. Returning null writes nothing.
 */
export type DayChange = DayPatch | ((day: Day) => DayPatch | null);

/**
 * Reads, patches and writes one day. Calls for the same day run one at a
 * time, and a function given as the change is called inside that turn. A file
 * is only written if its text changes, and only created if there is a patch.
 */
export function writeDay(fs: DataFs, date: string, change: DayChange): Promise<Day> {
  const path = dayPath(date);
  return inTurn(fs, path, async () => {
    const raw = await fs.read(path);
    const patch = typeof change === "function" ? change(parseDay(raw, date)) : change;
    if (patch === null) return parseDay(raw, date);
    const next = updateDayFile(raw, date, patch);
    // A patch that changes nothing writes nothing, and doesn't bring an empty file into being.
    if (next !== (raw ?? "")) await fs.write(path, next);
    return parseDay(next, date);
  });
}
