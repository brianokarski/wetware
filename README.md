# Wetware

A macOS habit tracker modeled on a bullet-journal monthly spread. Habits run down the left side and each day of the month is a box. Training, sleep, HRV, and weather fill themselves in from intervals.icu and Open-Meteo. You fill in the rest by hand in seconds. It also has a distraction-free morning pages room and a dot-sticker calendar.

No streaks. No cloud. Your data lives in plain markdown files you own, and they're Obsidian-compatible.

> Working title. v1 is a personal tool for one user on one Mac.

## Status

Milestones 1 to 3 are built: the app launches, you choose a data folder, `habits.yaml` is seeded, settings persist, the intervals.icu key is stored in the Keychain, the month grid reads and writes day files for every habit type, and sync fills in what intervals.icu and Open-Meteo have. The day panel is next. Build order is in [`SPEC.md` §11](SPEC.md#11-milestones).

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
| `src/sync/` | Pure TypeScript sync rules: source JSON in, day values and their sources out. No React, no network. |
| `src/platform/tauri.ts` | The only place the UI talks to the Rust shell. |
| `src/screens/`, `src/components/` | React UI. No raw colors or sizes; tokens only. |
| `src-tauri/` | Rust shell: file access limited to the data folder, folder dialog, Keychain, and the two fetches sync makes (`net.rs`). |
| `dev/` | The browser preview and the screenshot script. Not part of the app bundle. |

The data folder's location is kept in the app's own config (`~/Library/Application Support/com.brianokarski.wetware/config.json`), since it can't live inside the folder it points to. So is the time of the last sync. The intervals.icu key can be saved or removed from the UI but is never handed back to it; sync reads it on the Rust side and sends it only to intervals.icu.

## Sync

Sync runs when a data folder opens and when you press Sync in the month's header. It covers the seven days before the first of the current month through today, and writes only the day files whose values change.

- **intervals.icu** (needs an API key, in Settings): sleep in hours, HRV, resting heart rate, sleep score, weight if a day has one, and a tick for each activity habit on days with a matching activity.
- **Open-Meteo** (needs a latitude and longitude, in Settings): each day's high, low, precipitation and a one-word condition.

The two are independent: either works without the other.

What sync will and won't write:

- A value you set by hand is never written over. That means any key whose `_sources` entry is `manual`, and any value that has no `_sources` entry at all (typed into the file in Obsidian, say). To hand a value back to sync, delete its key and its `_sources` line.
- An activity habit is `false` only on a day the watch was plainly alive (some activity, or a wellness record with something measured). A day with nothing from the source is left unwritten and shows as "no data".
- Activities that reached intervals.icu through Strava arrive with no detail and are not counted. Settings says how many there were.

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
- that a key which is wrong answers 401 or 403, and that rate limiting answers 429;
- the Keychain read from the Rust side in a built, signed app.

Open-Meteo needs no key and was checked for real: `test/fixtures/sync/open-meteo-berlin.json` is a captured response.
