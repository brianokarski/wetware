import { describe, expect, it } from "vitest";
import { patchYaml, YamlPatchError, type YamlOp } from "../src/data/yamlPatch";

const set = (path: (string | number)[], value: unknown, extra: object = {}): YamlOp =>
  ({ op: "set", path, value, ...extra });
const del = (path: (string | number)[]): YamlOp => ({ op: "delete", path });

describe("changing a scalar", () => {
  it("replaces only the value's own text", () => {
    expect(patchYaml("a: 1\nmood: 1\nz: 3\n", [set(["mood"], 4)])).toBe("a: 1\nmood: 4\nz: 3\n");
  });

  it("keeps a comment on the same line, and the spacing before it", () => {
    expect(patchYaml("mood: 1   # how it went\n", [set(["mood"], 4)])).toBe("mood: 4   # how it went\n");
  });

  it("keeps the spacing after the colon and trailing spaces", () => {
    expect(patchYaml("mood:    1   \n", [set(["mood"], 4)])).toBe("mood:    4   \n");
  });

  it("replaces quoted values, quoting the new one only if it needs it", () => {
    expect(patchYaml('name: "Oakland: east" # home\n', [set(["name"], "Berkeley")])).toBe("name: Berkeley # home\n");
    expect(patchYaml("name: Oakland # home\n", [set(["name"], "a: b")])).toBe('name: "a: b" # home\n');
    expect(patchYaml("name: Oakland\n", [set(["name"], "")])).toBe('name: ""\n');
    expect(patchYaml("name: Oakland\n", [set(["name"], "true")])).toBe('name: "true"\n');
  });

  it("fills in a key that has no value", () => {
    expect(patchYaml("climb:\nrun: true\n", [set(["climb"], true)])).toBe("climb: true\nrun: true\n");
    expect(patchYaml("climb:   # tbd\n", [set(["climb"], null)])).toBe("climb:   # tbd\n");
    expect(patchYaml("climb:   # tbd\n", [set(["climb"], false)])).toBe("climb: false   # tbd\n");
  });

  it("writes null, booleans, decimals and negative numbers", () => {
    const src = "a: 1\nb: 1\nc: 1\nd: 1\n";
    expect(patchYaml(src, [set(["a"], null), set(["b"], false), set(["c"], 171.2), set(["d"], -3)]))
      .toBe("a: null\nb: false\nc: 171.2\nd: -3\n");
  });

  it("leaves the text alone when the value is already what was asked for", () => {
    expect(patchYaml("hex: 0x1F\nexp: 1e3\nf: 1.50\n", [set(["hex"], 31), set(["exp"], 1000), set(["f"], 1.5)]))
      .toBe("hex: 0x1F\nexp: 1e3\nf: 1.50\n");
  });

  it("keeps an anchor that other entries refer to", () => {
    expect(patchYaml("base: &b 1\nother: *b\n", [set(["other"], 2)])).toBe("base: &b 1\nother: 2\n");
  });

  it("re-serialises just that entry when the old or new value isn't a one-line scalar", () => {
    const src = "before: 1 # keep\nnote: |\n  line1\n  line2\nafter: 0x1F # keep\n";
    expect(patchYaml(src, [set(["note"], "short")])).toBe("before: 1 # keep\nnote: short\nafter: 0x1F # keep\n");
    expect(patchYaml("before: 1 # keep\nnote: x\nafter: 0x1F\n", [set(["note"], "a\nb")]))
      .toBe("before: 1 # keep\nnote: |-\n  a\n  b\nafter: 0x1F\n");
    expect(patchYaml("before: 1 # keep\ntags: [a]\nafter: 0x1F\n", [set(["tags"], ["a", "b"])]))
      .toBe("before: 1 # keep\ntags: [a, b]\nafter: 0x1F\n");
    expect(patchYaml("before: 1 # keep\ntagged: !!str 5\nafter: 0x1F\n", [set(["tagged"], 4)]))
      .toBe("before: 1 # keep\ntagged: 4\nafter: 0x1F\n");
  });
});

describe("adding a key", () => {
  it("inserts one line at the end and touches nothing else", () => {
    expect(patchYaml("a: 1 # c\n\nb: 0x1F   \n", [set(["mood"], 4)])).toBe("a: 1 # c\n\nb: 0x1F   \nmood: 4\n");
  });

  it("goes before the first of the named siblings that exists", () => {
    const src = "date: 2026-11-17\n_sources:\n  run: intervals\n_synced_at: x\n";
    expect(patchYaml(src, [set(["mood"], 4, { before: ["_sources", "_synced_at"] })]))
      .toBe("date: 2026-11-17\nmood: 4\n_sources:\n  run: intervals\n_synced_at: x\n");
    expect(patchYaml("date: 2026-11-17\n_synced_at: x\n", [set(["mood"], 4, { before: ["_sources", "_synced_at"] })]))
      .toBe("date: 2026-11-17\nmood: 4\n_synced_at: x\n");
    expect(patchYaml("_sources:\n  run: x\n", [set(["mood"], 4, { before: ["_sources"] })]))
      .toBe("mood: 4\n_sources:\n  run: x\n");
  });

  it("can go first, after any leading comment", () => {
    expect(patchYaml("# mine\nmood: 1\n", [set(["date"], "2026-11-17", { first: true })]))
      .toBe("# mine\ndate: 2026-11-17\nmood: 1\n");
  });

  it("goes before trailing comments and blank lines, leaving them as they were", () => {
    expect(patchYaml("a: 1\n\n# the end\n", [set(["b"], 2)])).toBe("a: 1\nb: 2\n\n# the end\n");
  });

  it("works on an empty document, one with only comments, and one with no final line break", () => {
    expect(patchYaml("", [set(["a"], 1)])).toBe("a: 1\n");
    expect(patchYaml(null, [set(["a"], 1)])).toBe("a: 1\n");
    expect(patchYaml("# only a comment\n", [set(["a"], 1)])).toBe("# only a comment\na: 1\n");
    expect(patchYaml("---\n", [set(["a"], 1)])).toBe("---\na: 1\n");
    expect(patchYaml("a: 1", [set(["b"], 2)])).toBe("a: 1\nb: 2");
  });

  it("quotes keys that need it, and writes maps and lists as blocks", () => {
    expect(patchYaml("a: 1\n", [set(["x: y"], 2)])).toBe('a: 1\n"x: y": 2\n');
    expect(patchYaml("a: 1\n", [set(["rule"], { types: ["Run"], min: 0 })]))
      .toBe("a: 1\nrule:\n  types:\n    - Run\n  min: 0\n");
  });
});

describe("removing a key", () => {
  it("removes its line only", () => {
    expect(patchYaml("a: 1\n# about b\nb: 2 # gone\n\nc: 0x1F\n", [del(["b"])])).toBe("a: 1\n# about b\n\nc: 0x1F\n");
  });

  it("removes every line of a multi-line value", () => {
    expect(patchYaml("a: 1\nnote: |\n  l1\n  l2\nmap:\n  x: 1\n  y: 2\nc: 3\n", [del(["note"]), del(["map"])]))
      .toBe("a: 1\nc: 3\n");
  });

  it("keeps comments that follow a nested map, even when its last key has no value", () => {
    expect(patchYaml("a: 1\nmap:\n  x: 1\n  y:\n# the end\n", [del(["map"])])).toBe("a: 1\n# the end\n");
    expect(patchYaml("map:\n  x: 1\n  y:\n# the end\n", [set(["map", "z"], 2)])).toBe("map:\n  x: 1\n  y:\n  z: 2\n# the end\n");
    expect(patchYaml("map:\n  x: 1\n  y:\n# the end\n", [set(["b"], 2)])).toBe("map:\n  x: 1\n  y:\nb: 2\n# the end\n");
  });

  it("does nothing when the key isn't there", () => {
    const src = "a: 1 # c\n";
    expect(patchYaml(src, [del(["b"]), del(["a", "x"]), del(["b", "c"])])).toBe(src);
  });

  it("leaves an emptied map as a bare key", () => {
    expect(patchYaml("_sources:\n  run: x\nz: 1\n", [del(["_sources", "run"])])).toBe("_sources:\nz: 1\n");
  });

  it("refuses rather than leave an alias pointing nowhere", () => {
    expect(() => patchYaml("base: &b 1\nother: *b\n", [del(["base"])])).toThrow(YamlPatchError);
  });
});

describe("nested paths", () => {
  const settings = "# mine\nlocation:\n  name: Oakland # home\n  latitude: 37.8\n  extra: keep\nunits:\n  weight: lb\n";

  it("changes a value inside a map", () => {
    expect(patchYaml(settings, [set(["location", "name"], "Berkeley")])).toBe(settings.replace("Oakland", "Berkeley"));
    expect(patchYaml(settings, [set(["location", "latitude"], 37.87)])).toBe(settings.replace("37.8", "37.87"));
  });

  it("adds a key inside a map at that map's indentation", () => {
    expect(patchYaml(settings, [set(["location", "longitude"], -122.27)]))
      .toBe(settings.replace("  extra: keep\n", "  extra: keep\n  longitude: -122.27\n"));
  });

  it("removes a key inside a map", () => {
    expect(patchYaml(settings, [del(["location", "extra"])])).toBe(settings.replace("  extra: keep\n", ""));
  });

  it("creates the maps a path needs", () => {
    expect(patchYaml("a: 1\n", [set(["location", "name"], "Oakland")])).toBe("a: 1\nlocation:\n  name: Oakland\n");
    expect(patchYaml("a: 1\n_synced_at: x\n", [set(["_sources", "run"], "intervals", { before: ["_synced_at"] })]))
      .toBe("a: 1\n_sources:\n  run: intervals\n_synced_at: x\n");
  });

  const habits = "# my comment\nhabits:\n  - id: mp\n    source: morning_pages\n    goal: 750 # words\n  - id: run\n";

  it("changes, adds and removes inside a list item", () => {
    expect(patchYaml(habits, [set(["habits", 0, "goal"], 500)])).toBe(habits.replace("750", "500"));
    expect(patchYaml(habits, [set(["habits", 1, "archived"], true)])).toBe(habits + "    archived: true\n");
    expect(patchYaml(habits, [set(["habits", 0, "name"], "Pages")]))
      .toBe(habits.replace("goal: 750 # words\n", "goal: 750 # words\n    name: Pages\n"));
    expect(patchYaml(habits, [del(["habits", 0, "source"])])).toBe(habits.replace("    source: morning_pages\n", ""));
  });

  it("works when the list isn't indented under its key", () => {
    const flush = "habits:\n- id: mp\n  goal: 750 # words\n- id: run\n";
    expect(patchYaml(flush, [set(["habits", 0, "goal"], 500)])).toBe(flush.replace("750", "500"));
    expect(patchYaml(flush, [set(["habits", 0, "name"], "Pages")]))
      .toBe(flush.replace("goal: 750 # words\n", "goal: 750 # words\n  name: Pages\n"));
    expect(patchYaml(flush, [{ op: "append", path: ["habits"], value: { id: "lift" } }])).toBe(flush + "- id: lift\n");
  });

  it("removing a list item's first key moves the next key up to the dash", () => {
    expect(patchYaml(habits, [del(["habits", 0, "id"])]))
      .toBe("# my comment\nhabits:\n  - source: morning_pages\n    goal: 750 # words\n  - id: run\n");
    // Review S-1, second input.
    expect(patchYaml("habits:\n  - old: x\n    id: run # keep\n    goal: 0x10\n  - id: walk # keep\n", [del(["habits", 0, "old"])]))
      .toBe("habits:\n  - id: run # keep\n    goal: 0x10\n  - id: walk # keep\n");
  });

  it("leaves the dash on its own line when nothing can move up to it", () => {
    expect(patchYaml("habits:\n  - old: x\n    # about id\n    id: run # keep\n", [del(["habits", 0, "old"])]))
      .toBe("habits:\n  -\n    # about id\n    id: run # keep\n");
    expect(patchYaml("habits:\n  - id: a # one\n  - id: b\n", [del(["habits", 0, "id"])])).toBe("habits:\n  -\n  - id: b\n");
  });

  it("refuses a list index that doesn't exist", () => {
    expect(() => patchYaml(habits, [set(["habits", 5, "goal"], 1)])).toThrow(YamlPatchError);
  });
});

describe("lists", () => {
  const src = "habits:\n  - id: a # first\n    goal: 0x1F\n  # between\n  - id: b\nafter: 1\n";

  it("appends an item as new lines, at the list's indentation", () => {
    expect(patchYaml(src, [{ op: "append", path: ["habits"], value: { id: "c", name: "See" } }]))
      .toBe(src.replace("  - id: b\n", "  - id: b\n  - id: c\n    name: See\n"));
  });

  it("removes an item's lines only", () => {
    expect(patchYaml(src, [del(["habits", 0])])).toBe("habits:\n  # between\n  - id: b\nafter: 1\n");
    expect(patchYaml(src, [del(["habits", 1])])).toBe("habits:\n  - id: a # first\n    goal: 0x1F\n  # between\nafter: 1\n");
  });

  it("creates the list when it's missing, empty or written as []", () => {
    expect(patchYaml("a: 1\n", [{ op: "append", path: ["habits"], value: { id: "c" } }])).toBe("a: 1\nhabits:\n  - id: c\n");
    expect(patchYaml("habits:\na: 1 # c\n", [{ op: "append", path: ["habits"], value: { id: "c" } }]))
      .toBe("habits:\n  - id: c\na: 1 # c\n");
  });

  it("turns an empty [] into a block list when the first item is added (review N-2)", () => {
    expect(patchYaml("habits: []\na: 1 # c\n", [{ op: "append", path: ["habits"], value: "x" }]))
      .toBe("habits:\n  - x\na: 1 # c\n");
    expect(patchYaml("habits: [] # none yet\n", [
      { op: "append", path: ["habits"], value: { id: "run", name: "Run" } },
      { op: "append", path: ["habits"], value: { id: "walk" } },
    ])).toBe("habits: # none yet\n  - id: run\n    name: Run\n  - id: walk\n");
    expect(patchYaml("m: {}\nz: 1\n", [set(["m", "a"], 1)])).toBe("m:\n  a: 1\nz: 1\n");
  });

  it("adds to a [..] list between its brackets", () => {
    expect(patchYaml("tags: [travel, 0x1F] # trip\nz: 1\n", [{ op: "append", path: ["tags"], value: "sick, tired" }]))
      .toBe('tags: [travel, 0x1F, "sick, tired"] # trip\nz: 1\n');
    expect(patchYaml("tags: [travel, 0x1F, sick] # trip\n", [del(["tags", 0])])).toBe("tags: [0x1F, sick] # trip\n");
    expect(patchYaml("tags: [travel, 0x1F, sick] # trip\n", [del(["tags", 2])])).toBe("tags: [travel, 0x1F] # trip\n");
    expect(patchYaml("tags: [travel] # trip\n", [del(["tags", 0])])).toBe("tags: [] # trip\n");
    expect(patchYaml("tags: [travel, 0x1F] # trip\n", [set(["tags", 0], "a: b")])).toBe('tags: ["a: b", 0x1F] # trip\n');
  });

  it("refuses to append to something that isn't a list", () => {
    expect(() => patchYaml("habits: 3\n", [{ op: "append", path: ["habits"], value: 1 }])).toThrow(YamlPatchError);
  });
});

describe("writing a new list or map in flow style", () => {
  it("writes a new key's value between brackets when asked", () => {
    expect(patchYaml("a: 1\n_sources:\n  a: x\n", [set(["tags"], ["travel"], { flow: true, before: ["_sources"] })]))
      .toBe("a: 1\ntags: [travel]\n_sources:\n  a: x\n");
    expect(patchYaml("a: 1\n", [set(["m"], { x: 1, y: [1, 2] }, { flow: true })])).toBe("a: 1\nm: {x: 1, y: [1, 2]}\n");
    expect(patchYaml("", [{ op: "append", path: ["tags"], value: "travel", flow: true }])).toBe("tags: [travel]\n");
  });

  it("replaces an empty or plain value the same way", () => {
    expect(patchYaml("tags: # why\nz: 1\n", [set(["tags"], ["travel"], { flow: true })])).toBe("tags: [travel] # why\nz: 1\n");
    expect(patchYaml("tags: sick # why\n", [set(["tags"], ["sick", "travel"], { flow: true })])).toBe("tags: [sick, travel] # why\n");
    expect(patchYaml("tags:\nz: 1\n", [{ op: "append", path: ["tags"], value: "travel", flow: true }])).toBe("tags: [travel]\nz: 1\n");
  });

  it("puts a list it has to create before the named siblings", () => {
    expect(patchYaml("a: 1\n_sources:\n  a: x\n", [{ op: "append", path: ["tags"], value: "travel", before: ["_sources"] }]))
      .toBe("a: 1\ntags:\n  - travel\n_sources:\n  a: x\n");
  });
});

describe("line endings", () => {
  it("uses CRLF for inserted lines in a CRLF file", () => {
    const src = "date: 2026-11-17\r\n# c\r\nmood: 2\r\n";
    expect(patchYaml(src, [set(["mood"], 4), set(["lift"], true)])).toBe("date: 2026-11-17\r\n# c\r\nmood: 4\r\nlift: true\r\n");
    expect(patchYaml(src, [set(["_sources", "mood"], "manual")]))
      .toBe(src + "_sources:\r\n  mood: manual\r\n");
    expect(patchYaml(src, [del(["mood"])])).toBe("date: 2026-11-17\r\n# c\r\n");
  });

  it("uses the given line ending when the source has none to copy", () => {
    expect(patchYaml("", [set(["a"], { b: 1 })], { eol: "\r\n" })).toBe("a:\r\n  b: 1\r\n");
    expect(patchYaml("a: 1", [set(["b"], 2)], { eol: "\r\n" })).toBe("a: 1\r\nb: 2");
  });
});

describe("review S-1: an edit never re-renders the entries beside it", () => {
  it("refuses to change a value whose anchor another entry uses", () => {
    const src = '# my habits\nhabits:\n  - id: run # first\n    color: &green "#3A7D44"\n    goal: 0x10\n\n  # walking\n  - id: walk\n    color: *green # same\n    order: 1.50\n';
    expect(() => patchYaml(src, [set(["habits", 0, "color"], "#000000")])).toThrow(YamlPatchError);
    // The entry that only refers to the anchor can be changed; so can everything else.
    expect(patchYaml(src, [set(["habits", 1, "color"], "#000000"), set(["habits", 0, "goal"], 20)]))
      .toBe(src.replace("*green", '"#000000"').replace("0x10", "20"));
  });

  it("edits a flow-style list item between its braces", () => {
    const src = "habits:\n  - {id: a, name: A, goal: 0x10} # keep\n  - {id: b} # b\n";
    expect(patchYaml(src, [set(["habits", 0, "name"], "Aye")])).toBe(src.replace("name: A", "name: Aye"));
    expect(patchYaml(src, [set(["habits", 0, "archived"], true)])).toBe(src.replace("0x10}", "0x10, archived: true}"));
    expect(patchYaml(src, [del(["habits", 0, "name"])])).toBe(src.replace("name: A, ", ""));
    expect(patchYaml(src, [set(["habits", 1, "name"], "Bee, or B")])).toBe(src.replace("{id: b}", '{id: b, name: "Bee, or B"}'));
  });

  it("edits a document that is one flow map between its braces", () => {
    const src = "{mood: 3, weight_lb: 171.20, hex: 0x1F}\n";
    expect(patchYaml(src, [set(["run"], true)])).toBe("{mood: 3, weight_lb: 171.20, hex: 0x1F, run: true}\n");
    expect(patchYaml(src, [set(["mood"], 4)])).toBe("{mood: 4, weight_lb: 171.20, hex: 0x1F}\n");
    expect(patchYaml(src, [set(["date"], "2026-11-17", { first: true })]))
      .toBe("{date: 2026-11-17, mood: 3, weight_lb: 171.20, hex: 0x1F}\n");
    expect(patchYaml(src, [set(["run"], true, { before: ["hex"] })])).toBe("{mood: 3, weight_lb: 171.20, run: true, hex: 0x1F}\n");
    expect(patchYaml(src, [del(["weight_lb"])])).toBe("{mood: 3, hex: 0x1F}\n");
    expect(patchYaml(src, [del(["hex"])])).toBe("{mood: 3, weight_lb: 171.20}\n");
  });

  it("never writes a block map or list out again to change one of its entries", () => {
    // A block list where a map is needed: replacing it would discard what the user wrote.
    expect(() => patchYaml("a: 0x1F\n_sources:\n  - x # c\n", [set(["_sources", "mood"], "manual")])).toThrow(YamlPatchError);
    // A multi-line value that would swallow the comment under it.
    expect(() => patchYaml("m:\n  a: 1\n    # deeper\n  b: 0x1F\n", [set(["m", "a"], "two\nlines")])).toThrow(YamlPatchError);
  });
});

describe("review N-1: a comment beside a list or map value stays", () => {
  it("when the whole value is replaced", () => {
    expect(patchYaml("tags: [travel] # trip\nz: 1\n", [set(["tags"], ["travel", "sick"])])).toBe("tags: [travel, sick] # trip\nz: 1\n");
    expect(patchYaml("tags: [travel] # trip\n", [set(["tags"], [])])).toBe("tags: [] # trip\n");
    expect(patchYaml("a: 1 # c\nb: 1\n", [set(["a"], { x: 1 })])).toBe("a: # c\n  x: 1\nb: 1\n");
    expect(patchYaml("note: short # c\n", [set(["note"], "two\nlines")])).toBe("note: |- # c\n  two\n  lines\n");
    expect(patchYaml("_sources:   # where from\nz: 1\n", [set(["_sources", "mood"], "manual")]))
      .toBe("_sources:   # where from\n  mood: manual\nz: 1\n");
  });

  it("when a value inside it changes", () => {
    const src = "units: {weight: lb, temperature: F} # u\n";
    expect(patchYaml(src, [set(["units", "weight"], "kg")])).toBe(src.replace("lb", "kg"));
    expect(patchYaml(src, [set(["units", "sleep"], "h")])).toBe("units: {weight: lb, temperature: F, sleep: h} # u\n");
  });
});

describe("entries that can't be edited in place", () => {
  it("replaces an empty or plain-text value with a map, and nothing else", () => {
    expect(patchYaml("a: 0x1F # c\n_sources:\nz: 1 # c\n", [set(["_sources", "mood"], "manual")]))
      .toBe("a: 0x1F # c\n_sources:\n  mood: manual\nz: 1 # c\n");
    expect(patchYaml("a: 0x1F # c\n_sources: oops\nz: 1 # c\n", [set(["_sources", "mood"], "manual")]))
      .toBe("a: 0x1F # c\n_sources:\n  mood: manual\nz: 1 # c\n");
  });

  it("rewrites a flow map on its own line, keeping it a flow map", () => {
    const src = "a: 0x1F # c\n_sources: {run: intervals}\nz: 1 # c\n";
    expect(patchYaml(src, [set(["_sources", "mood"], "manual")]))
      .toBe("a: 0x1F # c\n_sources: {run: intervals, mood: manual}\nz: 1 # c\n");
    expect(patchYaml(src, [del(["_sources", "run"])])).toBe("a: 0x1F # c\n_sources: {}\nz: 1 # c\n");
    expect(patchYaml(src, [set(["_sources", "run"], "manual")]))
      .toBe("a: 0x1F # c\n_sources: {run: manual}\nz: 1 # c\n");
    expect(patchYaml(src, [set(["_sources", "run"], 5)])).toBe("a: 0x1F # c\n_sources: {run: 5}\nz: 1 # c\n");
  });

  it("rewrites a document that is an empty flow map", () => {
    expect(patchYaml("{}\n", [set(["a"], 1)])).toBe("a: 1\n");
    expect(patchYaml("{} # nothing yet\n", [set(["a", "b"], 1)])).toBe("a:\n  b: 1 # nothing yet\n");
  });

  it("writes a flow entry out again, in flow style, only when it can't be edited between its brackets", () => {
    // A comment between the braces doesn't stop the in-place edit.
    expect(patchYaml("a: 0x1F # keep\nm: {x: 1, # first\n  y: 0x10}\nz: 1\n", [del(["m", "x"])]))
      .toBe("a: 0x1F # keep\nm: {y: 0x10}\nz: 1\n");
    // A list where a map is needed, inside braces: only that value is swapped.
    expect(patchYaml("a: 0x1F # keep\nm: {x: 0x10, y: [1, 2]} # m\nz: 1\n", [set(["m", "y", "k"], 1)]))
      .toBe("a: 0x1F # keep\nm: {x: 0x10, y: {k: 1}} # m\nz: 1\n");
    expect(patchYaml("m: {x: 0x10, y: [1, 2]} # m\n", [set(["m", "x"], ["a", "two\nlines"])]))
      .toBe('m: {x: [a, "two\\nlines"], y: [1, 2]} # m\n');
    // A tag pins the old value's type, so swapping its text can't work: the one entry
    // holding the braces is written out again, and its other values are re-rendered.
    expect(patchYaml("a: 0x1F # keep\nm: {x: 0x10, y: !!str 5} # m\nz: 1\n", [set(["m", "y"], 4)]))
      .toBe("a: 0x1F # keep\nm: {x: 16, y: 4} # m\nz: 1\n");
  });
});

describe("numbers the user wrote", () => {
  const src = "big: 12345678901234567890\nhex: 0x1F\noct: 0o17\nexp: 1e3\nf: 1.50\nmood: 1\n";

  it("are never re-rendered by a patch to another key", () => {
    expect(patchYaml(src, [set(["mood"], 4), set(["lift"], true), del(["oct"])]))
      .toBe("big: 12345678901234567890\nhex: 0x1F\nexp: 1e3\nf: 1.50\nmood: 4\nlift: true\n");
  });

  it("keep their precision even inside an entry that has to be re-serialised", () => {
    expect(patchYaml("m: {big: 12345678901234567890}\n", [set(["m", "x"], 1)]))
      .toBe("m: {big: 12345678901234567890, x: 1}\n");
  });

  it("can be patched to a large integer exactly", () => {
    expect(patchYaml("n: 1\n", [set(["n"], 12345678901234567890n)])).toBe("n: 12345678901234567890\n");
  });
});

describe("awkward keys", () => {
  it("treats __proto__ and other Object.prototype names as ordinary keys", () => {
    expect(patchYaml("a: 1\n", [set(["__proto__"], 1), set(["constructor", "x"], 1)]))
      .toBe("a: 1\n__proto__: 1\nconstructor:\n  x: 1\n");
    expect(patchYaml("__proto__: 1\nhasOwnProperty: 2\ntoString: 3\n", [set(["__proto__"], 3), del(["hasOwnProperty"])]))
      .toBe("__proto__: 3\ntoString: 3\n");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("finds numeric and quoted keys", () => {
    expect(patchYaml("1: a\n'odd key': 1 # c\n", [set(["1"], "z"), set(["odd key"], 2)])).toBe("1: z\n'odd key': 2 # c\n");
  });

  it("handles explicit and anchored keys", () => {
    expect(patchYaml("? complex\n: v\n&x k: 1\nb: 1\n", [set(["complex"], 2), del(["k"]), set(["c"], 3)]))
      .toBe("? complex\n: 2\nb: 1\nc: 3\n");
  });
});

describe("refusing to guess", () => {
  it("throws on invalid YAML, with the line", () => {
    expect(() => patchYaml("a: [unclosed\n", [set(["b"], 1)])).toThrow(YamlPatchError);
    expect(() => patchYaml("a: 1\na: 2\n", [set(["b"], 1)])).toThrow(/Map keys must be unique/);
    try {
      patchYaml("ok: 1\na: 1\na: 2\n", []);
      expect.unreachable();
    } catch (e) {
      expect((e as YamlPatchError).line).toBe(3);
      expect((e as YamlPatchError).message).toBe("Invalid YAML: Map keys must be unique");
    }
  });

  it("throws when the document isn't a map", () => {
    expect(() => patchYaml("- a\n- b\n", [set(["x"], 1)])).toThrow(/top level/);
    expect(() => patchYaml("just text\n", [set(["x"], 1)])).toThrow(/top level/);
  });

  it("throws on values that aren't plain data", () => {
    expect(() => patchYaml("a: 1\n", [set(["a"], new Date(0))])).toThrow(YamlPatchError);
  });

  it("returns the source untouched when there is nothing to do", () => {
    const src = "a:   1 # c\r\n\r\n";
    expect(patchYaml(src, [])).toBe(src);
  });
});
