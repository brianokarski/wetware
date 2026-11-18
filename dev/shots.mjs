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
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = fileURLToPath(new URL("../.shots/", import.meta.url));
const WIDE = { width: 1280, height: 820 };
const SMALL = { width: 960, height: 600 };
const TODAY_FILE = "days/2026-11-17.md";

/** The frontmatter lines of a day file, for comparing what changed. */
const lines = (text) => text.split("\n");
/** Lines in `after` that aren't in `before`, and the other way round. */
function changed(before, after) {
  const [a, b] = [lines(before), lines(after)];
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
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

      // Escape leaves the file alone. So does input that isn't a number, which is also explained.
      const saved = await t.file(TODAY_FILE);
      await t.click("weight", 17);
      await t.page.keyboard.type("9");
      await t.page.keyboard.press("Escape");
      await t.click("weight", 16);
      await t.page.keyboard.type("abc");
      await t.page.keyboard.press("Enter");
      assert.match(await t.problem(), /Weight takes a number/);
      assert.equal(await t.file(TODAY_FILE), saved);
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
      await t.click("morning_pages", 17); // progress
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
      // One tab stop: past the three month buttons, into the grid at today, and out the far side.
      for (let i = 0; i < 4; i++) await key("Tab");
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
      await key("Home");
      assert.equal(await t.focused(), "weight 2026-11-01");
      await key("ArrowLeft");
      assert.equal(await t.focused(), "weight 2026-11-01");
      await key("End");
      assert.equal(await t.focused(), "weight 2026-11-30");
      await key("ArrowUp");
      assert.equal(await t.focused(), "day 2026-11-30");
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

      // A day header is a button: Enter presses it and nothing else happens (the day panel is Milestone 4).
      for (let i = 0; i < 6; i++) await key("ArrowUp");
      assert.equal(await t.focused(), "day 2026-11-18");
      await key("Enter");
      assert.equal(await t.problem(), null);
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
      await t.page.waitForFunction(() => document.querySelector(".app-main > .mono")?.textContent.includes("was not saved"));
      await t.saved();
      assert.equal(await t.state("meditate", 17), "pending");
      assert.equal(await t.file(TODAY_FILE), before);
      assert.match(await t.problem(), /Meditate was not saved\. No space left on device/);
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
function tools(page, name, base) {
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
    /** The message on the error line, or null. */
    problem: () => page.evaluate(() => document.querySelector(".app-main > .mono")?.textContent ?? null),
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
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  const t = tools(page, scenario.name, base);
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
