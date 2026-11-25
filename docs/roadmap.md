# Roadmap

Where Wetware goes after M5, and why in this order. The milestone list itself lives in [`SPEC.md` §11](../SPEC.md#11-milestones); this document is the reasoning behind it.

## The order

| | Milestone | Led by | In short |
|-|-----------|--------|----------|
| M1–M5 | Skeleton, grid, sync, day view, morning pages | agent | ✅ Built. The plumbing works. |
| M6 | Calendar + monthly summary | agent | The last missing v1 feature. |
| M7 | Live with it | Brian | Real data, daily use, a friction log. |
| M8 | Interaction design | Brian | How the whole app behaves: "this does this when this." |
| M9 | Build to the interaction design | agent | Rework the screens, add the habit editor. |
| M10 | Analysis | both | Put any data against any other. |
| M11 | Redesign + branding | Brian | Name, identity, the final look. |

AI analysis, more data sources, an iPhone app and a multi-user product remain later (SPEC §9).

## Why this order

**What's built so far is mostly plumbing.** M1–M5 built the parts no design changes: files that survive Obsidian, sync rules, the Keychain, saves that never lose text, the privacy of morning pages. That work stays.

**Nobody has designed the interactions yet.** What a click does, how you move between screens, and what you see when something fails were decided screen by screen by the agent building them. They are recorded in [`how-it-works.md`](how-it-works.md), but nobody designed them as a whole. That's the gap M7–M9 close.

**Use it before designing it.** The best evidence for how the app should behave is a few weeks of using it on real data. Sync hasn't touched a real intervals.icu account yet, so some of the real behavior isn't known. M7 comes before M8 for that reason.

**Interactions before visuals.** A visual redesign dresses interactions; it can't fix them. So the interaction design (M8) and the rebuild (M9) come before the visual redesign (M11).

**Analysis needs months of data, and an interaction model to fit into.** By M10 there are months of daily data, and the app's navigation, selection and editing patterns are settled for the analysis screens to follow. Its interactions are still designed in M8 with everything else.

**Branding last,** over a product whose shape is settled, so it covers every screen, including analysis. Until then, every visual decision lives in the token layer (`src/styles/tokens.css`) so the redesign is cheap.

## M6: Calendar + monthly summary

As SPEC §6.3 and §8.3 describe: a month calendar with a colored dot on each day a habit was done, a legend and monthly counts; and a generated `months/YYYY-MM.md` with the month as a table, counts, averages and links to each day. It never includes morning pages text.

## M7: Live with it

The goal is to start using Wetware every day and find out what it's like.

- Connect the real intervals.icu account and confirm the sync against real data. The open items are listed under "Not yet confirmed against a real account" in [`how-it-works.md`](how-it-works.md). Set up Lift and Climb from the real activity types.
- Fix what breaks. Write the setup steps.
- Use it daily for 2–3 weeks. Keep a **friction log** (`docs/friction-log.md`): one line per moment where something was slow, confusing, missing or annoying. The agent fixes bugs during this time but doesn't redesign anything.

**Done when:** sync has run against the real account, the open sync questions have answers, and the friction log covers a few weeks of use.

## M8: Interaction design

The goal is a spec for how the whole app behaves, written before more screens are built.

1. **As-built inventory** (agent). Before Brian starts, the agent writes up what the app does today, drawing on the code and the end-to-end scenarios: every screen; every trigger (click, key, focus, window event) and what it does; every state (empty, loading, saving, error, conflict, no data); and how you move between screens. This gives Brian something concrete to mark up.
2. **Design** (Brian), using the inventory and the friction log. It covers:
   - flows between screens;
   - the keyboard model;
   - first run and onboarding;
   - empty, error and offline states;
   - feedback when things save or sync;
   - the habit editor (SPEC §8.5, never yet scheduled);
   - how the analysis screens (M10) work.
3. **Output:** `docs/interactions.md`, written as "when X, then Y" and specific enough to build and test.

**Done when:** Brian signs off on `docs/interactions.md`.

## M9: Build to the interaction design

- Rework the existing screens to match `docs/interactions.md`. Rework only the screens; the data layer, sync and shell stay as they are unless the design needs something new from them.
- Build the habit editor: create, edit, reorder and archive habits.
- This absorbs what the old "Polish" milestone held: the keyboard model across every screen and the token layer pass.
- Each interaction in the spec gets an end-to-end scenario in `npm run shots`.

**Done when:** every interaction in the spec is built and has a scenario, and SPEC §12 passes.

## M10: Analysis

The goal is to find things about yourself you wouldn't have noticed, by putting any piece of data against any other.

**What to match (not the look).** intervals.icu's fitness page with custom charts is the reference for depth, not for style:

- **Stacked panels on one shared timeline.** A crosshair follows the cursor through every panel at once and can be locked in place. The values under the crosshair show in a side column.
- **Several series in one panel**, with left and right axes. Each series is drawn as bars, a line, dots, or a shaded band.
- **Derived series:** rolling averages (e.g. 7-, 14- and 21-day), ratios such as acute:chronic training load, ramp rates, and zones drawn as background bands.
- **Goals on the chart:** a target line or band and a title that says what it's for ("Keep resting HR under 50").
- **A chart builder.** For each series, pick the field, the aggregation (as is, average, sum, min, max), the chart type, the color, a filter (only runs, only weekdays, only days tagged Travel), the label and the axis side. Add series, set the panel's height, reorder panels, save a set of panels as a view, and export a panel's data to CSV.

**Beyond intervals.icu:**

- **Scatter view:** any field on X and any field on Y, one dot per day (sleep vs. next-day mood).
- **Offset in days:** compare one field against another shifted by N days. Does drinking show up in HRV two days later?
- **Compare by tag or habit:** how does mood look on days you meditated vs. days you didn't, or on travel days vs. home?
- **"What moves together":** rank the strongest relationships in your data, each with how many days it rests on, so a pattern from 9 days isn't presented like one from 200. This is plain statistics, not AI. It's a way into the data and doesn't claim cause.
- **Notes in context:** day notes can be shown on the timeline, so a dip can be read next to what was written that day. Morning pages text never appears here; only its word count can.

**Every field is available:** every habit, everything sync logs (sleep, HRV, resting HR, sleep score, weather), and the derived series.

**Questions to settle before M10:**

- **What training data to keep.** Charts like these need more than "ran: yes": distance, duration, pace, heart rate, load. The day files are meant to stay readable in Obsidian, so detailed training data may need a place of its own (e.g. `activities/`). A cache that can be rebuilt from intervals.icu is allowed (SPEC §4). Decide what's kept, where, and in what format.
- **History.** Sync covers the current month plus the 7 days before it. Analysis needs history, which intervals.icu keeps, so it can be backfilled whenever the decision above is made.
- **What intervals.icu already computes** (fitness, fatigue, form, efficiency) vs. what Wetware computes itself. Check the API.

## M11: Redesign + branding

Brian leads a branding exploration: the name (SPEC §10 question 1), identity, typography, color, and the feel of the grid, calendar, writing room and analysis. Then comes a full visual redesign, built on the token layer and with component changes where needed. `design/reference.png` is only the temporary direction until then.
