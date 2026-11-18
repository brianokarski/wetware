# Wetware

A macOS habit tracker modeled on a bullet-journal monthly spread. Habits run down the left side and each day of the month is a box. Training, sleep, HRV, and weather fill themselves in from intervals.icu and Open-Meteo. You fill in the rest by hand in seconds. It also has a distraction-free morning pages room and a dot-sticker calendar.

No streaks. No cloud. Your data lives in plain markdown files you own, and they're Obsidian-compatible.

> Working title. v1 is a personal tool for one user on one Mac.

## Status

Milestones 1 and 2 are built: the app launches, you choose a data folder, `habits.yaml` is seeded, settings persist, the intervals.icu key is stored in the Keychain, and the month grid reads and writes day files for every habit type. Sync is next. Build order is in [`SPEC.md` §11](SPEC.md#11-milestones).

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
- Data sources (from Milestone 3): intervals.icu (activities + wellness), Open-Meteo (weather)

## Run it

Needs macOS (Apple Silicon), Node 20+, Rust (`rustup`), and Xcode Command Line Tools.

```sh
npm install
npm run tauri dev     # run the app
npm test              # data layer tests
(cd src-tauri && cargo test)   # shell tests
npm run shots         # screenshots of the UI into .shots/, with end-to-end checks
```

`npm run shots` needs Google Chrome (set `CHROME_PATH` if it isn't in `/Applications`). It runs the real app in a browser tab over a mocked shell and the made-up data folder in `test/fixtures/data-folder/`, with the date pinned to 2026-11-17. The same page can be opened by hand: `npm run dev`, then `http://localhost:1420/dev/preview.html`.

## How it's put together

| Path | What it is |
|------|------------|
| `src/styles/tokens.css` | Every color, font, size, space, and rule weight. Restyle the app here. |
| `src/data/` | Pure TypeScript data layer: habits, settings, day files. No React. |
| `src/platform/tauri.ts` | The only place the UI talks to the Rust shell. |
| `src/screens/`, `src/components/` | React UI. No raw colors or sizes; tokens only. |
| `src-tauri/` | Rust shell: file access limited to the data folder, folder dialog, Keychain. |
| `dev/` | The browser preview and the screenshot script. Not part of the app bundle. |

The data folder's location is kept in the app's own config (`~/Library/Application Support/com.brianokarski.wetware/config.json`), since it can't live inside the folder it points to. The intervals.icu key can be saved or removed from the UI but is never handed back to it; sync will read it on the Rust side.
