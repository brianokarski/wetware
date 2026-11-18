import { isMap } from "yaml";
import type { DataFs } from "./fs";
import { parseMapDocument, YAML_OUT } from "./yamlPatch";

export type DayValue = boolean | number | string | string[] | null;

export interface Day {
  date: string;
  /** Every frontmatter key except date, _sources and _synced_at. */
  values: Record<string, DayValue>;
  sources: Record<string, string>;
  syncedAt: string | null;
  /** Markdown after the frontmatter, exactly as it is on disk. */
  body: string;
}

export interface DayPatch {
  /** `undefined` removes the key; `null` records "no value". */
  values?: Record<string, DayValue | undefined>;
  sources?: Record<string, string | undefined>;
  syncedAt?: string;
  /** Leave out to keep the body untouched. */
  body?: string;
}

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const RESERVED = new Set(["date", "_sources", "_synced_at"]);

export function dayPath(date: string): string {
  return `days/${date}.md`;
}

export function splitFrontmatter(raw: string): { yaml: string; body: string } {
  const match = FRONTMATTER.exec(raw);
  if (!match) return { yaml: "", body: raw };
  return { yaml: match[1] ?? "", body: raw.slice(match[0].length) };
}

export function parseDay(raw: string | null, date: string): Day {
  const { yaml, body } = splitFrontmatter(raw ?? "");
  const data = (parseMapDocument(yaml).toJS() ?? {}) as Record<string, unknown>;
  const values: Record<string, DayValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!RESERVED.has(key)) values[key] = value as DayValue;
  }
  const sources = data._sources && typeof data._sources === "object" ? data._sources : {};
  return {
    date,
    values,
    sources: { ...(sources as Record<string, string>) },
    syncedAt: typeof data._synced_at === "string" ? data._synced_at : null,
    body,
  };
}

/**
 * Returns the new file text for a day. Only the keys named in the patch
 * change: other frontmatter (including keys we've never heard of, comments and
 * ordering) and the body are carried over as they were.
 */
export function updateDayFile(raw: string | null, date: string, patch: DayPatch): string {
  const { yaml, body } = splitFrontmatter(raw ?? "");
  const doc = parseMapDocument(yaml);
  const before = doc.toString(YAML_OUT);

  if (!doc.has("date")) {
    // New file, or one written by hand without a date: put it first.
    const rest = isMap(doc.contents) ? [...doc.contents.items] : [];
    doc.contents = doc.createNode({ date });
    if (isMap(doc.contents)) doc.contents.items.push(...rest);
  }

  for (const [key, value] of Object.entries(patch.values ?? {})) {
    if (RESERVED.has(key)) continue;
    if (value === undefined) doc.delete(key);
    else doc.set(key, value);
  }

  for (const [key, source] of Object.entries(patch.sources ?? {})) {
    if (source === undefined) doc.deleteIn(["_sources", key]);
    else if (doc.has("_sources")) doc.setIn(["_sources", key], source);
    else doc.set("_sources", { [key]: source });
  }

  if (patch.syncedAt !== undefined) doc.set("_synced_at", patch.syncedAt);

  let nextBody = body;
  if (patch.body !== undefined) nextBody = patch.body;
  else if (raw === null) nextBody = "";
  // A brand new body gets the blank line Obsidian expects after frontmatter.
  if (patch.body !== undefined && nextBody !== "" && !/^\r?\n/.test(nextBody)) {
    nextBody = "\n" + nextBody;
  }

  // Nothing in the frontmatter changed: reuse the original text verbatim
  // rather than trusting the serializer to reproduce it.
  const untouched =
    raw !== null && before === doc.toString(YAML_OUT) && FRONTMATTER.test(raw);
  if (untouched) return raw.slice(0, raw.length - body.length) + nextBody;

  return `---\n${doc.toString(YAML_OUT)}---\n${nextBody}`;
}

export async function readDay(fs: DataFs, date: string): Promise<Day> {
  return parseDay(await fs.read(dayPath(date)), date);
}

export async function writeDay(fs: DataFs, date: string, patch: DayPatch): Promise<Day> {
  const next = updateDayFile(await fs.read(dayPath(date)), date, patch);
  await fs.write(dayPath(date), next);
  return parseDay(next, date);
}
