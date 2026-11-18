/**
 * npm run shots: screenshots of the real UI, and the only end-to-end check.
 *
 * Starts Vite, opens dev/preview.html (the app over a mocked shell and an
 * in-memory data folder) in the installed Chrome, runs each scenario below,
 * and writes PNGs to .shots/. A scenario can click and type, and can read the
 * mock folder back to check what the app wrote. Exits non-zero if a scenario
 * throws or the page logs an error.
 *
 *   npm run shots                 every scenario
 *   npm run shots -- edit keys    only scenarios whose name contains a word given
 *   CHROME_PATH=/path/to/chrome   use a different Chrome
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = fileURLToPath(new URL("../.shots/", import.meta.url));
const WIDE = { width: 1280, height: 820 };
const SMALL = { width: 960, height: 600 };
const TODAY_FILE = "days/2026-11-17.md";

/** A file of the fixture data folder as it is on disk, before the app has touched its copy. */
const fixtureFile = (path) => readFile(new URL(`../test/fixtures/data-folder/${path}`, import.meta.url), "utf8");
/** What a sync at the pinned time (09:41 on 2026-11-17, in this machine's time zone) writes to `_synced_at`. */
const SYNCED_AT = (() => {
  const offset = -new Date(2026, 10, 17, 9, 41).getTimezoneOffset();
  const two = (n) => String(n).padStart(2, "0");
  return `2026-11-17T09:41:00${offset < 0 ? "-" : "+"}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`;
})();
const NOT_CONNECTED = "intervals.icu isn't connected, so runs and sleep don't fill in. Add an API key in Settings.";
const KEY_REJECTED = "intervals.icu did not accept the API key. Paste it again in Settings; it is under Developer Settings on intervals.icu.";

/** The frontmatter lines of a day file, for comparing what changed. */
const lines = (text) => text.split("\n");
/** Lines in `after` that aren't in `before`, and the other way round. */
function changed(before, after) {
  const [a, b] = [lines(before), lines(after)];
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}

/** The paths whose text differs between two readings of the folder (`t.folder()`), with those added and those gone. */
function folderDiff(before, after) {
  const [a, b] = [new Map(before), new Map(after)];
  return [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
}

/** `count` words of made-up prose, in sentences and paragraphs. Exactly `count`: nothing else in it is a word. */
function prose(count) {
  const sentence = "the kettle took its time this morning and so did I there is a kind of quiet in the flat before the street wakes".split(" ");
  const out = [];
  for (let i = 0; i < count; i++) {
    let word = sentence[i % sentence.length];
    if (i % 12 === 0) word = word[0].toUpperCase() + word.slice(1);
    if (i % 12 === 11 && i !== count - 1) word += ".";
    out.push(i > 0 && i % 84 === 0 ? `\n\n${word}` : i > 0 ? ` ${word}` : word);
  }
  return `${out.join("")}.`;
}

/** A PNG's pixels. Only what Chrome's screenshots use: 8 bits a channel, RGB or RGBA, not interlaced. */
function decodePng(png) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const chunks = [];
  for (let pos = 8; pos < png.length; ) {
    const length = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[body[9]];
      assert.ok(body[8] === 8 && channels && body[12] === 0, "a kind of PNG this script doesn't read");
    }
    if (type === "IDAT") chunks.push(body);
    pos += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const [a, b, c] = [Math.abs(up - upLeft), Math.abs(left - upLeft), Math.abs(left + up - 2 * upLeft)];
        predicted = a <= b && a <= c ? left : b <= c ? up : upLeft;
      }
      out[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predicted) & 255;
    }
  }
  return { width, height, at: (x, y) => out.subarray((y * width + x) * channels, (y * width + x) * channels + 3) };
}

const SCALE = 2; // device pixels per CSS pixel in the screenshots
/** How light a colour is, 0 (black) to 255 (white). */
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const INK = 60; // at most this light: drawn in ink
const PAPER = 250; // at least this light: nothing drawn
/** Between ink and paper: a gray mark, a faint rule, a wash. */
const isGray = (value) => value > 90 && value < 248;

/**
 * What is actually on screen, from a screenshot: `darkest` and `lightest`
 * give the darkest and lightest pixel within a device pixel of a point, in
 * CSS pixels, so a hairline is found even when it lands between two pixels.
 */
async function pixels(page) {
  const png = decodePng(await page.screenshot({ type: "png" }));
  const near = (x, y) => {
    const found = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.min(png.width - 1, Math.max(0, Math.round(x * SCALE) + dx));
        const py = Math.min(png.height - 1, Math.max(0, Math.round(y * SCALE) + dy));
        found.push(luma(png.at(px, py)));
      }
    }
    return found;
  };
  /** The darkest pixel anywhere in a box: whether anything at all is drawn there. */
  const darkestIn = (box) => {
    let found = 255;
    for (let y = Math.ceil(box.top * SCALE); y < Math.floor(box.bottom * SCALE); y++) {
      for (let x = Math.ceil(box.left * SCALE); x < Math.floor(box.right * SCALE); x++) {
        if (x >= 0 && y >= 0 && x < png.width && y < png.height) found = Math.min(found, luma(png.at(x, y)));
      }
    }
    return found;
  };
  return { darkest: (x, y) => Math.min(...near(x, y)), lightest: (x, y) => Math.max(...near(x, y)), darkestIn };
}

/** Sizes, positions and computed styles of everything in the grid, measured in the page. */
function measure(page) {
  return page.evaluate(() => {
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2 };
    };
    const table = document.querySelector(".grid");
    // What the stylesheet thinks a day column's width is, to compare with what it measures.
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;visibility:hidden;width:var(--grid-day)";
    table.querySelector("tbody tr").appendChild(probe);
    const assumedDay = probe.getBoundingClientRect().width;
    probe.remove();
    const cells = [...table.querySelectorAll("td.grid-cell")].map((td) => {
      const mark = td.querySelector(".mark");
      const style = mark && getComputedStyle(mark);
      return {
        habit: td.dataset.habit,
        day: Number(td.dataset.date.slice(8)),
        state: td.dataset.state,
        box: box(td),
        mark: mark && { box: box(mark), display: style.display, visibility: style.visibility, image: style.backgroundImage, color: style.backgroundColor },
        values: [...td.querySelectorAll("span")]
          .filter((span) => span.textContent && parseFloat(getComputedStyle(span).fontSize) > 0)
          .map((span) => ({ text: span.textContent, box: box(span), size: parseFloat(getComputedStyle(span).fontSize) })),
      };
    });
    const heads = [...table.querySelectorAll(".grid-day-button")].map((button) => {
      const style = getComputedStyle(button);
      const th = button.closest("th");
      return { day: Number(button.dataset.date.slice(8)), box: box(button), color: style.color, background: style.backgroundColor, today: "today" in th.dataset, future: "future" in th.dataset };
    });
    return {
      table: box(table),
      layout: getComputedStyle(table).tableLayout,
      habitColumn: box(table.querySelector("tbody th")),
      countColumn: box(table.querySelector("tbody td.grid-count")),
      rows: [...table.querySelectorAll("tbody tr")].map(box),
      assumedDay,
      cells,
      heads,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
}

/** Contrast ratio of a CSS rgb() colour against white, as WCAG defines it. */
function contrastOnWhite(color) {
  const channel = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = color.match(/[\d.]+/g).map(Number);
  return 1.05 / (0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b) + 0.05);
}

/**
 * Checks that the fixture month is drawn the way it should be: not that the
 * right attributes are set, but that the marks, rules, wash and columns are
 * where they belong and visible, from measured geometry and from the pixels
 * of a screenshot. Call it with nothing focused and the pointer off the grid.
 */
async function checkDrawing(t) {
  await t.page.mouse.move(2, 2);
  const m = await measure(t.page);
  const px = await pixels(t.page);
  const at = (habit, day) => m.cells.find((c) => c.habit === habit && c.day === day);
  const wide = m.viewport.width >= 1200;
  /** The box of the mark in a cell, which has to be there. */
  const markOf = (habit, day, what) => {
    assert.ok(at(habit, day).mark, `${habit} ${day}: ${what} is not there`);
    return at(habit, day).mark.box;
  };

  // ── Columns: measured, not taken from the stylesheet's arithmetic. ──
  assert.equal(m.layout, "fixed", "the table's columns are sized by their content");
  const firstRow = m.cells.filter((c) => c.habit === m.cells[0].habit);
  const widths = firstRow.map((c) => c.box.width);
  const dayWidth = widths[0];
  assert.ok(Math.max(...widths) - Math.min(...widths) < 0.6, `day columns differ in width: ${Math.min(...widths)} to ${Math.max(...widths)}`);
  assert.ok(dayWidth >= (wide ? 30 : 22), `day columns are ${dayWidth}px wide: too narrow to read`);
  assert.ok(Math.abs(m.assumedDay - dayWidth) < 1, `the stylesheet sizes values for ${m.assumedDay}px columns, but they are ${dayWidth}px`);
  assert.ok(m.habitColumn.width >= 120 && m.habitColumn.width <= m.table.width * 0.22, `habit column is ${m.habitColumn.width}px of ${m.table.width}px`);
  assert.ok(m.countColumn.width >= 40 && m.countColumn.width <= 80, `count column is ${m.countColumn.width}px`);
  assert.ok(Math.abs(m.habitColumn.width + dayWidth * firstRow.length + m.countColumn.width - m.table.width) < 2, "the columns don't add up to the table");
  assert.ok(m.table.right <= m.viewport.width + 0.5, "the table runs off the right edge");
  const heights = m.rows.map((r) => r.height);
  assert.ok(Math.max(...heights) - Math.min(...heights) < 0.6 && heights[0] >= 24, `rows are ${Math.min(...heights)} to ${Math.max(...heights)}px tall`);

  // ── Day headers sit over their columns. ──
  for (const head of m.heads) {
    const below = firstRow.find((c) => c.day === head.day);
    assert.ok(Math.abs(head.box.cx - below.box.cx) < 1, `day ${head.day}'s header is not over its column`);
    assert.ok(head.box.bottom <= below.box.top + 0.5, `day ${head.day}'s header overlaps the first row`);
  }

  // ── Every value is inside its own box, at a size that can be read. ──
  for (const cell of m.cells) {
    for (const value of cell.values) {
      const inside = value.box.left >= cell.box.left - 0.5 && value.box.right <= cell.box.right + 0.5 && value.box.top >= cell.box.top - 0.5 && value.box.bottom <= cell.box.bottom + 0.5;
      assert.ok(inside, `${cell.habit} ${cell.day}: "${value.text}" runs outside its box`);
      assert.ok(value.size >= 9, `${cell.habit} ${cell.day}: "${value.text}" is set at ${value.size}px`);
      assert.ok(px.darkestIn(value.box) < 120, `${cell.habit} ${cell.day}: "${value.text}" is not drawn`);
    }
  }

  // ── Every mark has a size, is inside its box, and is drawn. ──
  for (const cell of m.cells.filter((c) => c.mark)) {
    const { box, display, visibility } = cell.mark;
    const where = `${cell.habit} ${cell.day}`;
    assert.ok(display !== "none" && visibility === "visible", `${where}: its mark is hidden`);
    assert.ok(box.width >= 3 && box.height >= 1, `${where}: its mark is ${box.width} by ${box.height}px`);
    assert.ok(box.left >= cell.box.left && box.right <= cell.box.right && box.top >= cell.box.top && box.bottom <= cell.box.bottom, `${where}: its mark is outside its box`);
    assert.ok(px.darkestIn({ left: box.left - 0.5, right: box.right + 0.5, top: box.top - 0.5, bottom: box.bottom + 0.5 }) < 215, `${where}: nothing is drawn where its mark is`);
  }

  // Done, check habit: a ✕ in ink. Dark at the centre and along a diagonal, paper between the strokes.
  const cross = markOf("run", 1, "the ✕");
  assert.ok(cross.width >= 12 && Math.abs(cross.width - cross.height) < 1, `the ✕ is ${cross.width} by ${cross.height}px`);
  assert.ok(px.darkest(cross.cx, cross.cy) < INK, "the ✕ has no centre");
  assert.ok(px.darkest(cross.left + cross.width * 0.25, cross.top + cross.height * 0.25) < INK, "the ✕ has no stroke from the top left");
  assert.ok(px.darkest(cross.right - cross.width * 0.25, cross.top + cross.height * 0.25) < INK, "the ✕ has no stroke from the top right");
  assert.ok(px.lightest(cross.cx, cross.top + cross.height * 0.1) > PAPER, "the ✕ is a solid block");

  // No data: a short gray dash, with paper above and below it. Not empty, not ink.
  const dashCell = at("sleep", 5);
  assert.equal(dashCell.state, "no_data");
  const dash = markOf("sleep", 5, "the no-data dash");
  for (const cell of m.cells.filter((c) => c.state === "no_data")) markOf(cell.habit, cell.day, "the no-data dash");
  assert.ok(dash.width >= 4 && dash.width <= dashCell.box.width / 2, `the no-data dash is ${dash.width}px wide`);
  assert.ok(isGray(px.darkest(dash.cx, dash.cy)), `the no-data dash is not a gray mark (${px.darkest(dash.cx, dash.cy)})`);
  assert.ok(px.lightest(dash.cx, dashCell.box.top + dashCell.box.height * 0.25) > PAPER, "the no-data box is not empty above its dash");

  // A tag: a small solid square in ink.
  const tag = markOf("travel", 7, "the tag marker");
  assert.ok(tag.width >= 5 && tag.width <= 10 && Math.abs(tag.width - tag.height) < 0.5, `the tag marker is ${tag.width} by ${tag.height}px`);
  assert.ok(px.darkest(tag.cx, tag.cy) < INK, "the tag marker is not ink");

  // Progress part-way (300 of 750): a box filled gray from the bottom to about two fifths.
  const fill = markOf("morning_pages", 3, "the progress box");
  assert.ok(fill.height >= 12, `the progress box is ${fill.height}px tall`);
  assert.ok(isGray(px.darkest(fill.cx, fill.bottom - fill.height * 0.2)), "the progress box is not filled at the bottom");
  assert.ok(px.lightest(fill.cx, fill.bottom - fill.height * 0.65) > PAPER, "the progress box is filled past its share");
  assert.ok(isGray(px.darkest(fill.left + 0.5, fill.cy)), "the progress box has no outline");
  // Progress at or past the goal: the ✕.
  const met = markOf("morning_pages", 1, "the ✕ of a met goal");
  assert.ok(px.darkest(met.cx, met.cy) < INK, "a met goal has no ✕");

  // Missed and future: nothing in the box. Pending, in today's column: nothing but the wash.
  const missed = at("weight", 4).box;
  const pending = at("weight", 17).box;
  const future = at("weight", 18).box;
  assert.ok(px.darkest(missed.cx, missed.cy) > PAPER, "a missed box is not empty");
  assert.ok(px.darkest(future.cx, future.cy) > PAPER, "a future box is not empty");
  const wash = px.darkest(pending.cx, pending.cy);
  assert.ok(wash > 200 && wash < 248, `today's column has no wash (${wash})`);
  for (const cell of m.cells.filter((c) => c.day === 17 && !c.mark && c.values.length === 0)) {
    assert.ok(px.lightest(cell.box.cx, cell.box.cy) < 248, `today's wash stops short of ${cell.habit}`);
  }

  // ── Today's header is the black one. ──
  const today = m.heads.find((h) => h.today);
  const other = m.heads.find((h) => h.day === 10);
  assert.equal(today.day, 17);
  assert.ok(px.lightest(today.box.left + 3, today.box.top + 3) < INK, "today's header is not black");
  assert.ok(px.darkest(other.box.left + 3, other.box.top + 3) > PAPER, "another day's header is not on paper");
  assert.ok(contrastOnWhite(today.color) < 1.1, `today's day number is ${today.color} on black`);
  assert.equal(m.heads.filter((h) => h.background !== other.background).length, 1, "today's is not the only header that differs");

  // ── Rules: ink above days lived, faint above days ahead, faint between days. ──
  const lived = at("lift", 10).box;
  const ahead = at("lift", 20).box;
  assert.ok(px.darkest(lived.cx, lived.top + 0.5) < INK, "a past day has no ink rule above it");
  assert.ok(px.darkest(pending.cx, pending.top + 0.5) < INK, "today has no ink rule above it");
  assert.ok(isGray(px.darkest(ahead.cx, ahead.top + 0.5)) && px.darkest(ahead.cx, ahead.top + 0.5) > 190, `a future day is ruled in ink (${px.darkest(ahead.cx, ahead.top + 0.5)})`);
  assert.ok(isGray(px.darkest(lived.left + 0.5, lived.cy)) && px.darkest(lived.left + 0.5, lived.cy) > 190, "days are not divided by a faint rule");
  assert.ok(px.darkest(m.table.left + 20, m.table.bottom - 0.5) < INK, "the table has no rule under it");

  // ── Day numbers ahead can be read (4.5:1 or better), and are dimmer than those behind. ──
  const past = m.heads.find((h) => h.day === 10);
  for (const head of m.heads.filter((h) => h.future)) {
    assert.ok(contrastOnWhite(head.color) >= 4.5, `day ${head.day}'s number is ${head.color}: ${contrastOnWhite(head.color).toFixed(2)}:1 on white`);
    assert.ok(contrastOnWhite(head.color) < contrastOnWhite(past.color), `day ${head.day}'s number is as dark as a past day's`);
  }
  const aheadHead = m.heads.find((h) => h.day === 24).box;
  assert.ok(px.darkest(aheadHead.cx - 2, aheadHead.bottom - 13) < 170 || px.darkest(aheadHead.cx + 2, aheadHead.bottom - 13) < 170, "a future day number is too faint to see");
  return m;
}

/** Checks that the focused cell or day header shows a focus ring, in the pixels and not only in the styles. */
async function checkFocusRing(t, label, { outside = false } = {}) {
  const focused = await t.page.evaluate(() => {
    const el = document.activeElement;
    const style = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth), left: r.left, top: r.top, right: r.right, bottom: r.bottom, cy: (r.top + r.bottom) / 2, cx: (r.left + r.right) / 2 };
  });
  assert.equal(focused.style, "solid", `${label}: no focus outline`);
  assert.ok(focused.width >= 2, `${label}: the focus outline is ${focused.width}px`);
  await t.page.mouse.move(2, 2);
  const px = await pixels(t.page);
  // The ring is drawn just inside the edges of a grid cell, and just outside a control that stands alone: dark on all four sides.
  const by = outside ? -3 : 1;
  const sides = [[focused.left + by, focused.cy], [focused.right - by, focused.cy], [focused.cx, focused.top + by], [focused.cx, focused.bottom - by]];
  for (const [x, y] of sides) assert.ok(px.darkest(x, y) < INK, `${label}: the focus ring is not drawn at ${Math.round(x)}, ${Math.round(y)}`);
}

const scenarios = [
  {
    name: "month-1280",
    about: "the fixture month on 2026-11-17",
    async run(t) {
      assert.equal(await t.text("h1"), "November");
      assert.equal(await t.count(".grid-day"), 30);
      // Eleven habits; the archived twelfth is not shown.
      assert.equal(await t.count("tbody tr"), 11);
      assert.equal(await t.count('.grid-cell[data-habit="floss"]'), 0);
      assert.match(await t.file("habits.yaml"), /id: floss/);
      // All five cell states are on screen.
      for (const state of ["done", "missed", "no_data", "pending", "future"]) {
        assert.ok((await t.count(`.grid-cell[data-state="${state}"]`)) > 0, `no ${state} cell`);
      }
      // Spot checks against the fixture.
      assert.equal(await t.state("run", 5), "done");
      assert.equal(await t.state("sleep", 5), "no_data");
      assert.equal(await t.state("weight", 4), "missed");
      assert.equal(await t.state("weight", 17), "pending");
      assert.equal(await t.state("weight", 18), "future");
      assert.equal(await t.cellText("weight", 6), "171.3");
      assert.equal(await t.cellText("weight", 13), "171");
      assert.match(await t.label("weight", 6), /171\.25 lb$/);
      assert.ok((await t.fontSize("weight", 6)) >= 9, "values too small to read");
      assert.equal(await t.fontSize("weight", 6), await t.fontSize("weight", 13));
      assert.equal(await t.countText("run"), "7/30");
      assert.equal(await t.countText("morning_pages"), "8/30");
      assert.equal(await t.countText("travel"), "2/30");
      assert.equal(await t.count(".grid-notes"), 4);
      // Nothing scrolls sideways.
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      await checkDrawing(t);
      await t.shot();
    },
  },
  {
    name: "month-960",
    about: "the fixture month at the minimum window size",
    size: SMALL,
    async run(t) {
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      // Narrow boxes: values drop their decimals rather than shrink past reading. The label keeps the full value.
      assert.equal(await t.cellText("weight", 6), "171");
      assert.equal(await t.cellText("weight", 13), "171");
      assert.match(await t.label("weight", 6), /171\.25 lb$/);
      assert.equal(await t.cellText("sleep", 1), "7.9");
      assert.ok((await t.fontSize("weight", 6)) >= 9, "values too small to read");
      assert.equal(await t.fontSize("weight", 6), await t.fontSize("weight", 13));
      const m = await checkDrawing(t);
      // The whole grid is in view at the smallest window.
      assert.ok(m.table.bottom <= m.viewport.height, `the grid ends at ${m.table.bottom}px in a ${m.viewport.height}px window`);
      await t.shot();
    },
  },
  {
    name: "month-empty",
    about: "a data folder with nothing in it: the app seeds habits, the month has no data",
    query: "folder=empty",
    async run(t) {
      assert.equal(await t.count("tbody tr"), 9);
      assert.equal(await t.count('.grid-cell[data-state="done"]'), 0);
      assert.equal(await t.state("weight", 3), "missed");
      assert.equal(await t.state("run", 3), "no_data");
      assert.equal(await t.countText("run"), "0/30");
      assert.match(await t.file("habits.yaml"), /^habits:\n  - id: weight\n/);
      assert.deepEqual(await t.paths(), ["habits.yaml"]);
      await t.shot();
    },
  },
  {
    name: "cell-edit",
    about: "a number cell mid-edit, then saved",
    async run(t) {
      const before = await t.file(TODAY_FILE);
      await t.click("weight", 17);
      await t.page.keyboard.type("171.4");
      await t.shot();
      assert.equal(await t.file(TODAY_FILE), before, "written before Enter");
      await t.page.keyboard.press("Enter");
      await t.saved();
      assert.equal(await t.cellText("weight", 17), "171.4");
      assert.equal(await t.state("weight", 17), "done");
      assert.deepEqual(changed(before, await t.file(TODAY_FILE)), { added: ["weight_lb: 171.4", "  weight_lb: manual"], removed: [] });
      assert.equal(await t.focused(), "weight 2026-11-17");

      // Opening the editor on a value selects it, so typing replaces it (review N-1).
      const selection = () => t.page.evaluate(() => [document.activeElement.value, document.activeElement.selectionStart, document.activeElement.selectionEnd]);
      await t.click("sleep", 17);
      assert.deepEqual(await selection(), ["7.7", 0, 3]);
      await t.page.keyboard.type("5");
      await t.page.keyboard.press("Enter");
      await t.saved();
      assert.match(await t.file(TODAY_FILE), /^sleep_h: 5$/m);
      assert.equal(await t.cellText("sleep", 17), "5");
      // The same from the keyboard: Enter opens with the value selected.
      await t.page.keyboard.press("Enter");
      assert.deepEqual(await selection(), ["5", 0, 1]);
      await t.page.keyboard.type("6.5");
      await t.page.keyboard.press("Enter");
      await t.saved();
      assert.match(await t.file(TODAY_FILE), /^sleep_h: 6\.5$/m);

      // Escape leaves the file alone. So does input that isn't a number, which is also explained.
      const saved = await t.file(TODAY_FILE);
      const other = await t.file("days/2026-11-16.md");
      await t.click("weight", 17);
      await t.page.keyboard.type("9");
      await t.page.keyboard.press("Escape");
      await t.click("weight", 16);
      await t.page.keyboard.type("abc");
      await t.page.keyboard.press("Enter");
      assert.equal(await t.problem(), 'Weight takes a number. "abc" was not saved for November 16.');
      // Nor does a number too large to be a day's anything (review N-4).
      await t.click("weight", 16);
      await t.page.keyboard.type("99999999999999999999");
      await t.page.keyboard.press("Enter");
      assert.equal(await t.problem(), 'Weight takes a number. "99999999999999999999" was not saved for November 16.');
      await t.saved();
      assert.equal(await t.file(TODAY_FILE), saved);
      assert.equal(await t.file("days/2026-11-16.md"), other);
      await t.shot("cell-edit-rejected");
    },
  },
  {
    name: "types",
    about: "each of the six habit types entered with the mouse",
    async run(t) {
      const before = await t.file(TODAY_FILE);
      await t.click("meditate", 17); // check
      await t.click("travel", 17); // tag
      await t.click("mood", 17); // scale
      await t.page.keyboard.type("4");
      await t.page.keyboard.press("Enter");
      await t.click("stretch", 17); // duration
      await t.page.keyboard.type("15");
      await t.page.keyboard.press("Enter");
      // Progress. A click on the Morning pages box opens the writing room; a number typed on it is a count entered by hand.
      await t.focusCell("morning_pages", 17);
      await t.page.keyboard.type("300");
      await t.click("weight", 17); // number; this click also saves the pages by blur
      await t.page.keyboard.type("170.5");
      await t.page.keyboard.press("Enter");
      await t.saved();
      const after = await t.file(TODAY_FILE);
      assert.deepEqual(changed(before, after), {
        added: [
          "meditate: true", "tags: [travel]", "mood: 4", "stretch_min: 15", "morning_pages_words: 300", "weight_lb: 170.5",
          "  meditate: manual", "  mood: manual", "  stretch_min: manual", "  morning_pages_words: manual", "  weight_lb: manual",
        ],
        removed: [],
      });
      assert.equal(await t.state("morning_pages", 17), "done");
      assert.equal(await t.countText("meditate"), "10/30");
      assert.equal(await t.countText("morning_pages"), "8/30"); // 300 of 750 doesn't count yet
      assert.equal(await t.countText("travel"), "3/30");
      await t.shot();

      // Un-tick the check and the tag: false for the check, and tags loses only that tag.
      await t.click("meditate", 17);
      await t.click("travel", 17);
      await t.saved();
      assert.deepEqual(changed(after, await t.file(TODAY_FILE)), {
        added: ["meditate: false", "tags: []"],
        removed: ["meditate: true", "tags: [travel]"],
      });

      // On again: tags is still written between brackets, not over lines (review N-2).
      const off = await t.file(TODAY_FILE);
      await t.click("travel", 17);
      await t.saved();
      assert.deepEqual(changed(off, await t.file(TODAY_FILE)), { added: ["tags: [travel]"], removed: ["tags: []"] });

      // A day whose tags is a map, not a list: the tick is turned down and the file is left alone (review N-3).
      const mapped = (await t.file("days/2026-11-15.md")).replace("_sources:\n", "tags:\n  travel: true\n  note: keep me\n_sources:\n");
      await t.page.evaluate((text) => window.wetware.write("days/2026-11-15.md", text), mapped);
      await t.reload();
      await t.click("travel", 15);
      await t.told("Travel on November 15 was not saved. tags has to be a list");
      await t.saved();
      assert.equal(await t.state("travel", 15), "missed");
      assert.equal(await t.file("days/2026-11-15.md"), mapped);
      await t.page.click(".notice-dismiss");

      // A tag on a day with hand-added keys, a comment and notes: nothing else moves.
      const hand = await t.file("days/2026-11-10.md");
      await t.click("travel", 10);
      await t.saved();
      assert.equal(
        await t.file("days/2026-11-10.md"),
        hand.replace("_sources:\n", "tags: [travel]\n_sources:\n"),
      );
      // And taking a tag off a day that has another keeps the other.
      await t.page.evaluate(() => window.wetware.write("days/2026-11-14.md", window.wetware.read("days/2026-11-14.md").replace("tags: [sick]", "tags: [sick, travel] # both")));
      await t.reload();
      const two = await t.file("days/2026-11-14.md");
      await t.click("travel", 14);
      await t.saved();
      assert.equal(await t.file("days/2026-11-14.md"), two.replace("[sick, travel] # both", "[sick] # both"));
    },
  },
  {
    name: "keys",
    about: "the grid driven with the keyboard alone",
    async run(t) {
      const key = (name) => t.page.keyboard.press(name);
      const before = await t.file(TODAY_FILE);
      // Sync is the first stop. Then the grid is one tab stop: past the three month buttons and the way into the
      // writing room (there while today's pages are short), in at today, and out the far side.
      await key("Tab");
      assert.equal(await t.page.evaluate(() => document.activeElement.textContent), "Sync");
      for (let i = 0; i < 4; i++) await key("Tab");
      assert.equal(await t.page.evaluate(() => document.activeElement.textContent), "Write");
      await key("Tab");
      assert.equal(await t.focused(), "weight 2026-11-17");
      await key("Tab");
      assert.doesNotMatch(await t.focused(), /2026-11/);
      await t.page.keyboard.down("Shift");
      await key("Tab");
      await t.page.keyboard.up("Shift");
      assert.equal(await t.focused(), "weight 2026-11-17");

      // Arrows, Home and End.
      await key("ArrowLeft");
      assert.equal(await t.focused(), "weight 2026-11-16");
      await checkFocusRing(t, "a focused cell");
      await key("Home");
      assert.equal(await t.focused(), "weight 2026-11-01");
      await key("ArrowLeft");
      assert.equal(await t.focused(), "weight 2026-11-01");
      await key("End");
      assert.equal(await t.focused(), "weight 2026-11-30");
      await key("ArrowUp");
      assert.equal(await t.focused(), "day 2026-11-30");
      await checkFocusRing(t, "a focused day header");
      await key("ArrowUp");
      assert.equal(await t.focused(), "day 2026-11-30");
      for (let i = 0; i < 13; i++) await key("ArrowLeft");
      assert.equal(await t.focused(), "day 2026-11-17");
      for (let i = 0; i < 20; i++) await key("ArrowDown");
      assert.equal(await t.focused(), "travel 2026-11-17");

      // Space toggles a tag; Enter a check.
      await key("Space");
      for (let i = 0; i < 4; i++) await key("ArrowUp");
      assert.equal(await t.focused(), "meditate 2026-11-17");
      await key("Enter");
      // 1 to 5 sets a scale directly. 7 does nothing.
      await key("ArrowDown");
      await key("2");
      await key("ArrowDown");
      await key("7");
      await key("4");
      // Typing a number starts an entry; Enter saves it and focus stays on the cell.
      await key("ArrowDown");
      await t.page.keyboard.type("20");
      await key("Enter");
      assert.equal(await t.focused(), "stretch 2026-11-17");
      // Enter opens the editor with the current value; Escape leaves it alone.
      await key("Enter");
      await t.page.keyboard.type("5");
      await key("Escape");
      assert.equal(await t.focused(), "stretch 2026-11-17");
      await t.saved();
      const after = await t.file(TODAY_FILE);
      assert.deepEqual(changed(before, after), {
        added: [
          "tags: [travel]", "meditate: true", "brain_fog: 2", "mood: 4", "stretch_min: 20",
          "  meditate: manual", "  brain_fog: manual", "  mood: manual", "  stretch_min: manual",
        ],
        removed: [],
      });
      await t.shot();

      // Backspace clears: null for a number (still manual), false for a check, the tag out of tags.
      await key("Backspace");
      for (let i = 0; i < 3; i++) await key("ArrowUp");
      await key("Delete");
      for (let i = 0; i < 4; i++) await key("ArrowDown");
      await key("Backspace");
      // Synced sleep, cleared by hand: null, and its source becomes manual.
      for (let i = 0; i < 6; i++) await key("ArrowUp");
      assert.equal(await t.focused(), "sleep 2026-11-17");
      await key("Backspace");
      await t.saved();
      assert.deepEqual(changed(after, await t.file(TODAY_FILE)), {
        added: ["sleep_h: null", "tags: []", "meditate: false", "stretch_min: null", "  sleep_h: manual"],
        removed: ["sleep_h: 7.7", "tags: [travel]", "meditate: true", "stretch_min: 20", "  sleep_h: intervals"],
      });

      // A future cell can be reached but not changed.
      const paths = await t.paths();
      await key("ArrowRight");
      assert.equal(await t.focused(), "sleep 2026-11-18");
      await key("Enter");
      await t.page.keyboard.type("8");
      await key("Space");
      await t.saved();
      assert.deepEqual(await t.paths(), paths);
      assert.equal(await t.state("sleep", 18), "future");

      // The header of a day that hasn't come: Enter presses it and nothing opens.
      for (let i = 0; i < 6; i++) await key("ArrowUp");
      assert.equal(await t.focused(), "day 2026-11-18");
      await key("Enter");
      assert.equal(await t.problem(), null);
      assert.equal(await t.count(".day"), 0);
    },
  },
  {
    name: "months",
    about: "a 31-day month, February, and December into January and back",
    async run(t) {
      const next = () => t.page.click(".month-nav button:last-child");
      const previous = () => t.page.click(".month-nav button:first-child");
      await previous();
      await t.ready();
      assert.equal(await t.text("h1"), "October");
      assert.equal(await t.count(".grid-day"), 31);
      assert.equal(await t.state("run", 30), "done");
      assert.equal(await t.state("run", 29), "no_data");
      assert.equal(await t.state("weight", 29), "missed");
      assert.equal(await t.count('.grid-cell[data-state="future"]'), 0);
      assert.equal(await t.countText("run"), "1/31");
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      assert.equal(await t.cellText("weight", 30), "172.6");
      await t.shot("month-31-days");

      await next();
      await next();
      await t.ready();
      assert.equal(await t.text("h1"), "December");
      assert.equal(await t.text(".month .meta-row .mono"), "2026");
      assert.equal(await t.count(".grid-day"), 31);
      assert.equal(await t.count('.grid-cell[data-state="future"]'), 31 * 11);
      await t.shot("month-december");

      await next();
      await t.ready();
      assert.equal(await t.text("h1"), "January");
      assert.equal(await t.text(".month .meta-row .mono"), "2027");
      assert.equal(await t.count(".grid-day"), 31);

      await next();
      await t.ready();
      assert.equal(await t.text("h1"), "February");
      assert.equal(await t.count(".grid-day"), 28);
      assert.equal(await t.countText("run"), "0/28");
      await t.shot("month-february");

      await previous();
      await previous();
      await t.ready();
      assert.equal(await t.text("h1"), "December");
      assert.equal(await t.text(".month .meta-row .mono"), "2026");

      // "Today" goes back to the current month from anywhere.
      await t.page.click(".month-nav button:nth-child(2)");
      await t.ready();
      assert.equal(await t.text("h1"), "November");
      assert.equal(await t.state("weight", 17), "pending");
    },
  },
  {
    name: "write-failed",
    about: "a save that fails puts the old value back and says so",
    async run(t) {
      const before = await t.file(TODAY_FILE);
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.click("meditate", 17);
      await t.told("was not saved");
      await t.saved();
      assert.equal(await t.state("meditate", 17), "pending");
      assert.equal(await t.file(TODAY_FILE), before);
      assert.equal(await t.problem(), "Meditate on November 17 was not saved. No space left on device (os error 28)");
      await t.shot();

      // The next save that works clears the message.
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.click("meditate", 17);
      await t.saved();
      assert.equal(await t.state("meditate", 17), "done");
      assert.equal(await t.problem(), null);
    },
  },
  {
    name: "hung-write",
    about: "a write the shell never answers is given up on after 30 seconds, said, and holds up nothing else",
    async run(t) {
      // Slow: this scenario waits out the real time limit.
      const path = "days/2026-11-16.md";
      const before = await t.file(path);
      await t.page.evaluate((p) => window.wetware.slowWrite(p, 10 * 60 * 1000), path);
      await t.click("meditate", 16);
      assert.equal(await t.state("meditate", 16), "missed");
      // Another day is not behind it.
      await t.click("meditate", 17);
      await t.saved();
      assert.match(await t.file(TODAY_FILE), /^meditate: true$/m);
      await t.page.waitForFunction(() => document.querySelector(".notice").textContent.includes("after 30 seconds"), { timeout: 45_000 });
      assert.equal(await t.problem(), "Meditate on November 16 was not saved. No answer from the data folder for days/2026-11-16.md after 30 seconds");
      // The box goes back to what the file holds, and the month can be left and come back to.
      await t.page.waitForFunction((selector) => document.querySelector(selector).dataset.state === "done", {}, '.grid-cell[data-habit="meditate"][data-date="2026-11-16"]');
      assert.equal(await t.file(path), before);
      await t.reload();
      assert.equal(await t.text("h1"), "November");
      assert.equal(await t.state("meditate", 16), "done");
      assert.equal(await t.state("meditate", 17), "done");
      assert.equal(await t.countText("meditate"), "10/30");
    },
  },
  {
    name: "broken-day",
    about: "a day file that needs fixing by hand is flagged and can't be changed",
    async run(t) {
      const broken = "---\ndate: 2026-11-12\nmood: 1\nmood: 2\n---\n\nnotes\n";
      await t.page.evaluate((text) => window.wetware.write("days/2026-11-12.md", text), broken);
      await t.reload();
      assert.equal(await t.count(".grid-flag"), 1);
      assert.match(await t.label("mood", 12), /file needs fixing$/);
      // Its boxes show nothing: not "missed", not "no data". And it isn't counted.
      assert.equal(await t.state("run", 12), undefined);
      assert.equal(await t.page.$eval('.grid-cell[data-habit="run"][data-date="2026-11-12"]', (el) => el.children.length), 0);
      assert.equal(await t.countText("run"), "6/30");
      await t.click("meditate", 12);
      assert.match(await t.problem(), /days\/2026-11-12\.md needs fixing by hand.*Map keys must be unique \(line 4\)/);
      assert.equal(await t.file("days/2026-11-12.md"), broken);
      await t.shot();
    },
  },
  ...[["notices", WIDE], ["notices-960", SMALL]].map(([name, size]) => ({
    name,
    size,
    about: "messages have a place of their own, and a failure stays until its own cell saves",
    async run(t) {
      const place = await t.gridBox();
      const notice = () => t.page.$eval(".notice", (el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom, role: el.getAttribute("role"), title: el.title }));
      const dismiss = () => t.page.$eval(".notice-dismiss", (el) => el.textContent).catch(() => null);
      const unmoved = async (when) => assert.deepEqual(await t.gridBox(), place, `the grid moved ${when}`);

      // SF-1. A message that arrives between mouse-down and mouse-up: the click still lands on the cell under the pointer.
      await t.click("stretch", 17);
      await t.page.keyboard.type("abc");
      await t.click("lift", 17);
      await t.saved();
      const rejected = 'Stretch takes a whole number, 0 or more. "abc" was not saved for November 17.';
      assert.equal(await t.problem(), rejected);
      assert.equal(await t.state("lift", 17), "done", "the click was lost");
      await unmoved("when a message appeared");
      assert.equal((await notice()).role, "alert");
      assert.equal(await dismiss(), "Dismiss");
      // The message sits in the gap between the header strip and the month strip.
      const strips = await t.page.$$eval(".meta-row", (els) => els.map((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })));
      assert.ok((await notice()).top >= strips[0].bottom - 0.5 && (await notice()).bottom <= strips[1].top + 0.5, "the message is not in the gap under the header");

      // SF-2. A save that fails, then one elsewhere on the same day that works: the failure is still there.
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.click("meditate", 17);
      const failed = "Meditate on November 17 was not saved. No space left on device (os error 28)";
      await t.told(failed);
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.click("travel", 17);
      await t.saved();
      assert.equal(await t.state("travel", 17), "done");
      assert.equal(await t.state("meditate", 17), "pending");
      assert.equal(await t.problem(), failed, "a later save elsewhere erased the failure");
      assert.equal(await dismiss(), "Dismiss (1 of 2)");
      await unmoved("after a save elsewhere");
      await t.shot();

      // Dismissing it shows the one behind it. That one goes when its own cell saves.
      await t.page.click(".notice-dismiss");
      assert.equal(await t.problem(), rejected);
      await unmoved("when a message was dismissed");
      await t.click("stretch", 17);
      await t.page.keyboard.type("15");
      await t.page.keyboard.press("Enter");
      await t.saved();
      assert.equal(await t.problem(), null);
      assert.equal(await dismiss(), null);
      await unmoved("when the last message went");

      // A failure also goes when the same cell saves.
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.click("meditate", 17);
      await t.told(failed);
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.click("meditate", 17);
      await t.saved();
      assert.equal(await t.state("meditate", 17), "done");
      assert.equal(await t.problem(), null);

      // A message too long for the line is cut short there, with all of it in its tooltip, and still moves nothing.
      const long = `Disk trouble: ${"the volume is not responding, ".repeat(30)}try again.`;
      await t.page.evaluate((message) => window.wetware.failWrites(message), long);
      await t.click("brain_fog", 17);
      await t.page.keyboard.type("2");
      await t.page.keyboard.press("Enter");
      await t.told("Disk trouble");
      await t.saved();
      assert.equal((await notice()).title, `Brain fog on November 17 was not saved. ${long}`);
      assert.ok((await notice()).bottom <= strips[1].top + 0.5, "a long message runs into the month");
      await unmoved("under a long message");
      await t.shot(`${name}-long`);
    },
  })),
  {
    name: "unreadable-day",
    about: "a day file that can't be read is hatched out; the rest of the month loads and can be changed",
    async run(t) {
      const path = "days/2026-11-05.md";
      const original = await t.file(path);
      await t.page.evaluate((p) => window.wetware.failRead(p, "stream did not contain valid UTF-8"), path);
      await t.reload();
      // The month is there, apart from that day.
      assert.equal(await t.count(".grid-flag"), 1);
      assert.equal(await t.state("run", 5), undefined);
      assert.equal(await t.state("run", 1), "done");
      assert.equal(await t.state("sleep", 4), "done");
      assert.equal(await t.countText("run"), "6/30");
      assert.equal(await t.problem(), null);
      assert.equal(
        await t.page.$eval('.grid-day-button[data-date="2026-11-05"]', (el) => el.title),
        "days/2026-11-05.md: The file could not be read: stream did not contain valid UTF-8.",
      );
      // Its column is hatched: something gray is drawn in a box that holds no mark.
      await t.page.mouse.move(2, 2);
      const px = await pixels(t.page);
      const box = (await measure(t.page)).cells.find((c) => c.habit === "weight" && c.day === 5).box;
      const inner = { left: box.left + 3, right: box.right - 3, top: box.top + 3, bottom: box.bottom - 3 };
      assert.ok(isGray(px.darkestIn(inner)), "the unreadable day is not hatched");

      // Other days can be changed.
      const before = await t.file(TODAY_FILE);
      await t.click("meditate", 17);
      await t.saved();
      assert.deepEqual(changed(before, await t.file(TODAY_FILE)), { added: ["meditate: true", "  meditate: manual"], removed: [] });

      // That day can't, and the message names the file.
      await t.click("weight", 5);
      assert.equal(
        await t.problem(),
        "days/2026-11-05.md needs fixing by hand before it can be changed. The file could not be read: stream did not contain valid UTF-8.",
      );
      assert.equal(await t.count(".grid-input"), 0);
      await t.click("run", 5);
      await t.saved();
      assert.equal(await t.file(path), original);
      await t.shot();

      // Once the file can be read again, the day comes back and the message goes.
      await t.page.evaluate((p) => window.wetware.failRead(p, null), path);
      await t.reload();
      assert.equal(await t.count(".grid-flag"), 0);
      assert.equal(await t.state("run", 5), "done");
      assert.equal(await t.problem(), null);

      // The days folder itself failing is a different matter: the month can't load, and says so until one does.
      await t.page.evaluate(() => window.wetware.failList("Permission denied (os error 13)"));
      await t.page.click(".month-nav button:first-child");
      await t.told("October could not be loaded. Permission denied (os error 13)");
      await t.page.evaluate(() => window.wetware.failList(null));
      await t.page.click(".month-nav button:nth-child(2)");
      await t.ready();
      assert.equal(await t.problem(), null);
      assert.equal(await t.state("run", 1), "done");
    },
  },
  {
    name: "skipped-habit",
    about: "a habit that would write over one of the app's own keys is left out, with a reason",
    async run(t) {
      const nav = (label) => t.page.evaluate((text) => [...document.querySelectorAll(".nav-item")].find((el) => el.textContent === text).click(), label);
      const place = await t.gridBox();
      const day = await t.file("days/2026-11-14.md");
      const habits = await t.file("habits.yaml");
      await t.page.evaluate((text) => window.wetware.write("habits.yaml", text), `${habits}  - id: tags\n    name: Tagged\n  - id: sleep_h\n    name: Nap\n`);
      await nav("Settings");
      await t.page.click(".row-value .action");
      await t.told("habits.yaml: 2 habits are not shown.");
      assert.equal(
        await t.problem(),
        "habits.yaml: 2 habits are not shown. Habit 13 (tags) would store its values under tags, a key the app keeps for itself. Habit 14 (sleep_h) would store its values under sleep_h, the same key as Sleep.",
      );
      await nav("Month");
      await t.ready();
      assert.equal(await t.count("tbody tr"), 11);
      assert.equal(await t.count('.grid-cell[data-habit="tags"]'), 0);
      assert.equal(await t.count('.grid-cell[data-habit="sleep_h"]'), 0);
      assert.deepEqual(await t.gridBox(), place, "the notice moved the grid");
      assert.equal(await t.file("days/2026-11-14.md"), day);
      await t.shot();
    },
  },
  {
    name: "folder-fails",
    about: "a folder that fails to load leaves nothing from the last one on screen",
    async run(t) {
      const nav = (label) => t.page.evaluate((text) => [...document.querySelectorAll(".nav-item")].find((el) => el.textContent === text).click(), label);
      const folder = () => t.text(".row-value .grow");
      await nav("Settings");
      await t.page.waitForSelector('input[aria-label="Latitude"]');
      assert.equal(await folder(), "/Users/preview/Documents/Wetware Data");

      // The newly chosen folder has a habits.yaml that can't be read.
      const good = await t.file("habits.yaml");
      await t.page.evaluate(() => window.wetware.write("habits.yaml", "habits: [oops"));
      await t.page.click(".row-value .action");
      await t.told("habits.yaml could not be loaded. Invalid YAML");
      assert.equal(await folder(), "/Users/preview/Notes/Wetware");
      assert.equal(await t.count('input[aria-label="Latitude"]'), 0, "settings from the old folder are still shown");
      await nav("Month");
      await t.ready();
      assert.equal(await t.count("tbody tr"), 0, "habits from the old folder are still shown");
      await t.shot();

      // Fixed by hand and chosen again: everything loads and the error line clears.
      await t.page.evaluate((text) => window.wetware.write("habits.yaml", text), good);
      await nav("Settings");
      await t.page.click(".row-value .action");
      await t.page.waitForSelector('input[aria-label="Latitude"]');
      assert.equal(await t.problem(), null);
      await nav("Month");
      await t.ready();
      assert.equal(await t.count("tbody tr"), 11);
    },
  },
  {
    name: "sync",
    about: "opening the app syncs: cells fill in, sources are recorded, and what was set by hand stays",
    query: "sync=fixture&key=stored",
    async run(t) {
      await t.told("Sync: 24 days updated.");
      assert.equal(await t.problem(), "Sync: 24 days updated.");
      assert.equal(await t.syncStatus(), "Last synced 09:41");
      // One sync, three fetches, each for the seven days before the month through today.
      assert.deepEqual((await t.fetches()).sort(), ["activities 2026-10-25 2026-11-17", "weather 37.8 -122.27 2026-10-25 2026-11-17", "wellness 2026-10-25 2026-11-17"]);

      // Today's run is in, and the 9th, which had no file: a run beside a night with no sleep data.
      await t.stateIs("run", 17, "done");
      assert.equal(await t.state("run", 9), "done");
      assert.equal(await t.state("sleep", 9), "no_data");
      assert.equal(await t.cellText("weight", 9), "171.1");
      assert.equal(await t.countText("run"), "9/30");
      // The weekend the watch was off is still "no data", Strava stub and all. Sleep cleared by hand stays cleared.
      assert.equal(await t.state("run", 7), "no_data");
      assert.equal(await t.state("run", 8), "no_data");
      assert.equal(await t.state("sleep", 13), "missed");
      // Lift and Climb name no activity type: nothing was written for them, strength sessions or not.
      assert.equal(await t.state("lift", 9), "no_data");
      assert.equal(await t.state("lift", 17), "pending");
      assert.equal(await t.countText("lift"), "4/30");
      assert.equal(await t.countText("climb"), "2/30");

      // The files: only the lines sync owns changed, and each value has its source.
      assert.deepEqual(changed(await fixtureFile(TODAY_FILE), await t.file(TODAY_FILE)), {
        added: [
          "run: true", "weather_high_f: 47", "weather_low_f: 40", "weather_precip_in: 0.26", "weather_condition: rain",
          "  run: intervals", "  weather_high_f: open-meteo", "  weather_low_f: open-meteo", "  weather_precip_in: open-meteo",
          "  weather_condition: open-meteo", `_synced_at: ${SYNCED_AT}`,
        ],
        removed: ["_synced_at: 2026-11-17T06:27:00-08:00"],
      });
      assert.equal(
        await t.file("days/2026-11-09.md"),
        [
          "---", "date: 2026-11-09", "weight_lb: 171.1", "resting_hr: 50", "run: true",
          "weather_high_f: 38", "weather_low_f: 33", "weather_precip_in: 0", "weather_condition: drizzle",
          "_sources:", "  weight_lb: intervals", "  resting_hr: intervals", "  run: intervals",
          "  weather_high_f: open-meteo", "  weather_low_f: open-meteo", "  weather_precip_in: open-meteo", "  weather_condition: open-meteo",
          `_synced_at: ${SYNCED_AT}`, "---", "",
        ].join("\n"),
      );
      // A day with a comment, keys of the user's own and notes: all of it is where it was.
      assert.equal(
        await t.file("days/2026-11-10.md"),
        (await fixtureFile("days/2026-11-10.md"))
          .replace("weather_high_f: 62", "weather_high_f: 41")
          .replace("weather_low_f: 50", "weather_low_f: 36")
          .replace("weather_condition: fog\n", "weather_condition: rain\nweather_precip_in: 0\n")
          .replace("  weather_condition: open-meteo\n", "  weather_condition: open-meteo\n  weather_precip_in: open-meteo\n")
          .replace("_synced_at: 2026-11-11T06:20:00-08:00", `_synced_at: ${SYNCED_AT}`),
      );
      // Nothing synced is shown as a habit, and the month is still drawn as it should be.
      assert.equal(await t.count("tbody tr"), 11);
      await checkDrawing(t);
      await t.shot();

      // A value set by hand survives the next sync. Sync is reached and pressed from the keyboard.
      await t.click("sleep", 17);
      await t.page.keyboard.type("5");
      await t.page.keyboard.press("Enter");
      await t.saved();
      await t.page.focus(".month .action");
      await t.page.keyboard.press("Enter");
      await t.told("Sync: nothing new.");
      assert.equal(await t.cellText("sleep", 17), "5");
      assert.match(await t.file(TODAY_FILE), /^sleep_h: 5$/m);
      assert.match(await t.file(TODAY_FILE), /^  sleep_h: manual$/m);
      const settled = await t.file(TODAY_FILE);

      // A sync under way doesn't hold the grid up: a cell can be ticked, and an entry begun, while it runs.
      await t.page.evaluate(() => {
        window.wetware.write("days/2026-11-17.md", window.wetware.read("days/2026-11-17.md").replace("run: true\n", ""));
        window.wetware.slowFetches(500);
      });
      const asked = (await t.fetches()).length;
      await t.page.click(".month .action");
      await t.page.waitForFunction(() => document.querySelector(".sync-status").textContent === "Syncing");
      // Sync can't be started twice: pressing it again while it runs asks for nothing more.
      assert.equal(await t.page.$eval(".month .action", (el) => el.getAttribute("aria-disabled")), "true");
      await t.page.click(".month .action");
      await t.click("meditate", 17);
      assert.equal(await t.state("meditate", 17), "done");
      await t.click("weight", 17);
      await t.page.keyboard.type("170");
      await t.told("Sync: 1 day updated.");
      assert.equal(await t.syncStatus(), "Last synced 09:41");
      assert.equal(await t.page.$eval(".month .action", (el) => el.getAttribute("aria-disabled")), null);
      assert.equal((await t.fetches()).length, asked + 3);
      await t.stateIs("run", 17, "done");
      // The entry is still open with what was typed, and saves as usual.
      assert.equal(await t.page.$eval(".grid-input", (el) => el.value), "170");
      await t.page.keyboard.press("Enter");
      await t.saved();
      assert.deepEqual(changed(settled, await t.file(TODAY_FILE)), { added: ["meditate: true", "weight_lb: 170", "  meditate: manual", "  weight_lb: manual"], removed: [] });
      assert.equal(await t.state("meditate", 17), "done");
      assert.equal(await t.cellText("weight", 17), "170");
    },
  },
  {
    name: "sync-no-sleep",
    about: "an empty folder filled by sync: a run beside a night with no sleep data, and Lift and Climb left unset",
    query: "folder=empty&sync=fixture&key=stored",
    async run(t) {
      // No location in a new folder, so no weather: 22 days from intervals.icu, and none for the two the watch was off.
      await t.told("Sync: 22 days updated.");
      await t.stateIs("run", 5, "done");
      assert.equal(await t.state("sleep", 5), "no_data");
      assert.equal(await t.state("run", 9), "done");
      assert.equal(await t.state("sleep", 9), "no_data");
      assert.equal(await t.cellText("sleep", 4), "8.1");
      assert.equal(await t.state("run", 4), "missed"); // the watch was on, and there was no run
      for (const day of [7, 8]) {
        assert.equal(await t.state("run", day), "no_data");
        assert.equal(await t.state("sleep", day), "no_data");
      }
      const paths = await t.paths();
      assert.equal(paths.length, 23); // habits.yaml and 22 days
      assert.ok(!paths.includes("days/2026-11-07.md") && !paths.includes("days/2026-11-08.md"), "a file was made for a day with no data");
      assert.ok(paths.includes("days/2026-10-25.md"), "the seven days before the month were not synced");
      assert.equal(await t.file("days/2026-11-05.md"), `---\ndate: 2026-11-05\nresting_hr: 53\nrun: true\n_sources:\n  resting_hr: intervals\n  run: intervals\n_synced_at: ${SYNCED_AT}\n---\n`);
      // Lift and Climb: no day is ticked or crossed off, whatever intervals.icu had. Every past day reads "no data".
      for (const habit of ["lift", "climb"]) {
        assert.equal(await t.count(`.grid-cell[data-habit="${habit}"][data-state="no_data"]`), 16);
        assert.equal(await t.count(`.grid-cell[data-habit="${habit}"][data-state="done"]`), 0);
        assert.equal(await t.count(`.grid-cell[data-habit="${habit}"][data-state="missed"]`), 0);
      }
      for (const file of paths.filter((path) => path.startsWith("days/"))) {
        assert.doesNotMatch(await t.file(file), /^(lift|climb):/m, `${file} has a value for a habit that isn't set up`);
      }
      // The weight intervals.icu had for the 9th is in, in pounds; the one it carried over from settings on the 4th is not.
      assert.equal(await t.cellText("weight", 9), "171.1");
      assert.equal(await t.state("weight", 4), "missed");
      assert.equal(await t.countText("run"), "9/30");

      // Drawn: the ✕ of the run and, under it in the same column, the dash of no sleep data.
      await t.page.mouse.move(2, 2);
      const m = await measure(t.page);
      const px = await pixels(t.page);
      const at = (habit, day) => m.cells.find((c) => c.habit === habit && c.day === day);
      const cross = at("run", 5).mark.box;
      const dash = at("sleep", 5).mark.box;
      assert.ok(px.darkest(cross.cx, cross.cy) < INK, "the run has no ✕");
      assert.ok(isGray(px.darkest(dash.cx, dash.cy)), "the night with no sleep data has no dash");
      assert.ok(Math.abs(cross.cx - dash.cx) < 1, "the run and the night are not the same day");
      assert.ok(px.lightest(dash.cx, at("sleep", 5).box.top + at("sleep", 5).box.height * 0.25) > PAPER, "the no-data box is not empty above its dash");
      await t.shot();
    },
  },
  {
    name: "sync-no-key",
    about: "no intervals.icu key: the weather still syncs, and being not connected is said once",
    query: "sync=fixture&key=none&told=no",
    async run(t) {
      const once = `Sync: 24 days updated. ${NOT_CONNECTED}`;
      await t.told(once);
      assert.equal(await t.problem(), once);
      assert.equal(await t.syncStatus(), "Last synced 09:41");
      // The weather is in; nothing from intervals.icu is, and it was asked once, not twice.
      const today = await t.file(TODAY_FILE);
      assert.match(today, /^weather_condition: rain$/m);
      assert.match(today, /^  weather_high_f: open-meteo$/m);
      assert.doesNotMatch(today, /^run:/m);
      assert.equal(await t.state("run", 17), "pending");
      assert.deepEqual(await t.fetches(), ["wellness 2026-10-25 2026-11-17", "weather 37.8 -122.27 2026-10-25 2026-11-17"]);
      assert.equal((await t.syncState()).intervals_hint_shown, true);
      await t.shot();

      // The next time a folder opens, the sync runs again and doesn't say it again.
      await t.nav("Settings");
      await t.page.click(".row-value .action");
      await t.page.waitForFunction(() => window.wetware.fetches().length === 4);
      await t.nav("Month");
      await t.ready();
      await t.page.waitForFunction(() => document.querySelector(".sync-status").textContent === "Last synced 09:41");
      assert.equal(await t.problem(), null);

      // Asked for, it says where things stand.
      await t.page.click(".month .action");
      await t.told(`Sync: nothing new. ${NOT_CONNECTED}`);
    },
  },
  {
    name: "sync-key-rejected",
    about: "a key intervals.icu turns down: said plainly, the weather still syncs, and a new key puts it right",
    query: "sync=fixture&key=rejected",
    async run(t) {
      await t.told(`Sync: 24 days updated. ${KEY_REJECTED}`);
      assert.match(await t.file(TODAY_FILE), /^weather_condition: rain$/m);
      assert.doesNotMatch(await t.file(TODAY_FILE), /^run:/m);
      await t.shot();

      // Later, with the weather out of reach as well, nothing is reached: the last-synced time stays what it was.
      await t.page.evaluate(() => {
        window.wetware.setTime(10, 5);
        window.wetware.failWeather({ kind: "offline" });
      });
      await t.page.click(".month .action");
      await t.told(`Sync: ${KEY_REJECTED} Open-Meteo could not be reached. Check the internet connection, then try again.`);
      assert.equal(await t.syncStatus(), "Last synced 09:41");
      assert.equal((await t.syncState()).last_synced_ms, new Date(2026, 10, 17, 9, 41).getTime());
      // A source that limits requests: the wait it asked for is the wait that is said.
      await t.page.evaluate(() => window.wetware.failWeather({ kind: "rate_limited", retry_after_secs: 3600 }));
      await t.page.click(".month .action");
      await t.told("Open-Meteo is limiting requests. Try again in about an hour.");
      assert.equal(await t.syncStatus(), "Last synced 09:41");
      // A sync that does reach one moves it on.
      await t.page.evaluate(() => window.wetware.failWeather(null));
      await t.page.click(".month .action");
      await t.told(`Sync: nothing new. ${KEY_REJECTED}`);
      assert.equal(await t.syncStatus(), "Last synced 10:05");

      // Settings says the same of the key when asked to test it. A new key is accepted.
      await t.nav("Settings");
      await t.page.waitForSelector('input[aria-label="intervals.icu API key"]');
      await t.action("Test connection");
      await t.page.waitForFunction(() => window.wetware.fetches().at(-1) === "activities 2026-08-19 2026-11-17");
      await t.page.waitForFunction((text) => document.body.textContent.includes(text), {}, KEY_REJECTED);
      assert.equal(await t.row("Connection"), KEY_REJECTED);
      assert.equal(await t.row("Activity types"), null);
      await t.page.type('input[aria-label="intervals.icu API key"]', "preview-key-two");
      await t.page.keyboard.press("Enter");
      await t.page.waitForFunction(() => ![...document.querySelectorAll(".row")].some((row) => row.firstElementChild.textContent === "Connection"));
      await t.action("Test connection");
      await t.page.waitForFunction(() => [...document.querySelectorAll(".row")].some((row) => row.firstElementChild.textContent === "Activity types"));
      assert.equal(await t.row("Connection"), "Connected");

      // And the next sync fills in what intervals.icu has.
      await t.nav("Month");
      await t.ready();
      await t.page.click(".month .action");
      await t.told("Sync: 11 days updated.");
      await t.stateIs("run", 17, "done");
      assert.equal(await t.problem(), "Sync: 11 days updated.");

      // Both sources failing the same way is said once, for both.
      await t.page.evaluate(() => {
        window.wetware.failIntervals({ kind: "offline" });
        window.wetware.failWeather({ kind: "offline" });
      });
      await t.page.click(".month .action");
      await t.told("could not be reached");
      assert.equal(await t.problem(), "Sync: intervals.icu and Open-Meteo could not be reached. Check the internet connection, then try again.");
    },
  },
  {
    name: "sync-folder-change",
    about: "a sync goes on if the folder picker is cancelled, and stops, writing nowhere, when another folder is opened",
    query: "sync=fixture&key=stored",
    async run(t) {
      await t.told("Sync: 24 days updated.");
      const first = (await t.fetches()).length;

      // The picker opened and cancelled in the middle of a sync: the sync is left alone and finishes.
      await t.page.evaluate(() => {
        window.wetware.write("days/2026-11-17.md", window.wetware.read("days/2026-11-17.md").replace("run: true\n", ""));
        window.wetware.slowFetches(400);
        window.wetware.pick("cancel");
      });
      await t.page.click(".month .action");
      await t.page.waitForFunction(() => document.querySelector(".sync-status").textContent === "Syncing");
      await t.nav("Settings");
      await t.page.click(".row-value .action"); // Choose, then Cancel
      await t.page.waitForFunction(() => window.wetware.calls().includes("choose_data_root"));
      assert.doesNotMatch(await t.file(TODAY_FILE), /^run:/m, "the sync had finished before the picker was opened");
      await t.told("Sync: 1 day updated.");
      assert.match(await t.file(TODAY_FILE), /^run: true$/m);
      assert.equal((await t.fetches()).length, first + 3);
      assert.deepEqual(await t.page.evaluate(() => window.wetware.refused()), []);
      assert.equal(await t.page.evaluate(() => window.wetware.root()), "/Users/preview/Documents/Wetware Data");
      await t.nav("Month");
      await t.ready();
      await t.stateIs("run", 17, "done");
      assert.equal(await t.syncStatus(), "Last synced 09:41");
      assert.equal(await t.problem(), "Sync: 1 day updated.");

      // Another folder opened in the middle of a sync's writes. Every day has something to write, slowly.
      await t.page.evaluate(() => {
        for (const path of window.wetware.paths().filter((p) => p.startsWith("days/"))) {
          window.wetware.write(path, window.wetware.read(path).replace(/^weather_high_f: .*$/m, "weather_high_f: 0"));
        }
        window.wetware.slowFetches(0);
        window.wetware.slowWrite("*", 60);
        window.wetware.pick("other");
      });
      const written = () => t.page.evaluate(() => window.wetware.pathsIn("suggested").filter((p) => p.startsWith("days/") && !/^weather_high_f: 0$/m.test(window.wetware.readIn("suggested", p))).length);
      const before = await t.page.evaluate(() => window.wetware.writes().length);
      const pristine = await t.page.evaluate(() => window.wetware.pathsIn("other").map((p) => [p, window.wetware.readIn("other", p)]));
      await t.page.click(".month .action");
      await t.page.waitForFunction((n) => window.wetware.writes().length >= n + 3, {}, before);
      await t.nav("Settings");
      await t.page.click(".row-value .action"); // Choose: the shell opens the other folder
      await t.page.waitForFunction(() => window.wetware.root() === "/Users/preview/Elsewhere/Wetware");
      // The sync stops at the next thing it asks the shell for. A write let through before the change may still land.
      await t.page.waitForFunction(() => window.wetware.refused().length > 0);
      await t.saved();
      await t.saved();
      const left = await written();
      assert.ok(left >= 3 && left < 24, `${left} of 24 days were written to the folder that was left`);
      assert.deepEqual(await t.page.evaluate(() => window.wetware.refused()), ["data_read"]);

      // The folder that was opened is then synced for itself, and is the only thing written from here on.
      await t.page.evaluate(() => window.wetware.slowWrite("*", null));
      await t.told("Sync: 24 days updated.");
      assert.equal(await written(), left, "the folder that was left was written to after it was left");
      const writes = await t.page.evaluate(() => window.wetware.writes());
      const opened = Math.max(...writes.map((write) => write.folder));
      for (const write of writes.slice(before)) {
        const where = write.folder === opened ? "/Users/preview/Elsewhere/Wetware" : "/Users/preview/Documents/Wetware Data";
        assert.equal(write.root, where, `${write.path}, worked out for folder ${write.folder}, landed in ${write.root}`);
      }
      const inOther = writes.filter((write) => write.root === "/Users/preview/Elsewhere/Wetware");
      assert.equal(inOther.length, 24);
      assert.ok(inOther.every((write) => write.folder === opened), "the sync of the folder that was left wrote into the one that was opened");
      // What landed there is its own sync's work on its own files: the fixture as it was, plus that sync.
      const was = new Map(pristine);
      assert.match(was.get(TODAY_FILE), /^sleep_h: 7\.7$/m);
      assert.doesNotMatch(was.get(TODAY_FILE), /^run:/m);
      assert.match(await t.file(TODAY_FILE), /^run: true$/m);
      assert.doesNotMatch(await t.file("days/2026-11-10.md"), /^weather_high_f: 0$/m);
      assert.equal((await t.syncState()).last_synced_ms, new Date(2026, 10, 17, 9, 41).getTime());
      await t.nav("Month");
      await t.ready();
      await t.stateIs("run", 17, "done");
      assert.equal(await t.syncStatus(), "Last synced 09:41");
      assert.equal(await t.problem(), "Sync: 24 days updated.");

      // What the screens say of syncing is about the folder now open. Another folder has not been synced and
      // has no Strava activities to speak of, from the moment it opens: not only once its own sync has run.
      await t.nav("Settings");
      await t.page.waitForSelector('input[aria-label="intervals.icu API key"]');
      assert.equal(await t.row("Strava"), "2 activities can't be read");
      const fetched = (await t.fetches()).length;
      await t.page.evaluate(() => {
        window.wetware.pick("same");
        window.wetware.slowFetches(500);
        window.wetware.failIntervals({ kind: "offline" });
        window.wetware.failWeather({ kind: "offline" });
      });
      await t.page.click(".row-value .action");
      await t.page.waitForFunction((n) => window.wetware.fetches().length > n, {}, fetched);
      assert.equal(await t.problem(), "Sync: 24 days updated.", "the new folder's sync had already finished");
      assert.equal(await t.row("Strava"), null);
      await t.told("could not be reached");
      assert.equal(await t.row("Strava"), null);
      await t.nav("Month");
      await t.ready();
      assert.equal(await t.syncStatus(), "Not synced yet");
    },
  },
  {
    name: "sync-reread",
    about: "an edit made while the month is read again after a sync stays on screen, and the month is not read over an edit still on its way to disk",
    query: "sync=fixture&key=stored",
    async run(t) {
      await t.told("Sync: 24 days updated.");
      await t.stateIs("run", 17, "done");

      // The month's re-read is held up by one slow file: a day ahead, which sync doesn't touch. Its notes mark
      // is how the screen shows that the re-read has landed.
      const reread = '.grid-day-button[data-date="2026-11-20"] .grid-notes';
      await t.page.evaluate(() => {
        window.wetware.write("days/2026-11-20.md", "---\ndate: 2026-11-20\n---\n\nPacked for the trip.\n");
        window.wetware.slowRead("days/2026-11-20.md", 700);
        window.wetware.write("days/2026-11-17.md", window.wetware.read("days/2026-11-17.md").replace("run: true\n", ""));
      });
      await t.page.click(".month .action");
      await t.told("Sync: 1 day updated.");
      // The sync is done and the re-read is under way: the 16th has been read, the 20th is still coming.
      await t.page.waitForFunction(() => window.wetware.calls().lastIndexOf("data_list") > window.wetware.calls().lastIndexOf("data_write"));
      await t.saved();
      assert.equal(await t.count(reread), 0, "the re-read had landed before the edit was made");
      // An edit made now...
      assert.equal(await t.state("meditate", 16), "done");
      await t.click("meditate", 16);
      await t.saved();
      assert.match(await t.file("days/2026-11-16.md"), /^meditate: false$/m);
      assert.equal(await t.state("meditate", 16), "missed");
      assert.equal(await t.count(reread), 0, "the re-read had landed before the edit was saved");
      // ...is still what the screen shows once the re-read lands.
      await t.page.waitForSelector(reread);
      assert.equal(await t.state("meditate", 16), "missed", "the re-read put back what was on disk before the edit");
      assert.equal(await t.state("run", 17), "done");
      await t.page.evaluate(() => window.wetware.slowRead("days/2026-11-20.md", null));

      // An edit still on its way to disk when a sync finishes. October: the days before the 25th are outside
      // what sync looks at, so the edit's file is not one the sync waits its turn for.
      await t.page.click(".month-nav button:first-child");
      await t.ready();
      await t.page.evaluate(() => {
        window.wetware.write("days/2026-10-30.md", window.wetware.read("days/2026-10-30.md").replace("hrv: 65\n", ""));
        window.wetware.slowFetches(300);
        window.wetware.slowWrite("days/2026-10-10.md", 1200);
      });
      const lists = () => t.page.evaluate(() => window.wetware.calls().filter((call) => call === "data_list").length);
      const listed = await lists();
      await t.page.click(".month .action");
      await t.page.waitForFunction(() => document.querySelector(".sync-status").textContent === "Syncing");
      await t.click("meditate", 10);
      assert.equal(await t.state("meditate", 10), "done");
      await t.told("Sync: 1 day updated.");
      // The sync is done and the edit is not yet on disk. The tick stays, and the month is not read again
      // until it is: a month read now would not have the file the edit is making.
      assert.equal(await t.file("days/2026-10-10.md"), null, "the edit had already reached the disk");
      assert.equal(await lists(), listed, "the month was read again while an edit was on its way to disk");
      assert.equal(await t.state("meditate", 10), "done");
      await t.page.waitForFunction((n) => window.wetware.calls().filter((call) => call === "data_list").length > n, {}, listed);
      assert.notEqual(await t.file("days/2026-10-10.md"), null, "the month was read again before the edit reached the disk");
      await t.saved();
      assert.equal(await t.state("meditate", 10), "done", "the re-read took away the edit");
      assert.match(await t.file("days/2026-10-30.md"), /^hrv: 65$/m);
      assert.equal(await t.file("days/2026-10-10.md"), "---\ndate: 2026-10-10\nmeditate: true\n_sources:\n  meditate: manual\n---\n");
    },
  },
  {
    name: "sync-left-alone",
    about: "day files a sync can't change are each named, with the reason, and a read-only one is called that",
    query: "sync=fixture&key=stored",
    async run(t) {
      await t.told("Sync: 24 days updated.");
      // A key written twice on the 5th, a 6th that isn't text, and a 10th that is read-only and has something to write.
      const tenth = (await t.file("days/2026-11-10.md")).replace(/^weather_high_f: .*$/m, "weather_high_f: 0");
      await t.page.evaluate((text) => {
        window.wetware.write("days/2026-11-05.md", window.wetware.read("days/2026-11-05.md").replace("mood: 4\n", "mood: 4\nmood: 5\n"));
        window.wetware.failRead("days/2026-11-06.md", "stream did not contain valid UTF-8");
        window.wetware.write("days/2026-11-10.md", text);
        window.wetware.failWrite("days/2026-11-10.md", "2026-11-10.md is read-only, so it was not changed");
      }, tenth);
      const fifth = await t.file("days/2026-11-05.md");
      await t.page.click(".month .action");
      await t.told("left as it is");
      const line = 1 + fifth.split("\n").indexOf("mood: 5");
      const said =
        `Sync: nothing new. days/2026-11-05.md left as it is: Frontmatter: Invalid YAML: Map keys must be unique (line ${line}). ` +
        "days/2026-11-06.md left as it is: stream did not contain valid UTF-8. " +
        "days/2026-11-10.md is read-only, so it was left as it is. Unlock it in Finder (Get Info), then sync again.";
      assert.equal(await t.problem(), said);
      // The line is cut short on screen; all of it is in its tooltip.
      assert.equal(await t.page.$eval(".notice", (el) => el.title), said);
      assert.equal(await t.file("days/2026-11-05.md"), fifth);
      assert.equal(await t.file("days/2026-11-10.md"), tenth);
      await t.shot();

      // Unlocked, the read-only file is written by the next sync, and the message no longer names it.
      await t.page.evaluate(() => window.wetware.failWrite("days/2026-11-10.md", null));
      await t.page.click(".month .action");
      await t.told("Sync: 1 day updated.");
      assert.doesNotMatch(await t.problem(), /2026-11-10/);
      assert.match(await t.file("days/2026-11-10.md"), /^weather_high_f: 41$/m);
    },
  },
  {
    name: "settings-connection",
    about: "Settings tests the connection and lists the activity types found, so Lift and Climb can be set up",
    query: "sync=fixture&key=stored",
    async run(t) {
      await t.told("Sync: 24 days updated.");
      await t.nav("Settings");
      await t.page.waitForSelector('input[aria-label="intervals.icu API key"]');
      // Before any test: what isn't set up, and the Strava hint from the sync that just ran.
      assert.equal(await t.row("Not set up"), "Lift and Climb");
      assert.match(await t.rowNote("Not set up"), /No activity types yet, so sync leaves them alone\. In habits\.yaml, list the types that count under source_rule \/ activity_types\./);
      assert.equal(await t.row("Strava"), "2 activities can't be read");
      assert.match(await t.rowNote("Strava"), /Is your device connected to intervals\.icu directly, not through Strava\?$/);
      assert.equal(await t.row("Connection"), null);

      // From the keyboard: the key field, past Save (nothing to save), to Test connection.
      await t.page.focus('input[aria-label="intervals.icu API key"]');
      await t.page.keyboard.press("Tab");
      assert.equal(await t.page.evaluate(() => document.activeElement.textContent), "Test connection");
      await t.page.keyboard.press("Enter");
      await t.page.waitForFunction(() => [...document.querySelectorAll(".row")].some((row) => row.firstElementChild.textContent === "Activity types"));
      assert.equal(await t.row("Connection"), "Connected");
      assert.equal(await t.row("Activity types"), "Run 12, WeightTraining 5, RockClimbing 2, Walk 1");
      assert.match(await t.rowNote("Activity types"), /in the last 90 days\.$/);
      assert.equal(await t.row("Strava"), "2 activities can't be read");
      assert.equal((await t.fetches()).at(-1), "activities 2026-08-19 2026-11-17");
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      await t.shot();

      // If intervals.icu wrote its dates another way, the types are still listed, and the count says something is wrong.
      assert.equal(await t.row("Unreadable"), null);
      await t.page.evaluate(() => window.wetware.oddStarts(true));
      await t.action("Test connection");
      await t.page.waitForFunction(() => [...document.querySelectorAll(".row")].some((row) => row.firstElementChild.textContent === "Unreadable"));
      assert.equal(await t.row("Activity types"), "Run 12, WeightTraining 5, RockClimbing 2, Walk 1");
      assert.equal(await t.row("Unreadable"), "20 records can't be read");
      assert.equal(await t.row("Connection"), "Connected");
      await t.shot("settings-unreadable");
      // And a sync says how many it left out, rather than "nothing new" and no more.
      await t.nav("Month");
      await t.ready();
      await t.page.click(".month .action");
      await t.told("could not be read");
      assert.match(await t.problem(), /20 records from intervals\.icu could not be read and were left out\.$/);
      await t.page.evaluate(() => window.wetware.oddStarts(false));
      await t.nav("Settings");
      await t.page.waitForSelector('input[aria-label="intervals.icu API key"]');
      assert.equal(await t.row("Unreadable"), "20 records can't be read"); // from the sync that just ran
      await t.action("Test connection");
      await t.page.waitForFunction(() => ![...document.querySelectorAll(".row")].some((row) => row.firstElementChild.textContent === "Unreadable"));

      // A key that is saved goes to the shell and is nowhere in the page, the data folder or the sync record after.
      const secret = "preview-key-9f3a";
      await t.page.type('input[aria-label="intervals.icu API key"]', secret);
      await t.action("Save");
      await t.page.waitForFunction(() => document.querySelector('input[aria-label="intervals.icu API key"]').value === "");
      const kept = await t.page.evaluate(() => ({
        page: document.documentElement.outerHTML + [...document.querySelectorAll("input")].map((input) => input.value).join("\n"),
        files: window.wetware.paths().map((path) => window.wetware.read(path)).join("\n"),
        record: JSON.stringify(window.wetware.syncState()),
        storage: JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]),
      }));
      for (const [where, text] of Object.entries(kept)) assert.ok(!text.includes(secret), `the key is in the ${where}`);
      // What the test found was about the old key: it is cleared.
      assert.equal(await t.row("Connection"), null);
      assert.equal(await t.row("Activity types"), null);
    },
  },
  {
    name: "day",
    about: "a day opened from the grid: every value with its source, what was logged, the user's own keys, the notes",
    async run(t) {
      const before = await t.folder();
      await t.openDay(10);
      assert.equal(await t.text(".day h1"), "November 10");
      assert.deepEqual(await t.page.$$eval(".day .meta-row > *", (els) => els.slice(0, 3).map((el) => el.textContent)), [
        "Tuesday", "62° / 50° F, fog", "days/2026-11-10.md",
      ]);
      // One row for each habit on show, with the value the grid shows and where it came from.
      assert.equal(await t.count(".day .row[data-habit]"), 11);
      assert.equal(await t.count('.day .row[data-habit="floss"]'), 0);
      const row = async (habit) => {
        const { value, source } = await t.dayRow(habit);
        return `${value} ${source}`.trim();
      };
      assert.equal(await row("weight"), "171.6 manual");
      assert.equal(await row("run"), "true intervals");
      assert.equal(await row("lift"), "false intervals");
      assert.equal(await row("sleep"), "6.4 intervals");
      assert.equal(await row("morning_pages"), "420 unrecorded");
      assert.equal(await row("meditate"), "true manual");
      assert.equal(await row("brain_fog"), "4 manual");
      assert.equal(await row("stretch"), "");
      assert.equal(await row("travel"), "false");
      assert.equal((await t.dayRow("run")).mark, "mark-x");
      assert.equal((await t.dayRow("lift")).mark, null);
      // Nothing here was set by hand over a synced value, so nothing offers to hand it back.
      assert.equal(await t.count(".day .row .action"), 0);
      assert.deepEqual(await t.dayTable("Also logged"), [
        "HRV: 55 ms | unrecorded", "Resting heart rate: 51 bpm | unrecorded", "Sleep score: 80 | unrecorded",
        "High: 62 °F | open-meteo", "Low: 50 °F | open-meteo", "Conditions: fog | open-meteo",
      ]);
      // The keys the user added by hand are there to see.
      assert.deepEqual(await t.dayTable("Other properties"), [
        "caffeine_mg: 180", "obsidian_alias: Tuesday: long one", "_synced_at: 2026-11-11T06:20:00-08:00",
      ]);
      assert.equal(await t.page.$eval(".day-notes", (el) => el.value), "Slept badly. Two coffees before ten.\n");
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");

      // Drawn: the ✕ of the run in its box, an empty box for the lift, and the two columns side by side.
      await t.page.mouse.move(2, 2);
      const px = await pixels(t.page);
      const boxes = await t.page.evaluate(() => {
        const box = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, width: r.width, height: r.height };
        };
        return { run: box('.day .row[data-habit="run"] .day-box'), lift: box('.day .row[data-habit="lift"] .day-box'), habits: box('.day .table[aria-label="Habits"]'), notes: box(".day-notes") };
      });
      assert.ok(px.darkest(boxes.run.cx, boxes.run.cy) < INK, "the run's box has no ✕");
      assert.ok(px.darkest(boxes.lift.cx, boxes.lift.cy) > PAPER, "the lift's box is not empty");
      assert.ok(px.darkest(boxes.lift.left + 0.5, boxes.lift.cy) < INK, "the lift's box has no outline");
      assert.ok(boxes.run.width >= 16 && Math.abs(boxes.run.width - boxes.run.height) < 0.5, `a box is ${boxes.run.width} by ${boxes.run.height}px`);
      // Every habit's row is the same height, box or number, and each box sits level with its habit's name.
      const rowHeights = await t.page.$$eval(".day .row[data-habit]", (rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)));
      assert.ok(Math.max(...rowHeights) - Math.min(...rowHeights) <= 1, `habit rows are ${Math.min(...rowHeights)} to ${Math.max(...rowHeights)}px tall`);
      const level = await t.page.$$eval(".day .row[data-habit]", (rows) =>
        rows.filter((row) => row.querySelector(".day-box")).map((row) => {
          const name = row.children[0].getBoundingClientRect();
          const box = row.querySelector(".day-box").getBoundingClientRect();
          return Math.abs((name.top + name.bottom) / 2 - (box.top + box.bottom) / 2);
        }),
      );
      assert.ok(Math.max(...level) <= 2, `a box is ${Math.max(...level)}px off the line of its habit's name`);
      assert.ok(boxes.notes.left > boxes.habits.right && Math.abs(boxes.notes.top - boxes.habits.top) < 40, "the notes are not beside the habits");
      assert.ok(boxes.notes.height >= 200, `the notes field is ${boxes.notes.height}px tall`);
      await t.shot();

      // Opening a day and going back writes nothing, and the keyboard is on that day's header.
      await t.page.click(".day .month-nav button:nth-child(2)");
      await t.ready();
      assert.equal(await t.focused(), "day 2026-11-10");
      assert.deepEqual(await t.folder(), before);
      assert.equal(await t.writes(), 0);

      // A day that hasn't come can't be opened, from the grid or from the day before it.
      assert.equal(await t.page.$eval('.grid-day-button[data-date="2026-11-20"]', (el) => el.getAttribute("aria-disabled")), "true");
      await t.page.click('.grid-day-button[data-date="2026-11-20"]');
      assert.equal(await t.count(".day"), 0);
      await t.openDay(17);
      const next = ".day .month-nav button:nth-child(3)";
      assert.equal(await t.page.$eval(next, (el) => `${el.textContent} ${el.getAttribute("aria-disabled")}`), "Nov 18 → true");
      await t.page.click(next);
      assert.equal(await t.text(".day h1"), "November 17");
      // The day before, and the one before that, without going back to the grid. A day with no file is an empty day.
      await t.page.click(".day .month-nav button:first-child");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 16");
      assert.equal(await t.page.$eval(next, (el) => el.getAttribute("aria-disabled")), null);
      await t.page.click(next);
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 17");
      for (let i = 0; i < 8; i++) await t.page.click(".day .month-nav button:first-child");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 9");
      await t.page.waitForSelector(".day .table");
      assert.equal(await row("meditate"), "false");
      assert.equal(await row("run"), "false no data");
      assert.equal((await t.dayRow("run")).mark, "mark-none");
      assert.equal(await t.dayTable("Also logged"), null);
      assert.equal(await t.dayTable("Other properties"), null);
      assert.equal(await t.page.$eval(".day-notes", (el) => el.value), "");
      // Lift and Climb as seeded name no activity types, so sync has no part in them: ticking one by hand
      // offers nothing to hand back. A day before the range a sync covers offers nothing either.
      await t.page.click(t.dayBox("lift"));
      await t.saved();
      assert.deepEqual(await t.dayRow("lift"), { value: true, mark: "mark-x", source: "manual", action: null, note: null, state: "done" });
      // Back from there: the grid opens with the keyboard on the 9th.
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.focused(), "day 2026-11-09");

      // From another month, the grid comes back to that month. The navigation's "Month" goes back too.
      await t.page.click(".month-nav button:first-child");
      await t.ready();
      await t.openDay(30);
      assert.equal(await t.text(".day h1"), "October 30");
      await t.nav("Month");
      await t.ready();
      assert.equal(await t.text("h1"), "October");
      assert.equal(await t.focused(), "day 2026-10-30");

      // A day outside what a sync covers (it starts at October 25): a synced habit set by hand has nothing to hand back to.
      await t.openDay(20);
      await t.dayType("sleep", "6.5");
      await t.saved();
      assert.deepEqual(await t.dayRow("sleep"), { value: "6.5", mark: null, source: "manual", action: null, note: null, state: "done" });
      await t.page.keyboard.press("Escape");
      await t.ready();

      // Coming back from a day is where the grid opens once. After that it opens where it always does:
      // another month and then another screen and back is this month, not the one the day was in.
      assert.equal(await t.focused(), "day 2026-10-20");
      await t.page.click(".month-nav button:last-child");
      await t.ready();
      assert.equal(await t.text("h1"), "November");
      await t.nav("Settings");
      await t.page.waitForSelector('input[aria-label="Latitude"]');
      await t.nav("Month");
      await t.ready();
      assert.equal(await t.text("h1"), "November");
      assert.doesNotMatch(await t.focused(), /^day /);
      // And straight to another screen and back, without changing month first.
      await t.openDay(3);
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.focused(), "day 2026-11-03");
      await t.nav("Settings");
      await t.page.waitForSelector('input[aria-label="Latitude"]');
      await t.nav("Month");
      await t.ready();
      assert.doesNotMatch(await t.focused(), /^day /);
      await t.page.keyboard.press("Tab");
      for (let i = 0; i < 5; i++) await t.page.keyboard.press("Tab");
      assert.equal(await t.focused(), "weight 2026-11-17");
    },
  },
  {
    name: "day-960",
    about: "a day at the minimum window size",
    size: SMALL,
    async run(t) {
      await t.openDay(10);
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      const overflow = await t.page.$$eval(".day .row", (rows) => rows.filter((row) => row.scrollWidth > row.clientWidth + 1).map((row) => row.textContent));
      assert.deepEqual(overflow, [], "a row runs past its table");
      await t.shot();
    },
  },
  {
    name: "day-edit",
    about: "every kind of habit edited in the day view: the file changes in those lines and no others",
    async run(t) {
      const before = await t.file("days/2026-11-10.md");
      await t.openDay(10);
      await t.dayType("weight", "170.2"); // number
      await t.page.click(t.dayBox("run")); // check, synced: un-ticked by hand
      await t.dayType("sleep", "5"); // number, synced
      await t.dayType("morning_pages", "800"); // progress
      await t.page.click(t.dayBox("meditate")); // check
      await t.dayType("brain_fog", "3"); // scale
      await t.dayType("stretch", "25"); // duration, no value before
      await t.page.click(t.dayBox("travel")); // tag
      await t.dayType("mood", ""); // cleared
      await t.saved();
      assert.equal(
        await t.file("days/2026-11-10.md"),
        before
          .replace("run: true\n", "run: false\n")
          .replace("sleep_h: 6.4\n", "sleep_h: 5\n")
          .replace("weight_lb: 171.6\n", "weight_lb: 170.2\n")
          .replace("morning_pages_words: 420\n", "morning_pages_words: 800\n")
          .replace("meditate: true\n", "meditate: false\n")
          .replace("brain_fog: 4\n", "brain_fog: 3\n")
          .replace("mood: 2\n", "mood: null\n")
          .replace("weather_condition: fog\n", "weather_condition: fog\nstretch_min: 25\ntags: [travel]\n")
          .replace("  run: intervals\n", "  run: manual\n")
          .replace("  sleep_h: intervals\n", "  sleep_h: manual\n")
          .replace("  weather_condition: open-meteo\n", "  weather_condition: open-meteo\n  morning_pages_words: manual\n  stretch_min: manual\n"),
      );
      // The view shows what the file now says, and offers to hand the two synced values back.
      const row = async (habit) => {
        const { value, source, action } = await t.dayRow(habit);
        return `${value} ${source}${action ? ` [${action}]` : ""}`.trim();
      };
      assert.equal(await row("weight"), "170.2 manual");
      assert.equal(await row("run"), "false manual [Use synced value]");
      assert.equal(await row("sleep"), "5 manual [Use synced value]");
      assert.equal(await row("morning_pages"), "800 manual");
      assert.equal(await row("meditate"), "false manual");
      assert.equal(await row("stretch"), "25 manual");
      assert.equal(await row("travel"), "true manual");
      assert.equal(await row("mood"), "manual");
      assert.equal(await t.problem(), null);
      await t.shot();

      // What a type doesn't take is turned down and explained, as in the grid, and the field goes back.
      const saved = await t.file("days/2026-11-10.md");
      await t.dayType("mood", "9");
      assert.equal(await t.problem(), 'Mood takes a whole number from 1 to 5. "9" was not saved for November 10.');
      await t.dayType("weight", "heavy");
      assert.equal(await t.problem(), 'Weight takes a number. "heavy" was not saved for November 10.');
      assert.equal(await t.page.$eval(t.dayInput("weight"), (el) => el.value), "170.2");
      assert.equal(await t.page.$eval(t.dayInput("mood"), (el) => el.value), "");
      await t.saved();
      assert.equal(await t.file("days/2026-11-10.md"), saved);
      // A value that is then accepted clears its message.
      await t.dayType("mood", "4");
      await t.saved();
      await t.page.click(".notice-dismiss");
      assert.equal(await t.problem(), null);

      // A save that fails says so, and the view goes back to what the file holds.
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.click(t.dayBox("meditate"));
      await t.told("Meditate on November 10 was not saved. No space left on device (os error 28)");
      await t.saved();
      assert.equal((await t.dayRow("meditate")).value, false);
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.click(t.dayBox("meditate"));
      await t.saved();
      assert.equal((await t.dayRow("meditate")).value, true);
      assert.equal(await t.problem(), null);

      // Back in the month, the grid shows the same.
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.cellText("weight", 10), "170.2");
      assert.equal(await t.state("run", 10), "missed");
      assert.equal(await t.state("travel", 10), "done");
      assert.equal(await t.cellText("sleep", 10), "5");
    },
  },
  {
    name: "day-notes",
    about: "notes save as they are written and touch nothing but the body; a day that is only looked at is not written",
    async run(t) {
      const path = "days/2026-11-10.md";
      const before = await t.file(path);
      const frontmatter = (text) => text.slice(0, text.indexOf("\n---\n") + 5);
      const notes = () => t.page.$eval(".day-notes", (el) => el.value);
      const caretToEnd = () => t.page.$eval(".day-notes", (el) => (el.focus(), el.setSelectionRange(el.value.length, el.value.length)));
      assert.equal(await t.count(".grid-notes"), 4);

      // Typing stops, and a moment later it is in the file. The frontmatter is the same bytes as before.
      await t.openDay(10);
      await caretToEnd();
      await t.page.keyboard.type("Third coffee at two.\n");
      assert.equal(await t.file(path), before, "saved on the keystroke");
      await t.page.waitForFunction((p, text) => window.wetware.read(p) !== text, {}, path, before);
      assert.equal(await t.file(path), `${before}Third coffee at two.\n`);
      assert.equal(frontmatter(await t.file(path)), frontmatter(before));
      // Leaving the field saves at once.
      await t.page.keyboard.type("- [ ] buy *decaf*\n");
      await t.page.keyboard.down("Shift");
      await t.page.keyboard.press("Tab");
      await t.page.keyboard.up("Shift");
      await t.saved();
      assert.equal(await t.file(path), `${before}Third coffee at two.\n- [ ] buy *decaf*\n`);
      // Markdown stays as typed: it is text in a field, not a rendering.
      assert.equal(await notes(), "Slept badly. Two coffees before ten.\nThird coffee at two.\n- [ ] buy *decaf*\n");
      assert.equal(await t.count(".day-notes *"), 0);
      await t.shot();

      // Saving a value doesn't touch the notes, typed or saved.
      await caretToEnd();
      await t.page.keyboard.type("Unsaved so far.");
      await t.page.click(t.dayBox("travel"));
      await t.saved();
      const body = (text) => text.slice(text.indexOf("\n---\n") + 5);
      assert.equal(body(await t.file(path)), `\nSlept badly. Two coffees before ten.\nThird coffee at two.\n- [ ] buy *decaf*\nUnsaved so far.`);
      assert.match(await t.file(path), /^tags: \[travel\]$/m);
      assert.equal(await notes(), "Slept badly. Two coffees before ten.\nThird coffee at two.\n- [ ] buy *decaf*\nUnsaved so far.");

      // Escape from the notes goes back to the month and saves what was typed on the way out.
      await caretToEnd();
      await t.page.keyboard.type(" Now saved.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.saved();
      assert.ok((await t.file(path)).endsWith("Unsaved so far. Now saved."));
      assert.equal(frontmatter(await t.file(path)), frontmatter(before).replace("_sources:\n", "tags: [travel]\n_sources:\n"));
      assert.equal(await t.focused(), "day 2026-11-10");

      // A day with no file: looking at it makes none. A first note makes one, and the grid marks the day.
      const paths = await t.paths();
      const written = await t.writes();
      await t.openDay(9);
      await t.page.focus(".day-notes");
      await t.page.keyboard.press("Tab");
      await t.page.click(".day .month-nav button:nth-child(2)");
      await t.ready();
      assert.deepEqual(await t.paths(), paths);
      assert.equal(await t.writes(), written);
      // Escape straight from the typing, on a slow disk: the grid that comes back waits for the file being made.
      await t.openDay(9);
      await t.page.evaluate(() => window.wetware.slowWrite("days/2026-11-09.md", 300));
      await t.page.focus(".day-notes");
      await t.page.keyboard.type("Rest day.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.file("days/2026-11-09.md"), "---\ndate: 2026-11-09\n---\n\nRest day.");
      assert.equal(await t.count(".grid-notes"), 5);
      await t.page.evaluate(() => window.wetware.slowWrite("days/2026-11-09.md", null));
      assert.equal(await t.page.$eval('.grid-day-button[data-date="2026-11-09"]', (el) => el.getAttribute("aria-label")), "Monday, November 9, 2026, has notes");
      // Notes taken out again: the mark goes, and the file keeps its frontmatter.
      await t.openDay(9);
      await t.page.$eval(".day-notes", (el) => (el.focus(), el.select()));
      await t.page.keyboard.press("Backspace");
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.saved();
      assert.equal(await t.file("days/2026-11-09.md"), "---\ndate: 2026-11-09\n---\n");
      assert.equal(await t.count(".grid-notes"), 4);

      // A file with no date key, a comment and spacing of its own: notes are written under it, and it is not tidied.
      const plain = "---\n# kept by hand\nmood:   3\ncaffeine_mg: 90\n---\nOld note.\n";
      await t.page.evaluate((text) => window.wetware.write("days/2026-11-06.md", text), plain);
      await t.reload();
      await t.openDay(6);
      assert.equal(await notes(), "Old note.\n");
      await caretToEnd();
      await t.page.keyboard.type("New note.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.file("days/2026-11-06.md"), "---\n# kept by hand\nmood:   3\ncaffeine_mg: 90\n---\nOld note.\nNew note.");

      // A file that is only text, and notes typed above it that would read as frontmatter: they stay notes.
      // The file is given a frontmatter of its own first, and no habit is ticked by what was typed.
      await t.page.evaluate(() => window.wetware.write("days/2026-11-02.md", "Plain note made in Obsidian.\n"));
      await t.reload();
      await t.openDay(2);
      assert.equal(await notes(), "Plain note made in Obsidian.\n");
      await t.page.$eval(".day-notes", (el) => (el.focus(), el.setSelectionRange(0, 0)));
      await t.page.keyboard.type("---\nrun: true\nmood: 5\n---\n");
      await t.page.waitForFunction(() => window.wetware.read("days/2026-11-02.md").includes("mood: 5"));
      await t.saved();
      assert.equal(await t.file("days/2026-11-02.md"), "---\ndate: 2026-11-02\n---\n---\nrun: true\nmood: 5\n---\nPlain note made in Obsidian.\n");
      assert.equal(await t.count(".day-notes"), 1, "the day stopped being editable");
      assert.equal(await notes(), "---\nrun: true\nmood: 5\n---\nPlain note made in Obsidian.\n");
      assert.equal((await t.dayRow("run")).value, false);
      assert.equal((await t.dayRow("mood")).value, "");
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.count(".grid-flag"), 0);

      // Notes that can't be saved: said, kept in the field, and saved by the next try.
      await t.openDay(16);
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.focus(".day-notes");
      await t.page.keyboard.type("Long run.");
      await t.told("The notes for November 16 were not saved. No space left on device (os error 28)");
      assert.equal(await notes(), "Long run.");
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.keyboard.type(" Felt good.");
      await t.page.waitForFunction(() => window.wetware.read("days/2026-11-16.md").endsWith("\nLong run. Felt good."));
      assert.equal(await t.problem(), null);
      // And if there is no next keystroke, leaving the day tries again.
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.keyboard.type(" Twice.");
      await t.told("The notes for November 16 were not saved.");
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.ok((await t.file("days/2026-11-16.md")).endsWith("Long run. Felt good. Twice."), "the notes were not saved on leaving");
      assert.equal(await t.problem(), null);

      // Typing that never pauses is not put off for ever: a key every 150 ms for four seconds, and some of it is
      // on disk before the typing stops.
      await t.openDay(16);
      await t.notesEnd();
      const saves = await t.writes();
      await t.page.keyboard.type(" abcdefghijklmnopqrstuvwxyz", { delay: 150 });
      assert.equal(await t.writes(), saves + 1, "nothing was saved while the typing went on");
      assert.match(await t.file("days/2026-11-16.md"), /Twice\. [a-z]{10,25}$/);
      // The window going to the back saves the rest at once. So does hiding it, and asking it to close.
      const tail = async (text) => (await t.file("days/2026-11-16.md")).endsWith(text);
      await t.windowEvent("blur");
      await t.saved();
      assert.ok(await tail("uvwxyz"), "not saved when the window lost focus");
      await t.page.keyboard.type("1");
      await t.windowEvent("pagehide");
      await t.saved();
      assert.ok(await tail("xyz1"), "not saved when the page was hidden away");
      await t.page.keyboard.type("2");
      await t.windowEvent("beforeunload");
      await t.saved();
      assert.ok(await tail("xyz12"), "not saved when the window was asked to close");
      await t.page.keyboard.type("3");
      await t.page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        delete document.visibilityState;
      });
      await t.saved();
      assert.ok(await tail("xyz123"), "not saved when the window was hidden");
    },
  },
  {
    name: "day-outside",
    about: "a day file changed in another app while open: taken in when nothing is typed here, asked about when something is, never written over unseen",
    async run(t) {
      const path = "days/2026-11-10.md";
      const original = await t.file(path);
      const outside = (text) => t.page.evaluate((p, body) => window.wetware.write(p, body), path, text);
      const reads = () => t.page.evaluate(() => window.wetware.calls().filter((call) => call === "data_read").length);
      /** The app comes back to the front, reads the open day again, and has taken in what it read. */
      const front = async () => {
        const before = await reads();
        await t.windowEvent("focus");
        await t.page.waitForFunction((n) => window.wetware.calls().filter((call) => call === "data_read").length > n, {}, before);
        await t.saved();
      };
      const question = () => t.dayTable("Notes");
      const ASKED = "The notes for November 10 were changed outside Wetware while they were open here. What is typed here has not been saved. Beside the notes, choose whether to keep it or take the file's text.";
      const HELD = "The notes for November 10 are not saved: they were changed outside Wetware. Before leaving this day, choose beside the notes whether to keep what is typed here or take the file's text.";

      // Changed outside with nothing typed here: the field takes the new text, and nothing is said or written.
      await t.openDay(10);
      const second = `${original}Second line from Obsidian.\n`;
      await outside(second);
      await front();
      assert.equal(await t.notes(), "Slept badly. Two coffees before ten.\nSecond line from Obsidian.\n");
      assert.equal(await t.problem(), null);
      assert.deepEqual(await question(), []);
      assert.equal(await t.writes(), 0);

      // Changed outside in the frontmatter only: the values follow, a new key is listed, and there is nothing to ask.
      const values = second.replace("mood: 2\n", "mood: 5\nadded_outside: yes\n");
      await outside(values);
      await front();
      assert.equal((await t.dayRow("mood")).value, "5");
      assert.ok((await t.dayTable("Other properties")).includes("added_outside: yes"));
      assert.deepEqual(await question(), []);
      // Notes typed after that are saved as usual, under the frontmatter as the other app left it.
      await t.notesEnd();
      await t.page.keyboard.type("Typed in Wetware.\n");
      await t.page.waitForFunction((p, text) => window.wetware.read(p) !== text, {}, path, values);
      const third = `${values}Typed in Wetware.\n`;
      assert.equal(await t.file(path), third);
      assert.equal(await t.problem(), null);
      // The same with the frontmatter changed and not yet seen: a value set here lands beside it, key by key.
      await outside(third.replace("mood: 5\n", "mood: 1\n"));
      await t.page.click(t.dayBox("travel"));
      await t.saved();
      assert.equal(await t.file(path), third.replace("mood: 5\n", "mood: 1\n").replace("_sources:\n", "tags: [travel]\n_sources:\n"));
      assert.equal((await t.dayRow("mood")).value, "1");
      assert.deepEqual(await question(), []);

      // Changed outside and not yet seen, and then typed over here: nothing is written, the typing stays, and the app asks.
      const fourth = `${await t.file(path)}Fourth line, from Obsidian.\n`;
      await outside(fourth);
      const written = await t.writes();
      await t.notesEnd();
      await t.page.keyboard.type("Typed after.");
      await t.told("were changed outside Wetware");
      assert.equal(await t.problem(), ASKED);
      assert.equal(await t.file(path), fourth);
      assert.ok((await t.notes()).endsWith("Typed in Wetware.\nTyped after."));
      assert.deepEqual(await question(), [
        "Changed outside: Keep what is typed here | Take the file's text | The file's notes were changed while these were open. Nothing is saved until one is chosen. Keeping writes this text over the file's; taking puts the file's text here in its place.",
      ]);
      await t.shot();
      // Typing on, leaving the field, the window going to the back: still nothing is written.
      await t.page.keyboard.type(" And more.");
      await t.windowEvent("blur");
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1100)));
      assert.equal(await t.file(path), fourth);
      assert.equal(await t.writes(), written);

      // Nor is a save so much as tried while the question is open: the file is not read, and the question is not put again.
      await t.page.click(".notice-dismiss");
      const read = await reads();
      await t.page.focus(".day-notes");
      await t.page.keyboard.type(" x");
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1100)));
      assert.equal(await reads(), read, "a save was tried while the question was open");
      assert.equal(await t.problem(), null);
      assert.equal((await question()).length, 1);

      // The day can't be left while that stands, by any road, and each try says why.
      await t.page.keyboard.press("Escape");
      assert.equal(await t.text(".day h1"), "November 10");
      assert.equal(await t.problem(), HELD);
      assert.equal(await t.focusedLabel(), "Keep what is typed here");
      for (const way of [".day .month-nav button:nth-child(2)", ".day .month-nav button:first-child", ".day .month-nav button:nth-child(3)"]) {
        await t.page.click(".notice-dismiss");
        await t.page.click(way);
        assert.equal(await t.text(".day h1"), "November 10");
        assert.equal(await t.problem(), HELD);
      }
      await t.nav("Settings");
      assert.equal(await t.count(".day"), 1);
      assert.equal(await t.text(".day h1"), "November 10");
      assert.ok((await t.notes()).endsWith("Typed after. And more. x"));

      // "Take the file's text", from the keyboard: the field holds what the file holds, and nothing was written.
      await t.page.focus('.day .table[aria-label="Notes"] .action');
      await t.page.keyboard.press("Tab");
      assert.equal(await t.focusedLabel(), "Take the file's text");
      await t.page.keyboard.press("Enter");
      assert.equal(await t.notes(), "Slept badly. Two coffees before ten.\nSecond line from Obsidian.\nTyped in Wetware.\nFourth line, from Obsidian.\n");
      assert.equal(await t.problem(), null);
      assert.deepEqual(await question(), []);
      assert.equal(await t.file(path), fourth);
      assert.equal(await t.writes(), written);
      // And now the day can be left.
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.focused(), "day 2026-11-10");
      assert.equal(await t.file(path), fourth);

      // The other choice. Asked the same way, "Keep what is typed here" writes it over the file's text.
      await t.openDay(10);
      const fifth = `${fourth}Fifth line, from Obsidian.\n`;
      await outside(fifth);
      await t.notesEnd();
      await t.page.keyboard.type("Mine.");
      await t.told("were changed outside Wetware");
      assert.equal(await t.file(path), fifth);
      await t.page.click('.day .table[aria-label="Notes"] .action');
      await t.page.waitForFunction((p, text) => window.wetware.read(p) !== text, {}, path, fifth);
      assert.equal(await t.file(path), `${fourth}Mine.`);
      assert.equal(await t.problem(), null);
      assert.deepEqual(await question(), []);
      // From there on it saves as usual.
      await t.notesEnd();
      await t.page.keyboard.type(" And more.");
      await t.page.waitForFunction((p) => window.wetware.read(p).endsWith("Mine. And more."), {}, path);

      // Seen on coming back to the window, with typing here not yet saved: asked at once, before any save is tried.
      const sixth = `${await t.file(path)}\nSixth, from Obsidian.\n`;
      await t.page.keyboard.type(" Unsaved.");
      await outside(sixth);
      await front();
      assert.equal(await t.problem(), ASKED);
      assert.equal((await question()).length, 1);
      assert.equal(await t.file(path), sixth);
      assert.ok((await t.notes()).endsWith("Mine. And more. Unsaved."), "the file's text replaced what was typed");
      // If the file goes back to what it was, there is nothing left to ask, and the typing is saved.
      await outside(sixth.replace("\nSixth, from Obsidian.\n", ""));
      await front();
      assert.deepEqual(await question(), []);
      await t.page.waitForFunction((p) => window.wetware.read(p).endsWith("Mine. And more. Unsaved."), {}, path);
      assert.equal(await t.problem(), null);

      // A value set while the day is being read again is not undone by that reading, even for a moment.
      await t.page.evaluate((p) => {
        window.wetware.slowRead(p, 300);
        window.wetware.slowWrite(p, 900);
      }, path);
      assert.equal((await t.dayRow("meditate")).value, true);
      await t.windowEvent("focus");
      await t.page.click(t.dayBox("meditate"));
      assert.equal((await t.dayRow("meditate")).value, false);
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
      assert.match(await t.file(path), /^meditate: true$/m, "the edit had already reached the disk");
      assert.equal((await t.dayRow("meditate")).value, false, "the reading put back what was on disk before the edit");
      await t.page.waitForFunction((p) => /^meditate: false$/m.test(window.wetware.read(p)), {}, path);
      await t.saved();
      assert.equal((await t.dayRow("meditate")).value, false);
    },
  },
  ...[["day-odd", WIDE], ["day-odd-960", SMALL]].map(([name, size]) => ({
    name,
    size,
    about: "a day file with values its habits can't hold, bookkeeping out of place and a long value: all of it shown, none of it changed unasked",
    async run(t) {
      const path = "days/2026-11-12.md";
      // No spaces, hyphens or anything else a line could break at.
      const url = `https://example.com/${"averylongpathwithnowheretobreak".repeat(4)}`;
      const odd = [
        "---", "date: 2026-11-13", "weight_lb: 182 lb", 'run: "yes"', "sleep_h: 7.1", "mood: [1, 2]", "hrv: null", "sleep_score: {a: 1}",
        "resting_hr: 47", `url: ${url}`, "tags: [travel, {a: 1}, sick]", "_sources:", "  sleep_h: intervals", "  url: manual", "  run: 5",
        "_synced_at: 2026-11-13T06:00:00-08:00", "---", "", "Notes.", "",
      ].join("\n");
      assert.ok(url.length >= 120);
      await t.page.evaluate((p, text) => window.wetware.write(p, text), path, odd);
      await t.reload();
      await t.openDay(12);
      const raw = (habit) => t.page.$eval(`.day .row[data-habit="${habit}"]`, (row) => row.querySelector(".day-raw")?.textContent ?? null);

      // A habit's key holding what the habit can't: the row shows it as written and says it can't be read.
      assert.equal(await raw("weight"), "182 lb");
      const weight = await t.dayRow("weight");
      assert.equal(`${weight.value}|${weight.source}`, "|not readable");
      assert.equal(weight.note, "The file has this under weight_lb, and it is not a number. It stays as it is until a value is entered here.");
      assert.equal(await raw("run"), "yes");
      const run = await t.dayRow("run");
      // It also keeps sync off the run, as any value with no source on record does, so it can be handed back.
      assert.equal(`${run.value}|${run.source}|${run.action}`, "false|not readable|Use synced value");
      assert.match(run.note, /^The file has this under run, and it is not true or false\./);
      assert.equal(await raw("mood"), "[1, 2]");
      assert.equal(await raw("sleep"), null);
      assert.equal(await t.page.$eval(t.dayInput("weight"), (el) => el.getAttribute("aria-label")), "Weight, Thursday, November 12, 2026: not readable, the file has 182 lb");

      // What was logged is shown as the file has it, whatever its shape. What holds nothing is listed with the rest.
      assert.deepEqual(await t.dayTable("Also logged"), ["Resting heart rate: 47 bpm | unrecorded", 'Sleep score: {"a":1} | unrecorded']);
      assert.deepEqual(await t.dayTable("Other properties"), [
        "date: 2026-11-13", "hrv: null", `url: ${url}`, 'tags: [{"a":1}, sick]', "_sources.url: manual", "_sources.run: 5",
        "_synced_at: 2026-11-13T06:00:00-08:00",
      ]);
      assert.equal((await t.dayRow("travel")).value, true);

      // The long value breaks inside its table: nothing runs under the notes or off the page.
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      const fit = await t.page.evaluate(() => {
        const table = document.querySelector('.day .table[aria-label="Other properties"]').getBoundingClientRect();
        const notes = document.querySelector(".day-notes").getBoundingClientRect();
        const cells = [...document.querySelectorAll('.day .table[aria-label="Other properties"] .row > div')].map((el) => el.getBoundingClientRect());
        return { over: cells.filter((cell) => cell.right > table.right + 0.5).length, gap: notes.left - table.right, lines: Math.max(...cells.map((cell) => cell.height)) };
      });
      assert.equal(fit.over, 0, "a value runs out of its table");
      assert.ok(fit.gap > 0, "the properties run under the notes");
      assert.ok(fit.lines > 30, "the long value is still on one line");
      await t.shot();

      // Going through every field without typing changes nothing.
      const written = await t.writes();
      await t.page.focus(t.dayInput("weight"));
      for (let i = 0; i < 14; i++) await t.page.keyboard.press("Tab");
      await t.saved();
      assert.equal(await t.file(path), odd);
      assert.equal(await t.writes(), written);

      // A value entered, or a box set, takes the place of what couldn't be read. Nothing else in the file moves.
      await t.dayType("weight", "181.5");
      await t.page.click(t.dayBox("run"));
      await t.saved();
      assert.deepEqual(changed(odd, await t.file(path)), {
        added: ["weight_lb: 181.5", "run: true", "  run: manual", "  weight_lb: manual"],
        removed: ["weight_lb: 182 lb", 'run: "yes"', "  run: 5"],
      });
      assert.equal(await raw("weight"), null);
      assert.equal((await t.dayRow("weight")).source, "manual");
      assert.equal(await raw("run"), null);
      assert.equal(await raw("mood"), "[1, 2]");
    },
  })),
  {
    name: "day-synced",
    about: "a synced value changed by hand is manual, and can be handed back for the next sync to fill",
    query: "sync=fixture&key=stored",
    async run(t) {
      await t.told("Sync: 24 days updated.");
      await t.stateIs("run", 17, "done");
      await t.openDay(17);
      assert.deepEqual(await t.dayRow("sleep"), { value: "7.7", mark: null, source: "intervals", action: null, note: null, state: "done" });
      assert.deepEqual(await t.dayTable("Also logged"), [
        "HRV: 69 ms | unrecorded", "Resting heart rate: 52 bpm | unrecorded", "Sleep score: 82 | unrecorded",
        "High: 47 °F | open-meteo", "Low: 40 °F | open-meteo", "Precipitation: 0.26 in | open-meteo", "Conditions: rain | open-meteo",
      ]);
      assert.equal(await t.page.$eval(".day .meta-row > :nth-child(2)", (el) => el.textContent), "47° / 40° F, rain, 0.26 in");

      // Changed by hand: it is manual now, and sync will leave it alone. The row says how to undo that.
      const synced = await t.file(TODAY_FILE);
      await t.dayType("sleep", "5");
      await t.page.click(t.dayBox("run"));
      await t.saved();
      const manual = await t.file(TODAY_FILE);
      assert.deepEqual(changed(synced, manual), {
        added: ["sleep_h: 5", "run: false", "  sleep_h: manual", "  run: manual"],
        removed: ["sleep_h: 7.7", "run: true", "  sleep_h: intervals", "  run: intervals"],
      });
      const sleep = await t.dayRow("sleep");
      assert.equal(`${sleep.value} ${sleep.source} ${sleep.action}`, "5 manual Use synced value");
      assert.equal(sleep.note, "Set by hand, so sync leaves it alone. Use synced value clears it. The next sync then fills in what intervals.icu has for this day, and leaves it empty if it has nothing.");
      assert.equal((await t.dayRow("run")).action, "Use synced value");
      await t.shot();

      // Handed back: the key and its source entry are gone from the file, and nothing else has moved.
      await t.page.evaluate(() => [...document.querySelectorAll('.day .row[data-habit="sleep"] .action')][0].click());
      await t.saved();
      assert.deepEqual(changed(manual, await t.file(TODAY_FILE)), { added: [], removed: ["sleep_h: 5", "  sleep_h: manual"] });
      assert.deepEqual(await t.dayRow("sleep"), { value: "", mark: null, source: "", action: null, note: null, state: "pending" });
      // The run is handed back from the keyboard, which is then on the run's box and not lost.
      await t.page.focus('.day .row[data-habit="run"] .action');
      await t.page.keyboard.press("Enter");
      await t.saved();
      assert.equal(await t.page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Run, Tuesday, November 17, 2026: not filled in yet");
      assert.deepEqual(changed(manual, await t.file(TODAY_FILE)), { added: [], removed: ["sleep_h: 5", "run: false", "  sleep_h: manual", "  run: manual"] });
      assert.equal((await t.dayRow("run")).action, null);

      // The next sync fills both in again, as its own. It lands while the day is open, and the day shows it.
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.state("sleep", 17), "pending");
      await t.page.evaluate(() => window.wetware.slowFetches(400));
      await t.page.click(".month .action");
      await t.openDay(17);
      assert.equal((await t.dayRow("sleep")).value, "");
      // Except in a field that is being typed in: the sync lands under it, and what is typed stays what is shown.
      await t.page.click(t.dayInput("sleep"));
      await t.page.keyboard.type("6");
      await t.told("Sync: 1 day updated.");
      await t.page.waitForFunction((selector) => document.querySelector(selector).getAttribute("aria-pressed") === "true", {}, t.dayBox("run"));
      assert.match(await t.file(TODAY_FILE), /^sleep_h: 7\.7$/m);
      assert.equal(await t.page.$eval(t.dayInput("sleep"), (el) => el.value), "6");
      // Taken back with Escape, the field shows what the sync wrote, and the day is still open.
      await t.page.keyboard.press("Escape");
      assert.equal(await t.text(".day h1"), "November 17");
      await t.page.waitForFunction((selector) => document.querySelector(selector).value === "7.7", {}, t.dayInput("sleep"));
      const sleepAgain = await t.dayRow("sleep");
      assert.equal(`${sleepAgain.value} ${sleepAgain.source} ${sleepAgain.action}`, "7.7 intervals null");
      const runAgain = await t.dayRow("run");
      assert.equal(`${runAgain.value} ${runAgain.source} ${runAgain.action}`, "true intervals null");
      assert.deepEqual(changed(synced, await t.file(TODAY_FILE)), { added: [], removed: [] });

      // The same when the file changes under a half-typed value some other way, and the typing is then finished:
      // what was typed is what is entered, not a mix of the two.
      await t.page.$eval(t.dayInput("sleep"), (el) => (el.focus(), el.select()));
      await t.page.keyboard.type("6");
      await t.page.evaluate(() => window.wetware.write("days/2026-11-17.md", window.wetware.read("days/2026-11-17.md").replace("sleep_h: 7.7", "sleep_h: 8.1")));
      await t.windowEvent("focus");
      await t.page.waitForFunction(() => window.wetware.calls().at(-1) === "data_read");
      await t.saved();
      assert.equal(await t.page.$eval(t.dayInput("sleep"), (el) => el.value), "6");
      await t.page.keyboard.type(".5");
      await t.page.keyboard.press("Enter");
      await t.saved();
      assert.match(await t.file(TODAY_FILE), /^sleep_h: 6\.5$/m);
      assert.match(await t.file(TODAY_FILE), /^  sleep_h: manual$/m);
      assert.equal(await t.page.$eval(t.dayInput("sleep"), (el) => el.value), "6.5");
      assert.equal(await t.problem(), "Sync: 1 day updated.");

      // A value whose source is something this app doesn't know holds sync back like one set by hand, and says so.
      await t.page.evaluate(() => window.wetware.write("days/2026-11-17.md", window.wetware.read("days/2026-11-17.md").replace("  sleep_h: manual", "  sleep_h: garmin")));
      await t.windowEvent("focus");
      await t.page.waitForFunction((selector) => document.querySelector(selector).textContent === "garmin", {}, '.day .row[data-habit="sleep"] .day-source');
      const garmin = await t.dayRow("sleep");
      assert.equal(garmin.action, "Use synced value");
      assert.match(garmin.note, /^Marked as coming from garmin, so sync leaves it alone\./);
    },
  },
  {
    name: "day-error",
    about: "a day whose file can't be read or parsed: the problem and the path are shown and nothing can be changed",
    async run(t) {
      const broken = "---\ndate: 2026-11-12\nmood: 1\nmood: 2\n---\n\nnotes\n";
      await t.page.evaluate((text) => {
        window.wetware.write("days/2026-11-12.md", text);
        window.wetware.failRead("days/2026-11-05.md", "stream did not contain valid UTF-8");
      }, broken);
      await t.reload();
      const written = await t.writes();
      await t.openDay(12);
      assert.equal(await t.text(".day h1"), "November 12");
      assert.deepEqual(await t.dayTable("This day's file needs fixing by hand"), [
        "File: days/2026-11-12.md",
        "Problem: Frontmatter: Invalid YAML: Map keys must be unique (line 4). | Nothing here can be changed until the file is put right in a text editor. It has been left exactly as it is.",
      ]);
      // Nothing to type into, tick or press but the way out and the days either side.
      assert.equal(await t.count(".day input, .day textarea, .day .day-box, .day .action"), 0);
      assert.equal(await t.count(".day button"), 3);
      assert.equal(await t.page.$eval(".day .meta-row > :nth-child(2)", (el) => el.textContent), "No weather logged");
      await t.shot();
      // The day before it is as usual, and so is going back.
      await t.page.click(".day .month-nav button:first-child");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 11");
      await t.page.waitForSelector(".day .day-notes");
      assert.equal(await t.count(".day .row[data-habit]"), 11);

      // A file that can't be read at all is the same, in the shell's words.
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.openDay(5);
      assert.deepEqual((await t.dayTable("This day's file needs fixing by hand")).map((line) => line.split(" | ")[0]), [
        "File: days/2026-11-05.md",
        "Problem: The file could not be read: stream did not contain valid UTF-8.",
      ]);
      assert.equal(await t.count(".day input, .day textarea, .day .day-box"), 0);
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.focused(), "day 2026-11-05");
      assert.equal(await t.file("days/2026-11-12.md"), broken);
      assert.equal(await t.writes(), written);
    },
  },
  {
    name: "day-keys",
    about: "a day from start to finish with the keyboard alone: open, edit, write notes, the next day, and back",
    async run(t) {
      const key = (name) => t.page.keyboard.press(name);
      const focusedLabel = () => t.page.evaluate(() => document.activeElement.getAttribute("aria-label") ?? document.activeElement.textContent);
      // Into the grid, up to the day headers, along to the 16th, and Enter opens it.
      for (let i = 0; i < 6; i++) await key("Tab");
      assert.equal(await t.focused(), "weight 2026-11-17");
      await key("ArrowUp");
      await key("ArrowLeft");
      assert.equal(await t.focused(), "day 2026-11-16");
      await key("Enter");
      await t.page.waitForSelector(".day .table");
      assert.equal(await t.text(".day h1"), "November 16");
      // The keyboard is on the way back, and can be seen there.
      assert.equal(await focusedLabel(), "Month");
      await checkFocusRing(t, "Month, when a day opens", { outside: true });

      // The day before, and the one before that: two presses, since the keyboard stays on the control that was used.
      await t.tabTo("Previous day, Sunday, November 15, 2026", true);
      await key("Enter");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 15");
      assert.equal(await focusedLabel(), "Previous day, Saturday, November 14, 2026");
      await checkFocusRing(t, "Previous day, after it was used", { outside: true });
      await key("Enter");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 14");
      assert.equal(await focusedLabel(), "Previous day, Friday, November 13, 2026");
      // And forward again the same way.
      await t.tabTo("Next day, Sunday, November 15, 2026");
      await key("Enter");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 15");
      assert.equal(await focusedLabel(), "Next day, Monday, November 16, 2026");
      await key("Enter");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 16");
      await t.page.waitForSelector(".day .table");
      assert.equal(await focusedLabel(), "Next day, Tuesday, November 17, 2026");

      // Tab goes on to each value in turn. A number is typed and saved with Enter.
      await t.tabTo("Weight, Monday, November 16, 2026");
      await t.page.keyboard.type("170.1");
      await key("Enter");
      // A box is ticked or un-ticked with Space or Enter.
      await t.tabTo("Run, Monday, November 16, 2026");
      await checkFocusRing(t, "a focused box in the day view");
      await key("Space");
      await t.tabTo("Travel, Monday, November 16, 2026");
      await key("Enter");
      // On to the notes, which are written like any text.
      await t.tabTo("Notes for Monday, November 16, 2026");
      await t.page.keyboard.type("Easy day.\nLegs fine.");
      await t.saved();

      // Back up to the nav, and on to the next day without touching the grid. The notes are saved on the way.
      await t.tabTo("Next day, Tuesday, November 17, 2026", true);
      await key("Enter");
      await t.page.waitForFunction(() => document.querySelector(".day h1").textContent === "November 17");
      await t.page.waitForSelector(".day .table");
      await t.saved();
      // On the last day there is, the keyboard is still on "next", which now goes nowhere.
      assert.equal(await focusedLabel(), "Next day, Wednesday, November 18, 2026");
      assert.equal(await t.page.evaluate(() => document.activeElement.getAttribute("aria-disabled")), "true");
      const sixteenth = await t.file("days/2026-11-16.md");
      assert.match(sixteenth, /^weight_lb: 170\.1$/m);
      assert.match(sixteenth, /^run: false$/m);
      assert.match(sixteenth, /^  run: manual$/m);
      assert.match(sixteenth, /^tags: \[travel\]$/m);
      assert.ok(sixteenth.endsWith("---\n\nEasy day.\nLegs fine."), sixteenth);

      // Escape in a field that has been typed in takes the typing back. Escape again leaves the day.
      await t.tabTo("Weight, Tuesday, November 17, 2026");
      await t.page.keyboard.type("9");
      await key("Escape");
      assert.equal(await t.text(".day h1"), "November 17");
      assert.equal(await t.page.$eval(t.dayInput("weight"), (el) => el.value), "");
      await key("Escape");
      await t.ready();
      // The grid is back with the keyboard on the header of the day that was open, and arrows work from there.
      assert.equal(await t.focused(), "day 2026-11-17");
      // Today's header is black, so its ring is drawn in paper.
      const ring = await t.page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return `${style.outlineStyle} ${parseFloat(style.outlineWidth) >= 2} ${style.outlineColor}`;
      });
      assert.equal(ring, "solid true rgb(255, 255, 255)");
      await t.saved();
      assert.doesNotMatch(await t.file(TODAY_FILE), /weight_lb/);
      await key("ArrowDown");
      assert.equal(await t.focused(), "weight 2026-11-17");
      await key("ArrowLeft");
      assert.equal(await t.cellText("weight", 16), "170.1");
      assert.equal(await t.state("run", 16), "missed");
      assert.equal(await t.count(".grid-notes"), 5);
    },
  },
  {
    name: "pages",
    about: "the writing room: bare, a few words kept in pages/ with only their count in the day file, left mid-sentence and gone back to",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const before = await t.folder();
      const day = await t.file(TODAY_FILE);
      const gray = (color) => {
        const [r, g, b] = color.match(/[\d.]+/g).map(Number);
        assert.ok(r === g && g === b, `${color} is not a gray`);
        return r;
      };

      // The way in: a quiet line beside the month's name, while today's pages are short of the goal.
      assert.equal(await t.text(".pages-prompt"), "Morning pages0 / 750 words todayWrite");
      const title = await t.page.evaluate(() => {
        const box = (selector) => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        return { name: box(".month h1"), prompt: box(".pages-prompt"), grid: box(".grid"), width: window.innerWidth };
      });
      assert.ok(title.prompt.left > title.name.right && title.prompt.right <= title.width, "the line runs into the month's name or off the window");
      assert.ok(title.prompt.top >= title.name.top && title.prompt.bottom <= title.grid.top, "the line is not on the month's name's own line");
      // It is about today, and is on the month today is in: another month says nothing of anyone's pages.
      await t.page.click(".month-nav button:first-child");
      await t.ready();
      assert.equal(await t.count(".pages-prompt"), 0);
      await t.page.click(".month-nav button:nth-child(2)");
      await t.ready();
      await t.page.click(".pages-prompt .action");
      await t.page.waitForSelector(".room-field");
      await t.page.evaluate(() => document.fonts.ready);

      // Bare: no header, no message line, no navigation, no grid. What is on screen is this and nothing else.
      assert.equal(await t.count(".app, .nav, .nav-item, .notices, .notice, .meta-row, .grid, .month, .day"), 0);
      const onScreen = () => t.page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
      assert.equal(
        await onScreen(),
        "Tuesday, November 17 page 1 of 3 0 / 750 words Leave Kept in pages/2026-11-17.md and nowhere else. Only the word count goes to the day file.",
      );
      // One field for the whole text, with the keyboard in it. Spellcheck is on: it is prose.
      assert.equal(await t.count(".room textarea, .room input, .room [contenteditable]"), 1);
      assert.equal(
        await t.page.evaluate(() => `${document.activeElement.className} ${document.activeElement.spellcheck} ${document.activeElement.placeholder}`),
        "room-text room-field true Start anywhere.",
      );
      // The one thing a page can ask of the system about this field: no suggestions written for it, and nothing filled in.
      assert.equal(await t.page.$eval(".room-field", (el) => `${el.getAttribute("writingsuggestions")} ${el.getAttribute("autocomplete")}`), "false off");
      assert.deepEqual((await t.room()).marks, []);
      // Softer than the rest of the app, and still no colour: gray paper, gray ink, to the edges of the window.
      const look = await t.page.evaluate(() => {
        const style = (selector) => getComputedStyle(document.querySelector(selector));
        return { paper: style(".room").backgroundColor, behind: style("body").backgroundColor, ink: style(".room-field").color, quiet: style(".room-strip").color };
      });
      assert.ok(gray(look.paper) < 255 && gray(look.paper) > 235, `the room's paper is ${look.paper}`);
      assert.equal(look.behind, look.paper);
      assert.ok(gray(look.ink) > 0 && gray(look.ink) < 80, `the room's ink is ${look.ink}`);
      assert.ok(gray(look.quiet) > gray(look.ink));
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      await t.shot("pages-empty");

      // Looked at and left: nothing is written, and the keyboard is back on the box of the day's pages.
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.focused(), "morning_pages 2026-11-17");
      assert.equal(await t.page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(255, 255, 255)");
      assert.deepEqual(await t.folder(), before);
      assert.equal(await t.writes(), 0);

      // In again from the keyboard: Enter on that box. A few words, and a moment later they are in pages/.
      await t.page.keyboard.press("Enter");
      await t.page.waitForSelector(".room-field");
      await t.page.keyboard.type("The kettle took its time.");
      assert.equal(await t.file(PAGES), null, "saved on the keystroke");
      await t.page.waitForFunction((path) => window.wetware.read(path) !== null, {}, PAGES);
      await t.saved();
      assert.equal(await t.file(PAGES), "The kettle took its time.");
      // The day file has the count, with its source, and not a line more. Nothing else in the folder has changed.
      assert.deepEqual(changed(day, await t.file(TODAY_FILE)), { added: ["morning_pages_words: 5", "  morning_pages_words: morning_pages"], removed: [] });
      assert.deepEqual(folderDiff(before, await t.folder()), [TODAY_FILE, PAGES]);
      assert.deepEqual((await t.room()).strip, ["Tuesday, November 17", "page 1 of 3", "5 / 750 words", "Leave"]);
      assert.equal((await t.room()).said, null);
      await t.shot();

      // Escape while a character is being composed belongs to the input method: it puts the composition away, and the room stays.
      await t.page.$eval(".room-field", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
      await t.saved();
      assert.equal(await t.count(".room"), 1);
      assert.equal(await t.count(".grid"), 0);

      // Left mid-sentence, at once: nothing typed is lost, and the grid that comes back shows how far the pages have got.
      await t.page.keyboard.type(" And so");
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.saved();
      assert.equal(await t.file(PAGES), "The kettle took its time. And so");
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 7$/m);
      assert.equal(await t.state("morning_pages", 17), "done");
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 7 of 750 words");
      assert.equal(await t.text(".pages-prompt"), "Morning pages7 / 750 words todayWrite");
      assert.equal(await t.focused(), "morning_pages 2026-11-17");

      // Gone back to with a click on the box: the same text, and the caret at its end to go on from.
      await t.click("morning_pages", 17);
      await t.page.waitForSelector(".room-field");
      assert.equal((await t.room()).text, "The kettle took its time. And so");
      assert.deepEqual(await t.page.$eval(".room-field", (el) => [el.selectionStart, el.selectionEnd]), [32, 32]);
      await t.page.keyboard.type(" did I.");
      // Out by the keyboard's other way: back a stop to Leave, which shows where the keyboard is, and Enter.
      await t.page.keyboard.down("Shift");
      await t.page.keyboard.press("Tab");
      await t.page.keyboard.up("Shift");
      assert.equal(await t.focusedLabel(), "Leave the writing room");
      await checkFocusRing(t, "Leave, in the writing room", { outside: true });
      await t.page.keyboard.press("Enter");
      await t.ready();
      await t.saved();
      assert.equal(await t.file(PAGES), "The kettle took its time. And so did I.");
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 9$/m);

      // "Pages" in the navigation is today's pages as well.
      await t.openPages();
      assert.equal((await t.room()).text, "The kettle took its time. And so did I.");
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 1 of 3", "9 / 750 words"]);
      // No timer, no streak, no score: what the room says is the date, the page, the count, and where the text is kept.
      assert.doesNotMatch(await onScreen(), /streak|in a row|timer|minute|second|keep going|well done|congrat|goal met|🔥/i);
      await t.page.keyboard.press("Escape");
      await t.ready();
      // A day still to come has no pages to open.
      await t.click("morning_pages", 18);
      assert.equal(await t.count(".room"), 0);
      assert.deepEqual(folderDiff(before, await t.folder()), [TODAY_FILE, PAGES]);
    },
  },
  {
    name: "pages-760",
    about: "750 words are three pages and the habit done; ten more begin a fourth; each page is marked in the margin on the line it begins on",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const saved = (count) => t.page.waitForFunction((path, n) => (window.wetware.read(path) ?? "").split(/\s+/).filter(Boolean).length === n, {}, PAGES, count);
      /** Where the marks are, against the field: how far down, and whether they are in the margin. */
      const marks = () =>
        t.page.evaluate(() => {
          const field = document.querySelector(".room-field").getBoundingClientRect();
          return [...document.querySelectorAll(".room-mark")].map((mark) => {
            const r = mark.getBoundingClientRect();
            return { page: Number(mark.textContent), top: r.top - field.top, left: r.left, right: r.right, height: r.height, gap: field.left - r.right, x: r.left, y: r.top };
          });
        });
      const sizes = () =>
        t.page.evaluate(() => {
          const field = document.querySelector(".room-field");
          // How tall the field's text is when the field is given no height of its own to stretch to.
          field.style.height = "0";
          const natural = field.scrollHeight;
          field.style.height = "";
          return {
            field: field.getBoundingClientRect().height,
            copy: document.querySelector(".room-copy").getBoundingClientRect().height,
            inside: field.scrollHeight,
            natural,
            line: parseFloat(getComputedStyle(field).lineHeight),
            sideways: document.documentElement.scrollWidth > window.innerWidth,
            animations: document.getAnimations().length,
          };
        });

      await t.openPages();
      // 750 words, put in at once as a paste is.
      await t.insert(prose(750));
      await saved(750);
      assert.deepEqual((await t.room()).strip, ["Tuesday, November 17", "page 3 of 3", "750 / 750 words", "Leave"]);
      // Three pages: the first begins where the text does, and the second and third are marked where they begin.
      assert.deepEqual((await t.room()).marks, [2, 3]);
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 750$/m);
      // Reaching the goal changes nothing loud: nothing moves, nothing is added, nothing is said.
      assert.equal((await sizes()).animations, 0);
      assert.equal((await t.room()).said, null);
      assert.equal(await t.count(".room-head *"), 7);
      assert.equal((await t.room()).foot, "Kept in pages/2026-11-17.md and nowhere else. Only the word count goes to the day file.");

      // Ten more words: the fourth page begins, and there is no "of" any more.
      await t.insert(` ${prose(10)}`);
      await saved(760);
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 4", "760 / 750 words"]);
      assert.deepEqual((await t.room()).marks, [2, 3, 4]);
      assert.equal(await t.count(".room-head *"), 7);

      // The field is as tall as its text, with no scrolling of its own: the window scrolls, and never sideways.
      const size = await sizes();
      assert.ok(Math.abs(size.field - size.copy) < 1 && Math.abs(size.field - size.inside) < 1, `the field is ${size.field}px tall, its text ${size.inside}px, its copy ${size.copy}px`);
      // The unseen copy the marks are measured on is set as the field's own text is: the same lines, so the same height.
      assert.ok(Math.abs(size.natural - size.copy) < 1, `the field's text is ${size.natural}px tall by itself, the copy the marks are measured on ${size.copy}px`);
      assert.ok(size.field > 30 * size.line, "760 words came to fewer than 30 lines");
      assert.ok(!size.sideways, "horizontal scroll");
      // The line being written is in the window, clear of its bottom edge, and the strip is still in sight above.
      const view = await t.page.evaluate(() => {
        const field = document.querySelector(".room-field").getBoundingClientRect();
        const strip = document.querySelector(".room-strip").getBoundingClientRect();
        return { end: field.bottom, height: window.innerHeight, strip: strip.top, scrolled: window.scrollY };
      });
      assert.ok(view.scrolled > 0 && view.end < view.height - 40, `the last line is at ${view.end}px of ${view.height}px`);
      assert.ok(view.strip >= 0 && view.strip < 60, `the strip is at ${view.strip}px`);

      // Each mark is in the margin, left of the text and inside the window: a number under a hairline, both drawn in gray.
      const found = await marks();
      for (const mark of found) {
        assert.ok(mark.left >= 0 && mark.gap >= 8, `page ${mark.page}'s mark is at ${mark.left}px, ${mark.gap}px from the text`);
        assert.ok(Math.abs(mark.height - size.line) < 1, `page ${mark.page}'s mark is ${mark.height}px tall, a line is ${size.line}px`);
        // On a line of the text: a whole number of lines down.
        assert.ok(Math.abs(mark.top / size.line - Math.round(mark.top / size.line)) < 0.08, `page ${mark.page}'s mark is ${mark.top / size.line} lines down`);
      }
      assert.ok(found[0].top < found[1].top && found[1].top < found[2].top);
      await t.page.mouse.move(2, 2);
      const px = await pixels(t.page);
      const last = found[2];
      assert.ok(isGray(px.darkest(last.x + 10, last.y)), `no hairline over page 4's number (${px.darkest(last.x + 10, last.y)})`);
      assert.ok(px.darkestIn({ left: last.left, right: last.left + 12, top: last.y + 3, bottom: last.y + last.height }) < 170, "page 4's number is not drawn");
      assert.ok(px.lightest(last.x + 10, last.y - 6) > 235, "something is drawn above the hairline");
      await t.shot();

      // One word to a line, and where a page begins can be worked out without looking at how the text wraps:
      // the 251st, 501st and 751st lines. The marks are exactly there.
      await t.page.$eval(".room-field", (el) => el.select());
      await t.insert(Array.from({ length: 760 }, (_, i) => `w${i + 1}`).join("\n"));
      await saved(760);
      const column = await marks();
      assert.deepEqual(column.map((mark) => mark.page), [2, 3, 4]);
      for (const mark of column) {
        const lines = (mark.page - 1) * 250;
        assert.ok(Math.abs(mark.top - lines * size.line) < 1.5, `page ${mark.page} begins ${lines} lines down, at ${lines * size.line}px; its mark is at ${mark.top}px`);
      }
      // Blank lines at the end are part of the text, and the field is tall enough to show them.
      await t.page.$eval(".room-field", (el) => el.setSelectionRange(el.value.length, el.value.length));
      await t.insert("\n\n\n");
      const trailing = await sizes();
      assert.ok(Math.abs(trailing.field - trailing.inside) < 1 && Math.abs(trailing.field - trailing.copy) < 1, `with blank lines at its end the field is ${trailing.field}px tall, its text ${trailing.inside}px`);
      assert.ok(Math.abs(trailing.field - 763 * size.line) < 2, `763 lines came to ${trailing.field / size.line} lines`);
      for (let i = 0; i < 3; i++) await t.page.keyboard.press("Backspace");
      // Taking words out takes the marks with them.
      await t.page.$eval(".room-field", (el) => el.setSelectionRange(el.value.indexOf("\nw501"), el.value.length));
      await t.page.keyboard.press("Backspace");
      assert.deepEqual((await t.room()).marks, [2]);
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 2 of 3", "500 / 750 words"]);
      await t.page.$eval(".room-field", (el) => el.setSelectionRange(el.value.length, el.value.length));
      await t.insert(`\n${Array.from({ length: 260 }, (_, i) => `w${i + 501}`).join("\n")}`);
      await saved(760);

      // Back in the month: the box is done, with the ✕ of a goal met, it counts toward the month, and the line is gone.
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.saved();
      assert.equal(await t.state("morning_pages", 17), "done");
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 760 of 750 words, goal met");
      assert.equal(await t.page.$eval('.grid-cell[data-habit="morning_pages"][data-date="2026-11-17"] .mark', (el) => el.className), "mark mark-x");
      assert.equal(await t.countText("morning_pages"), "9/30");
      assert.equal(await t.count(".pages-prompt"), 0);
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 760$/m);
      assert.match(await t.file(TODAY_FILE), /^  morning_pages_words: morning_pages$/m);
      // The month's name has not moved for the line going.
      assert.equal(await t.text(".month h1"), "November");
    },
  },
  {
    name: "pages-960",
    about: "the writing room at the minimum window size, part-way down three pages",
    size: SMALL,
    async run(t) {
      await t.openPages();
      await t.insert(prose(760));
      await t.page.waitForFunction(() => document.querySelectorAll(".room-mark").length === 3);
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      // The window has gone down with the writing, to the last line.
      await t.page.waitForFunction(() => window.scrollY > 0);
      // Scrolled back to where the second page begins: its mark is in the window, in the margin, and the strip is still above.
      // (The keyboard is taken out of the text first: taking the screenshot would otherwise bring the caret back into view.)
      await t.page.evaluate(() => document.activeElement.blur());
      await t.page.evaluate(() => window.scrollTo(0, document.querySelector('.room-mark[data-page="2"]').getBoundingClientRect().top + window.scrollY - 200));
      const seen = await t.page.evaluate(() => {
        const mark = document.querySelector('.room-mark[data-page="2"]').getBoundingClientRect();
        const field = document.querySelector(".room-field").getBoundingClientRect();
        const strip = document.querySelector(".room-strip").getBoundingClientRect();
        const second = document.querySelector(".room-strip > :nth-child(2)").getBoundingClientRect();
        return { mark: [mark.left, mark.right, mark.top], field: [field.left, field.right], strip: [strip.top, strip.bottom], second: second.left, width: window.innerWidth, height: window.innerHeight };
      });
      assert.ok(seen.mark[2] > 100 && seen.mark[2] < seen.height - 100, `the second page's mark is at ${seen.mark[2]}px of ${seen.height}px`);
      assert.ok(seen.mark[0] >= 0 && seen.mark[1] < seen.field[0], `the mark is at ${seen.mark[0]} to ${seen.mark[1]}px; the text starts at ${seen.field[0]}px`);
      assert.ok(seen.field[1] <= seen.width, "the text runs off the window");
      assert.ok(seen.strip[0] >= 0 && seen.strip[1] < seen.mark[2], "the strip is not above the text");
      // The text hangs from the strip's grid: it starts where the strip's second column does.
      assert.ok(Math.abs(seen.field[0] - seen.second) < 1, `the text starts at ${seen.field[0]}px, the strip's second column at ${seen.second}px`);
      await t.shot();
    },
  },
  {
    name: "pages-again",
    about: "pages gone back to and gone on with; emptied again; and a day whose count was set by hand",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const before = await t.folder();
      const day = await t.file(TODAY_FILE);
      const holds = (path, text) => t.page.waitForFunction((p, body) => window.wetware.read(p) === body, {}, path, text);

      // A first sitting, left by Escape.
      await t.openPages();
      await t.page.keyboard.type("First sitting.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      await holds(PAGES, "First sitting.");
      // A second: the text is there, the writing goes on from its end, and the window going to the back saves at once.
      await t.openPages();
      assert.equal((await t.room()).text, "First sitting.");
      await t.page.keyboard.type("\nSecond sitting, after tea.");
      await t.windowEvent("blur");
      await t.saved();
      assert.equal(await t.file(PAGES), "First sitting.\nSecond sitting, after tea.");
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 6$/m);
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 1 of 3", "6 / 750 words"]);

      // Emptied: the file is empty, and the count the room wrote is taken back out. The day file is as it was
      // before any pages were written, byte for byte, and the day is one with no pages again.
      await t.page.$eval(".room-field", (el) => el.select());
      await t.page.keyboard.press("Backspace");
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 1 of 3", "0 / 750 words"]);
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.saved();
      assert.equal(await t.file(PAGES), "");
      assert.equal(await t.file(TODAY_FILE), day);
      assert.deepEqual(folderDiff(before, await t.folder()), [PAGES]);
      assert.equal(await t.state("morning_pages", 17), "pending");
      assert.equal(await t.text(".pages-prompt"), "Morning pages0 / 750 words todayWrite");

      // A past day opens from its box. The fixture's 16th has a count (768) with no source on record: set by
      // hand, as far as the app can tell. The room keeps the text and leaves that count as it is, and says so.
      const sixteenth = await t.file("days/2026-11-16.md");
      await t.click("morning_pages", 16);
      await t.page.waitForSelector(".room-field");
      await t.page.waitForFunction(() => document.querySelector(".room-foot").textContent.includes("set by hand"));
      assert.deepEqual((await t.room()).strip, ["Monday, November 16", "page 1 of 3", "0 / 750 words", "Leave"]);
      assert.equal((await t.room()).foot, "Kept in pages/2026-11-16.md and nowhere else. The day file's count (768) was set by hand, so the room leaves it as it is.");
      await t.page.keyboard.type("Written late.");
      await holds("pages/2026-11-16.md", "Written late.");
      await t.saved();
      assert.equal(await t.file("days/2026-11-16.md"), sixteenth);
      assert.equal((await t.room()).said, null);
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 1 of 3", "2 / 750 words"]);
      await t.shot("pages-by-hand");
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.focused(), "morning_pages 2026-11-16");
      assert.equal(await t.label("morning_pages", 16), "Morning pages, Monday, November 16, 2026: 768 of 750 words, goal met");

      // The same for a count typed into the grid today: a number typed on the box is a count entered by hand.
      await t.focusCell("morning_pages", 17);
      await t.page.keyboard.type("300");
      await t.page.keyboard.press("Enter");
      await t.saved();
      const typed = await t.file(TODAY_FILE);
      assert.deepEqual(changed(day, typed), { added: ["morning_pages_words: 300", "  morning_pages_words: manual"], removed: [] });
      await t.page.keyboard.press("Enter");
      await t.page.waitForSelector(".room-field");
      await t.page.keyboard.type("Four words, not 300.");
      await holds(PAGES, "Four words, not 300.");
      await t.saved();
      assert.equal(await t.file(TODAY_FILE), typed);
      assert.equal((await t.room()).foot, "Kept in pages/2026-11-17.md and nowhere else. The day file's count (300) was set by hand, so the room leaves it as it is.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 300 of 750 words");
    },
  },
  {
    name: "pages-slow",
    about: "on a slow disk, saves asked for while one is on its way land in order, none is taken for a change made elsewhere, and the month that comes back has the last count",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const pagesWrites = () => t.page.evaluate((path) => window.wetware.writes().filter((write) => write.path === path).length, PAGES);
      await t.page.evaluate((path) => {
        window.wetware.slowWrite(path, 400);
        window.wetware.slowWrite("days/2026-11-17.md", 200);
      }, PAGES);
      await t.openPages();
      await t.page.keyboard.type("One.");
      // The first save is on its way to disk, and has not landed.
      await t.page.waitForFunction(() => window.wetware.calls().includes("data_write"));
      assert.equal(await t.file(PAGES), null);
      // More is typed, and the window goes to the back: a second save is asked for behind the first.
      await t.page.keyboard.type(" Two.");
      await t.windowEvent("blur");
      // And more again, and out of the room at once: a third, on the way out.
      await t.page.keyboard.type(" Three.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      // The month is not shown until every one of them has landed, count and all. Nothing was asked, nothing is said.
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 3 of 750 words");
      assert.equal(await t.file(PAGES), "One. Two. Three.");
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 3$/m);
      assert.equal(await pagesWrites(), 3);
      assert.equal(await t.problem(), null);
      assert.equal(await t.text(".pages-prompt"), "Morning pages3 / 750 words todayWrite");

      // A save that fails with another behind it: the one behind is not taken for a change made elsewhere.
      await t.openPages();
      assert.equal((await t.room()).text, "One. Two. Three.");
      const calls = await t.page.evaluate(() => window.wetware.calls().length);
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.keyboard.type(" Four.");
      await t.page.waitForFunction((n) => window.wetware.calls().slice(n).includes("data_write"), {}, calls);
      await t.page.keyboard.type(" Five.");
      await t.windowEvent("blur");
      await t.page.waitForFunction(() => document.querySelector(".room-notice").textContent.includes("were not saved"));
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)));
      assert.equal((await t.room()).said, "The pages for November 17 were not saved. No space left on device (os error 28)");
      assert.deepEqual((await t.room()).actions, ["Dismiss"]);
      assert.equal(await t.file(PAGES), "One. Two. Three.");
      // The disk has room again, and leaving saves what is there.
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.file(PAGES), "One. Two. Three. Four. Five.");
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 5 of 750 words");
      assert.equal(await t.problem(), null);
    },
  },
  {
    name: "pages-midnight",
    about: "just after midnight, with nothing to tell the app the day has turned, the ways into the room that mean today open today",
    async run(t) {
      const typed = (path, text) => t.page.waitForFunction((p, body) => window.wetware.read(p) === body, {}, path, text);
      const strip = async () => (await t.room()).strip[0];
      // Yesterday's pages are there, short of the goal, so the line beside the month's name is too.
      await t.page.evaluate(() => window.wetware.write("pages/2026-11-17.md", "Yesterday's pages."));
      // Five seconds past midnight on the 18th. No focus event, no tick: the screen still says the 17th.
      await t.page.evaluate(() => window.wetware.setDay(18, 0, 0));
      assert.equal(await t.page.$eval(".app > .meta-row > :nth-child(3)", (el) => el.textContent), "2026-11-17");

      // "Pages" in the navigation asks the clock, not the screen.
      await t.openPages();
      assert.equal(await strip(), "Wednesday, November 18");
      assert.equal((await t.room()).text, "");
      await t.page.keyboard.type("Today's.");
      await typed("pages/2026-11-18.md", "Today's.");
      assert.equal(await t.file("pages/2026-11-17.md"), "Yesterday's pages.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.saved();
      assert.match(await t.file("days/2026-11-18.md"), /^morning_pages_words: 1$/m);
      assert.doesNotMatch(await t.file(TODAY_FILE), /morning_pages_words/);

      // So does "Write", on a grid that was drawn for yesterday (the clock is put back and forward to draw it so).
      await t.page.evaluate(() => window.wetware.setDay(17, 23, 59));
      await t.windowEvent("focus");
      await t.page.waitForSelector(".pages-prompt");
      await t.page.evaluate(() => window.wetware.setDay(18, 6, 30));
      assert.equal(await t.page.$eval(".app > .meta-row > :nth-child(3)", (el) => el.textContent), "2026-11-17");
      await t.page.click(".pages-prompt .action");
      await t.page.waitForSelector(".room-field");
      assert.equal(await strip(), "Wednesday, November 18");
      assert.equal((await t.room()).text, "Today's.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      // Yesterday's box still opens yesterday's pages: it is the box of that day.
      await t.click("morning_pages", 17);
      await t.page.waitForSelector(".room-field");
      assert.equal(await strip(), "Tuesday, November 17");
      assert.equal((await t.room()).text, "Yesterday's pages.");
      await t.page.keyboard.press("Escape");
      await t.ready();

      // The page being shown again (a laptop opened, the app still in front) is enough for the screen to catch up.
      assert.equal(await t.page.$eval(".app > .meta-row > :nth-child(3)", (el) => el.textContent), "2026-11-17");
      await t.page.evaluate(() => void document.dispatchEvent(new Event("visibilitychange")));
      await t.page.waitForFunction(() => document.querySelector(".app > .meta-row > :nth-child(3)").textContent === "2026-11-18");
      assert.equal(await t.page.$eval(".grid-day[data-today] .grid-day-button", (el) => el.dataset.date), "2026-11-18");
    },
  },
  {
    name: "pages-kept",
    about: "the room is not left with text that is not on disk: leaving waits for the save, stays and says why if it fails, and only goes without it when told to",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const STAYED = "The pages for November 17 are not saved, so the room has stayed open: leaving now would lose what is typed here. No space left on device (os error 28)";
      const roomSays = (text) => t.page.waitForFunction((said) => document.querySelector(".room-notice").textContent === said, {}, text);

      await t.openPages();
      await t.page.keyboard.type("First part saved.");
      await t.page.waitForFunction((path) => window.wetware.read(path) === "First part saved.", {}, PAGES);
      // The disk fills. A second sentence, and Escape at once.
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.keyboard.type(" Second part, typed as the disk filled.");
      await t.page.keyboard.press("Escape");
      // The room is still there, with the text in it, and says why in exactly these words.
      await roomSays(STAYED);
      assert.equal(await t.count(".room"), 1);
      assert.equal(await t.count(".grid"), 0);
      assert.equal((await t.room()).text, "First part saved. Second part, typed as the disk filled.");
      assert.deepEqual((await t.room()).actions, ["Leave without saving"]);
      assert.equal(await t.file(PAGES), "First part saved.");
      await t.shot();
      // Leave says the same, and so does Escape again. Nothing else is a way out.
      await t.page.click(".room-leave");
      await t.saved();
      assert.equal(await t.count(".room"), 1);
      assert.equal((await t.room()).said, STAYED);
      // The same when it is the read inside the save that fails.
      await t.page.evaluate((path) => {
        window.wetware.failWrites(null);
        window.wetware.failRead(path, "Operation timed out (os error 60)");
      }, PAGES);
      await t.page.keyboard.press("Escape");
      await roomSays(STAYED.replace("No space left on device (os error 28)", "Operation timed out (os error 60)"));
      assert.equal(await t.count(".room"), 1);
      // The trouble passes: leaving saves what is there and goes, and nothing is left on the month's message line.
      await t.page.evaluate((path) => window.wetware.failRead(path, null), PAGES);
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.file(PAGES), "First part saved. Second part, typed as the disk filled.");
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 10 of 750 words");
      assert.equal(await t.problem(), null);

      // The one way out with text that can't be saved: saying so. The file keeps what it had, and nothing more is said.
      await t.openPages();
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.keyboard.type(" Let go.");
      await t.page.keyboard.press("Escape");
      await roomSays(STAYED);
      const tried = await t.writes();
      await t.page.evaluate(() => [...document.querySelectorAll(".room-action")].find((el) => el.textContent === "Leave without saving").click());
      await t.ready();
      await t.saved();
      assert.equal(await t.file(PAGES), "First part saved. Second part, typed as the disk filled.");
      assert.equal(await t.problem(), null);
      assert.equal(await t.writes(), tried, "a save was tried after the text was let go");
      assert.equal(await t.focused(), "morning_pages 2026-11-17");
      await t.page.evaluate(() => window.wetware.failWrites(null));

      // A save that is merely slow is waited for: the room stays up until it has landed, and then goes.
      await t.page.evaluate((path) => window.wetware.slowWrite(path, 500), PAGES);
      await t.openPages();
      await t.page.keyboard.type(" Slow.");
      await t.page.keyboard.press("Escape");
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
      assert.equal(await t.count(".room"), 1, "the room was left before its save had landed");
      assert.equal(await t.file(PAGES), "First part saved. Second part, typed as the disk filled.");
      await t.ready();
      assert.equal(await t.file(PAGES), "First part saved. Second part, typed as the disk filled. Slow.");
      assert.equal(await t.problem(), null);
    },
  },
  {
    name: "pages-count",
    about: "the count follows the pages: text taken from the file, a stray key on the box, a count cleared by hand, and one handed back to the room from the day view",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const count = async (day = 17) => (await t.file(`days/2026-11-${day}.md`))?.match(/^morning_pages_words: .*$/m)?.[0] ?? null;
      const source = async (day = 17) => (await t.file(`days/2026-11-${day}.md`))?.match(/^  morning_pages_words: .*$/m)?.[0].trim() ?? null;
      const reads = () => t.page.evaluate(() => window.wetware.calls().filter((call) => call === "data_read").length);
      const front = async () => {
        const before = await reads();
        await t.windowEvent("focus");
        await t.page.waitForFunction((n) => window.wetware.calls().filter((call) => call === "data_read").length > n, {}, before);
        await t.saved();
      };
      const key = (name) => t.page.keyboard.press(name);

      // Pages written in another app, with no count anywhere: opened in the room and left, they are counted.
      await t.page.evaluate((text) => window.wetware.write("pages/2026-11-13.md", text), prose(800));
      assert.equal(await count(13), null);
      await t.click("morning_pages", 13);
      await t.page.waitForSelector(".room-field");
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 4", "800 / 750 words"]);
      await key("Escape");
      await t.ready();
      assert.equal(await count(13), "morning_pages_words: 800");
      assert.equal(await source(13), "morning_pages_words: morning_pages");
      assert.equal(await t.label("morning_pages", 13), "Morning pages, Friday, November 13, 2026: 800 of 750 words, goal met");
      assert.equal(await t.file("pages/2026-11-13.md"), prose(800));

      // Taken when the window comes back to the front: the strip follows the file, and so does the count on leaving.
      await t.openPages();
      await t.page.keyboard.type("Five words written in here.");
      await t.page.waitForFunction((path) => window.wetware.read(path) !== null, {}, PAGES);
      await t.saved();
      assert.equal(await count(), "morning_pages_words: 5");
      await t.page.evaluate((path, text) => window.wetware.write(path, text), PAGES, prose(405));
      await front();
      assert.deepEqual((await t.room()).strip.slice(1, 3), ["page 2 of 3", "405 / 750 words"]);
      await key("Escape");
      await t.ready();
      assert.equal(await count(), "morning_pages_words: 405");
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 405 of 750 words");
      // "Take the file's text": the count follows that too.
      await t.openPages();
      await t.page.evaluate((path) => window.wetware.write(path, "Three words now."), PAGES);
      await t.page.keyboard.type(" Typed over.");
      await t.page.waitForFunction(() => document.querySelectorAll(".room-said button").length === 2);
      await t.page.evaluate(() => [...document.querySelectorAll(".room-action")].find((el) => el.textContent === "Take the file's text").click());
      await t.page.waitForFunction(() => document.querySelectorAll(".room-said button").length === 0);
      await key("Escape");
      await t.ready();
      assert.equal(await count(), "morning_pages_words: 3");
      assert.equal(await t.file(PAGES), "Three words now.");

      // 760 words, and out. The keyboard is on the day's box, where the app puts it. A stray Backspace or Delete
      // there does nothing to a count the room wrote.
      await t.openPages();
      await t.page.$eval(".room-field", (el) => el.select());
      await t.insert(prose(760));
      await key("Escape");
      await t.ready();
      assert.equal(await t.focused(), "morning_pages 2026-11-17");
      const counted = await t.file(TODAY_FILE);
      assert.equal(await count(), "morning_pages_words: 760");
      const written = await t.writes();
      await key("Backspace");
      await key("Delete");
      await t.saved();
      assert.equal(await t.file(TODAY_FILE), counted);
      assert.equal(await t.writes(), written);
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 760 of 750 words, goal met");
      assert.equal(await t.countText("morning_pages"), "10/30");
      assert.equal(await t.problem(), null);

      // A number typed on the box is a count by hand, and that one can be cleared. An empty count is nobody's:
      // the room counts the day again the next time it is open, whatever the file says of who cleared it.
      await t.page.keyboard.type("9");
      await key("Enter");
      await t.saved();
      assert.equal(await count(), "morning_pages_words: 9");
      assert.equal(await source(), "morning_pages_words: manual");
      await key("Backspace");
      await t.saved();
      assert.equal(await count(), "morning_pages_words: null");
      assert.equal(await source(), "morning_pages_words: manual");
      assert.equal(await t.text(".pages-prompt"), "Morning pages0 / 750 words todayWrite");
      await key("Enter");
      await t.page.waitForSelector(".room-field");
      // Nothing is said of a count set by hand: there is no count.
      assert.equal((await t.room()).foot, "Kept in pages/2026-11-17.md and nowhere else. Only the word count goes to the day file.");
      await key("Escape");
      await t.ready();
      assert.equal(await t.file(TODAY_FILE), counted);
      assert.equal(await t.countText("morning_pages"), "10/30");

      // A wrong number typed over the room's count stays, as any count by hand does. The day view says how many
      // words the pages hold and offers to hand the count back to the room.
      await t.page.keyboard.type("9");
      await key("Enter");
      await t.saved();
      await t.openDay(17);
      await t.page.waitForFunction(() => document.querySelector('.day .row[data-habit="morning_pages"] .action') !== null);
      const row = await t.dayRow("morning_pages");
      assert.equal(`${row.value} ${row.source} ${row.action}`, "9 manual Use the room's count");
      assert.equal(row.note, "Set by hand, so the writing room leaves it alone. This day's pages hold 760 words. Use the room's count puts that here, and the room keeps it from then on.");
      await t.shot();
      await t.page.focus('.day .row[data-habit="morning_pages"] .action');
      await key("Enter");
      await t.saved();
      assert.equal(await t.file(TODAY_FILE), counted);
      const back = await t.dayRow("morning_pages");
      assert.equal(`${back.value} ${back.source} ${back.action}`, "760 morning_pages null");
      // The keyboard is on the value the action was about, not nowhere.
      assert.equal(await t.focusedLabel(), "Morning pages, Tuesday, November 17, 2026");
      await key("Escape");
      await t.ready();

      // A count by hand on a day with no pages has nothing to be handed back to: no action. The fixture's 16th.
      await t.openDay(16);
      await t.page.waitForSelector(".day .day-notes");
      await t.saved();
      assert.equal((await t.dayRow("morning_pages")).action, null);
      assert.equal((await t.dayRow("morning_pages")).source, "unrecorded");
      await key("Escape");
      await t.ready();

      // Pages emptied on a day whose file held nothing but their count: no stub of a day file is left behind,
      // and no empty _sources in a file that holds more.
      const paths = await t.paths();
      assert.ok(!paths.includes("days/2026-11-09.md"));
      await t.click("morning_pages", 9);
      await t.page.waitForSelector(".room-field");
      await t.page.keyboard.type("A few words on the ninth.");
      await key("Escape");
      await t.ready();
      assert.equal(await t.file("days/2026-11-09.md"), "---\ndate: 2026-11-09\nmorning_pages_words: 6\n_sources:\n  morning_pages_words: morning_pages\n---\n");
      await key("Enter");
      await t.page.waitForSelector(".room-field");
      await t.page.$eval(".room-field", (el) => el.select());
      await key("Backspace");
      await key("Escape");
      await t.ready();
      assert.equal(await t.file("days/2026-11-09.md"), null);
      assert.deepEqual(await t.page.evaluate(() => window.wetware.removed()), ["days/2026-11-09.md"]);
      assert.equal(await t.state("morning_pages", 9), "missed");
      // A file that holds something of the user's and no source entry but the room's: written and emptied again, it
      // is exactly as it was, with no "_sources:" left where the app put one.
      const own = "---\ndate: 2026-11-09\n# kept by hand\ncaffeine_mg: 90\n---\n";
      await t.page.evaluate((text) => window.wetware.write("days/2026-11-09.md", text), own);
      await t.reload();
      await t.click("morning_pages", 9);
      await t.page.waitForSelector(".room-field");
      await t.page.keyboard.type("Again.");
      await key("Escape");
      await t.ready();
      assert.equal(await t.file("days/2026-11-09.md"), own.replace("---\n", "---\n").replace("caffeine_mg: 90\n", "caffeine_mg: 90\nmorning_pages_words: 1\n_sources:\n  morning_pages_words: morning_pages\n"));
      await key("Enter");
      await t.page.waitForSelector(".room-field");
      await t.page.$eval(".room-field", (el) => el.select());
      await key("Backspace");
      await key("Escape");
      await t.ready();
      assert.equal(await t.file("days/2026-11-09.md"), own);
      assert.deepEqual(await t.page.evaluate(() => window.wetware.removed()), ["days/2026-11-09.md"]);
    },
  },
  {
    name: "notes-slow",
    about: "on a slow disk, a notes save asked for while one is on its way is not taken for a change made elsewhere",
    async run(t) {
      const path = "days/2026-11-10.md";
      const before = await t.file(path);
      await t.page.evaluate((file) => window.wetware.slowWrite(file, 400), path);
      await t.openDay(10);
      await t.notesEnd();
      // The first save is on its way to disk, and has not landed. More is typed, and the window goes to the back.
      await t.page.keyboard.type("One.");
      await t.page.waitForFunction(() => window.wetware.calls().includes("data_write"));
      assert.equal(await t.file(path), before);
      await t.page.keyboard.type(" Two.");
      await t.windowEvent("blur");
      await t.page.waitForFunction((file, text) => window.wetware.read(file) === text, {}, path, `${before}One. Two.`);
      await t.saved();
      // Nothing was asked, and the day can be left.
      assert.equal(await t.problem(), null);
      assert.deepEqual(await t.dayTable("Notes"), []);

      // The same with no blur at all, on a slower disk still: a sentence, a pause long enough for its save to start,
      // another sentence, and a pause.
      await t.page.evaluate((file) => window.wetware.slowWrite(file, 1000), path);
      await t.notesEnd();
      await t.page.keyboard.type(" Three.");
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)));
      await t.page.keyboard.type(" Four.");
      await t.page.waitForFunction((file, text) => window.wetware.read(file) === text, {}, path, `${before}One. Two. Three. Four.`);
      await t.saved();
      assert.equal(await t.problem(), null);
      assert.deepEqual(await t.dayTable("Notes"), []);
      assert.equal(await t.notes(), "Slept badly. Two coffees before ten.\nOne. Two. Three. Four.");
      // And a change that really was made elsewhere is still asked about.
      await t.page.evaluate((file) => {
        window.wetware.slowWrite(file, null);
        window.wetware.write(file, `${window.wetware.read(file)}\nFrom Obsidian.\n`);
      }, path);
      await t.page.keyboard.type(" Five.");
      await t.told("were changed outside Wetware");
      assert.equal((await t.dayTable("Notes")).length, 1);
      await t.page.evaluate(() => [...document.querySelectorAll('.day .table[aria-label="Notes"] .action')].find((el) => el.textContent === "Take the file's text").click());
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.focused(), "day 2026-11-10");
    },
  },
  {
    name: "pages-stuck",
    about: "a pages write that the folder is slow to answer is given up on; when it lands after all, it lands before the newer one and never over it",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      await t.openPages();
      await t.page.keyboard.type("One. Two.");
      await t.page.waitForFunction((path) => window.wetware.read(path) === "One. Two.", {}, PAGES);
      // The next write of the pages takes 33 seconds to land: three more than the app waits for an answer.
      await t.page.evaluate((path) => window.wetware.slowWrite(path, 33000), PAGES);
      await t.page.keyboard.type(" Three.");
      await t.page.waitForFunction(() => window.wetware.calls().filter((call) => call === "data_write").length >= 3);
      await t.page.evaluate((path) => window.wetware.slowWrite(path, null), PAGES);
      // A newer save is asked for behind it.
      await t.page.keyboard.type(" Four.");
      await t.windowEvent("blur");
      // At thirty seconds the first is given up on, and the room says so, naming the file.
      await t.page.waitForFunction(() => document.querySelector(".room-notice").textContent !== "", { timeout: 40000 });
      assert.equal((await t.room()).said, "The pages for November 17 were not saved. No answer from the data folder for pages/2026-11-17.md after 30 seconds");
      assert.equal(await t.file(PAGES), "One. Two.");
      // Three seconds later the stuck write lands, and the newer one after it: the file holds the newer text, the day
      // file its count, and the message has gone. Had the newer one landed first, the stuck one would have written over it.
      await t.page.waitForFunction((path) => window.wetware.read(path) === "One. Two. Three. Four.", { timeout: 20000 }, PAGES);
      await t.saved();
      assert.equal((await t.room()).said, null);
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 4$/m);
      assert.deepEqual(
        (await t.page.evaluate(() => window.wetware.writes())).filter((write) => write.path === PAGES).length,
        3,
      );
      // What the room knows the file to hold is what the newer save wrote: more typing is saved with nothing asked.
      await t.page.keyboard.type(" Five.");
      await t.page.waitForFunction((path) => window.wetware.read(path) === "One. Two. Three. Four. Five.", {}, PAGES);
      await t.saved();
      assert.equal((await t.room()).said, null);
      assert.deepEqual((await t.room()).actions, []);
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.label("morning_pages", 17), "Morning pages, Tuesday, November 17, 2026: 5 of 750 words");
    },
  },
  {
    name: "quit-flush",
    about: "the shell holds a close and asks the app to save: what is typed in the room and in a day's notes is on disk by the time the app answers, and it always answers",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const flush = () => t.page.evaluate(() => window.wetware.askFlush());

      // With nothing typed anywhere there is nothing to wait for.
      const idle = await flush();
      assert.ok(idle >= 0 && idle < 500, `with nothing to save, the answer took ${idle} ms`);
      assert.equal(await t.writes(), 0);

      // In the room, mid-sentence, with no pause for a save to have run: the close is asked for.
      await t.openPages();
      await t.page.keyboard.type("Typed just before quitting");
      assert.equal(await t.file(PAGES), null);
      const quick = await flush();
      assert.ok(quick >= 0, "the app did not answer");
      // By the time it answers, the text and its count are both on disk.
      assert.equal(await t.file(PAGES), "Typed just before quitting");
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 4$/m);
      // On a slow disk it answers only once the write has landed, not before.
      await t.page.evaluate((path) => {
        window.wetware.slowWrite(path, 600);
        window.wetware.slowWrite("days/2026-11-17.md", 300);
      }, PAGES);
      await t.page.keyboard.type(", and again");
      const slow = await flush();
      assert.ok(slow >= 850, `the answer came after ${slow} ms, before the writes could have landed`);
      assert.equal(await t.file(PAGES), "Typed just before quitting, and again");
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 6$/m);
      await t.page.evaluate((path) => {
        window.wetware.slowWrite(path, null);
        window.wetware.slowWrite("days/2026-11-17.md", null);
      }, PAGES);
      // A save that can't be made does not hold the close: the app still answers, and well inside the shell's limit.
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.keyboard.type(". Lost");
      const failing = await flush();
      assert.ok(failing >= 0 && failing < 1500, `with a failing disk the answer took ${failing} ms`);
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.keyboard.press("Escape");
      await t.ready();

      // A day's notes, the same.
      await t.openDay(10);
      const before = await t.file("days/2026-11-10.md");
      await t.notesEnd();
      await t.page.keyboard.type("Typed just before quitting");
      assert.equal(await t.file("days/2026-11-10.md"), before);
      assert.ok((await flush()) >= 0);
      assert.equal(await t.file("days/2026-11-10.md"), `${before}Typed just before quitting`);
      await t.page.keyboard.press("Escape");
      await t.ready();
    },
  },
  {
    name: "pages-private",
    about: "what is written in the room is in its pages file and nowhere else: no other file, no storage, no log, no message, nothing sent but the write itself",
    query: "sync=fixture&key=stored",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      // A phrase that is nowhere in the app or its fixtures, and each of its parts on its own.
      const MARKER = "quince-marmalade-7391 is under the floorboards";
      const PARTS = [MARKER, "quince", "marmalade", "7391", "floorboards"];
      const holds = (text) => t.page.waitForFunction((p, body) => (window.wetware.read(p) ?? "").includes(body), {}, PAGES, text);
      const roomSays = (text) => t.page.waitForFunction((part) => document.querySelector(".room-notice").textContent.includes(part), {}, text);
      await t.told("Sync: 24 days updated.");
      for (const part of PARTS) assert.deepEqual(await t.page.evaluate((text) => window.wetware.filesHolding(text), part), [], `the fixture already holds "${part}"`);
      /**
       * Whatever hangs off the window that a script could have put there: every property but the harness's own
       * and the browser's, looked through a few levels down for `text`. Returns the names of those that hold it.
       */
      const globalsHolding = (text) =>
        t.page.evaluate((needle) => {
          const holds = (value, depth) => {
            if (typeof value === "string") return value.includes(needle);
            if (value === null || typeof value !== "object" || depth === 0) return false;
            if (value instanceof Node || value === window) return false;
            try {
              return (Array.isArray(value) ? value : Object.values(value)).some((inner) => holds(inner, depth - 1));
            } catch {
              return false;
            }
          };
          const found = [];
          for (const name of Object.getOwnPropertyNames(window)) {
            if (name === "wetware" || name.startsWith("__TAURI") || name.startsWith("__vite") || name.startsWith("$Refresh") || name.startsWith("__REACT")) continue;
            let value;
            try {
              value = window[name];
            } catch {
              continue;
            }
            if (holds(value, 4)) found.push(name);
          }
          return found;
        }, text);

      // Written, and saved the ordinary way.
      await t.openPages();
      await t.page.keyboard.type(`Nobody reads this. The ${MARKER}.`);
      await holds(MARKER);
      // A save that fails, with the phrase in the text it failed to save: what is said names the file, and quotes nothing.
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.keyboard.type(" More of the marmalade.");
      await roomSays("were not saved");
      assert.equal((await t.room()).said, "The pages for November 17 were not saved. No space left on device (os error 28)");
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.keyboard.type(" And the floorboards.");
      await holds("And the floorboards.");
      // The file changed in another app under unsaved typing: the question is put without a word of either text.
      await t.page.evaluate((path) => window.wetware.write(path, `${window.wetware.read(path)} Quince, added elsewhere: quince-7391.`), PAGES);
      await t.page.keyboard.type(" Typed over it: 7391.");
      await roomSays("was changed outside Wetware");
      assert.equal(
        (await t.room()).said,
        "pages/2026-11-17.md was changed outside Wetware while it was open here. What is typed here has not been saved. Choose whether to keep it or take the file's text.",
      );
      await t.page.keyboard.press("Escape");
      assert.equal((await t.room()).said, "pages/2026-11-17.md is not saved: it was changed outside Wetware. Before leaving, choose whether to keep what is typed here or take the file's text.");
      await t.page.evaluate(() => [...document.querySelectorAll(".room-action")].find((el) => el.textContent === "Keep what is typed here").click());
      await holds("Typed over it: 7391.");
      // The window to the back and to the front again, then out of the room.
      await t.windowEvent("blur");
      await t.windowEvent("focus");
      await t.saved();
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.saved();
      const written = await t.file(PAGES);
      assert.equal(written, `Nobody reads this. The ${MARKER}. More of the marmalade. And the floorboards. Typed over it: 7391.`);

      // Everything else the app does, with the pages written: a sync, the day's own view and its notes, Settings.
      await t.page.click(".month .action");
      await t.told("Sync:");
      await t.openDay(17);
      await t.page.focus(".day-notes");
      await t.page.keyboard.type("Day notes are another thing.");
      await t.page.keyboard.press("Escape");
      await t.ready();
      await t.nav("Settings");
      await t.page.waitForSelector('input[aria-label="Latitude"]');
      await t.page.evaluate(() => [...document.querySelectorAll(".row .action")].find((el) => el.textContent === "Test connection").click());
      await t.saved();
      await t.nav("Month");
      await t.ready();
      await t.saved();

      for (const part of PARTS) {
        const where = `"${part}"`;
        // In the pages file, and in no other file of this folder or any other the app has known.
        assert.deepEqual(await t.page.evaluate((text) => window.wetware.filesHolding(text), part), [`suggested: ${PAGES}`], `${where} is in a file other than the pages`);
        // Sent to the shell only as the write of that file, and handed back only by the read of it. Sync sent none of it.
        assert.deepEqual([...new Set(await t.page.evaluate((text) => window.wetware.sent(text), part))], [`data_write ${PAGES}`], `${where} was sent somewhere`);
        assert.deepEqual([...new Set(await t.page.evaluate((text) => window.wetware.answered(text), part))], [`data_read ${PAGES}`], `${where} was handed over`);
        assert.ok(!(await t.page.evaluate(() => window.wetware.fetches())).join("\n").includes(part), `${where} is in a fetch`);
        // Not in anything the page logged or asked the network for.
        assert.ok(!t.said().includes(part), `${where} is in the console or a request`);
        // Not in the browser's storage, which the app does not use at all.
        const kept = await t.page.evaluate(async () => ({
          local: JSON.stringify(Object.entries(localStorage)),
          session: JSON.stringify(Object.entries(sessionStorage)),
          cookie: document.cookie,
          databases: JSON.stringify(await indexedDB.databases()),
          name: window.name,
          history: JSON.stringify(history.state),
          address: location.href,
        }));
        assert.deepEqual(kept, { local: "[]", session: "[]", cookie: "", databases: "[]", name: "", history: "null", address: kept.address });
        assert.ok(!kept.address.includes(part));
        // Not hung on the window for some other script to find.
        assert.deepEqual(await globalsHolding(part), [], `${where} is on the window`);
        // And, out of the room, not anywhere in the page: not on the message line, not in a title or a label.
        assert.ok(!(await t.page.evaluate(() => document.documentElement.outerHTML)).includes(part), `${where} is still in the page`);
      }
      // The count is the one thing that left: a number, in the day file.
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 20$/m);
      // The message line holds what the sync had to say, and nothing of the room's: not on top, and not underneath
      // when each message in turn is dismissed.
      assert.equal(await t.problem(), "Sync: nothing new.");
      for (let said = await t.problem(); said !== null; said = await t.problem()) {
        for (const part of PARTS) assert.ok(!said.includes(part), `"${part}" is on the message line`);
        await t.page.click(".notice-dismiss");
      }
    },
  },
  {
    name: "pages-outside",
    about: "a pages file changed in another app while the room is open: taken in when nothing is typed, asked about when something is, never written over unseen",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const outside = (text) => t.page.evaluate((path, body) => window.wetware.write(path, body), PAGES, text);
      const reads = () => t.page.evaluate(() => window.wetware.calls().filter((call) => call === "data_read").length);
      const front = async () => {
        const before = await reads();
        await t.windowEvent("focus");
        await t.page.waitForFunction((n) => window.wetware.calls().filter((call) => call === "data_read").length > n, {}, before);
        await t.saved();
      };
      const roomSays = (text) => t.page.waitForFunction((part) => document.querySelector(".room-notice").textContent.includes(part), {}, text);
      const choose = (label) => t.page.evaluate((text) => [...document.querySelectorAll(".room-action")].find((el) => el.textContent === text).click(), label);
      const ASKED = "pages/2026-11-17.md was changed outside Wetware while it was open here. What is typed here has not been saved. Choose whether to keep it or take the file's text.";
      const HELD = "pages/2026-11-17.md is not saved: it was changed outside Wetware. Before leaving, choose whether to keep what is typed here or take the file's text.";

      await outside("Written in the room this morning.\n");
      await t.openPages();
      assert.equal((await t.room()).text, "Written in the room this morning.\n");

      // Changed outside with nothing typed here: coming back to the window, the room takes the new text. Nothing is said or written.
      await outside("Written in the room this morning.\nA line from Obsidian.\n");
      await front();
      assert.equal((await t.room()).text, "Written in the room this morning.\nA line from Obsidian.\n");
      assert.equal((await t.room()).said, null);
      assert.deepEqual((await t.room()).actions, []);
      assert.equal(await t.writes(), 0);

      // Changed outside and not yet seen, and then typed over here: nothing is written, the typing stays, and the room asks.
      const second = "Written in the room this morning.\nA line from Obsidian.\nAnother from Obsidian.\n";
      await outside(second);
      await t.page.keyboard.type("Typed here.");
      await roomSays("was changed outside Wetware");
      assert.equal((await t.room()).said, ASKED);
      assert.deepEqual((await t.room()).actions, ["Keep what is typed here", "Take the file's text"]);
      assert.equal(await t.file(PAGES), second);
      assert.equal((await t.room()).text, "Written in the room this morning.\nA line from Obsidian.\nTyped here.");
      assert.equal(await t.writes(), 0);
      assert.equal(await t.count(".app, .nav, .notices"), 0);
      await t.shot();
      // Typing on, the window going to the back: still nothing is written, and no save is so much as tried.
      const read = await reads();
      await t.page.keyboard.type(" And more.");
      await t.windowEvent("blur");
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1100)));
      assert.equal(await t.file(PAGES), second);
      assert.equal(await t.writes(), 0);
      assert.equal(await reads(), read, "a save was tried while the question was open");
      // The room can't be left while that stands, by Escape or by Leave, and each try says why.
      await t.page.keyboard.press("Escape");
      assert.equal(await t.count(".room"), 1);
      assert.equal((await t.room()).said, HELD);
      assert.equal(await t.focusedLabel(), "Keep what is typed here");
      await t.page.click(".room-leave");
      assert.equal(await t.count(".room"), 1);

      // Answering needs the file read again. If it can't be, the question stays open and the room says so, in these words.
      await t.page.evaluate((path) => window.wetware.failRead(path, "stream did not contain valid UTF-8"), PAGES);
      await choose("Keep what is typed here");
      await t.page.waitForFunction(() => document.querySelector(".room-notice").textContent.startsWith("What is typed here is still not saved"));
      assert.equal((await t.room()).said, "What is typed here is still not saved: pages/2026-11-17.md could not be read. stream did not contain valid UTF-8");
      assert.deepEqual((await t.room()).actions, ["Keep what is typed here", "Take the file's text"]);
      assert.equal(await t.writes(), 0);
      await t.page.evaluate((path) => window.wetware.failRead(path, null), PAGES);
      await t.page.focus(".room-said button");

      // "Take the file's text", from the keyboard: the room holds what the file holds, nothing was written, and the way out is open.
      await t.page.keyboard.press("Tab");
      assert.equal(await t.focusedLabel(), "Take the file's text");
      await t.page.keyboard.press("Enter");
      await t.page.waitForFunction(() => document.querySelectorAll(".room-said button").length === 0);
      assert.equal((await t.room()).text, second);
      assert.equal((await t.room()).said, null);
      assert.equal(await t.file(PAGES), second);
      assert.equal(await t.writes(), 0);
      // The keyboard is back in the text.
      assert.equal(await t.page.evaluate(() => document.activeElement.className), "room-text room-field");

      // The other choice. Asked the same way, "Keep what is typed here" writes it over the file's text, count and all.
      const third = `${second}A third from Obsidian.\n`;
      await outside(third);
      await t.page.$eval(".room-field", (el) => el.setSelectionRange(el.value.length, el.value.length));
      await t.page.keyboard.type("Mine.");
      await roomSays("was changed outside Wetware");
      assert.equal(await t.file(PAGES), third);
      await choose("Keep what is typed here");
      await t.page.waitForFunction((path) => window.wetware.read(path).endsWith("Mine."), {}, PAGES);
      await t.saved();
      assert.equal(await t.file(PAGES), `${second}Mine.`);
      assert.equal((await t.room()).said, null);
      assert.deepEqual((await t.room()).actions, []);
      assert.match(await t.file(TODAY_FILE), /^morning_pages_words: 14$/m);
      // And typing goes on being saved as usual.
      await t.page.keyboard.type(" Still mine.");
      await t.page.waitForFunction((path) => window.wetware.read(path).endsWith("Still mine."), {}, PAGES);

      // The window comes back to the front over typing that is not saved yet, with the file changed meanwhile:
      // the typing is not thrown away for the file's text. The room asks, and writes nothing.
      const fifth = await t.file(PAGES);
      await outside(`${fifth} From elsewhere.`);
      await t.page.keyboard.type(" Not saved yet.");
      await front();
      await roomSays("was changed outside Wetware");
      assert.ok((await t.room()).text.endsWith("Still mine. Not saved yet."), (await t.room()).text);
      assert.equal(await t.file(PAGES), `${fifth} From elsewhere.`);
      await choose("Take the file's text");
      await t.page.waitForFunction(() => document.querySelectorAll(".room-said button").length === 0);
      assert.equal((await t.room()).text, `${fifth} From elsewhere.`);
      assert.equal(await t.file(PAGES), `${fifth} From elsewhere.`);
      await t.page.$eval(".room-field", (el) => el.setSelectionRange(el.value.length, el.value.length));

      // Asked, and then the other app puts the file back as it was: there is nothing left to ask, and the typing is saved.
      const fourth = await t.file(PAGES);
      await outside(`${fourth} Elsewhere.`);
      await t.page.keyboard.type(" Here.");
      await roomSays("was changed outside Wetware");
      await outside(fourth);
      await front();
      await t.page.waitForFunction((path) => window.wetware.read(path).endsWith("From elsewhere. Here."), {}, PAGES);
      assert.equal((await t.room()).said, null);
      assert.deepEqual((await t.room()).actions, []);
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.problem(), null);
    },
  },
  {
    name: "pages-trouble",
    about: "trouble in the room is said in the room, quietly: a save that fails, a count that can't be written, a file that can't be read",
    async run(t) {
      const PAGES = "pages/2026-11-17.md";
      const roomSays = (text) => t.page.waitForFunction((part) => document.querySelector(".room-notice").textContent.includes(part), {}, text);

      // A save that fails: said under the strip, in the room's own voice; the app's message line stays away.
      await t.openPages();
      await t.page.evaluate(() => window.wetware.failWrites("No space left on device (os error 28)"));
      await t.page.keyboard.type("Nowhere to put this yet.");
      await roomSays("were not saved");
      assert.equal((await t.room()).said, "The pages for November 17 were not saved. No space left on device (os error 28)");
      assert.deepEqual((await t.room()).actions, ["Dismiss"]);
      assert.equal(await t.count(".app, .nav, .notices"), 0);
      assert.equal((await t.room()).text, "Nowhere to put this yet.");
      assert.equal(await t.file(PAGES), null);
      // Nothing below the strip moved for it: the text starts where it did.
      const top = () => t.page.$eval(".room-field", (el) => el.getBoundingClientRect().top + window.scrollY);
      const withMessage = await top();
      await t.shot();
      // The next keystroke tries again, and once the text is saved the message is gone by itself.
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.keyboard.type(" Now there is.");
      await t.page.waitForFunction((path) => window.wetware.read(path) === "Nowhere to put this yet. Now there is.", {}, PAGES);
      await t.saved();
      assert.equal((await t.room()).said, null);
      assert.deepEqual((await t.room()).actions, []);
      assert.equal(await top(), withMessage);

      // A message as long as an operating system can make one keeps to the two lines kept for it. The text below
      // does not move, and the whole of the message is in its tooltip.
      const long = `The folder said no (os error 5): ${"a very long reason from the operating system, ".repeat(12)}and that is all.`;
      await t.page.evaluate((message) => window.wetware.failWrites(message), long);
      await t.page.keyboard.type(" More.");
      await roomSays("The folder said no");
      assert.equal(await top(), withMessage);
      const said = await t.page.$eval(".room-notice", (el) => ({ title: el.title, lines: el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight), cut: el.scrollHeight > el.clientHeight }));
      assert.equal(said.title, `The pages for November 17 were not saved. ${long}`);
      assert.ok(said.lines <= 2.05 && said.cut, `the message takes ${said.lines} lines`);
      assert.ok(await t.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "horizontal scroll");
      await t.shot("pages-trouble-long");
      await t.page.evaluate(() => window.wetware.failWrites(null));
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.file(PAGES), "Nowhere to put this yet. Now there is. More.");
      assert.equal(await t.problem(), null);

      // A day file that needs fixing by hand: the text is saved all the same, and the room says the count was not.
      const broken = "---\ndate: 2026-11-12\nmood: 1\nmood: 2\n---\n";
      await t.page.evaluate((text) => window.wetware.write("days/2026-11-12.md", text), broken);
      await t.reload();
      await t.click("morning_pages", 12);
      await t.page.waitForSelector(".room-field");
      await t.page.keyboard.type("Kept, uncounted.");
      await roomSays("The pages are saved.");
      assert.equal((await t.room()).said, "The pages are saved. The word count could not be written to days/2026-11-12.md. Frontmatter: Invalid YAML: Map keys must be unique (line 4).");
      assert.equal(await t.file("pages/2026-11-12.md"), "Kept, uncounted.");
      assert.equal(await t.file("days/2026-11-12.md"), broken);
      // The day file put right while the room is open, and nothing more typed: the count is still owed, and leaving
      // writes it. The month that comes back has it, and the message has gone.
      await t.page.evaluate(() => window.wetware.write("days/2026-11-12.md", "---\ndate: 2026-11-12\nmood: 2\n---\n"));
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.label("morning_pages", 12), "Morning pages, Thursday, November 12, 2026: 2 of 750 words");
      assert.match(await t.file("days/2026-11-12.md"), /^morning_pages_words: 2$/m);
      assert.equal(await t.file("pages/2026-11-12.md"), "Kept, uncounted.");
      assert.equal(await t.problem(), null);

      // A pages file that can't be read: the room says which file and why, and offers nothing to type into, so nothing is written over it.
      await t.page.evaluate(() => window.wetware.failRead("pages/2026-11-11.md", "stream did not contain valid UTF-8"));
      const written = await t.writes();
      await t.click("morning_pages", 11);
      await t.page.waitForSelector(".room");
      await roomSays("could not be read");
      assert.equal((await t.room()).said, "pages/2026-11-11.md could not be read, so nothing can be written here. stream did not contain valid UTF-8");
      assert.equal(await t.count(".room textarea, .room-sheet"), 0);
      assert.deepEqual((await t.room()).strip, ["Wednesday, November 11", "", "", "Leave"]);
      // It is the one thing the room has to show, so it can't be dismissed. It is gone with the room.
      assert.deepEqual((await t.room()).actions, []);
      await t.shot("pages-unreadable");
      await t.page.keyboard.press("Escape");
      await t.ready();
      assert.equal(await t.writes(), written);
      assert.equal(await t.focused(), "morning_pages 2026-11-11");
      assert.equal(await t.problem(), null);
    },
  },
  {
    name: "settings",
    about: "the Settings screen, and first run with no data folder",
    query: "folder=none",
    async run(t) {
      await t.page.waitForSelector("h1");
      assert.equal(await t.text("h1"), "Settings");
      await t.shot("settings-first-run");
      await t.page.click(".row-value .action:nth-of-type(2)");
      await t.page.waitForSelector('input[aria-label="Latitude"]');
      assert.match(await t.file("habits.yaml"), /^habits:\n  - id: weight\n/);
      await t.page.type('input[aria-label="City"]', "Oakland");
      await t.page.keyboard.press("Tab");
      await t.page.keyboard.type("37.8");
      await t.page.keyboard.press("Tab");
      await t.page.keyboard.type("500");
      await t.page.keyboard.press("Tab");
      await t.saved();
      assert.equal(await t.file("settings.yaml"), "location:\n  name: Oakland\n  latitude: 37.8\n");
      assert.equal(await t.page.$eval('input[aria-label="Longitude"]', (el) => el.value), "");
      await t.shot();
    },
  },
];

/** What a scenario gets to work with. */
function tools(page, name, base, said) {
  const cell = (habit, day) => `.grid-cell[data-habit="${habit}"][data-date$="-${String(day).padStart(2, "0")}"]`;
  const t = {
    page,
    ready: async () => {
      await page.waitForSelector('.grid[aria-busy="false"]');
      await page.evaluate(() => document.fonts.ready);
    },
    /** Waits until every write the app has started has finished. */
    saved: () => page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 60))),
    reload: async () => {
      // Another month and back: the grid reads the folder again.
      await page.click(".month-nav button:first-child");
      await t.ready();
      await page.click(".month-nav button:nth-child(2)");
      await t.ready();
    },
    shot: (as = name) => page.screenshot({ path: `${OUT}${as}.png` }),
    file: (path) => page.evaluate((p) => window.wetware.read(p), path),
    paths: () => page.evaluate(() => window.wetware.paths()),
    text: (selector) => page.$eval(selector, (el) => el.textContent),
    count: (selector) => page.$$eval(selector, (els) => els.length),
    click: (habit, day) => page.click(cell(habit, day)),
    state: (habit, day) => page.$eval(cell(habit, day), (el) => el.dataset.state),
    label: (habit, day) => page.$eval(cell(habit, day), (el) => el.getAttribute("aria-label")),
    /** The value a cell is showing: of its full and shortened forms, the one with a size. */
    cellText: (habit, day) =>
      page.$eval(cell(habit, day), (el) => {
        const shown = [...el.querySelectorAll("span")].find((span) => parseFloat(getComputedStyle(span).fontSize) > 0);
        return shown?.textContent ?? "";
      }),
    fontSize: (habit, day) =>
      page.$eval(cell(habit, day), (el) => {
        const sizes = [...el.querySelectorAll("span")].map((span) => parseFloat(getComputedStyle(span).fontSize));
        return Math.max(0, ...sizes);
      }),
    countText: (habit) => page.$eval(`${cell(habit, 1)} ~ .grid-count`, (el) => el.textContent),
    /** Waits for a cell to reach a state: after a sync, the grid reads the month again. */
    stateIs: (habit, day, state) =>
      page.waitForFunction((selector, wanted) => document.querySelector(selector)?.dataset.state === wanted, {}, cell(habit, day), state),
    /** What the grid header says about syncing. */
    syncStatus: () => page.$eval(".sync-status", (el) => el.textContent),
    fetches: () => page.evaluate(() => window.wetware.fetches()),
    syncState: () => page.evaluate(() => window.wetware.syncState()),
    /** Goes to another screen by its name in the navigation. */
    nav: (label) => page.evaluate((text) => [...document.querySelectorAll(".nav-item")].find((el) => el.textContent === text).click(), label),
    /** Presses the action with this label on a Settings row. */
    action: (label) => page.evaluate((text) => [...document.querySelectorAll(".row .action")].find((el) => el.textContent === text).click(), label),
    /** The value of the Settings row with this label, without its note. Null if there is no such row. */
    row: (label) =>
      page.evaluate((text) => {
        const row = [...document.querySelectorAll(".row")].find((el) => el.firstElementChild.textContent === text);
        if (!row) return null;
        return [...row.querySelector(".row-value").children].filter((el) => !el.classList.contains("row-note")).map((el) => el.textContent).join(" ");
      }, label),
    rowNote: (label) =>
      page.evaluate((text) => {
        const row = [...document.querySelectorAll(".row")].find((el) => el.firstElementChild.textContent === text);
        return row?.querySelector(".row-note")?.textContent ?? null;
      }, label),
    /** Opens a day from the grid by its header, and waits for the day view to have read its file. */
    openDay: async (day) => {
      await page.click(`.grid-day-button[data-date$="-${String(day).padStart(2, "0")}"]`);
      await page.waitForSelector(".day .table");
      await page.evaluate(() => document.fonts.ready);
    },
    /** A habit's row in the day view: what its control holds, where the value came from, and what else the row offers. */
    dayRow: (habit) =>
      page.$eval(`.day .row[data-habit="${habit}"]`, (row) => {
        const input = row.querySelector("input");
        const box = row.querySelector(".day-box");
        return {
          value: input ? input.value : box.getAttribute("aria-pressed") === "true",
          mark: box?.querySelector(".mark")?.className.replace("mark ", "") ?? null,
          source: row.querySelector(".day-source").textContent,
          action: row.querySelector(".action")?.textContent ?? null,
          note: row.querySelector(".row-note")?.textContent ?? null,
          state: row.dataset.state,
        };
      }),
    dayInput: (habit) => `.day .row[data-habit="${habit}"] input`,
    dayBox: (habit) => `.day .row[data-habit="${habit}"] .day-box`,
    /** Types a value into a habit's field in the day view, in place of what is there, and presses Enter. */
    dayType: async (habit, text) => {
      await page.click(`.day .row[data-habit="${habit}"] input`);
      await page.$eval(`.day .row[data-habit="${habit}"] input`, (el) => el.select());
      if (text === "") await page.keyboard.press("Backspace");
      else await page.keyboard.type(text);
      await page.keyboard.press("Enter");
    },
    /** The rows of one of the day view's tables, as "label: value" lines. */
    dayTable: (label) =>
      page.evaluate((name) => {
        const table = [...document.querySelectorAll(".day .table")].find((el) => el.getAttribute("aria-label") === name);
        if (!table) return null;
        return [...table.querySelectorAll(".row")].map((row) => `${row.children[0].textContent}: ${[...row.children[1].children].map((el) => el.textContent).join(" | ") || row.children[1].textContent}`);
      }, label),
    /** Presses Tab (or Shift+Tab) until the focused element's label or text starts with `name`. */
    tabTo: async (name, back = false) => {
      for (let i = 0; i < 60; i++) {
        if (back) await page.keyboard.down("Shift");
        await page.keyboard.press("Tab");
        if (back) await page.keyboard.up("Shift");
        const label = await page.evaluate(() => document.activeElement.getAttribute("aria-label") ?? document.activeElement.textContent);
        if (label.startsWith(name)) return;
      }
      throw new Error(`Tab never reached "${name}"`);
    },
    /** Fires an event on the window, as the system does when the app comes to the front, goes to the back or is closed. */
    windowEvent: (name) => page.evaluate((type) => void window.dispatchEvent(new Event(type)), name),
    notes: () => page.$eval(".day-notes", (el) => el.value),
    /** Puts the caret at the end of the notes, ready to type. */
    notesEnd: () => page.$eval(".day-notes", (el) => (el.focus(), el.setSelectionRange(el.value.length, el.value.length))),
    focusedLabel: () => page.evaluate(() => document.activeElement.getAttribute("aria-label") ?? document.activeElement.textContent),
    /** Puts the keyboard on a box of the grid without pressing it. */
    focusCell: (habit, day) => page.focus(cell(habit, day)),
    /** Opens today's morning pages from the navigation, and waits for the writing room to have read them. */
    openPages: async () => {
      await t.nav("Pages");
      await page.waitForSelector(".room-field");
      await page.evaluate(() => document.fonts.ready);
    },
    /** What the writing room shows: its text, the strip above it, what it has to say and offers, its foot, its page marks. */
    room: () =>
      page.evaluate(() => ({
        text: document.querySelector(".room-field")?.value ?? null,
        strip: [...document.querySelectorAll(".room-strip > *")].map((el) => el.textContent.trim()),
        said: document.querySelector(".room-notice").textContent || null,
        actions: [...document.querySelectorAll(".room-said button")].map((el) => el.textContent),
        foot: document.querySelector(".room-foot")?.textContent ?? null,
        marks: [...document.querySelectorAll(".room-mark")].map((el) => Number(el.textContent)),
      })),
    /** Puts a long text in at the caret in one go, as a paste does. */
    insert: (text) => page.keyboard.sendCharacter(text),
    /** Everything the page has written to the console, and every request it has made, as one text. */
    said: () => said.join("\n"),
    /** Everything in the open folder, to check that nothing changed. */
    folder: () => page.evaluate(() => window.wetware.paths().map((path) => [path, window.wetware.read(path)])),
    writes: () => page.evaluate(() => window.wetware.calls().filter((call) => call === "data_write").length),
    /** The message on the error line, or null. */
    problem: () => page.evaluate(() => document.querySelector(".notice").textContent || null),
    /** Waits for a message containing `text` to be on the message line. */
    told: (text) => page.waitForFunction((part) => document.querySelector(".notice").textContent.includes(part), {}, text),
    /** Top and bottom of the grid, in the window. */
    gridBox: () => page.$eval(".grid", (el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom })),
    /** Which cell has keyboard focus: "habit date", or "day date" for a day header. */
    focused: () =>
      page.evaluate(() => {
        const el = document.activeElement;
        return el?.dataset.date ? `${el.dataset.habit ?? "day"} ${el.dataset.date}` : (el?.tagName ?? "nothing");
      }),
    base,
  };
  return t;
}

const wanted = process.argv.slice(2);
const chosen = scenarios.filter((s) => wanted.length === 0 || wanted.some((word) => s.name.includes(word)));
if (chosen.length === 0) {
  console.error(`No scenario matches ${wanted.join(", ")}. There are: ${scenarios.map((s) => s.name).join(", ")}`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// Its own port, so it can run beside `npm run tauri dev`.
const server = await createServer({ logLevel: "warn", server: { port: 1431, strictPort: false, host: "127.0.0.1" } });
await server.listen();
const base = `http://127.0.0.1:${server.config.server.port}/dev/preview.html`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

let failures = 0;
for (const scenario of chosen) {
  const page = await browser.newPage();
  await page.setViewport({ ...(scenario.size ?? WIDE), deviceScaleFactor: 2 });
  const errors = [];
  /** Everything the page logs, of any kind, and everything it asks the network for: for checking that a text is in none of it. */
  const said = [];
  page.on("pageerror", (e) => {
    errors.push(`uncaught: ${e.message}`);
    said.push(`${e.message}\n${e.stack ?? ""}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
    said.push(message.text());
  });
  // The webview makes no network calls: everything it loads comes from the app itself.
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "data:" && url.host !== new URL(base).host) errors.push(`network: ${request.url()}`);
    said.push(`${request.url()}\n${request.postData() ?? ""}`);
  });
  const t = tools(page, scenario.name, base, said);
  try {
    await page.goto(`${base}?today=2026-11-17&${scenario.query ?? ""}`);
    if (!scenario.query?.includes("folder=none")) await t.ready();
    await scenario.run(t);
    assert.deepEqual(errors, [], "the page logged errors");
    console.log(`ok    ${scenario.name}: ${scenario.about}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${scenario.name}: ${scenario.about}\n${e.stack ?? e}\n`);
    await page.screenshot({ path: `${OUT}FAILED-${scenario.name}.png` }).catch(() => {});
  }
  await page.close();
}

await browser.close();
await server.close();
console.log(failures ? `${failures} of ${chosen.length} scenarios failed` : `${chosen.length} scenarios passed. Screenshots are in .shots/`);
process.exit(failures ? 1 : 0);
