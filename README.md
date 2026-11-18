# Wetware

A macOS habit tracker modeled on a bullet-journal monthly spread. Habits run down the left side and each day of the month is a box. Training, sleep, HRV, and weather fill themselves in from intervals.icu and Open-Meteo. You fill in the rest by hand in seconds. It also has a distraction-free morning pages room and a dot-sticker calendar.

No streaks. No cloud. Your data lives in plain markdown files you own, and they're Obsidian-compatible.

> Working title. v1 is a personal tool for one user on one Mac.

## Status

Milestones 1 to 5 are built: the app launches, you choose a data folder, `habits.yaml` is seeded, settings persist, the intervals.icu key is stored in the Keychain, the month grid reads and writes day files for every habit type, sync fills in what intervals.icu and Open-Meteo have, each day opens into a view of its own with its values, their sources and its notes, and morning pages have a writing room. The dot calendar and the monthly roll-up are next. Build order is in [`SPEC.md` §11](SPEC.md#11-milestones).

Sync has been built against the intervals.icu API documentation and made-up responses, not against a real account: see [Sync](#sync) for what that leaves unconfirmed.

## Docs

| File | What it is |
|------|------------|
| [`SPEC.md`](SPEC.md) | Full product and build spec. **This is the source of truth.** |
| [`AGENTS.md`](AGENTS.md) | Instructions for coding agents: where to start, rules, open questions |
| [`design/reference.png`](design/reference.png) | Visual direction (Swiss / International Typographic Style) |

## Stack

- **Tauri 2** + React + TypeScript + Vite. Tauri worked without friction, so the Electron fallback wasn't needed.
- Storage: markdown + YAML frontmatter in a user-chosen folder
- Secrets: macOS Keychain (`keyring` crate)
- Data sources: intervals.icu (activities + wellness), Open-Meteo (weather). The Rust shell makes every network call (`ureq`); the webview has no network access.

## Run it

Needs macOS (Apple Silicon), Node 20+, Rust (`rustup`), and Xcode Command Line Tools.

```sh
npm install
npm run tauri dev     # run the app
npm test              # data layer tests
(cd src-tauri && cargo test)   # shell tests
npm run shots         # screenshots of the UI into .shots/, with end-to-end checks
```

`(cd src-tauri && cargo test -- --ignored)` runs the one test that uses the network: it asks the real Open-Meteo for three days of Berlin weather. Nothing in the tests calls intervals.icu.

`npm run shots` needs Google Chrome (set `CHROME_PATH` if it isn't in `/Applications`). It runs the real app in a browser tab over a mocked shell and the made-up data folder in `test/fixtures/data-folder/`, with the date pinned to 2026-11-17. The same page can be opened by hand: `npm run dev`, then `http://localhost:1420/dev/preview.html`.

## How it's put together

| Path | What it is |
|------|------------|
| `src/styles/tokens.css` | Every color, font, size, space, and rule weight. Restyle the app here. |
| `src/data/` | Pure TypeScript data layer: habits, settings, day files. No React. |
| `src/data/pages.ts` | The one module that reads and writes morning pages text. Only the writing room may read it. |
| `src/sync/` | Pure TypeScript sync rules: source JSON in, day values and their sources out. No React, no network. |
| `src/platform/tauri.ts` | The only place the UI talks to the Rust shell. |
| `src/screens/`, `src/components/` | React UI. No raw colors or sizes; tokens only. |
| `src-tauri/` | Rust shell: file access limited to the data folder, folder dialog, Keychain, and the two fetches sync makes (`net.rs`). |
| `dev/` | The browser preview and the screenshot script. Not part of the app bundle. |

A read or write the shell never answers is given up on after 30 seconds, with a message, so that one stuck file can't hold up the rest. The shell lets writes to one file land one at a time, in the order they were asked for, so a write that was given up on and lands late lands before any newer one, never over it.

**Closing and quitting.** A window asked to close, or the app asked to quit from its menu (⌘Q), is held by the shell while it asks the app to save what is being typed, and closes when the app answers or after 3 seconds, whichever is first. The Quit menu item is the app's own for this reason; the system's would quit without asking. Quitting from the Dock, or the Mac shutting down, is not held. With `WETWARE_TRACE=1` the shell prints `flush_asked`, then `flush_answered` or `flush_timed_out`.

The shell gives each opening of the data folder a number. Every file command carries the number it was given, and the shell refuses one whose number is stale, so nothing worked out for one folder (a sync, a cell edit) can be written into another.

The data folder's location is kept in the app's own config (`~/Library/Application Support/com.brianokarski.wetware/config.json`), since it can't live inside the folder it points to. So is the time of the last sync. The intervals.icu key can be saved or removed from the UI but is never handed back to it; sync reads it on the Rust side and sends it only to intervals.icu.

## The day view

Click a day's number in the grid (or press Enter on it) to open that day. Escape, or Month, goes back.

- Every habit's value can be edited there, with the same rules as the grid. Each shows where it came from: `manual`, `intervals`, `open-meteo`, or `unrecorded` for a value the file has no `_sources` entry for.
- A value sync is keeping its hands off (set by hand, no source on record, or a source the app doesn't know) has a "Use synced value" action, where a sync could fill it: the habit's rule is set up, and the day is one a sync still covers (the current month and the seven days before it). It removes the key and its `_sources` entry from the file. The next sync then writes what intervals.icu has for that day, and leaves it empty if it has nothing.
- A habit's key that holds something the habit can't (`weight_lb: 182 lb`, `run: "yes"`) is shown in the habit's row as written, marked not readable. It stays in the file until you enter a value.
- Below the habits: what sync logged by itself (HRV, resting heart rate, sleep score, weather), and then everything else in the frontmatter, read-only and as written. That is your own keys, archived habits' values, tags no habit shows, `_synced_at`, a `date` that isn't the file's, and `_sources` entries no row shows. Every frontmatter key is shown in one of these places.
- Notes are the body of the day's file, as plain text; markdown is not rendered. Saving notes writes only the body: the frontmatter is left byte for byte as it is, and a file that had none (plain text) still has none, unless the notes themselves would then read as frontmatter, in which case the file is given a `date` of its own first.
- Notes save a moment (0.8 s) after typing stops, at least every 3 s while it doesn't, and at once when you leave the field or the day, or the window goes to the background, is hidden or is asked to close.
- A day whose file can't be read or parsed shows the problem and the file's path, and nothing in it can be changed from the app.

**If the file changes outside the app while the day is open** (in Obsidian, say):

- When the window comes back to the front, the open day is read again. Values follow the file. Notes follow it too, if nothing unsaved is typed here.
- Notes are only ever saved over the text they were typed from. If the file's notes have changed since, nothing is written. The typing stays in the field, and the app asks: "Keep what is typed here" writes it over the file's text; "Take the file's text" puts the file's text in the field. Until you choose, nothing is saved and the day can't be left.
- Values don't need the question: each is written as its own key, beside whatever else changed.

## Morning pages

The writing room takes the whole window: no navigation, no message line, only the date, how far along the writing is, and the text. Three ways in: "Pages" in the navigation (today's pages), the quiet line beside the month's name while today's pages are short of their goal, and the Morning pages box of today or any past day in the grid (click it, or press Enter on it). Escape, or Leave, goes back to the month.

- The text is one field. Every 250 words a new page begins, and its number is set in the margin beside the line it begins on. The strip at the top says which page the writing has reached ("page 2 of 3") and the count against the goal ("412 / 750 words"). The goal is the Morning pages habit's, set in Settings. Reaching it changes nothing in the room; in the grid, the day's box gets its ✕.
- A word is whatever is left when the text is split on white space. Writing with no spaces between words counts by its runs.
- It saves as notes do: a moment (0.8 s) after typing stops, at least every 3 s while it doesn't, and at once when you leave the room or the window goes to the background, is hidden or is asked to close.
- The room is not left with text that isn't on disk. Leaving waits for the last save to land. If it can't be made (a full disk, a locked file), the room stays open and says why; the only way out then is "Leave without saving".
- "Pages" and "Write" mean today as the clock has it at the moment you press them, so pages begun just after midnight go to the new day's file.
- There is no timer, and nothing is said about other days.

**Where the text goes.** Into `pages/YYYY-MM-DD.md`, exactly as typed, and nowhere else. The only thing that leaves is the word count, written to the day file as the Morning pages habit's value (`morning_pages_words`) with `morning_pages` as its source.

- One module (`src/data/pages.ts`) reads and writes these files. Two of its functions are for the writing room alone, which imports them from the module itself: the one that hands over the text, and the one that says where a day's pages are kept. Other screens get numbers (how many words a day's pages hold) and nothing else.
- `test/pages.privacy.test.ts` reads the source and fails if:
  - the module exports anything that is not on the test's own list, or the data layer's front door passes on anything but that list less the room's two;
  - anything but the room names either of those two functions, or imports the module directly;
  - anything but the module names the pages folder, in any case (`Pages/` is the same folder to the file system);
  - a screen reads a file for itself, where files are read by the data-layer modules that own them;
  - the app gains anywhere for text to go: browser storage, the console, a network call of its own.
- What that test can't see is a path put together at run time from pieces. The scenario below is the check on what the app does, whatever its source says.
- A screenshot scenario (`pages-private`) writes a phrase in the room and then looks for it everywhere else: every other file, browser storage, everything logged, everything sent to the shell, anything hung on the window. It has to be in the pages file only.
- Messages about a pages file name the file and never quote it.
- The shell creates files under `pages/`, and the folder itself, readable and writable by you alone (`0600`, `0700`). A file that is already there keeps the permissions it has.
- The field asks the system not to write suggestions for it (`writingsuggestions="false"`: inline predictions). That is the one switch a page has. macOS Writing Tools, Look Up, Translate and dictation are the system's own, offered on any text field of any app; they act only when you invoke them, and some of them send the selected text to Apple. The app can't turn them off from inside the web view.

**The count.**

- The room keeps the day file's count while the count is its own: there is none (an empty count is nobody's, whoever emptied it), or `_sources` says `morning_pages`. It counts whatever text it shows, not only what was typed in it: pages written or changed in another app are counted when the room next opens on them and is left.
- Emptying the text takes the count back out, with its `_sources` entry, and `_sources` itself if that was its only entry. A day file that then holds nothing but its own date, exactly as the app writes one, is removed.
- A count set by hand is left as it is: one `_sources` calls `manual` (a number typed on the Morning pages box in the grid, or into the day view), or one with no `_sources` entry at all. The room still saves the text, and says below it that the count is not its own.
- To give such a count back to the room, open the day: where the day has pages, the Morning pages row has "Use the room's count", which sets it to the number of words the pages hold. Or clear it, and the room counts the day the next time it is open.
- Backspace and Delete on a Morning pages box do nothing to a count the room wrote. They clear one set by hand.
- If the text is saved and the count can't be (the day file needs fixing by hand, say), the room says so, and the count is written by the next save that can.

**If the file changes outside the app while the room is open**, the rule is the day view's: the text is only ever saved over the text it was typed from. Coming back to the window, the file is read again, and taken as it is if nothing unsaved is typed. If something is, nothing is written and the room asks whether to keep what is typed or take the file's text. Until you choose, nothing is saved and the room can't be left.

## Sync

Sync runs when a data folder opens and when you press Sync in the month's header. It covers the seven days before the first of the current month through today, and writes only the day files whose values change.

- **intervals.icu** (needs an API key, in Settings): sleep in hours, HRV, resting heart rate, sleep score, weight if a day has one, and a tick for each activity habit on days with a matching activity.
- **Open-Meteo** (needs a latitude and longitude, in Settings): each day's high, low, precipitation and a one-word condition.

The two are independent: either works without the other.

What sync will and won't write:

- A value you set by hand is never written over. That means any key whose `_sources` entry is `manual`, and any value that has no `_sources` entry at all (typed into the file in Obsidian, say). To hand a value back to sync, delete its key and its `_sources` line.
- The reverse is not protected: if you change a value in Obsidian and leave its `_sources` entry saying `intervals` or `open-meteo`, the next sync puts the source's value back. Change the entry to `manual` (the app does this itself when you edit in the grid).
- An activity habit is `false` only on a day the watch was plainly alive (some activity, or a wellness record with something a device measured) and everything done that day can be read. A day with nothing from the source is left unwritten and shows as "no data".
- Activities that reached intervals.icu through Strava arrive with no detail and are not counted. Settings says how many there were. A day that has one gets no `false`, since it might have been the very thing, and a `false` sync wrote there earlier is taken back.
- Records sync can't place (a date or start time in a form it doesn't expect, an activity with no type) are left out and counted. The sync message and Settings say how many.

**Lift and Climb are not set up yet.** Their `source_rule.activity_types` lists in `habits.yaml` are empty, so sync leaves them alone. In Settings, "Test connection" lists the activity types in your own data for the last 90 days with a count of each. Put the ones that count into the list, spelled as shown (case doesn't matter):

```yaml
  - id: lift
    source_rule:
      activity_types: [WeightTraining]
      min_minutes: 0
```

### Not yet confirmed against a real account

There was no API key when this was built, so intervals.icu has never been called. Field names come from its OpenAPI document (`https://intervals.icu/api/v1/docs`); the fixtures in `test/fixtures/sync/` are made up to match it. Still to be confirmed with real data:

- that `weight` is in kilograms (the document gives no unit);
- the exact form of `start_date_local` and of a wellness record's `id`;
- what a Strava stub looks like (taken from forum posts: `source: STRAVA` and no `type`);
- which wellness fields only a device writes. A day counts as "the watch was on" if it has sleep time or score, sleeping or resting heart rate, HRV, SpO2, respiration, steps or floors. Most of these can also be typed into intervals.icu by hand;
- that a key which is wrong answers 401 or 403, and that rate limiting answers 429;
- the Keychain read from the Rust side in a built, signed app.

Open-Meteo needs no key and was checked for real: `test/fixtures/sync/open-meteo-berlin.json` is a captured response.
