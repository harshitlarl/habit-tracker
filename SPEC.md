# Momentum — Product, Design & Architecture Spec

> Single source of truth for everyone building this app. Read it fully before touching code.
> It is the binding contract: data model, store API, design tokens, file ownership.
> If you must deviate, document the deviation in your report.

## 1. What this is

Momentum is a personal habit tracker for ONE person, used on an iPhone as an installed
Progressive Web App (PWA). The owner creates **trackers** (habits) such as "Gym",
"Study 2 hours", "Wake up by 8 AM". Each tracker is scheduled on some weekdays (default: all
seven). Each day the owner checks off what they did. The app shows a Monday→Sunday weekly grid,
streaks, progress, and warm motivational messages. Data lives on the device (localStorage) with
JSON export/import for backup. No accounts, no server, no analytics.

Non-goals: multi-user, cloud sync, push notifications, timers.

## 2. Tech stack (fixed)

- Vite (latest stable) + React 19 + TypeScript (strict). Package manager: npm.
- State: zustand v5 with the `persist` middleware → localStorage key `momentum-v1`.
- Dates: date-fns v4. All dates are LOCAL calendar dates. Never use UTC getters/`toISOString()` for date keys.
- PWA: vite-plugin-pwa (`registerType: 'autoUpdate'`, generateSW / workbox).
- Fonts: self-hosted via npm `@fontsource-variable/fraunces` (import the `full` + `full-italic` CSS so the
  `opsz`/`SOFT` axes and italics are available — verify the exact file paths in node_modules) and
  `@fontsource-variable/hanken-grotesk`. No Google Fonts `<link>` tags (fonts must be precached for offline).
- Styling: plain CSS. `src/styles/tokens.css` (design tokens) + `src/styles/base.css` (reset, typography,
  utilities). Feature CSS lives next to its component as `Name.css`, imported by the component.
  No Tailwind, no CSS-in-JS, no UI kits.
- Icons: inline SVG React components in `src/components/Icon.tsx`. No icon libraries.
- Tests: vitest for `src/lib/**`. Playwright (`@playwright/test`) for e2e in `e2e/`.
- Build: `tsc -b && vite build`. Vite `base` comes from env: `base: process.env.BASE_PATH ?? '/'`.
  GitHub Pages deploys with `BASE_PATH=/habit-tracker/`. All asset URLs must therefore be base-aware
  (use Vite's normal handling; never hardcode `/icons/...` inside JS — use `import.meta.env.BASE_URL`).
- Node ≥ 20. Allowed runtime deps: react, react-dom, zustand, date-fns, the two fontsource packages.
  Dev deps: vite, @vitejs/plugin-react, typescript, @types/react, @types/react-dom, vite-plugin-pwa,
  vitest, @playwright/test, sharp (icon rasterising script). Anything else needs a documented reason.

*Deviations (as built):*
- Fonts: the three Latin woff2 files (Fraunces full normal + italic, Hanken Grotesk) are copied from the Fontsource packages into
  `public/fonts/` (`npm run fonts`), declared in `src/styles/fonts.css` and preloaded by `index.html` — not the packages' CSS
  (nine files); same families, axes and italics, still self-hosted and precached.
- PWA: still `autoUpdate`, but `src/pwa.ts` reloads into a new build only at a calm moment (no sheet open, no field in use) and asks
  for one on each return to the foreground, at most hourly; the Firebase chunk is runtime-cached (`firebase-sdk`), not precached.
- Node: `engines` is `^22.12.0 || ^24.0.0 || >=26.0.0` (vitest 5's range) rather than ≥ 20; CI and Netlify build on Node 24.
- Hosting: GitHub Pages was retired on 2026-10-18 (§13.7); the app is served from the root of https://momentum-harshitlarl.web.app.
  `BASE_PATH` support stays, for any host that needs a sub-path, and the e2e suite still runs under one (`BASE_PATH=/momentum/`).

## 3. Views

Bottom tab bar with four tabs: **Today**, **Week**, **Progress**, **Trackers**. The current `view`
is React state in `App.tsx`. No router. Content column max-width 560px, centred, 20px side gutters.

### 3.1 Today (default tab)
- Header: weekday in large display serif ("Thursday"), the date beneath in small caps ("16 October").
  Top-right: `Ring` showing done/due today with the fraction inside ("3/5").
- Motivation line: italic display serif, set like a pull-quote, from `getMotivation()`.
  Must not change across re-renders within the same state (deterministic by day + state).
- "Due today" list: trackers scheduled today, in `order`. Row = emoji inside a soft tinted circle (habit
  colour), name, note (muted, e.g. "2 hours"), streak chip ("🔥 7", only when currentStreak ≥ 2), and a large
  `Check` (52px) on the right. Tapping the row toggles. Done rows get a muted treatment but STAY IN PLACE
  (no reordering on toggle — the UI must not jump under the finger).
- "Not scheduled today" collapsible section (collapsed by default) listing the other active trackers; they can
  still be checked (a bonus). Bonus completions count in totals and show in the grid, but not toward streaks
  or the due denominator.
- All due done → celebration: `Confetti` burst (habit colours, ≤80 particles, ~1.2s, fires once per day per
  session) and the motivation line switches to an `allDone` message.
- Empty state (no active trackers): warm copy + primary button "Add your first tracker" → opens `HabitEditor`.
- Floating "+" button (bottom-right, above the tab bar) opens `HabitEditor` for a new tracker.
  *Deviation (as built, phase 3):* the "+" is a 44px round "Add tracker" button in the Today header, beside the ring, shown once a
  tracker exists (the empty state's "Add your first tracker" covers the first one). A fixed corner "+" shared its x-band with every
  row's Check and caught taps meant for a check.

*Deviations (as built, polish):* "Not scheduled today" opens by default on a day with nothing due and then stays as the owner leaves
it for the session; below 360px the weekday steps down to 34px so it clears the ring and the "+"; the ring has `aria-valuetext`.

### 3.2 Week
- Header: week range ("13 – 19 Oct") with ‹ › buttons, and a "This week" pill when not on the current week.
- Grid: first column = tracker (emoji + name, truncated with ellipsis), then 7 columns Mon…Sun.
  Column headers: two-letter day labels in small caps + day number; today's column highlighted (ember tint).
- Cell states: scheduled + done → filled dot in habit colour with a check; scheduled + not done → outlined
  circle; unscheduled → faint dash, still tappable (a bonus completion renders filled at reduced opacity);
  future dates → disabled (not tappable, low opacity); before the tracker's `createdAt` → empty, disabled.
- Tap toggles via `toggleCompletion`. Every tappable cell is a ≥44px target.
- Footer row: per-day "done/due" counts in small text. Below the grid: a summary line, e.g.
  "18 of 21 done · 86%", from `weekSummary` + `getWeekSummaryMessage`.
- Empty state if there are no trackers.

*Deviations (as built, polish):* a bonus completion is the disc outlined in the habit tone on the paper fill, with a tone check, and
the unscheduled dash is a 12×2px `--line-strong` mark at full opacity (the reduced-opacity fill and the faint dash fell below 3:1);
tappable cells carry `aria-pressed`, so their labels keep only the name, the date and a bonus / not scheduled / upcoming suffix.

### 3.3 Progress
- Overall section first: perfect-day streak (consecutive days where everything due was done), total
  completions, this week's rate. Then a bar chart of the last 8 weeks' completion rate (ember bars, labelled
  by week start, current week last).
- One card per active tracker: emoji + name, current streak, best streak, 30-day rate. A 12-week heatmap:
  7 columns Mon…Sun (aligned with the Week view), rows = weeks (oldest at the top, current week at the bottom);
  done → habit colour; scheduled-but-not-done → hairline outline; unscheduled / before createdAt / future → empty.
- Archived trackers at the bottom in a collapsed section with their final stats and a "Restore" action.

*Deviations (as built, polish):* each card's header is an "Edit <name>" button that opens `HabitEditor`, as is each archived row
beside its Restore; the heatmap marks a bonus day with a round tone ring and no fill.

### 3.4 Trackers (manage + settings)
- List of active trackers; tap to edit; reorder with ▲ ▼ buttons (reliable on iOS, no drag libraries).
  "Add tracker" button.
- `HabitEditor` bottom sheet: Name (required, 1–40 chars), Emoji (curated grid of ~48 + a free-text field),
  Colour (8 swatches), Note (optional, ≤40 chars, placeholder "e.g. 2 hours, by 8 AM"), Days (7 toggle chips
  Mo…Su; presets: Every day / Weekdays / Weekends; at least one day required). Save. For an existing tracker:
  Archive and Delete; Delete asks for in-app confirmation inside the sheet. NEVER use `window.confirm`,
  `alert` or `prompt` anywhere in the app.
- Settings section: Theme (System / Light / Dark `SegmentedControl`); Export data (downloads
  `momentum-backup-YYYY-MM-DD.json`); Import data (file input → validate → in-app confirm → replace);
  Reset all data (in-app confirm). An "Install on iPhone" card with the Share → Add to Home Screen steps,
  shown only when not running standalone (`isStandalone()` from `src/lib/platform.ts`). Version/about line.

*Deviations (as built, polish):*
- Gear: a 44px "Settings" icon button in the Trackers header scrolls to the Settings heading and focuses it.
- Emoji grid: the first 16 of the 48 options plus the selected one, with a "More emoji" / "Fewer emoji" chip for the rest.
- `HabitEditor`: Save sits in a sticky footer and stays enabled (a submit marks every error and focuses the first invalid field);
  it turns off only when the tracker was deleted on another device, which a status line says. An archived tracker offers Restore
  in place of Archive.
- Settings order: Appearance → Your data → Sync across devices → Install on iPhone → Reset this device (its own last card and status
  line) → about line. The install card also stays hidden while the `InstallHint` banner shows, and "Your data" says "This device is
  not saving changes right now — export a backup." while storage refuses writes.

## 4. Data model — `src/lib/types.ts` (exact)

```ts
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;          // 0 = Monday … 6 = Sunday
export type DateKey = string;                              // 'YYYY-MM-DD', LOCAL calendar date
export const HABIT_COLORS = ['terracotta','ochre','sage','slate','plum','rose','moss','graphite'] as const;
export type HabitColor = typeof HABIT_COLORS[number];
export interface Habit {
  id: string; name: string; emoji: string; color: HabitColor; note?: string;
  days: Weekday[];              // scheduled weekdays — non-empty, unique, sorted ascending
  createdAt: DateKey; archivedAt?: DateKey; order: number;
}
export type Completions = Record<string, Record<DateKey, true>>;   // habitId → set of dateKeys
export type Theme = 'system' | 'light' | 'dark';
export interface Settings { theme: Theme; installHintDismissed: boolean }
export interface AppData { version: 1; habits: Habit[]; completions: Completions; settings: Settings; exportedAt?: string }
```

## 5. Store — `src/lib/store.ts` (exact API)

zustand `create` + `persist` (`name: 'momentum-v1'`, `version: 1`, `migrate` passthrough that returns the
persisted state). State: `habits`, `completions`, `settings`. Actions:
- `addHabit(input: { name: string; emoji: string; color: HabitColor; note?: string; days: Weekday[]; createdAt?: DateKey }): Habit`
  — `createdAt` defaults to `todayKey()`, `order` = max existing + 1, `id` from `src/lib/ids.ts`.
- `updateHabit(id: string, patch: Partial<Omit<Habit,'id'|'createdAt'|'order'>>): void`
- `archiveHabit(id)` → sets `archivedAt = todayKey()`;  `unarchiveHabit(id)` → clears it.
- `deleteHabit(id)` → removes the habit AND its completions.
- `reorderHabits(orderedIds: string[])` → reassigns `order` 0..n-1 in that sequence (ids not listed keep relative order after).
- `toggleCompletion(habitId, dateKey)`, `setCompletion(habitId, dateKey, done: boolean)`.
- `setTheme(theme)`, `dismissInstallHint()`.
- `exportData(): AppData`; `importData(raw: unknown): { ok: true } | { ok: false; error: string }` — validates the
  shape strictly (version, arrays, ids, colours, days, dateKey format) and REPLACES everything; `resetAll()`.
Default export `useStore` (the zustand hook). Also export the `StoreState` type.

Pure selectors in `src/lib/selectors.ts`: `activeHabits(habits)` (not archived, sorted by order),
`archivedHabits(habits)`, `isDone(completions, habitId, dateKey)`, `dueHabits(habits, dateKey)`
(= `isScheduled(h, dateKey)`), `habitColorVar(color)` → `'var(--c-terracotta)'`.

Hooks: `useToday()` in `src/lib/useToday.ts` → the current `DateKey`, re-evaluated at local midnight (timer to
next midnight) and on `visibilitychange`/`focus`. As built it also re-reads the clock when it mounts (a midnight can fall between the
render and the effect) and on `pageshow`; `useHour()` in `src/lib/useHour.ts` (the hour behind the time-of-day copy) does the same,
at every full hour. `useReducedMotion()` in `src/lib/useReducedMotion.ts`.
`src/lib/platform.ts`: `isIOS()`, `isStandalone()`.

*Deviation (as built):* additive store exports: `NOT_A_BACKUP` ("This file is not a Momentum backup.", for a file without a numeric
`version`, `habits` or `completions`; a real unknown version still reads "Unsupported backup version: N.") and the `useStorageHealth`
store (`{ error, unavailable }`, also behind `lastStorageError()`) that drives the Settings warning.

## 6. Date utilities — `src/lib/dates.ts` (exact)

- `toKey(d: Date): DateKey`, `fromKey(k: DateKey): Date` (local midnight), `todayKey(now?: Date): DateKey`
- `weekdayOf(k: DateKey): Weekday` (Mon = 0 … Sun = 6)
- `addDays(k, n): DateKey`, `diffDays(a, b): number` (calendar days, b − a)
- `startOfWeekKey(k): DateKey` (the Monday), `weekKeys(anchor: DateKey): DateKey[]` (7 keys Mon→Sun)
- `compareKeys(a, b): number` (string compare is valid for this format), `isFuture(k, today): boolean`
- `isScheduled(habit, k): boolean` — `habit.days` includes `weekdayOf(k)` AND `k >= habit.createdAt`
  AND (`!habit.archivedAt` OR `k < habit.archivedAt`)
- Formatting: `formatWeekday(k)` ("Thursday"), `formatLongDate(k)` ("16 October"),
  `formatWeekRange(mondayKey)` ("13 – 19 Oct", or "29 Sep – 5 Oct" across months), `dayNumber(k)` (16).
- `WEEKDAY_SHORT = ['Mo','Tu','We','Th','Fr','Sa','Su']`, `WEEKDAY_LONG = ['Monday', …]`.

## 7. Streaks & stats — `src/lib/streaks.ts` (exact semantics)

- `currentStreak(habit, completions, today)`: walk backwards from `today`. If today is scheduled and not yet
  done, skip today (a pending day never breaks a streak). Unscheduled days are skipped (they neither count nor
  break). Each scheduled day that is done → +1; the first scheduled day not done → stop. Bonus completions on
  unscheduled days never count.
- `bestStreak(habit, completions, today)`: the longest such run between `createdAt` and `today`.
- `completionStats(habit, completions, fromKey, toKey)`: `{ due, done, bonus, rate }` — due = scheduled days in
  range (and ≤ toKey), done = due days completed, bonus = unscheduled completions in range, `rate = due ? done/due : 0`.
- `perfectDayStreak(habits, completions, today)`: consecutive days (ending today, or yesterday if today is
  incomplete) on which `dueHabits(day).length > 0` and all were done; days with zero due habits are skipped.
- `weekSummary(habits, completions, mondayKey, today)`: `{ due, done, rate }` counting only days ≤ today.
- `weeklyRates(habits, completions, today, weeks = 8)`: array oldest→newest of `{ mondayKey, due, done, rate }`.
- `totalCompletions(completions): number`.
- `STREAK_MILESTONES = [3, 7, 14, 21, 30, 50, 100, 365]`.

## 8. Motivation — `src/lib/motivation.ts` (exact)

```ts
export interface MotivationContext {
  dateKey: DateKey; hour: number; habitsCount: number; dueCount: number; doneCount: number;
  bestCurrentStreak: { habitName: string; days: number } | null; perfectDayStreak: number;
  missedYesterday: boolean;   // at least one due habit yesterday was not done
}
export interface Motivation { title: string; body?: string; tone: 'calm' | 'warm' | 'celebrate' | 'nudge' }
export function getMotivation(ctx: MotivationContext): Motivation
export function getWeekSummaryMessage(done: number, due: number): string   // e.g. "18 of 21 done · 86%"
export function hashString(s: string): number                               // stable, non-negative
```
Selection is deterministic: `hashString(dateKey + ':' + stateKey) % pool.length`. States in priority order:
`noHabits` → `allDone` (dueCount > 0 && doneCount === dueCount) → `milestone` (bestCurrentStreak.days ∈
STREAK_MILESTONES; copy must include the habit name and the number) → `comeback` (missedYesterday &&
doneCount > 0) → `nothingYet` (split by hour: < 12 morning, < 18 afternoon, else evening) → `partial`
(< 50% vs ≥ 50%). Voice: warm, direct, short (title ≤ 60 chars), never guilt-tripping, no exclamation-mark
spam, no emoji in titles. At least 4 variants per state. Examples of the register:
"Fresh day. Pick the easiest one and begin." · "More than halfway. Finish strong." ·
"Perfect day. You showed up for everything." · "Back at it. Showing up again is the whole game." ·
"7 days straight on Gym. That's a habit forming."

## 9. Design brief — "Warm editorial journal"

A beautifully typeset personal notebook, not a dashboard. Calm, warm, tactile. The one memorable thing:
oversized serif headlines on a warm paper surface, with big, satisfying checks.

**Typography.** Display: `'Fraunces Variable', Georgia, serif` (weights 500–700; on big headlines use
`font-variation-settings: 'SOFT' 50, 'opsz' 144`; italics for the motivation line). UI/body:
`'Hanken Grotesk Variable', system-ui, sans-serif`. Small-caps labels: uppercase, `letter-spacing: .08em`,
11–12px, weight 600, colour `--ink-3`. Body 16px / line-height 1.45. Headline sizes: 40px (weekday),
28px (section titles), 20px (card titles). Tabular numerals (`font-variant-numeric: tabular-nums`) for counts.

**Colour tokens** (`tokens.css`: `:root` = light; `html[data-theme="dark"]` = dark; `data-theme` on `<html>`
is set from settings — `system` resolves via `prefers-color-scheme`, and must update live when the OS switches).
Light: `--bg:#F4EEE2; --surface:#FBF7EF; --surface-2:#EFE7D8; --ink:#211B17; --ink-2:#5F554D; --ink-3:#9A8F85;
--line:rgba(33,27,23,.10); --ember:#D6602F; --ember-soft:#F5DCCB; --ember-ink:#8E3C17; --shadow:0 10px 30px rgba(60,40,20,.10)`.
Dark: `--bg:#15110E; --surface:#1F1915; --surface-2:#2A231E; --ink:#F3ECE1; --ink-2:#B8ADA2; --ink-3:#7F756C;
--line:rgba(243,236,225,.10); --ember:#E97A49; --ember-soft:#3A251A; --ember-ink:#F6C7AE; --shadow:0 10px 30px rgba(0,0,0,.45)`.
Habit colours — each defines `--c-<name>` and `--c-<name>-soft`:
light: terracotta `#D6602F`/`#F5DCCB` · ochre `#C9962B`/`#F3E5C2` · sage `#7A9A6A`/`#DDE7D3` · slate `#5C7D97`/`#D6E1EA`
· plum `#8A5A83`/`#E6D6E3` · rose `#C4667A`/`#F2D6DD` · moss `#4F7B5C`/`#D2E3D6` · graphite `#6A655F`/`#E3DED6`.
dark: terracotta `#E97A49`/`#3A251A` · ochre `#E0AC3F`/`#3A2F18` · sage `#93B383`/`#24301F` · slate `#7FA2BE`/`#1E2A35`
· plum `#B07FA8`/`#32243A` · rose `#E08AA0`/`#3A2430` · moss `#6FA07E`/`#1F3027` · graphite `#9B948C`/`#2C2824`.
Helper classes `.tone-<name>` set `--tone` and `--tone-soft` so components use `color: var(--tone)`.
Radii: `--r-sm:10px; --r-md:16px; --r-lg:24px; --r-pill:999px`. Spacing scale 4/8/12/16/20/24/32.

**Texture.** `body::before`: fixed full-screen pseudo-element with an SVG `feTurbulence` noise data-URI,
opacity .035 (light) / .06 (dark), `pointer-events:none`, `mix-blend-mode: multiply` in light. Paper, not grit.

**Motion.** Tab/page load: list rows rise + fade with a 35ms stagger (`animation-delay: calc(var(--i) * 35ms)`).
Check toggle: scale spring `cubic-bezier(.34,1.56,.64,1)` 320ms + checkmark stroke draw (`stroke-dashoffset`)
260ms. Ring: `stroke-dashoffset` transition 600ms ease-out. Tab switch: content fades in 160ms. Sheets slide up
240ms. `@media (prefers-reduced-motion: reduce)` disables non-essential animation. Confetti: canvas overlay.

**Mobile/PWA ergonomics (base.css).** `html{-webkit-text-size-adjust:100%; color-scheme: light dark}`;
`body{overscroll-behavior-y:none; -webkit-tap-highlight-color:transparent; background:var(--bg); color:var(--ink)}`;
interactive elements `touch-action: manipulation; user-select: none`; form inputs ≥16px font (prevents iOS zoom);
layout uses `100dvh`; safe areas via `env(safe-area-inset-*)` on the header and tab bar; tap targets ≥44px;
`:focus-visible` outlines in ember; sticky/fixed tab bar with blurred `--surface` background.

**Layout.** Generous top padding in headers; one column; tab bar fixed to the bottom with 4 items — 24px line
icons, 11px small-caps labels, the active item in ember with a small dot beneath. Sheets slide up from the
bottom with a drag-handle bar, `--r-lg` top corners, blurred backdrop.

Avoid: purple gradients, Inter/Roboto/system fonts for display text, grids of drop-shadowed cards,
emoji in headlines, exclamation-heavy copy, generic "dashboard" chrome.

*Deviation (as built, polish):* `:focus-visible` also draws a 2px `--surface` gap (box-shadow) under the ember outline, so the ring
keeps 3:1 on tinted fills such as today's band.

## 10. Shared components — `src/components/` (built in Foundation, used by everyone)

- `Check` `{ checked: boolean; onChange(): void; tone: HabitColor; size?: number; disabled?: boolean; label: string }`
  — round button; filled with `--tone` when checked; animated SVG check; `aria-pressed`; 44px min hit area.
- `Ring` `{ value: number /*0..1*/; size?: number; stroke?: number; children?: ReactNode }` — SVG progress ring,
  ember on a `--line` track, animated.
- `Sheet` `{ open: boolean; onClose(): void; title?: string; children: ReactNode }` — bottom-sheet portal,
  `role="dialog"`, `aria-modal`, Escape and backdrop close it, body scroll lock, safe-area bottom padding.
- `Button` `{ variant?: 'primary'|'ghost'|'danger'|'subtle'; size?: 'md'|'lg'; full?: boolean }` + native button props.
- `Chip` `{ selected?: boolean; tone?: HabitColor }` + native button props. Pill shaped.
- `SegmentedControl` `{ options: { value: string; label: string }[]; value: string; onChange(v: string): void; label: string }`.
- `EmptyState` `{ title: string; body: string; action?: ReactNode }`.
- `Icon` `{ name: IconName; size?: number }` with `IconName` = `'sun'|'grid'|'chart'|'list'|'plus'|'chevronLeft'|
  'chevronRight'|'check'|'flame'|'trash'|'archive'|'restore'|'edit'|'close'|'share'|'up'|'down'|'download'|'upload'|'gear'`
  — inline SVG, `currentColor`, stroke 1.75, round caps.
- `Confetti` `{ fire: boolean; colors: string[] }` — canvas overlay, self-removing.

*Deviation (as built):* `Ring` also takes `label` and `valueText` (`aria-label` / `aria-valuetext`). `Sheet` remembers its opener in
the commit where `open` turns true and focuses it again after unmounting, ignores taps while it slides out, and arms Escape, the Tab
trap, the scroll lock and its focus step in a layout effect, in the commit that inserts the panel (§14.10).

## 11. File ownership (parallel work — never edit files you don't own)

- **foundation**: `package.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `.gitignore`,
  `README.md`, `src/main.tsx`, `src/App.tsx`, `src/App.css`, `src/vite-env.d.ts`, `src/pwa.ts`, `src/styles/**`,
  `src/lib/**`, `src/components/**`, placeholder implementations of every feature component (final export names
  and props), placeholder `public/icons/*`.
- **today**: `src/features/today/**`
- **week**: `src/features/week/**`
- **progress**: `src/features/progress/**`
- **manage**: `src/features/manage/**` (incl. `HabitEditor.tsx`, `SettingsSection.tsx`)
- **logic**: `src/lib/dates.ts`, `src/lib/streaks.ts`, `src/lib/motivation.ts`, `src/lib/selectors.ts`,
  `src/lib/store.ts`, `src/lib/__tests__/**`, `vitest.config.ts` — may fix bugs; must NOT change exported signatures.
- **pwa**: `src/features/pwa/**`, `src/pwa.ts`, `public/**`, `scripts/**`, `index.html` (head tags), the
  `VitePWA({...})` block inside `vite.config.ts`, `.github/workflows/deploy.yml`.

Feature components take no props except where stated; they read the store directly.
Exports: `TodayView`, `WeekView`, `ProgressView`, `ManageView`, `HabitEditor({ open, habitId?, onClose })`,
`InstallHint()` (a slim dismissible banner rendered by `App.tsx` above the tab bar; shows only on iOS, not
standalone, not dismissed).

## 12. Quality bar

- `npm run typecheck`, `npm run build`, `npm test` must pass. No `any`. No console errors or React warnings in the browser.
- Every pure function in `src/lib` has tests, including: week boundaries, DST-transition weeks (tests run with
  `TZ=America/New_York`), habits created mid-week, archived habits, bonus completions, pending today, streak
  milestones, deterministic motivation, and import validation of malformed data.
- Accessibility: every control has a label; tap targets ≥44px; text contrast ≥4.5:1; reduced motion respected.
- Works offline after first load; data survives reload; iOS "Add to Home Screen" opens standalone with the
  correct icon, title and status-bar treatment; the deployed app works under the `/habit-tracker/` base path.
  *(As built: since 2026-10-18 the deployed app is at the root of web.app (§13.7); a sub-path base is still supported and tested.)*

## 13. Phase 2 — Optional cloud sync (Firebase) and multi-host packaging

### 13.1 Principle
Local-first stays exactly as it is. Without signing in, nothing changes. Signing in (Settings → "Sync across
devices") mirrors the local store to Firestore and keeps all the owner's devices in sync, including offline
queuing. Firebase code is lazy-loaded (dynamic import) so the local-only experience does not pay for it:
only `import type` from `firebase/*` may appear at the top of any file; the SDK reaches the bundle solely
through the dynamic imports inside `loadFirebase()`.

### 13.2 Firebase services (Spark free tier, no billing) — project `momentum-harshitlarl`, Firestore in asia-south1
- Auth: Email/Password only — it works inside iOS standalone PWAs (no popups, no redirects). Password reset by email.
- Firestore with persistent local cache:
  `initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })`,
  falling back to `memoryLocalCache()` when that throws (private mode, unsupported browser).
- Hosting via `firebase.json` (public dist, SPA rewrite, cache headers). Rules in `firestore.rules`.
- Config via Vite env in `.env` (public values — security lives in the rules): `VITE_FIREBASE_API_KEY`,
  `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. `.env` IS committed.
  `isSyncConfigured()` is false when any is missing → the entire sync UI is hidden and no Firebase code loads.

### 13.3 Firestore data model
```
users/{uid}/habits/{habitId}:
  { id, name, emoji, color, note?, days, createdAt, archivedAt?, order,
    completions: { [dateKey]: true },     // map of LOCAL calendar dates
    deleted: boolean,                     // tombstone — sync never hard-deletes (only "Delete cloud data" does)
    updatedAt: <serverTimestamp> }
```
Rules: a signed-in user may read/write only `users/{uid}/**` where `uid == request.auth.uid`; everything
else is denied. Field validation in rules is deliberately minimal: the data is owner-only, and a batch write
must never be partially rejected by a rule the client did not anticipate. The client validates instead
(`parseRemoteDoc` on read, the store on write).

### 13.4 Local store additions — IMPLEMENTED in `src/lib/store.ts` (persist version 2)
- `deletedIds: string[]` tombstones — `deleteHabit` appends (deduplicated); `resetAll` clears; `exportData`
  includes it; `importData` keeps the union of the device's and the backup's tombstones.
- `importData` and tombstones: a tracker in the backup whose id is tombstoned on this device is restored under a
  NEW id (same fields, same completions) so the deletion stays final everywhere a synced copy might live.
- `applyRemote(data: LocalData)` — wholesale replace of habits, completions and deletedIds; used only by the
  sync engine; no-op (no set, no persist write) when `sameData()` says nothing changed.
- `AppData` gains optional `deletedIds?: string[]` (version stays 1: old files import, new files import on old builds).
- Persist `migrate` v1→v2 adds `deletedIds: []`; `merge` re-validates every field (a damaged blob never crashes hydration).
- `resetAll()` now means "reset this device" — local only. The UI signs out first when signed in.

### 13.5 Sync module — `src/lib/sync/` (exact contract in `src/lib/sync/types.ts`; stubs carry every signature)
Types: `LocalData { habits; completions; deletedIds }`, `RemoteHabit = Habit & { completions: Record<DateKey, true>;
deleted: boolean; updatedAt?: unknown }`, `PushOp` (`setHabit` | `addCompletion` | `removeCompletion` | `tombstone`),
`MergeResult { merged; toPush }`, `SyncStatus`, `SyncUser { uid; email }`, `SyncState`.
- `firebase.ts`: `isSyncConfigured(): boolean` (done), `loadFirebase(): Promise<{ app, auth, db }>` — dynamic-imports
  firebase/app, firebase/auth, firebase/firestore once (memoised promise).
- `syncStore.ts` (done; zustand, NOT persisted): `SyncState` + `setStatus(status, error?)`, `setUser`, `setPending`,
  `markSynced(at)`, `setError(message)`. Initial status `'off'` when not configured, else `'signed-out'`.
- `auth.ts`: `signIn(email, pw)`, `signUp(email, pw)`, `resetPassword(email)`, `signOutUser()`,
  `onAuthChanged(cb): Promise<() => void>`, `friendlyAuthError(error: unknown): string` — maps auth/invalid-email,
  auth/user-not-found, auth/wrong-password, auth/invalid-credential, auth/email-already-in-use, auth/weak-password,
  auth/too-many-requests, auth/network-request-failed; anything else → one calm generic sentence. Each wrapper
  trims the email and rethrows `new Error(friendlyAuthError(e))`.
- `merge.ts` (PURE, no Firebase imports, fully unit-tested):
  `parseRemoteDoc(id, data: unknown): RemoteHabit | null` — validates one raw document (never throws; null when unusable);
  `remoteToLocal(remote)` — non-deleted docs → habits (strip completions/deleted/updatedAt) + completions (true-valued
  keys only); deleted docs → deletedIds;
  `mergeSnapshots(local, remote) → { merged, toPush }` — tombstones = union of both sides and always win; habits =
  union by id excluding tombstoned ids, REMOTE fields win for ids on both sides, completions unioned per habit;
  habits sorted by order, then createdAt, then id, re-numbered 0..n-1 only if duplicates exist; `toPush` = `setHabit`
  for local-only habits, `tombstone` for ids tombstoned locally that exist remotely as non-deleted docs (never for
  ids the remote has never seen), `addCompletion` for local completions missing remotely;
  `diffForPush(prev, next)` — `setHabit` for added/changed habits (field comparison), `addCompletion`/`removeCompletion`
  per key (only for habits present in `next`), `tombstone` for ids newly in `next.deletedIds`; a habit removed
  without a tombstone produces no op;
  `sameData(a, b)` (done, with `sameHabit`, `sameCompletions`) — deep equality, order-insensitive for deletedIds.
- `engine.ts`: `startSync(uid)` / `stopSync()` / `deleteCloudData(uid)`:
  1. `onSnapshot(collection(db,'users',uid,'habits'), { includeMetadataChanges: true }, …)`; status `'connecting'`
     until the first snapshot.
  2. Until the first SERVER-confirmed snapshot (`fromCache === false`): `mergeSnapshots(local, remote)`,
     `applyRemote(merged)`, execute `toPush`.
  3. After that, remote is authoritative: `applyRemote(remoteToLocal(remote))`; `pending = hasPendingWrites`;
     `status = fromCache ? 'offline' : 'synced'`; `markSynced(Date.now())` when server-confirmed.
  4. `useStore.subscribe` → when habits/completions/deletedIds change and we are not applying remote,
     `diffForPush(lastPushed, current)` → `writeBatch` in chunks of ≤ 400 ops:
     `setHabit` → `set(ref, { ...habitFields, updatedAt: serverTimestamp() }, { merge: true })` — never writes `deleted`;
     `addCompletion` → `set(ref, { completions: { [k]: true } }, { merge: true })`;
     `removeCompletion` → `update(ref, { ['completions.' + k]: deleteField() })` (ignore not-found);
     `tombstone` → `set(ref, { deleted: true, updatedAt: serverTimestamp() }, { merge: true })`.
     `lastPushed` is updated after every apply and every successful push.
  5. Loop guard: module flag `applyingRemote` + `sameData` before `applyRemote`, so echoes never re-push.
     Listener errors (permission-denied, …) → `setError(friendly message)`. `stopSync()` unsubscribes both the
     listener and the store subscription and resets module state (safe to call twice; sign-out → sign-in as
     another user must not see stale `lastPushed`).
  `deleteCloudData(uid)`: read all docs under `users/{uid}/habits` and delete them in chunked batches.
- `bootstrap.ts`: `initSync()` — called from `main.tsx` after render; if `!isSyncConfigured()` set status `'off'`
  and return; else `setTimeout(0)` → `loadFirebase` → `onAuthStateChanged`: user → `setUser`, `startSync(uid)`;
  null → `stopSync()`, `setUser(null)`, status `'signed-out'`. Never throws, never blocks rendering.

*Deviations (as built, polish):* `initSync` loads the SDK at launch only when the device has a session to restore
(`momentum-sync-session` in `baseline.ts`, or a phase-2 install's saved baseline); otherwise the Sync card's Sign in / Create account
loads it. A sign-out whose queued writes were not confirmed (offline, flush timeout) keeps that account's baseline, so the next sign-in
replays them three-way; another account's sign-in drops it.

### 13.6 UI — Settings → "Sync across devices" (`src/features/manage/SyncSection.tsx` + `.css`)
- Hidden when `!isSyncConfigured()`.
- Signed out: one-line explainer ("Back up and sync your trackers across your devices. Only you can read your data."),
  email (type email, autocomplete username, inputmode email) + password (autocomplete current-password) inputs at
  ≥16px, primary "Sign in", subtle "Create account", "Forgot password?" → reset email with inline confirmation;
  friendly inline errors in ember-ink; disabled + busy state while a request runs; Enter submits.
- Signed in: the account email; status line with a small coloured dot — "Synced · just now" / "Synced · 5 min ago"
  (relative, refreshed every 30 s, interval cleaned up) / "Syncing…" / "Offline — changes will sync when you're back
  online" / the error text; "Sign out" (keeps local data); "Delete cloud data" (two-step inline confirm → `deleteCloudData`
  → `signOutUser`).
- Existing "Reset all data" → "Reset this device" (signs out first when signed in; the confirmation says so).
  Import confirmation copy mentions "and syncs to your account" when signed in.

*Deviations (as built, polish):*
- Signed out, the card shows the explainer and one subtle 44px "Sign in or create account" button; the form (unchanged) opens on that
  tap and stays open once opened in the session, while a request runs and while a message shows.
- Settings card order: Appearance → Your data → Sync across devices → Install on iPhone → Reset this device (see §3.4).
- Every reset confirmation asks "Reset this device?": "Reset" signed out; signed in, "Sign out and reset", or "Reset anyway" when the
  account may not hold every change yet.
- Signed in, the import confirmation says "Trackers and tasks not in this backup are deleted from your account and every signed-in
  device, and check-ins made since it was exported are removed. There is no undo." in place of "and syncs to your account".

### 13.7 Hosting files
- `firebase.json` (hosting: public "dist", ignore, rewrites `**` → `/index.html`, headers: `/sw.js`, `/index.html`,
  `/manifest.webmanifest` → `Cache-Control: no-cache`; `/assets/**` → `public, max-age=31536000, immutable`;
  `/icons/**` → `public, max-age=86400`; firestore: rules + indexes), `.firebaserc` (default `momentum-harshitlarl`),
  `firestore.rules`, `firestore.indexes.json`.
- `vercel.json` (SPA rewrite for paths without a file extension, excluding assets/ and icons/; same cache headers),
  `netlify.toml` (build command, publish dist, `/*` → `/index.html` 200, same headers).
- package.json scripts: `deploy:firebase` = `npm run build && firebase deploy --only hosting,firestore`;
  `deploy:rules` = `firebase deploy --only firestore:rules`. Live URLs: https://momentum-harshitlarl.web.app and
  https://harshitlarl.github.io/habit-tracker/ (GitHub Actions, `BASE_PATH=/habit-tracker/`).

*Deviation (as built, polish):* the three host configs also send `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `X-Frame-Options: DENY` and a `Permissions-Policy` that turns off camera, microphone and
geolocation (no CSP yet), and cache `/fonts/**` for a day like the icons. GitHub Pages cannot send headers.

*Deviation (as built, 2026-10-18): one host.* GitHub Pages is switched off and https://momentum-harshitlarl.web.app is the
only live URL, because each origin keeps its own local copy of the data. `.github/workflows/deploy.yml` ("Test and deploy")
runs typecheck, unit tests and build on pull requests; on a push to `main` it runs them again and then
`firebase deploy --only hosting` (firebase-tools pinned), signed in keylessly through Workload Identity Federation: pool `github`,
provider `habit-tracker` (issuer `token.actions.githubusercontent.com`; condition: repository id 1422388619, owner id 64593254,
ref `refs/heads/main`), impersonating `github-deploy@momentum-harshitlarl.iam.gserviceaccount.com`, which holds only
`roles/firebasehosting.admin` and `roles/serviceusage.serviceUsageConsumer`. Rules are not deployed by CI (`npm run deploy:rules`).
`harshitlarl.github.io` was removed from the Auth authorized domains. `vercel.json` and `netlify.toml` remain as undeployed
alternatives.

### 13.8 Tests
- Unit (vitest, no Firebase SDK needed): `parseRemoteDoc` (good doc, missing fields, wrong types, extra keys);
  `remoteToLocal`; `mergeSnapshots` — local-only, remote-only, both (completions union, remote fields win), tombstone on
  either side, duplicate orders, never tombstone unknown docs; `diffForPush` — added habit, edited fields, completion
  added/removed, tombstone, habit removed without tombstone, no-op; `sameData`; `friendlyAuthError`; store migrate
  v1→v2, `deleteHabit` tombstones, `importData` with/without `deletedIds` and the re-key rule, `applyRemote` no-op/replace,
  `exportData` includes `deletedIds`.
- e2e (Playwright, WebKit iPhone 14): with env configured the sign-in form renders in Settings and nothing else
  changes; a real-backend spec signs up a throwaway account, syncs between two contexts in realtime, deletes cloud
  data, and always cleans the account up (Identity Toolkit REST `accounts:delete`). As built (§14.10 Tests): every Node-side call
  is retried, and the credentials are recorded before sign-up in a git-ignored, owner-only ledger (`e2e/.pending-cleanup/`) that
  the next run sweeps, so a worker killed mid-run cannot leave the account behind for good.

### 13.9 Phase-2 file ownership (parallel work — never edit files you don't own)
- **sync-core**: `src/lib/store.ts`, `src/lib/types.ts`, `src/lib/selectors.ts`, `src/lib/sync/merge.ts`, `src/lib/__tests__/**`.
- **sync-firebase**: `src/lib/sync/firebase.ts`, `syncStore.ts`, `auth.ts`, `engine.ts`, `bootstrap.ts`, `src/main.tsx`, `src/vite-env.d.ts`.
- **sync-ui**: `src/features/manage/**`.
- **hosting**: `firebase.json`, `.firebaserc`, `firestore.rules`, `firestore.indexes.json`, `vercel.json`, `netlify.toml`,
  `package.json` (scripts only), `README.md` ("Hosting & sync" section), `.gitignore`.

## 14. Phase 3 — One-time tasks

### 14.1 What and why
Trackers are recurring. A **task** is a one-time, dated item: "Tuesday — renew the gym membership", "Thursday 3:00 pm — meeting
with mentor". Tasks live next to trackers on Today, appear under their day in Week, carry over while undone, and sync like
everything else. They never touch the progress ring, streaks, confetti or motivation copy (those stay about habits).
Vocabulary in the UI: "task" / "tasks" (never "to-do", never "plan"). Adding a tracker stays a separate action (the
Today add-tracker control, see §3.1 and its deviation note); the Tasks section has its own add button.

### 14.2 Data model — `src/lib/types.ts` (IMPLEMENTED)
```ts
export const TASK_TITLE_MAX = 60;
export const TASK_NOTE_MAX = 80;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;   // 'HH:mm', 24-hour
export const isTimeString: (v: unknown) => v is string;
export interface Task {
  id: string;
  title: string;      // trimmed, 1–60 chars
  note?: string;      // trimmed, ≤ 80 chars
  date: DateKey;      // planned LOCAL calendar date
  time?: string;      // 'HH:mm' 24-hour, optional
  done: boolean;
  doneAt?: DateKey;   // LOCAL date it was checked off (differs from `date` when done late); only while done
  createdAt: DateKey;
}
```
`AppData` gains optional `tasks?: Task[]` and `deletedTaskIds?: string[]` (version stays 1: old backups import, new backups
import on old builds, which ignore the two keys). `src/lib/tasks.ts` re-exports the constants and `isTimeString`.

### 14.3 Store — `src/lib/store.ts` (IMPLEMENTED; persist version 3)
- State: `tasks: Task[]`, `deletedTaskIds: string[]` (tombstones, same role as `deletedIds`).
- `addTask(input: TaskInput): Task` — `TaskInput = { title; date; time?; note?; createdAt? }`; title/note trimmed and capped,
  blank title → 'Untitled', invalid `time` dropped, invalid `date` falls back to `createdAt` (default today).
- `updateTask(id, patch: TaskPatch)` — `TaskPatch = Partial<Pick<Task, 'title' | 'note' | 'date' | 'time'>>`, applied field by
  field; `note`/`time` clearable with `undefined` or `''`; a blank title or invalid date is ignored; unknown id → no change.
- `setTaskDone(id, done, today = todayKey())` — sets `doneAt = today` when done, deletes it when undone; no-op when unchanged.
  `toggleTask(id, today?)`. `deleteTask(id)` removes and tombstones in `deletedTaskIds` (unknown ids ignored).
- `exportData` includes `tasks` and `deletedTaskIds`. `validateAppData`/`importData`: tasks are optional in the file and strict
  when present (valid unique ids, title 1–60, note ≤ 80, real `date`, `time` matching TIME_RE, boolean `done`, `doneAt` kept only
  while done, real `createdAt`); import REPLACES tasks (a backup without tasks leaves none), tombstones the replaced ones, re-keys
  a backup task whose id is tombstoned here (same rule as trackers) and unions tombstones.
- `resetAll` clears both. `applyRemoteTasks(data: LocalTasks)` replaces tasks + tombstones wholesale (no-op via `sameTasks`).
- Persist `migrate` v2→v3 adds `tasks: []`, `deletedTaskIds: []`; hydration repair (`repairTask`) fixes damaged records field by
  field (blank title → 'Untitled', bad date → createdAt → today, damaged optional fields dropped).
- Tests so far: `src/lib/__tests__/store-tasks.test.ts` (smoke); tasks-core extends them.

### 14.4 Pure helpers — `src/lib/tasks.ts` (signatures fixed; `compareTasks`/`sortTasks` IMPLEMENTED, the rest are stubs)
- `compareTasks(a, b)`: by `date`, then timed before untimed, then `time`, then `createdAt`, then `id`. `sortTasks(list)` (copy).
- `tasksOn(tasks, dateKey)`: every task (any state) with `date === dateKey`, sorted.
- `carriedOver(tasks, today)`: `!done && date < today`, sorted (oldest first).
- `tasksForToday(tasks, today) → { carried, scheduled, openCount }` — `openCount` counts undone items in both lists.
- `tasksInWeek(tasks, mondayKey) → Map<DateKey, Task[]>`: only days that have tasks, Monday→Sunday order, each list sorted.
- `taskStatus(task, today) → 'done' | 'open' | 'overdue' | 'upcoming'` (`open` = today and undone).
- `nextWeekdayKey(today, weekday)`: the next occurrence strictly after today (1–7 days ahead).
- `quickDates(today)`: `[{ key: today, label: 'Today' }, { key: tomorrow, label: 'Tomorrow' }, …five more days labelled like 'Tue 21']`.
- `relativeDayLabel(dateKey, today)`: 'Today' / 'Tomorrow' / 'Yesterday' / weekday name when within 6 days either way / 'Tue 21 Oct'.
- `formatTime(time)`: device-locale clock via `Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })` applied to a
  LOCAL Date built from the 'HH:mm' ('15:00' → '3:00 pm' or '15:00' depending on the device); invalid input is returned as is.
- Fully unit-tested in `src/lib/__tests__/tasks.test.ts` (tests run with TZ=America/New_York; cover DST and month boundaries).

### 14.5 Today — `src/features/today/` (TaskSection.tsx, TaskRow.tsx + CSS; TodayView renders the section)
- Position: after "Due today", before "Not scheduled today". Also rendered when there are no trackers at all (below the empty state),
  so a first task can be planned before the first tracker.
- Header row: small-caps "Tasks"; right side: status small-caps ("2 left" / "All done"; nothing when there are no tasks) and a
  44px icon button "Add task" (`plus` icon, 20px) that opens `TaskEditor` with `defaultDate = today`.
- List: carried-over tasks first (oldest first), then today's (sorted). Row = square `Check` (`shape="square"`, `tone="ember"`,
  size 36, label "Mark <title> done"), then a text button filling the row (opens the editor for that task): title (15px; done →
  `--ink-3` with a soft strike), meta line (12px, `--ink-2`): `formatTime(time)` when timed, `· note` when present, and for
  carried-over items a small-caps "From Tue 14 Oct" (`relativeDayLabel`) in `--accent-text`. Done tasks sink to the bottom of
  their group. Row rise-in uses the same `--i` stagger as HabitRow.
- Empty: one quiet line "Nothing planned today." (`--ink-2`, italic serif); the header "+" stays visible.
- `Check` gains an additive `shape?: 'round' | 'square'` prop (default round) and `tone: HabitColor | 'ember'`; `.tone-ember`
  joins the `.tone-*` rules in base.css (`--tone: var(--ember); --tone-soft: var(--ember-soft)`) and `toneClass` widens to match.
- Settings: the "Reset this device" copy and the import preview (`describeBackup`) mention tasks.

### 14.6 Week — `src/features/week/` (WeekTasks.tsx + CSS; WeekView renders it under the summary, and below the EmptyState when there are no trackers)
- Section "Tasks this week" with a 44px "Add task" icon button. Default date for the new task: today when the shown week is the
  current one; that week's Monday when it is a future week; today for past weeks.
- Groups per day that has tasks: small-caps label "Tue 21 · Tomorrow" (`relativeDayLabel` supplies the relative part only when it
  is Today/Tomorrow/Yesterday); rows like Today's (check + title + meta). Past, undone tasks show a small-caps "Still open" in
  `--accent-text`; they can still be checked here (`doneAt = today`). Future tasks can be checked early.
- Empty week: one line "No tasks this week." The ‹ › navigation already changes the week; the section follows it.

### 14.7 Task editor — `src/features/tasks/TaskEditor.tsx` (+ CSS; reuse `Sheet`, `Chip`, `Button`, `InlineConfirm`, `fields.css`)
- Props `{ open: boolean; taskId?: string; defaultDate?: DateKey; onClose: () => void }`. Title "New task" / "Edit task".
- Fields, in order: **Title** (autofocus when new; maxLength 60 with count; required; ≥16px), **Date**: chip row from `quickDates`
  plus a last chip "Pick a date…" that reveals a native `<input type="date">` (shown selected and labelled with the formatted date
  when the task's date is outside the quick range), **Time**: a ghost button "Add a time" that reveals `<input type="time">` plus
  a "Remove" link; **Note** (optional, maxLength 80 with count).
- Buttons: primary full-width "Save task" / "Save"; for existing tasks a "Delete task" danger-subtle button with the same inline
  two-step confirm the tracker editor uses. Enter in the title submits. Native date/time inputs are ≥16px and 44px tall, styled
  with the field tokens and `color-scheme`, in both themes. Form state resets per open session the way HabitEditor does.
- Validation: empty title → inline error; invalid date → inline error. Saving an existing task calls `updateTask`; a new one
  `addTask`. Focus returns to the row's button on close.

### 14.8 Sync — `src/lib/sync/` (types in `types.ts`; pure layer `tasksMerge.ts` IMPLEMENTED; engine + baseline to extend)
- Firestore `users/{uid}/tasks/{taskId}`: `{ id, title, note?, date, time?, done, doneAt?, createdAt, deleted, updatedAt }`. The
  deployed rules already cover it (owner-only subtree) — no rules change.
- Types (`types.ts`, IMPLEMENTED): `LocalTasks { tasks; deletedTaskIds }`, `RemoteTask = Task & { deleted; updatedAt? }`,
  `TaskPushOp = { type: 'setTask'; task } | { type: 'tombstoneTask'; taskId }`, `TasksMergeResult`. `LocalData` and `PushOp`
  are UNCHANGED: habits and tasks are two independent collections with parallel logic.
- `tasksMerge.ts` (IMPLEMENTED, smoke-tested in `src/lib/__tests__/sync-tasks-merge.test.ts`): `parseRemoteTask(id, data)` (strict
  on title/date, lenient on optional fields, bare tombstones allowed, never throws), `remoteTasksToLocal`, `mergeTasks` (first
  contact: union, remote fields win except a done side wins on `done`/`doneAt`, tombstones win, never tombstone an unseen id),
  `mergeTasksWithBase(base, local, remote)` (three-way, field-by-field replay of local edits incl. un-checks; a task the cloud
  dropped without a tombstone is kept and re-pushed), `restoreTombstonedTasks`, `diffTasksForPush`, `sameTask`, `sameTasks`
  (order-insensitive). The engine must use these exactly as it uses the habit counterparts.
- Engine (`engine.ts`, to extend): a second `onSnapshot` on `users/{uid}/tasks` with `includeMetadataChanges`, driving the same
  state machine as habits (first contact → `mergeTasks`; afterwards → `mergeTasksWithBase` against the baseline at launch and the
  last pushed state within the session; cache snapshots before the first server view handled as for habits). The two channels
  share the write batches (both collections live under `users/{uid}`, so one batch may carry habit and task ops), the
  `applyingRemote` guard and the store subscription; a rejected batch rolls back each channel it wrote (both, for a mixed
  batch). Writes: `setTask` →
  `set(ref, { id, title, note: note ?? deleteField(), date, time: time ?? deleteField(), done, doneAt: doneAt ?? deleteField(),
  createdAt, updatedAt: serverTimestamp() }, { merge: true })` (never writes `deleted`); `tombstoneTask` → `set(ref, { deleted:
  true, updatedAt: serverTimestamp() }, { merge: true })`. Every task document goes through `parseRemoteTask`.
- Status: `connecting` until BOTH collections have a server-confirmed snapshot, then `synced`; the confirm timeout and the
  `offline` rule cover both; `pending` is true while either collection has pending writes. The "cloud cleared" detection covers
  acknowledged documents of both collections; `stopSync` tears both listeners down; `deleteCloudData` hard-deletes both
  collections (tasks too) and clears the baseline.
- Baseline (`baseline.ts`): the saved record gains the tasks side (`tasks: LocalTasks`, `ackedTasks: string[]`); a v1 record
  (saved by phase 2) reads with an empty tasks side, which is correct because no task existed before phase 3. The baseline is
  written only once both collections are server-confirmed with no pending writes.
- Store hook: `applyRemoteTasks` for the tasks side, `applyRemote` for habits, both inside the `applyingRemote` guard.

### 14.9 Phase-3 file ownership (parallel work — never edit files you don't own)
- **tasks-core**: `src/lib/tasks.ts` (implement the stubs), `src/lib/__tests__/tasks.test.ts`, `src/lib/__tests__/store-tasks.test.ts`,
  `src/lib/__tests__/store.test.ts`, `src/lib/store.ts` (bug fixes only, no signature changes).
- **tasks-sync**: `src/lib/sync/**` except `types.ts` (engine.ts, baseline.ts, auth.ts, bootstrap.ts, firebase.ts, tasksMerge.ts bug
  fixes), `src/lib/__tests__/sync-*.test.ts`.
- **tasks-today**: `src/features/today/**`, `src/features/tasks/**`, `src/components/Check.tsx` + `Check.css`, `src/styles/base.css`
  (only the `.tone-ember` rule), `src/lib/selectors.ts` (only widening `toneClass`).
- **tasks-week**: `src/features/week/**`.
- Integration (single owner afterwards): `src/features/manage/**` copy (reset + import preview mention tasks), README, SPEC deviations.

### 14.10 Phase-3 deviations and decisions (as built)
Recorded by the integration owner; each file's header comment carries the same note where it applies.

**Today (§14.5)**
- A done task's title is set in `--ink-2` with the 1px strike drawn in `--ink-3`, on Today and on Week alike: `--ink-3` is 2.7:1 on
  paper and the house rule is ≥ 4.5:1 for text (base.css applies the same rule to small-caps labels).
- A carried-over task checked off today stays listed in the carried group, checked, until midnight — so a late check-off can be
  undone and the day's work stays visible. `carriedOver`/`tasksForToday` are unchanged (open items only); the pure helper
  `carriedOverDone(tasks, today)` in `src/lib/tasks.ts` supplies the rule (`done && date < today && doneAt === today`).
- Done tasks sink to the bottom of their group on Today, as specified; on Week they keep their chronological place within the day
  (the ledger never reorders under the finger). Two deliberate behaviours, not one.
- The square `Check` is 36px on Today and 32px on Week, matching each view's scale. Both rows share the same anatomy but stay two
  components (`today/TaskRow.tsx`, the row inside `week/WeekTasks.tsx`) because their alignment rules differ.
- Today's task rows rise in with the `--i` stagger only at the section's first paint; a row that mounts later (a task just saved, one
  moving between the carried and today groups, a new day's list) fades in instead. Each row drops its entrance class once it has
  played: WebKit restarts a class-driven animation whenever React re-inserts a moved row (a done task sinking), so it blinked.
- Row buttons on Today and Week are named in full — "Mentor meeting, 3:00 PM, Bring the portfolio, edit task", plus "from Yesterday"
  on a carried row or "still open" on Week where the meta line shows it (`taskRowLabel` in `src/features/tasks/taskModel.ts`):
  the "·" between the meta parts is aria-hidden, and the adjacent inline text would otherwise run "PM" into the note.

**Task editor (§14.7)**
- Save stays enabled and the inline errors ("Give it a title.", "Pick a date.") appear on a submit attempt, with focus moved to
  the first invalid field; the title error then shows and hides live. HabitEditor (polish) now also keeps Save enabled and marks
  every error on submit, but it still shows its name error on blur as well. Reason: the task sheet is short, so an error line
  appearing while the autofocused title blurs would grow the panel upward between pointer-down and pointer-up, and the Close
  button (or the backdrop) would miss the very tap that caused the blur.
- Quick-date chips use the default ink-filled selected style (`Chip.tone` stays `HabitColor`); the ember tone is reserved for the
  Check. The eight chips wrap to up to three rows on a 375px phone (no horizontal scroller).
- Delete is the `danger` Button variant, full width, labelled "Delete task"; the inline question reads "Delete “<title>”?" with
  "There is no undo."
- A new task's untouched date follows `defaultDate` across midnight: until a chip or the native field is used, the form derives the
  date on every render (`formDate` in `src/features/tasks/taskModel.ts`), so a sheet left open past midnight saves to the new day.
- A date outside the quick row (an existing task's, or one that midnight moved the row past) shows the native date field, and the
  last chip, selected, writes that date out: "Wed 14 Oct" (`customDateLabel`), never a bare weekday name, which beside the quick
  chip "Wed 21" read as the coming one.
- "Deleted on another device" guard, as in HabitEditor: when a tombstone from another device removes the task while its sheet is
  open, a status line says "This task was deleted on another device.", Save and Delete turn off (Enter saves nothing either), the
  typed text stays in the fields, and nothing is re-created under a new id.
- Save and delete (and, in HabitEditor, archive and restore) run once per open session: a double tap on Save adds one task.

**Week (§14.6, and §3.2)**
- With no trackers the Week header still shows the ‹ › navigation and the "This week" pill, so tasks can be planned in other weeks
  before the first tracker exists; the EmptyState copy and button are unchanged. The day groups fade with the week while the head
  and the editor stay mounted, so a week change or midnight never closes a sheet mid-edit.
- Day groups present at first paint continue the grid's rise stagger (`--i` from `rows.length`); a group that appears later (a task
  just saved) fades in instead of waiting for a cascade that already played.
- Focus return (§14.7) is handled by the sections themselves on both Today and Week: the control that opened the editor is remembered
  with the task it was opened for, and focused after the close commits. A row that remounted meanwhile (an edit moved it to another
  day of the shown week, or between Today's carried and today groups) is found again by its task id; "Add task" takes focus only
  when the row is gone — deleted, or moved to a day the section does not show. iOS and WebKit do not focus buttons on tap, so the
  Sheet's own restore to the previously focused element is not enough on the phone.
- Shared `Sheet` fix found by the phase-3 e2e: the 20ms "move focus into the dialog" step armed at mount is now cancelled when the
  sheet starts closing. Closed within those 20ms (Escape right after opening), it used to fire after the opener had restored focus and
  pull it into the departing panel, leaving focus on `<body>`. Applies to HabitEditor as well.
- A closing `Sheet` takes no more taps: `closing` is derived from `open` in the very render that closes it (a state flag set a
  render later left a few milliseconds in which a quick second tap still reached Save), the departing panel has
  `pointer-events: none`, and its backdrop swallows the press without moving focus or closing again. Applies to every sheet.
- The `Sheet` arms what it does while open (its Escape-stack entry and keydown listener, the Tab trap, the scroll lock with
  `html[data-sheet-open]`, the deferred focus step) in a layout effect, in the commit that inserts the panel. As a passive effect a
  commit later, an Escape pressed the moment a sheet appeared was lost and the sheet stayed open (QA round 2; guarded by the e2e
  test "Escape pressed the moment a sheet appears still closes it"). Applies to every sheet.

**Store (§14.3)**
- `updateTask`: `note`/`time` clear with `undefined` or `''` only; an invalid non-empty `time` (e.g. `'25:00'`) is ignored and the
  existing time kept, as a blank title or an invalid date is. The editor's `<input type="time">` can only produce a valid value or `''`.
- Hydration repair: two stored task records under the same cloud-unsafe id count as one duplicate — the first is re-keyed to a fresh
  uuid, the second dropped — exactly as the tracker path does.
- Capped task titles and notes (and tracker names, emoji and notes in hydration repair and the cloud parsers) are trimmed again
  after the cut and never split a surrogate pair (`clampText` in `src/lib/text.ts`), so a capped value re-imports unchanged.

**Sync (§14.8)**
- The baseline is saved only when the reconciling collection's server view carries no pending writes AND the other collection's last
  reconciled server view carried none either; both acknowledged id sets are saved with it. A collection whose last server view had
  pending writes therefore holds the baseline back for both until its next acknowledged view is reconciled (the safe direction: an
  unacknowledged write is never recorded as the cloud's word).
- A snapshot is held back only by in-flight batches that write its own collection, not by any in-flight batch: a habits-only
  hold-back during a task write would lose a remote habit change, since no later habits snapshot follows. A rejected batch rolls back
  only the sides of `lastPushed` it wrote, each to the `prev` of the oldest unsettled batch writing that side, and rebases the `prev`
  of the later unsettled batches on that side onto the same state (there is no session-wide pin). A side the batch did not write
  keeps what its snapshots taught it: rewinding it would replay already-applied cloud changes as local edits over newer cloud values,
  and could re-key and re-upload a task or tracker deleted elsewhere.
- Status: a server snapshot on one collection sets `connecting` (never `synced`) until the other confirms; if the 10 s confirm timer had
  already flipped the status to `offline`, a lone server snapshot flips it back to `connecting` until the second collection answers.
- The saved baseline record is v2 (`tasks`, `ackedTasks` added). A v1 record (phase 2) reads as a valid baseline with an empty tasks
  side; stray task fields on a v1 record are ignored. `writeBaseline` accepts the tasks side as optional (saved empty) so phase-2 callers
  compile unchanged.
- `sameTasks` bug fixed in the pure layer: it could report two lists equal when the first held a duplicate id standing in for a task it
  lacked (only the second list's ids were checked for uniqueness).

**Settings and copy (§14.5 last bullet, §13.6)**
- Reset: "Every tracker, check-in and task on this device will be removed …" (all three variants name tasks). Import preview
  (`describeBackup`): "1 tracker · 42 check-ins · 3 tasks · exported 16 Oct 2026" — tasks are named only when the backup holds some, so
  a pre-phase-3 file reads as before; the replace sentence names the device's tasks when there are some ("The 2 trackers, 5 check-ins
  and 3 tasks on this device will be replaced"), since an import replaces tasks too. The Sync card's lead, sign-out, delete-confirm and
  delete-outcome sentences say "trackers and tasks".

**Tests**
- `e2e/tasks.spec.ts` (Playwright, WebKit iPhone 14, no network) covers the Tasks section, the Week day groups, the editor (Close on an
  untouched sheet, submit-time validation, quick chips, native date/time inputs, note), check-off incl. late and early, the inline
  delete confirm and focus return, persistence (v3) and text contrast in both themes. `e2e/sync.spec.ts` carries tasks between the
  two phones too (planned with a time and a note, checked, renamed, un-checked, deleted while the other phone has it open in the
  editor) and reads `users/{uid}/tasks` back over REST; it ran against the real project in phase 3.
- `e2e/sync.spec.ts` cleanup: it sweeps both collections, retries every Node-side call (1/2/4/8 s backoff on a dropped request or a
  429/5xx, 20 s per request), deletes the account even when the document sweep failed, and records the account's uid in
  `cleanup.json`. The random password lives only in the worker, so before the account can exist the beforeAll writes the
  credentials to a git-ignored, owner-only ledger (`e2e/.pending-cleanup/`, `e2e/helpers/ledger.ts`, throwaway addresses only); the
  afterAll forgets them once a sign-in with them is refused, and each run's beforeAll first removes what earlier runs left there
  (entries whose process has exited, or older than an hour), reported in `cleanup.json` under `earlierRuns`. A run still in progress
  is never swept.
- Realtime budgets in `e2e/sync.spec.ts`: 10 s per hop, except each phone's first write after it signs in or reloads, which gets 20 s
  (`COLD_WRITE_MS`): Firestore opens its Write stream lazily, so that write also pays for the WebChannel handshake.
- `formatTime` output is device-locale dependent; tests assert against the same Intl formula or 12h/24h-tolerant patterns, never an
  exact string.
