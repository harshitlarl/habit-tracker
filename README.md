# Momentum

A calm, personal habit tracker that lives on your iPhone's Home Screen.

You create **trackers** — "Gym", "Study 2 hours", "Wake up by 8 AM" — choose which weekdays each
one is due, and check them off as the day goes. Momentum shows the week Monday to Sunday, keeps your
streaks, draws your progress, and says something kind along the way. Everything stays on your phone:
no account, no server, no analytics.

Live at **https://harshitlarl.github.io/habit-tracker/**

## What it does

- **Today** — the trackers due today, each with an oversized check. A ring counts done/due, a short
  motivation line changes with your day (same words all day, no re-rolling), and streak chips appear
  once a tracker reaches two days. Anything not scheduled today sits in a collapsed section and can
  still be checked as a bonus. Finish everything due and you get a small confetti burst.
- **Week** — a Monday–Sunday ledger of every tracker. Tap any past day to fix a missed check-in,
  browse earlier weeks with ‹ ›, and read the totals and a one-line summary ("18 of 21 done · 86%").
- **Progress** — your perfect-day streak, total check-ins and this week's rate; a bar chart of the
  last eight weeks; and a card per tracker with its current streak, best streak, 30-day rate and a
  12-week heatmap. Archived trackers wait at the bottom with their final numbers and a Restore button.
- **Trackers** — add, edit, reorder, archive or delete trackers: a name, an emoji (pick one or type
  your own), one of eight colours, an optional note, and the weekdays it is due (Every day, Weekdays,
  Weekends or any mix). Settings cover the theme (System / Light / Dark), backup export and import,
  and a full reset — every destructive step asks first, inside the app.
- Works offline after the first load, follows your phone's light/dark setting, and respects
  Reduce Motion.

## Install it on your iPhone

1. Open **https://harshitlarl.github.io/habit-tracker/** in **Safari** (it has to be Safari for
   the Home Screen install).
2. Tap the **Share** button (the square with the arrow), then **Add to Home Screen**, then **Add**.
3. Open Momentum from the Home Screen. It runs full screen with its own icon and works offline.

Updates install themselves: when a new version has been deployed, it is picked up in the background
and used the next time you open the app.

## Your data, backups and restores

Momentum keeps everything in the browser's local storage on the device (key `momentum-v1`): your
trackers, every check-in and your settings. Nothing is sent anywhere.

Two things follow from that:

- The installed Home Screen app and a Safari tab are separate copies with separate data. Use the
  installed app day to day, and move data between the two (or to a new phone) with a backup.
- Deleting the Home Screen app, or clearing Safari's website data, deletes the data with it. Export
  a backup now and then.

**Back up:** Trackers → Settings → **Export**. On the iPhone the share sheet opens; choose
**Save to Files** (or AirDrop it to a Mac). The file is `momentum-backup-YYYY-MM-DD.json` — plain,
readable JSON holding your trackers, check-ins and settings.

**Restore:** Trackers → Settings → **Import**, pick the backup file, read the summary ("1 tracker ·
42 check-ins · exported 16 Oct 2026") and confirm **Replace**. Importing replaces what is on the
device; a file that is not a Momentum backup is refused with a reason and nothing changes.

## Development

Requires Node 22.12 or newer (`engines` in `package.json`; vitest 5 does not run on Node 20, so
this deviates from the "Node ≥ 20" line in `SPEC.md`). Then:

```sh
npm install
npm run dev          # Vite dev server
npm run typecheck    # tsc -p tsconfig.app.json --noEmit
npm test             # vitest unit tests (pinned to TZ=America/New_York for the DST cases)
npm run test:watch
npm run build        # tsc -b && vite build → dist/
npm run preview      # serve dist/ locally
npm run icons        # regenerate public/icons/* from the SVG in scripts/make-icons.mjs
npm run e2e          # build, then the Playwright suite against dist/ (see below)
```

**Unit tests** cover the pure modules: everything in `src/lib` (dates, streaks, motivation, store,
import validation) plus the feature model files under `src/features/**/__tests__`.

**End-to-end tests** (`e2e/`) drive the production build in an emulated iPhone 14 running WebKit,
the engine the app ships to. Install the browser once with `npx playwright install webkit`. The
suite walks one full first day with the app (empty state → trackers → check-ins → week → progress →
settings → backup → import → reset), audits every screen for text contrast and tap-target size, and
checks the OS colour scheme, reduced motion and offline start. `e2e/screenshots.spec.ts` also saves a
visual QA set to `e2e/screenshots/` (git-ignored). On a machine where WebKit cannot launch,
`PW_FALLBACK_CHROMIUM=1 npm run e2e` runs the same phone geometry in Chromium.

Stack: Vite 8, React 19, TypeScript (strict), zustand (persist → localStorage), date-fns, plain CSS
with design tokens, vite-plugin-pwa (Workbox precache, auto-update), self-hosted Fraunces and Hanken
Grotesk from Fontsource. No UI kit, no icon library, no CSS framework.

## How deploys work

Push to `main` and GitHub Actions does the rest:

1. `.github/workflows/deploy.yml` checks out the repo, installs with `npm ci`, runs the unit tests
   (a red suite stops the deploy), and builds with `BASE_PATH=/habit-tracker/` so every URL in
   `index.html`, the manifest and the service worker is prefixed for GitHub Pages.
2. `dist/` is uploaded and published with `actions/deploy-pages` to
   **https://harshitlarl.github.io/habit-tracker/**.

The workflow can also be started by hand from the Actions tab (`workflow_dispatch`). An in-progress
deployment is never cancelled by a newer push; queued runs collapse to the latest one.

One-time repository settings:

- **Settings → Pages → Build and deployment → Source: GitHub Actions.**
- The default branch must be `main` (or change the `branches` filter in the workflow).
  If the local repository still calls its branch `master`, rename it once with `git branch -M main`
  before the first push, or the workflow never triggers.
- The workflow derives `BASE_PATH` from the repository name. If the repo were ever renamed, the
  URL and the base path follow it automatically; a user-site repository (`<user>.github.io`) would
  need `BASE_PATH: /` instead.

To reproduce the Pages build locally: `BASE_PATH=/habit-tracker/ npm run build`, then
`npm run preview` and open `http://localhost:4173/habit-tracker/`.

## Project structure

```
index.html                  App shell: viewport-fit, iOS metas, theme-color per scheme, icon links
vite.config.ts              Vite + React + VitePWA (manifest, Workbox precache incl. fonts); base from BASE_PATH
playwright.config.ts        e2e config: iPhone 14 on WebKit against `vite preview` of dist/
vitest.config.ts            Unit-test config (src/lib + feature model tests, TZ pinned)
scripts/make-icons.mjs      Draws the app icon and rasterises public/icons/* with sharp
public/icons/               192/512/512-maskable PNGs, 180px apple-touch-icon, favicon.svg
.github/workflows/          deploy.yml — test, build with the Pages base path, deploy
e2e/                        Playwright specs (journey, smoke, screenshots) and the contrast helper
src/
  main.tsx                  Fonts, tokens, base styles, service-worker registration, React root
  App.tsx / App.css         Tab bar, view switching, theme → <html data-theme> and theme-color
  pwa.ts                    registerSW (autoUpdate), offline-ready event
  styles/tokens.css         Design tokens: light + dark palettes, habit colours, radii, spacing, type
  styles/base.css           Reset, typography, paper texture, utilities, focus and motion rules
  lib/                      Pure logic, fully unit-tested
    types.ts                Data model (Habit, Completions, Settings, AppData)
    store.ts                zustand store: actions, strict import validation, persistence
    dates.ts                Local-date keys, week maths, isScheduled, formatting
    streaks.ts              Streaks, completion stats, perfect days, weekly rates
    motivation.ts           Deterministic motivation lines and the week summary
    selectors.ts            activeHabits, dueHabits, habitsActiveBetween, colour helpers
    useToday.ts / useHour.ts / useReducedMotion.ts / platform.ts / ids.ts
  components/               Shared UI: Check, Ring, Sheet, Button, Chip, SegmentedControl,
                            EmptyState, Icon (inline SVG), Confetti
  features/
    today/                  TodayView, HabitRow, celebration + motivation model
    week/                   WeekView, WeekGrid, weekModel
    progress/               ProgressView, Stat, WeeklyBars, TrackerCard, Heatmap, ArchivedSection
    manage/                 ManageView, HabitEditor (bottom sheet), SettingsSection, InlineConfirm
    pwa/                    InstallHint banner (iOS Safari, not installed, not dismissed)
```

`SPEC.md` is the product, design and architecture contract the app was built against — data model,
store API, streak semantics, the "warm editorial journal" design brief and the quality bar. Start
there before changing behaviour.
