/**
 * Morning pages text lives in `pages/` and nowhere else (SPEC §2, principle 4;
 * hard rule 4). This is the structural half of that rule: it reads the
 * source, and fails if anything but the writing room could get at the text,
 * or if there is somewhere in the app for text to leak to.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as data from "../src/data";
import * as pages from "../src/data/pages";

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const files = (dir: string, pattern: RegExp) =>
  (readdirSync(new URL(dir, ROOT), { recursive: true }) as string[])
    .map((name) => `${dir}/${name.split("\\").join("/")}`)
    .filter((path) => pattern.test(path))
    .sort();

const SOURCE = files("src", /\.(ts|tsx)$/);
/** The one module that reads and writes the text, and the one screen that shows it. */
const MODULE = "src/data/pages.ts";
const ROOM = "src/screens/MorningPages.tsx";

/** The files, other than `allowed`, whose text matches. */
const matching = (pattern: RegExp, allowed: string[] = []) => SOURCE.filter((path) => !allowed.includes(path) && pattern.test(read(path)));

/**
 * Everything the pages module exports, by name. A new export does not get
 * past this list without being put on it, and what is put on it is read.
 * Two are for the room alone: the function that hands over the text, and
 * the one that says where the text is kept.
 */
const ROOM_ONLY = ["pagesPath", "readPages"];
const FRONT_DOOR = [
  "PAGES_SOURCE", "PagesChangedError", "PagesCountError", "WORDS_PER_PAGE", "countWords", "currentPage", "goalPages", "pageLine",
  "pageStarts", "pagesCountPatch", "pagesHabit", "pagesNoticeKey", "pagesWords", "roomCountPatch", "roomKeepsCount", "savePages",
  "takeRoomCount", "wordLine",
];

/** A file's text with the one place the word is a label, and not a folder, taken out: "Pages" in the navigation. */
const withoutNavLabel = (path: string) => (path === "src/App.tsx" ? read(path).replace('{ id: "room", label: "Pages" }', "") : read(path));

describe("morning pages text can only be read by the writing room", () => {
  it("has the two files this test is about", () => {
    expect(SOURCE).toContain(MODULE);
    expect(SOURCE).toContain(ROOM);
    expect(SOURCE.length).toBeGreaterThan(20);
  });

  it("the pages module exports exactly what is on the list", () => {
    expect(Object.keys(pages).sort()).toEqual([...FRONT_DOOR, ...ROOM_ONLY].sort());
  });

  it("the data layer's front door passes on that list less the two that are the room's, and nothing else from the module", () => {
    const index = read("src/data/index.ts");
    // Named exports only: `export *` would hand out whatever the module gains later.
    expect(index).not.toMatch(/export\s*\*\s*from\s*["']\.\/pages["']/);
    const blocks = [...index.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']\.\/pages["']/g)];
    expect(blocks.length).toBe(1);
    const names = blocks[0][1].split(",").map((name) => name.trim()).filter((name) => name !== "");
    // Types say nothing at run time. Nothing is renamed on the way through.
    const values = names.filter((name) => !name.startsWith("type "));
    for (const name of names) expect(name).toMatch(/^(type )?\w+$/);
    expect(values.sort()).toEqual([...FRONT_DOOR].sort());
    // And what the front door really hands out agrees with what its source says.
    for (const name of ROOM_ONLY) expect(Object.keys(data)).not.toContain(name);
    for (const name of FRONT_DOOR) expect((data as Record<string, unknown>)[name]).toBe((pages as Record<string, unknown>)[name]);
    // Nothing else in the data layer hands them out under another name.
    const reexported = Object.entries(data).filter(([, value]) => ROOM_ONLY.some((name) => value === (pages as Record<string, unknown>)[name]));
    expect(reexported).toEqual([]);
  });

  it("the two that are the room's are named in the pages module and the room, and nowhere else", () => {
    expect(matching(/\breadPages\b/)).toEqual([MODULE, ROOM]);
    expect(matching(/\bpagesPath\b/)).toEqual([MODULE, ROOM]);
  });

  it("only the room reaches past the front door into the pages module", () => {
    // `data/index.ts` re-exports from "./pages"; the room imports "../data/pages". Nobody else names the module,
    // by `import ... from`, by `import(...)` or by `require(...)`.
    expect(matching(/(from|import|require)\s*\(?\s*["'`][^"'`]*\/pages(\.ts)?["'`]/)).toEqual(["src/data/index.ts", ROOM]);
    expect(read(ROOM)).toMatch(/import \{ pagesPath, readPages \} from "\.\.\/data\/pages";/);
  });

  it("nothing else names the pages folder, in any case, so nothing else can read a file in it", () => {
    // The folder's name as a path or a path's first part: "pages", 'Pages', `PAGES/…`, "pages/…". The file
    // system does not tell `Pages/` from `pages/`, so neither does this.
    const named = SOURCE.filter((path) => /["'`]pages["'`/]/i.test(withoutNavLabel(path)));
    expect(named).toEqual([MODULE]);
    // The module keeps the folder's name to itself.
    expect(read(MODULE)).toMatch(/^const PAGES_DIR = "pages";$/m);
    expect(read(MODULE)).not.toMatch(/export const PAGES_DIR/);
  });

  it("no screen reads a file for itself: files are read in the data layer, by the modules that own them", () => {
    const readers = matching(/\bfs\s*\??\.\s*read\s*\(|\.read\s*\(\s*[`"']/);
    // The memory folder used in tests has a `read` of its own; the rest each read their own file.
    expect(readers).toEqual(["src/data/dayFile.ts", "src/data/habits.ts", MODULE, "src/data/settings.ts"]);
    // The shell's read is called in one place, where the folder's `DataFs` is made.
    expect(matching(/data_read/)).toEqual(["src/platform/tauri.ts"]);
  });

  it("the pages module hands the text to no one but its caller", () => {
    const module = read(MODULE);
    // One function returns text. Everything else it exports returns counts, patches, paths or nothing.
    const returningText = [...module.matchAll(/export (?:async )?function (\w+)\([^)]*\): Promise<string>/g)].map((m) => m[1]);
    expect(returningText).toEqual(["readPages"]);
    // Every exported function says what it returns, so that the line above can be trusted.
    const exported = [...module.matchAll(/^export (?:async )?function (\w+)\(.*\)(: [^{]+)? \{$/gm)];
    expect(exported.length).toBeGreaterThan(10);
    for (const [, name, returns] of exported) expect(returns, name).toBeTruthy();
    // Its errors take a date, and build their message from the file's name.
    expect(module).toMatch(/class PagesChangedError extends Error \{\s*constructor\(date: string\)/);
    expect(module).toMatch(/class PagesCountError extends Error \{\s*constructor\(date: string, cause: unknown\)/);
    expect(module).not.toMatch(/console\./);
  });

  it("sync, which is the part of the app that talks to the network, knows nothing of pages", () => {
    const sync = SOURCE.filter((path) => path.startsWith("src/sync/") || path === "src/platform/useSync.ts");
    expect(sync.length).toBeGreaterThan(5);
    for (const path of sync) {
      expect(read(path), path).not.toMatch(/readPages|savePages|pagesPath|pagesWords|takeRoomCount|MorningPages|from\s*["'][^"']*pages["']/);
    }
  });
});

describe("there is nowhere in the app for text to leak to", () => {
  it("nothing is kept in the browser's storage", () => {
    expect(matching(/\b(localStorage|sessionStorage|indexedDB|caches)\b|document\.cookie/)).toEqual([]);
  });

  it("nothing is written to the console", () => {
    expect(matching(/\bconsole\s*\./)).toEqual([]);
  });

  it("the only network calls are the two the shell makes for sync", () => {
    expect(matching(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)).toEqual([]);
    // The webview talks to the shell through one file, and the room is not it.
    expect(matching(/@tauri-apps/)).toEqual(["src/platform/tauri.ts"]);
  });

  it("the shell's launch trace prints command names and nothing else", () => {
    const rust = files("src-tauri/src", /\.rs$/);
    expect(rust.length).toBeGreaterThan(3);
    const calls = rust.flatMap((path) => [...read(path).matchAll(/\btrace\(([^)]*)\)/g)].map((m) => m[1]));
    expect(calls.length).toBeGreaterThan(8);
    // Each call passes a string literal: its own name. The declaration takes `command: &str`.
    for (const argument of calls) expect(argument).toMatch(/^"[a-z_]+"$|^command: &str$/);
    // And nothing else in the shell prints.
    for (const path of rust) {
      const outside = read(path).split("#[cfg(test)]")[0];
      expect(outside.match(/\b(e?println|e?print|dbg)!/g) ?? [], path).toEqual(path.endsWith("lib.rs") ? ["eprintln!"] : []);
    }
  });
});
