# Wetware — Product & Build Spec (v1)

> **For the agent picking this up:** read this whole file before writing code. Section 10 lists open questions — ask Brian rather than guessing on those. Everything else is decided.

> Wetware keeps the record the body won't. Every morning it pulls what the watch saw in the dark — hours of sleep, the slow drum of a resting heart, the miles run in the gray before the city woke — and lays it down in a grid of small boxes, the color of ink on cheap paper. You fill in the rest by hand. No streaks, no sirens. Just a month of signal building up like static on a dead screen, until the pattern surfaces on its own.

Working title: **Wetware** (placeholder name — may change before any public release)
Owner: Brian
Status: planning complete for v1, ready to build
Last updated: 2026-11-23

---

## 1. What this is

A desktop habit tracker modeled on a **bullet journal monthly spread**: habits listed down the left, one box per day of the current month across the top. As much as possible fills itself in from connected data (training, sleep, weather) so daily logging is never a chore. Includes a distraction-free **morning pages** writing room, a **dot-sticker calendar** view, and (later) **graphs** and **AI analysis** across habits.

**v1 is for Brian only, on his Mac.** Build it so it *could* become a product later, but don't build accounts, servers, or multi-user anything now.

## 2. Principles (non-negotiable)

1. **Low burden beats completeness.** Automate everything possible. Manual entry should take seconds.
2. **No streaks. Ever.** No streak counters, no "you broke your streak" messaging, no fire emojis. This is about data and doing what you can. Positive reinforcement comes from *seeing* the month (dots, counts like "Run 14/30"), not from gamification.
3. **The user owns their data.** All data is stored locally as plain files the user can read, move, and back up. No cloud backend. No telemetry.
4. **Morning pages are private.** Their text is never sent to any AI or external service. Only metadata (wrote yes/no, word count) can be used elsewhere.
5. **A missed box means a missed day** — for manual habits. For synced habits, absence of data is shown as *no data*, not as a miss (see §5.3).

## 3. v1 scope

| # | Feature | In v1 |
|---|---------|-------|
| 1 | Monthly grid (bullet-journal spread) | ✅ |
| 2 | Typed habits (create/edit/reorder/archive) | ✅ |
| 3 | intervals.icu sync (activities + wellness) | ✅ |
| 4 | Weather auto-log | ✅ |
| 5 | Day notes (comment on any day) | ✅ |
| 6 | Morning pages writing room | ✅ |
| 7 | Dot calendar view + monthly counts | ✅ |
| 8 | Local markdown storage (Obsidian-compatible) | ✅ |
| 9 | Graphs screen | ⏭ v2 |
| 10 | AI analysis | ⏭ v2 |
| 11 | More background sources (calendar load, screen time, air quality, daylight) | ⏭ v2 |
| 12 | iPhone app | ⏭ later |
| 13 | Multi-user product / sync server | ⏭ later |

AI is deliberately deferred: it needs ~2+ months of clean data before correlations mean anything.

## 4. Platform & stack

- **Target:** macOS desktop.
- **Recommended:** Tauri 2 + React + TypeScript. Small bundle, native file system access, secure storage for the API key. Electron is acceptable if Tauri causes friction — agent's call, document the choice in the README.
- **Storage:** plain markdown files with YAML frontmatter in a user-chosen folder (§6). An in-memory or SQLite cache is fine for speed, but **files are the source of truth**.
- **Secrets:** intervals.icu API key stored in the macOS Keychain (via Tauri's secure storage or equivalent), never in the data folder or in git.
- **Sync model:** sync runs when the app opens and on a manual "Sync" button. No background daemon in v1.

## 5. Habits

### 5.1 Habit types

When creating a habit, the user picks a type. The type controls input UI, storage, grid rendering, and (later) charting.

| Type | Example | Stored as | Grid cell shows |
|------|---------|-----------|-----------------|
| `check` | Climb, Meditate | `true` / `false` | ✕ mark (bullet-journal X) |
| `number` | Weight, Sleep | number + unit | the value, small |
| `scale` | Brain fog, Mood, Energy | integer 1–5 | value, or filled shade |
| `progress` | Morning pages | number toward a goal | partial fill / ✕ when goal met |
| `duration` | Meditation minutes | minutes | value |
| `tag` | Sick, Travel, Drinks | `true` when present | small marker |

### 5.2 Habit config fields

```yaml
id: run                 # slug, used as frontmatter key
name: Run
type: check             # see 5.1
unit: null              # e.g. lb, h, min, words
goal: null              # for progress type, e.g. 750 (words)
direction: higher       # higher | lower | neutral — which is "good" (brain fog = lower)
source: intervals       # manual | intervals | weather | morning_pages
source_rule:            # how a synced value is derived (see §7)
  activity_types: [Run]
  min_minutes: 0
color: "#3A7D44"        # dot color on calendar view
show_on_calendar: true
order: 1
archived: false
```

Store all habit configs in `habits.yaml` at the data folder root.

### 5.3 Cell states

| State | When | Rendering |
|-------|------|-----------|
| `done` / value | Has a value | ✕ or value |
| `missed` | **Manual** habit, past day, no value | Empty box (that *is* the miss — no red, no shame styling) |
| `no_data` | **Synced** habit, source returned nothing for that day | Distinct subtle marker (e.g. faint dot or dash) so a dead watch battery ≠ a miss |
| `pending` | Today, no value yet | Normal empty box |
| `future` | After today | Dimmed |

Manual override always wins over synced values. Record which source produced each value (§6.2).

### 5.4 Brian's starting habits (seed data)

| Name | Type | Source | Notes |
|------|------|--------|-------|
| Weight | number (lb) | manual | intervals has a weight field but Brian's is empty; allow sync if it ever populates |
| Run | check | intervals | activity type Run |
| Lift | check | intervals | strength activity type |
| Climb | check | intervals | climbing activity type — Brian records climbs; the activity's GPS/heatmap data is irrelevant, existence of the activity = done |
| Sleep | number (h) | intervals | `sleepSecs` → hours |
| Morning pages | progress (words, goal 750) | morning_pages | ~250 words = 1 page; 3 pages = goal |
| Meditate | check | manual | |
| Brain fog | scale 1–5, direction lower | manual | |
| Mood | scale 1–5 | manual | anchor variable for future "why do I feel off?" analysis |

Also auto-log (not shown as habits by default, but stored per day): HRV, resting HR, sleep score, weather.

## 6. Data storage

### 6.1 Folder layout

User picks a root folder in Settings (can be inside an Obsidian vault).

```
<root>/
  habits.yaml                 # habit configs
  settings.yaml               # non-secret settings (location, units, folder paths)
  days/
    2026-11-17.md             # one file per day: frontmatter values + day notes
  pages/
    2026-11-17.md             # morning pages text — PRIVATE, never sent to AI
  months/
    2026-11.md                # generated monthly roll-up (regenerated, never hand-edited)
```

### 6.2 Day file format

```markdown
---
date: 2026-11-17
run: true
lift: false
climb: null
sleep_h: 7.7
weight_lb: null
morning_pages_words: 812
meditate: true
brain_fog: 2
mood: 4
hrv: 68
resting_hr: 49
sleep_score: 91
weather_high_f: 72
weather_low_f: 54
weather_condition: clear
tags: [travel]
_sources:
  run: intervals
  sleep_h: intervals
  brain_fog: manual
  weather_high_f: open-meteo
_synced_at: 2026-11-17T06:30:00-08:00
---

Day notes go here as normal markdown. Felt foggy until ~11am. Late dinner last night.
```

Rules:
- Frontmatter keys = habit `id` (plus unit suffix for numbers, e.g. `sleep_h`).
- `null` = no value. Absent key = never logged.
- Writes must preserve anything the user added by hand in the body or unknown frontmatter keys.
- Files must render cleanly in Obsidian and work with Obsidian Bases/Dataview.

### 6.3 Monthly roll-up

`months/YYYY-MM.md` is generated: a markdown table of the grid, monthly counts per habit ("Run 14/30"), averages for number/scale habits, and links to each day file. **Excludes morning pages text.**

## 7. Data sources

### 7.1 intervals.icu (v1)

- Base URL: `https://intervals.icu/api/v1`
- Auth: HTTP Basic, username `API_KEY`, password = the user's API key (from intervals.icu → Settings → Developer Settings). Athlete id `0` = the authenticated athlete.
- Endpoints:
  - Wellness: `GET /athlete/0/wellness?oldest=YYYY-MM-DD&newest=YYYY-MM-DD`
    - Fields of interest: `sleepSecs`, `sleepScore`, `hrv`, `restingHR`, `weight`, `mood`, `fatigue`, `soreness`, `steps` (verify exact names against `https://intervals.icu/api/v1/docs`)
  - Activities: `GET /athlete/0/activities?oldest=YYYY-MM-DD&newest=YYYY-MM-DD`
    - Use `type` to match habits. **Verify the exact type strings** for run, strength, and climbing by inspecting Brian's real data before hard-coding.
- On each sync, pull the current month plus the previous 7 days (late-syncing watches).
- Respect rate limits; back off on 429.

**⚠️ Strava caveat:** Strava's API terms ban using Strava data in AI models, and intervals.icu does not expose Strava-sourced activities through its API. Activities must reach intervals.icu directly from the device, not via Strava. If an activity is missing, surface a hint in Settings ("Is your device connected to intervals.icu directly, not through Strava?"). Do not build a direct Strava integration.

Observed in Brian's data (Nov 2026): sleep/HRV present only on some nights; weight empty. This is why `no_data` exists.

### 7.2 Weather (v1)

- Use Open-Meteo (free, no API key) daily historical/forecast endpoints. Verify current endpoint shapes.
- Location: a fixed lat/long from Settings (city-level). No live geolocation in v1.
- Store: high, low, condition, precipitation. Units °F.

### 7.3 Later sources (v2+, don't build now)

Calendar load (event count/hours), macOS Screen Time, air quality, daylight hours, Cronometer nutrition (exists via intervals but empty for Brian), Apple HealthKit (iPhone app).

## 8. Screens

### 8.1 Month grid (home)
- Bullet-journal spread: habit names in a left column, day columns 1–28/31 across, today's column highlighted.
- Click a cell to toggle or enter a value (inline, type-appropriate input). Keyboard navigable (arrows + enter).
- Each day column header can be clicked to open the **day panel** (notes + all values for that day).
- A small indicator on any day that has notes.
- Month switcher (prev/next).
- Right edge: monthly count per habit ("14/30") — counts, not streaks.
- Sync button + last-synced time.

### 8.2 Day panel
- All habit values for the day, editable.
- Markdown notes area (saved to the day file body).
- Shows which values came from which source; manual override available.

### 8.3 Dot calendar
- Standard month calendar.
- User picks which habits appear (`show_on_calendar`), each as a colored dot sticker on the days it was done.
- Goal: glance and think "that's a ton of green dots." Calm, tactile, sticker-like.
- Legend + monthly counts.

### 8.4 Morning pages
- Entry point: a gentle prompt on the home screen if today's pages aren't done.
- Opens a full-screen, distraction-free writing room: calm palette, no chrome, no notifications.
- Simulated journal pages: text fills a page; at ~250 words a new page begins. Subtle progress like "page 2 of 3."
- Goal 750 words (configurable). No timers, no streaks.
- Autosave to `pages/YYYY-MM-DD.md`. Writes `morning_pages_words` to the day file.
- **Text never leaves the device and is never included in AI context, exports, or the monthly roll-up.**

### 8.5 Habit editor
- Create/edit/reorder/archive habits. Pick type → type-specific fields appear. Pick source + rule. Pick color and calendar visibility.
- Archiving hides a habit from the grid but keeps its data.

### 8.6 Settings
- Data folder location.
- intervals.icu API key (Keychain) + "Test connection."
- Location for weather.
- Units (default: lb, °F, hours).
- Morning pages word goal.

### Visual design

**Reference: [`design/reference.png`](design/reference.png)** — match this direction. Brian is a brand designer and owns the visual language; build everything on a token layer (color, type, spacing in one place) so he can restyle fast.

> This reference is the **interim** direction for M1–M7. The app gets a full redesign and branding exploration in **M8**, once it works end to end. Until then, keep every visual decision in the token layer and don't sink time into visual polish that M8 will replace.

What to take from the reference:
- **Swiss / International Typographic Style.** Strict flush-left grid, no decoration, no cards, no shadows, no rounded corners.
- **Two type voices only:**
  - A heavy neo-grotesk (Neue Haas / Helvetica Now Display Bold feel) for headlines and values — set large, tight tracking, tight leading (~0.95–1.0).
  - A small monospace for metadata labels (dates, habit types, sources, column headers) — like the `NR 17 / Spring Summer / 2023` row.
- **Hairline-rule tables.** Key/value rows separated by thin 1px black rules (see the project data table on the right). This is the model for the day panel and the monthly grid itself — the grid is a typographic table, not a widget.
- **Grayscale first.** Black on white, with gray for inactive/secondary (like `Resources, Office` next to the active `Projects`). Soft gray gradients as the only graphic element. Habit dot colors are the *only* color in the app.
- **Scale contrast.** Huge type for the thing that matters (the month name, today's date, a monthly count), tiny mono for everything else. Lots of empty white space.
- **Navigation** as a typographic list: active item black, others gray, comma-separated.

The bullet-journal grid stays the core layout — expressed in this typographic language, not as a skeuomorphic paper journal. Morning pages can be the one quieter exception (still type-led, but softer and calmer). Nothing gamified.

Use free stand-ins until Brian picks licensed fonts: e.g. Inter Tight / Inter Display (bold) for the grotesk, JetBrains Mono or IBM Plex Mono for the mono.

## 9. v2 notes (for context only — don't build)

- **Graphs:** intervals.icu-style. Pick any habits (multi-select) and plot them on a shared timeline. Default charts for standard habits; user can save custom combinations.
- **AI analysis:** ask "why did I feel off last week?" or get an automatic weekly review. Context = day files (values + notes) and the monthly roll-up. **Never morning pages text.** Show the user exactly what is sent. Likely bring-your-own-key.
- **Product path:** replace intervals.icu with Garmin Connect Developer Program, an aggregator (e.g. Terra), and/or Apple HealthKit via an iPhone app (HealthKit keeps data on device, which fits principle 3).

## 10. Open questions — ask Brian

1. Final app name (working title: Wetware — check availability before any public release).
2. Are day notes OK to feed to AI in v2? (Current assumption: yes; morning pages: no.)
3. Exact intervals.icu activity types for lift and climb — confirm against real data.
4. Should weight sync from anywhere (smart scale → intervals), or stay manual?
5. Monthly grid: fixed habit order, or grouped (body / mind / tags)?

## 11. Milestones

1. **Skeleton:** Tauri app, settings, choose data folder, `habits.yaml` read/write, seeded habits.
2. **Grid:** month grid with manual entry for all types, day files written/read, cell states.
3. **Sync:** intervals.icu wellness + activities, weather, source tracking, `no_data` state.
4. **Day panel + notes.**
5. **Morning pages room.**
6. **Dot calendar + monthly counts + monthly roll-up file.**
7. **Polish:** keyboard nav, token layer, README with setup steps.
8. **Redesign + branding:** once the v1 acceptance criteria (§12) pass. A branding exploration (name, identity, typography, color, the feel of the grid, calendar and writing room) led by Brian, then a full visual redesign built on the token layer and, where needed, component changes. Settles open question 1 (final name).

## 12. Acceptance criteria (v1 done when)

- [ ] Brian can open the app, see November's grid, and tick a manual habit in under 3 seconds.
- [ ] Opening the app pulls runs, lifts, climbs, sleep, HRV, and resting HR from intervals.icu into the right cells with no manual input.
- [ ] A night with no sleep data shows `no_data`, not a miss.
- [ ] Every day with data has a readable `days/YYYY-MM-DD.md` that opens cleanly in Obsidian.
- [ ] Morning pages: writing 750 words fills 3 simulated pages and marks the habit done; the text exists only in `pages/`.
- [ ] Dot calendar shows chosen habits as colored dots with monthly counts.
- [ ] Zero streak UI anywhere.
- [ ] API key is in the Keychain, not on disk in plain text, not in git.
