# AGENTS.md — start here

You're building **Wetware**, a local-first macOS habit tracker. Read [`SPEC.md`](SPEC.md) end to end before writing code. Everything in it is decided except §10. This file covers what the spec doesn't: where to start, house rules, and current open questions.

## Hard rules (from SPEC §2; don't break these)

1. **No streaks, anywhere.** No streak counters, "don't break the chain" copy, fire icons, or badges. Show counts ("Run 14/30"), never streaks.
2. **Files are the source of truth.** All user data lives in plain `.md`/`.yaml` files in the user's data folder. A cache is fine, but a database as the primary store isn't.
3. **Preserve what you don't own.** When you rewrite a day file, keep unknown frontmatter keys and the markdown body exactly as they were.
4. **Morning pages text never leaves `pages/`.** Don't put it in roll-ups, exports, logs, or any network call. Only the word count may be used elsewhere.
5. **`no_data` ≠ `missed`.** If a synced habit has no data from its source, render it as `no_data`. Only a manual habit with an empty past day counts as a miss, and a miss gets no red or shame styling.
6. **Secrets go in the Keychain only.** The intervals.icu API key must never be written to the data folder, `settings.yaml`, logs, or git.
7. **No accounts, servers, telemetry, or Strava integration.**

## Where to start

Work through SPEC §11 in order. Each milestone should leave the app runnable.

**Current state:** Milestones 1–5 are built and merged into `main`. Read [`docs/how-it-works.md`](docs/how-it-works.md) for how the app behaves today, and keep it current as you build. The README is the product overview: update its Status table when a milestone lands, but put behavior details, edge cases and caveats in `docs/how-it-works.md`, not the README. Next is **M6: dot calendar, monthly counts, and the monthly roll-up file** (SPEC §6.3, §8.3). The M1/M2 notes below are kept for context.

### Milestone 1: Skeleton (do this first)

1. Scaffold Tauri 2 + React + TS + Vite at the repo root (`npm create tauri-app@latest`, React/TS template). If Rust isn't installed, install it with `rustup`. If Tauri fights you, Electron is allowed; record the decision in `docs/how-it-works.md`.
2. **Token layer first.** Create `src/styles/tokens.css` (or `tokens.ts`) to hold every color, font, size, spacing, and rule weight. Components must not contain raw hex values or pixel sizes. Brian is a brand designer and will restyle by editing this one file.
   - Fonts: Inter Tight (bold, tight tracking, leading ~0.95–1.0) for the grotesk, and JetBrains Mono or IBM Plex Mono for metadata. Self-host them; no Google Fonts CDN.
   - Grayscale: black, white, one or two grays, and 1px black hairlines. No radius, shadows, or cards. Habit dot colors are the only color in the app.
3. **Data layer as a pure TS module** (`src/data/`) with no React imports, so it can be unit tested:
   - Read/write `habits.yaml` and `settings.yaml`.
   - Read/write `days/YYYY-MM-DD.md` with YAML frontmatter plus the body, using a round-trip-safe parser. Write a test proving unknown keys and the body survive a rewrite.
   - Seed the habits from SPEC §5.4 the first time the app runs.
4. **Settings screen:** choose a data folder (native dialog), set the location, units, and morning pages goal.
5. **Keychain:** store and read the intervals.icu key (e.g. `tauri-plugin-keyring` / the `keyring` crate). A "Test connection" button can wait until Milestone 3, but build the storage now.

**Done when:** the app launches, you can pick a folder, seeded `habits.yaml` appears in it, settings persist across restarts, and `npm test` passes the day-file round-trip test.

### Then

- **M2 Grid:** build this as a typographic table, not a widget (see reference: hairline-ruled key/value table). Click or Enter toggles and edits, arrow keys move between cells. Apply all five cell states from §5.3.
- **M3 Sync:** before hard-coding any activity type strings, **inspect real intervals.icu data** (`GET /athlete/0/activities`) and log the distinct `type` values. Verify Open-Meteo endpoint shapes against its current docs.
- **M4–M7:** follow the spec.
- **M8 Redesign + branding:** starts only once SPEC §12 passes. Brian leads the branding exploration; your job is to make the redesign cheap. Until then, keep every visual decision in the token layer and don't spend time on visual polish that M8 will replace.

## Suggested layout

```
src/
  data/        # pure TS: files, frontmatter, habits, day model, roll-up generation
  sync/        # intervals.ts, weather.ts: fetch → normalized day values + _sources
  screens/     # Grid, DayPanel, DotCalendar, MorningPages, HabitEditor, Settings
  components/  # small typographic primitives (Rule, MonoLabel, Display, Cell)
  styles/      # tokens.css + global.css
src-tauri/     # Rust shell: fs scope, dialog, keychain
```

## Working conventions

- Small commits with clear messages. Work each milestone on its own branch (`m6-dot-calendar`, …), branched from an up-to-date `main`; don't push directly to `main`.
- **Finish a milestone by merging it.** Open a PR, and once the checks below pass, merge it into `main` (merge commit) and delete the branch. Start the next milestone from `main`. Don't stack milestone branches on each other.
- **A milestone is done only when all of these pass on its last commit:** `npx tsc --noEmit`, `npm test`, `npm run shots`, `(cd src-tauri && cargo test)`, and `(cd src-tauri && cargo clippy --all-targets)` with no warnings. Never end a session on an unverified `WIP` commit without saying so in the PR.
- Add unit tests for the data layer, sync normalization (intervals → day values, `no_data` logic), and roll-up generation. UI tests are optional.
- Never commit a real data folder or an API key. Use fixtures in `test/fixtures/` with fake data.
- If the code lives in Dropbox, mark `node_modules/` and `src-tauri/target/` as ignored so they don't sync: `xattr -w com.dropbox.ignored 1 <dir>`. Note that `npm ci` deletes and recreates `node_modules/`, which can drop the flag; check it with `xattr -p com.dropbox.ignored node_modules`.

## Open questions — ask Brian, don't guess

From SPEC §10. Items 3–5 need answers before the milestone noted next to them.

| # | Question | Blocks | Proposed default (not yet confirmed) |
|---|----------|--------|-------------------------------------|
| 1 | Final app name | M8 (branding) | keep "Wetware" until M8 |
| 2 | Day notes OK to send to AI in v2? | v2 only | yes for notes, never morning pages |
| 3 | intervals.icu activity types for Lift and Climb | M3 | read them from real data |
| 4 | Weight: manual only, or sync if intervals ever has it? | M3 | manual, sync if a value appears |
| 5 | Grid habit order: fixed, or grouped (body / mind / tags)? | M2 | fixed, user-reorderable |

Also unconfirmed: the default data folder path (proposed `~/Documents/Wetware Data`) and the weather city.
