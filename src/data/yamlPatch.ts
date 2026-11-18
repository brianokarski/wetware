/**
 * Lossless YAML patching.
 *
 * Every write to a day file's frontmatter, `settings.yaml` or `habits.yaml`
 * goes through `patchYaml`. It never re-serialises the document: each
 * operation changes only the source text of the entry it names, and every
 * other byte (comments, spacing, quoting, number formats, line endings) stays
 * as the user wrote it.
 *
 * Each operation is tried from least to most invasive:
 *   1. edit in place (swap a scalar's text, insert a line, remove lines);
 *   2. re-serialise the one entry the path points into;
 *   3. re-serialise the entry that contains it, and so on outwards.
 * A candidate is only accepted if parsing it gives exactly the data the
 * operation should produce. If nothing qualifies the patch throws, so a file
 * is left alone rather than damaged.
 */
import {
  Document, isAlias, isCollection, isMap, isNode, isScalar, isSeq, Pair, parseDocument,
  Scalar, YAMLMap, YAMLSeq,
  type Node,
} from "yaml";

/** Output style for anything we do have to write ourselves. */
export const YAML_OUT = { lineWidth: 0, flowCollectionPadding: false } as const;

export type YamlPath = readonly (string | number)[];

export type YamlOp =
  | {
      op: "set";
      path: YamlPath;
      value: unknown;
      /**
       * Where a new entry goes, if this creates one: ahead of the first of
       * these sibling keys that exists. Otherwise it goes last.
       */
      before?: readonly string[];
      /** Put a new entry ahead of its siblings. */
      first?: boolean;
    }
  /** Removes the entry. A path that doesn't exist is left alone. */
  | { op: "delete"; path: YamlPath }
  /** Adds an item to the end of the list at `path`, creating the list if needed. */
  | { op: "append"; path: YamlPath; value: unknown };

export type Eol = "\n" | "\r\n";

export class YamlPatchError extends Error {
  /** For invalid YAML: the line of the source the problem is on, from 1. */
  line?: number;

  constructor(message: string, line?: number) {
    super(message);
    this.name = "YamlPatchError";
    this.line = line;
  }
}

/** The parser's first complaint, without the source excerpt it would print underneath. */
function invalid(problem: unknown): YamlPatchError {
  const full = problem instanceof Error ? problem.message : String(problem);
  const [, what, line] = /^(.*?)(?: at line (\d+), column \d+)?:?$/.exec(full.split("\n")[0]) ?? [];
  return new YamlPatchError(`Invalid YAML: ${what ?? full}`, line ? Number(line) : undefined);
}

// ---------------------------------------------------------------------------
// Plain data model: what the document means, used to check every edit.
// ---------------------------------------------------------------------------

type Dict = Record<string, unknown>;

const has = (obj: object, key: string | number) =>
  Object.prototype.hasOwnProperty.call(obj, key);

export function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep copy into null-prototype objects, so aliases stop sharing and no key is special. */
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) {
    const out: Dict = Object.create(null);
    for (const [k, v] of value) if (v !== undefined) out[String(k)] = plain(v);
    return out;
  }
  if (isDict(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      throw new YamlPatchError("Only plain values can be written to YAML");
    }
    const out: Dict = Object.create(null);
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) out[key] = plain(value[key]);
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new YamlPatchError("Only plain values can be written to YAML");
  }
  return value;
}

/**
 * Deep equality. Integers in a document are read as bigints so none lose
 * precision; one equals the number a caller passed if it converts to it.
 */
export function same(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (typeof a === "bigint") return typeof b === "number" && Number(a) === b;
  if (typeof b === "bigint") return typeof a === "number" && Number(b) === a;
  if (typeof a === "number" && typeof b === "number") return a === b || (a !== a && b !== b);
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => same(v, b[i]));
  }
  if (isDict(a)) {
    if (!isDict(b) || Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => has(b, k) && same(a[k], b[k]));
  }
  return a === b;
}

function describe(path: YamlPath, upTo = path.length): string {
  const text = path
    .slice(0, upTo)
    .map((seg, i) => (typeof seg === "number" ? `[${seg}]` : i ? `.${seg}` : seg))
    .join("");
  return text || "the top level";
}

/** The container for `seg` inside `holder[key]`, created (or replaced) if it isn't one. */
function container(holder: Dict | unknown[], key: string | number, path: YamlPath, depth: number): Dict | unknown[] {
  const seg = path[depth];
  const current = (holder as Dict)[key];
  if (typeof seg === "number") {
    if (!Array.isArray(current)) throw new YamlPatchError(`Expected a list at ${describe(path, depth)}`);
    return current;
  }
  if (isDict(current)) return current;
  // The top level is never replaced: a file that isn't a map needs a person.
  if (depth === 0 && current !== null && current !== undefined) {
    throw new YamlPatchError("Expected a map at the top level");
  }
  const fresh: Dict = Object.create(null);
  (holder as Dict)[key] = fresh;
  return fresh;
}

function checkIndex(list: unknown[], seg: number, path: YamlPath, depth: number): void {
  if (!Number.isInteger(seg) || seg < 0 || seg >= list.length) {
    throw new YamlPatchError(`No item at ${describe(path, depth + 1)}`);
  }
}

/** Walks to the container holding the last path segment, creating maps on the way. */
function walk(holder: Dict, path: YamlPath): Dict | unknown[] {
  let current = container(holder, "root", path, 0);
  for (let depth = 0; depth < path.length - 1; depth++) {
    const seg = path[depth];
    if (Array.isArray(current)) checkIndex(current, seg as number, path, depth);
    current = container(current, seg, path, depth + 1);
  }
  return current;
}

/**
 * What the document should mean after `op`, or null if the operation changes
 * nothing. More than one answer is acceptable when removing the last entry of
 * a map or list: taking its line out leaves an empty value, which is null.
 */
function expected(model: unknown, op: YamlOp): unknown[] | null {
  const { path } = op;
  if (path.length === 0) throw new YamlPatchError("A patch needs a path");
  const holder: Dict = Object.create(null);
  holder.root = plain(model);
  const last = path[path.length - 1];

  if (op.op === "delete") {
    let current: unknown = holder.root;
    let parent: Dict | unknown[] = holder;
    let parentKey: string | number = "root";
    for (let depth = 0; depth < path.length; depth++) {
      const seg = path[depth];
      const fits = typeof seg === "number" ? Array.isArray(current) : isDict(current);
      if (!fits || !has(current as object, seg)) return null;
      if (depth === path.length - 1) break;
      parent = current as Dict | unknown[];
      parentKey = seg;
      current = (current as Dict)[seg];
    }
    if (Array.isArray(current)) current.splice(last as number, 1);
    else delete (current as Dict)[last];
    const answers = [plain(holder.root)];
    const emptied = Array.isArray(current) ? current.length === 0 : Object.keys(current as Dict).length === 0;
    if (emptied) {
      (parent as Dict)[parentKey] = null;
      answers.push(holder.root);
    }
    return answers;
  }

  const value = plain(op.value);
  const target = walk(holder, path);

  if (op.op === "append") {
    if (Array.isArray(target)) checkIndex(target, last as number, path, path.length - 1);
    const list = (target as Dict)[last];
    if (Array.isArray(list)) list.push(value);
    else if (list === null || list === undefined) (target as Dict)[last] = [value];
    else throw new YamlPatchError(`Expected a list at ${describe(path)}`);
    return [holder.root];
  }

  if (Array.isArray(target)) checkIndex(target, last as number, path, path.length - 1);
  if (has(target, last) && same((target as Dict)[last], value)) return null;
  (target as Dict)[last] = value;
  return [holder.root];
}

function valueAt(model: unknown, path: YamlPath): unknown {
  let current = model;
  for (const seg of path) current = (current as Dict)[seg];
  return current;
}

// ---------------------------------------------------------------------------
// Source text
// ---------------------------------------------------------------------------

interface Parsed {
  text: string;
  doc: Document.Parsed;
  model: unknown;
}

function parseSource(text: string): Parsed {
  const doc = parseDocument(text, { intAsBigInt: true, keepSourceTokens: true });
  if (doc.errors.length > 0) throw invalid(doc.errors[0]);
  try {
    return { text, doc, model: plain(doc.toJS()) };
  } catch (e) {
    throw invalid(e);
  }
}

export function detectEol(text: string): Eol | null {
  const i = text.indexOf("\n");
  if (i < 0) return null;
  return text[i - 1] === "\r" ? "\r\n" : "\n";
}

const lineStart = (text: string, pos: number) => text.lastIndexOf("\n", pos - 1) + 1;

function lineEnd(text: string, pos: number): number {
  const i = text.indexOf("\n", pos);
  return i < 0 ? text.length : i + 1;
}

const splice = (text: string, from: number, to: number, insert: string) =>
  text.slice(0, from) + insert + text.slice(to);

interface Token {
  type: string;
  offset: number;
}

function tokenOffset(tokens: Token[] | undefined, type: string): number | null {
  return tokens?.find((t) => t.type === type)?.offset ?? null;
}

/** One step of a path, found in the source. */
interface Entry {
  /** The collection this entry sits in. */
  parent: YAMLMap | YAMLSeq;
  value: Node | null;
  /** First character of the entry: the key (with any anchor or `?`), or the `-`. */
  start: number;
  /** Just after the `:` or the `-`. Null if the source has no such marker. */
  marker: number | null;
}

const WHITESPACE = new Set(["space", "newline", "comment"]);

function pairEntry(parent: YAMLMap, pair: Pair): Entry | null {
  if (!isNode(pair.key) || !pair.key.range) return null;
  const src = (pair as { srcToken?: { start?: Token[]; sep?: Token[] } }).srcToken;
  const lead = src?.start?.find((t) => !WHITESPACE.has(t.type));
  const colon = tokenOffset(src?.sep, "map-value-ind");
  return {
    parent,
    value: isNode(pair.value) ? pair.value : null,
    start: Math.min(lead?.offset ?? pair.key.range[0], pair.key.range[0]),
    marker: colon === null ? null : colon + 1,
  };
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
}

/** Offsets of each item's `-` in a block list, or null if they can't be matched up. */
function dashes(seq: YAMLSeq): number[] | null {
  const src = (seq as { srcToken?: { type?: string; items?: { start?: Token[] }[] } }).srcToken;
  if (src?.type !== "block-seq" || !src.items) return null;
  const found = src.items
    .map((item) => tokenOffset(item.start, "seq-item-ind"))
    .filter((offset): offset is number => offset !== null);
  return found.length === seq.items.length ? found : null;
}

function itemEntry(parent: YAMLSeq, index: number): Entry | null {
  if (index < 0 || index >= parent.items.length) return null;
  const item = parent.items[index];
  const value = isNode(item) ? item : null;
  const dash = dashes(parent)?.[index] ?? null;
  if (dash === null) {
    if (!value?.range) return null;
    return { parent, value, start: value.range[0], marker: null };
  }
  return { parent, value, start: dash, marker: dash + 1 };
}

/** Follows `path` through the source as far as it exists. */
function locate(doc: Document.Parsed, path: YamlPath): Entry[] {
  const entries: Entry[] = [];
  let node: unknown = doc.contents;
  for (const seg of path) {
    let entry: Entry | null = null;
    if (typeof seg === "string" && isMap(node)) {
      const pair = findPair(node, seg);
      entry = pair ? pairEntry(node, pair) : null;
    } else if (typeof seg === "number" && isSeq(node)) {
      entry = itemEntry(node, seg);
    }
    if (!entry) break;
    entries.push(entry);
    node = entry.value;
  }
  return entries;
}

/** No content yet, though there may be comments or a `---` line. */
function isEmptyDocument(doc: Document.Parsed): boolean {
  const root: unknown = doc.contents;
  if (root === null) return true;
  return isScalar(root) && root.value === null && !!root.range && root.range[0] === root.range[1];
}

function isBlock(node: unknown): node is YAMLMap | YAMLSeq {
  return isCollection(node) && !node.flow && node.items.length > 0;
}

/** The last entry of a block map or list, if it can be found in the source. */
function lastEntry(node: unknown): Entry | null {
  if (!isBlock(node)) return null;
  const last = node.items.length - 1;
  return isMap(node) ? pairEntry(node, node.items[last]) : itemEntry(node as YAMLSeq, last);
}

/** End of the last line an entry occupies (just past its line break). */
function entryEnd(text: string, entry: Entry): number {
  // A block collection ends where its last entry does. Its own range can run
  // on into comments that follow it, which belong to whatever comes next.
  const inner = lastEntry(entry.value);
  if (inner) return entryEnd(text, inner);
  const floor = entry.marker ?? entry.start;
  const pos = Math.max(entry.value?.range?.[1] ?? 0, floor);
  if (pos > floor && text[pos - 1] === "\n") return pos;
  return lineEnd(text, pos);
}

/** True when nothing but indentation sits before the entry on its line. */
function ownsLine(text: string, entry: Entry): boolean {
  return /^ *$/.test(text.slice(lineStart(text, entry.start), entry.start));
}

const column = (text: string, pos: number) => pos - lineStart(text, pos);

/** YAML source lines for one `key: value` pair or one `- item`, at column 0. */
function renderLines(key: string | null, value: unknown, flow: boolean): string[] {
  const doc = new Document();
  const node = doc.createNode(value);
  if (flow && isCollection(node)) node.flow = true;
  if (key === null) {
    const seq = new YAMLSeq();
    seq.items.push(node);
    doc.contents = seq;
  } else {
    const map = new YAMLMap();
    map.items.push(new Pair(new Scalar(key), node));
    doc.contents = map;
  }
  const lines = doc.toString(YAML_OUT).split("\n");
  lines.pop();
  return lines;
}

/** The text for a scalar where it can stand in for another on the same line, else null. */
function scalarText(value: unknown): string | null {
  if (value !== null && typeof value === "object") return null;
  const text = new Document(value).toString(YAML_OUT).replace(/\n$/, "");
  return text.includes("\n") ? null : text;
}

function indentLines(lines: string[], indent: number, eol: Eol, skipFirst = false): string {
  const pad = " ".repeat(indent);
  return lines.map((line, i) => (line === "" || (skipFirst && i === 0) ? line : pad + line)).join(eol);
}

/** Inserts whole lines at `at`, which is a line start or the end of the text. */
function insertLines(text: string, at: number, block: string, eol: Eol): string {
  const midLine = at === text.length && text.length > 0 && !text.endsWith("\n");
  return splice(text, at, at, midLine ? eol + block : block + eol);
}

/** Rewrites one entry's value, keeping its key (or dash) and everything outside it. */
function rewriteEntry(text: string, entry: Entry, value: unknown, eol: Eol): string | null {
  if (entry.marker === null || entry.parent.flow) return null;
  const flow = isCollection(entry.value) && entry.value.flow === true;
  const asPair = isMap(entry.parent);
  const lines = renderLines(asPair ? "k" : null, value, flow);
  // Drop the stand-in key (or the dash): the original stays in the file.
  lines[0] = lines[0].slice(asPair ? 2 : 1);
  const end = entryEnd(text, entry);
  const keepBreak = text.slice(entry.marker, end).endsWith("\n");
  const block = indentLines(lines, column(text, entry.start), eol, true) + (keepBreak ? eol : "");
  return splice(text, entry.marker, end, block);
}

function* candidates(
  { text, doc }: Parsed,
  op: YamlOp,
  model: unknown,
  eol: Eol,
): Generator<string | null> {
  const { path } = op;
  const found = locate(doc, path);
  const target = found.length === path.length ? found[found.length - 1] : null;
  const inFlow = found.some((e) => e.parent.flow);
  // Entries that may be re-serialised if editing in place isn't possible.
  let fallbackFrom = found.length - 1;

  if (op.op === "delete") {
    // The model said this exists, so `target` is set unless it came through an alias or merge.
    if (target && !inFlow && ownsLine(text, target)) {
      yield splice(text, lineStart(text, target.start), entryEnd(text, target), "");
    }
    fallbackFrom = path.length - 2;
  } else if (!target) {
    // New entry: one or more new lines in the deepest map that exists.
    const depth = found.length;
    const key = path[depth];
    const parent = depth === 0 ? doc.contents : found[depth - 1].value;
    const value = valueAt(model, path.slice(0, depth + 1));
    if (typeof key === "string" && isMap(parent) && isBlock(parent)) {
      const siblings = parent.items.map((pair) => pairEntry(parent, pair));
      if (siblings.every((e): e is Entry => e !== null)) {
        let index = siblings.length;
        if (op.op === "set" && op.first) index = 0;
        else if (op.op === "set" && op.before) {
          const before = op.before;
          const i = parent.items.findIndex((p) => isScalar(p.key) && before.includes(String(p.key.value)));
          if (i >= 0) index = i;
        }
        const first = siblings[0];
        const block = indentLines(renderLines(key, value, false), column(text, first.start), eol);
        if (index > 0) yield insertLines(text, entryEnd(text, siblings[index - 1]), block, eol);
        else if (ownsLine(text, first)) yield insertLines(text, lineStart(text, first.start), block, eol);
        else yield insertLines(text, entryEnd(text, siblings[siblings.length - 1]), block, eol);
      }
    } else if (depth === 0 && typeof key === "string" && isEmptyDocument(doc)) {
      yield insertLines(text, text.length, renderLines(key, value, false).join(eol), eol);
    }
  } else if (op.op === "append") {
    const list = target.value;
    if (isSeq(list) && isBlock(list)) {
      const first = itemEntry(list, 0);
      const last = itemEntry(list, list.items.length - 1);
      if (first?.marker && last?.marker) {
        const block = indentLines(renderLines(null, plain(op.value), false), column(text, first.start), eol);
        yield insertLines(text, entryEnd(text, last), block, eol);
      }
    }
  } else {
    // Existing entry: swap the scalar's own text when both old and new are simple.
    const value = plain(op.value);
    const node = target.value;
    const replacement = inFlow && typeof value === "string" ? null : scalarText(value);
    if (replacement !== null && node?.range) {
      const [from, to] = node.range;
      const inline = isScalar(node) && node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED";
      if (isAlias(node) || (inline && from < to)) {
        yield splice(text, from, to, replacement);
      } else if (inline && target.marker !== null && isMap(target.parent)) {
        // `key:` with nothing after it.
        yield splice(text, target.marker, target.marker, " " + replacement);
      }
    }
  }

  for (let depth = Math.min(fallbackFrom, found.length - 1); depth >= 0; depth--) {
    yield rewriteEntry(text, found[depth], valueAt(model, path.slice(0, depth + 1)), eol);
  }

  // A one-line `{}` or `[]` document can be rewritten whole; a block document never is.
  const root = doc.contents;
  if (isCollection(root) && root.flow && root.range && isDict(model)) {
    const fresh = new Document(model).toString(YAML_OUT).replace(/\n$/, "").split("\n").join(eol);
    yield splice(text, root.range[0], root.range[1], fresh);
  }
}

function tryParse(text: string): Parsed | null {
  try {
    return parseSource(text);
  } catch {
    return null;
  }
}

/**
 * Applies `ops` in order to YAML source and returns the new source. Only the
 * entries the operations name are touched. Throws `YamlPatchError` if the
 * source isn't valid YAML or an operation can't be applied safely.
 *
 * `eol` is used for inserted lines when the source has no line break to copy.
 */
export function patchYaml(
  source: string | null,
  ops: readonly YamlOp[],
  options: { eol?: Eol } = {},
): string {
  let current = parseSource(source ?? "");
  const eol = detectEol(current.text) ?? options.eol ?? "\n";

  for (const op of ops) {
    const answers = expected(current.model, op);
    if (answers === null) continue;
    let next: Parsed | null = null;
    for (const candidate of candidates(current, op, answers[0], eol)) {
      if (candidate === null) continue;
      const parsed = tryParse(candidate);
      if (parsed && answers.some((answer) => same(parsed.model, answer))) {
        next = parsed;
        break;
      }
    }
    if (!next) {
      throw new YamlPatchError(`Can't change ${describe(op.path)} without rewriting other parts of the file`);
    }
    current = next;
  }
  return current.text;
}

/** Parses YAML for reading. Throws `YamlPatchError` on anything `patchYaml` would refuse. */
export function readYaml(source: string | null): unknown {
  const doc = parseDocument(source ?? "");
  if (doc.errors.length > 0) throw invalid(doc.errors[0]);
  try {
    return doc.toJS();
  } catch (e) {
    throw invalid(e);
  }
}
