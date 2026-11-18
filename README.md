# Wetware

A macOS habit tracker modeled on a bullet-journal monthly spread. Habits run down the left side and each day of the month is a box. Training, sleep, HRV, and weather fill themselves in from intervals.icu and Open-Meteo. You fill in the rest by hand in seconds. It also has a distraction-free morning pages room and a dot-sticker calendar.

No streaks. No cloud. Your data lives in plain markdown files you own, and they're Obsidian-compatible.

> Working title. v1 is a personal tool for one user on one Mac.

## Status

Planning is done and no code exists yet. Build order is in [`SPEC.md` §11](SPEC.md#11-milestones).

## Docs

| File | What it is |
|------|------------|
| [`SPEC.md`](SPEC.md) | Full product and build spec. **This is the source of truth.** |
| [`AGENTS.md`](AGENTS.md) | Instructions for coding agents: where to start, rules, open questions |
| [`design/reference.png`](design/reference.png) | Visual direction (Swiss / International Typographic Style) |

## Stack (planned)

- Tauri 2 + React + TypeScript (Electron is an acceptable fallback; see SPEC §4)
- Storage: markdown + YAML frontmatter in a user-chosen folder
- Secrets: macOS Keychain
- Data sources: intervals.icu (activities + wellness), Open-Meteo (weather)

## Setup

_To be written in Milestone 7._ Expected prerequisites: macOS (Apple Silicon), Node 20+, Rust (`rustup`), and Xcode Command Line Tools.
