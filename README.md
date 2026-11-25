# Wetware

A macOS habit tracker laid out like a bullet-journal monthly spread. Your habits run down the left side and every day of the month gets a box. Training, sleep, heart-rate data and weather fill themselves in from intervals.icu and Open-Meteo. Everything else takes a click or a keystroke.

No streaks. No cloud. No accounts. Your data lives in plain markdown files in a folder you choose, and they open cleanly in Obsidian.

> Working title, and the current look is temporary. The name and design get a full branding pass once the app works end to end (M11). v1 is a personal tool for one person on one Mac.

## The idea

Most habit trackers run on streaks and guilt. Wetware runs on data. It shows you a month of boxes and lets the pattern show up by itself. You can see "Run 14/30" or a page full of dots, but never "you broke your streak."

The other idea is that logging should cost almost nothing. A watch already records runs, sleep and HRV, so Wetware pulls those in itself. You only type in what nothing else can know, like your mood, brain fog, or whether you meditated.

## What's in it

- **The month.** The home screen. Habits down the left, days across the top, a count for each habit at the right edge. Synced values fill in when the app opens; you fill in the rest with a click or the keyboard.
- **A day.** Everything about one day: each value and where it came from (your watch, the weather, or you), plus free-form notes.
- **Morning pages.** A full-window writing room with nothing else on screen. Three pages (750 words) is the goal. The writing stays in its own private file; only the word count goes anywhere else.
- **Calendar** *(coming next)*. A month calendar with a colored dot sticker on each day you did a habit.
- **Analysis** *(planned)*. Put any piece of data against any other (sleep, mood, HRV, training, weather, habits) to find patterns you wouldn't have noticed.
- **Settings.** Your data folder, intervals.icu key, weather location, units and morning pages goal.

## What it promises

- **No streaks, anywhere.** Counts only.
- **Your files are the database.** One markdown file per day. Edit them in Obsidian if you want; the app keeps anything it didn't write.
- **A dead watch isn't a miss.** If a synced habit has no data, it says *no data*, not empty. Misses never get red or shame styling.
- **What you type wins.** Sync never overwrites a value you set by hand.
- **Morning pages are private.** The text never leaves `pages/`, and never goes into a summary, export, log, or network call.
- **Nothing leaves your Mac** except the two fetches sync makes (intervals.icu and Open-Meteo). Your API key lives in the macOS Keychain. No telemetry.

## Your data folder

```
<your folder>/
  habits.yaml          # your habits
  settings.yaml        # location, units, goals (no secrets)
  days/2026-11-17.md   # one file per day: values + notes
  pages/2026-11-17.md  # morning pages, private
  months/2026-11.md    # monthly summary (coming next)
```

## Status

| | Milestone | What it adds | |
|-|-----------|--------------|-|
| M1 | Skeleton | The app, your data folder, settings, Keychain | ✅ |
| M2 | Month grid | The home screen, filled in by hand | ✅ |
| M3 | Sync | Watch and weather data fill in by themselves | ✅ |
| M4 | Day view | One day in full, with notes | ✅ |
| M5 | Morning pages | The writing room | ✅ |
| M6 | Calendar and monthly summary | Dot calendar, counts, `months/` file | next |
| M7 | Live with it | Real data, daily use, a friction log | planned |
| M8 | Interaction design | How the whole app behaves, designed as a whole | planned |
| M9 | Build to the design | Screens reworked, habit editor | planned |
| M10 | Analysis | Put any piece of data against any other | planned |
| M11 | Redesign + branding | Name, identity, and the final look | planned |

Why it's in this order, and what each milestone holds: [`docs/roadmap.md`](docs/roadmap.md).

Until the habit editor lands (M9), habits are edited in `habits.yaml`.

Sync hasn't been tried against a real intervals.icu account yet.

## Run it

Needs macOS (Apple Silicon), Node 20+, Rust (`rustup`), and Xcode Command Line Tools.

```sh
npm install
npm run tauri dev
```

Built with Tauri 2, React and TypeScript.

## Docs

| File | For |
|------|-----|
| [`SPEC.md`](SPEC.md) | The full product spec. Source of truth. |
| [`docs/roadmap.md`](docs/roadmap.md) | What comes next and why, milestone by milestone |
| [`docs/how-it-works.md`](docs/how-it-works.md) | Developer reference: tests, code layout, edge-case behavior, sync rules, what's unconfirmed |
| [`AGENTS.md`](AGENTS.md) | Rules and workflow for coding agents |
| [`design/reference.png`](design/reference.png) | Visual direction (Swiss / International Typographic Style) |
