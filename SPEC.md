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

### 3.3 Progress
- Overall section first: perfect-day streak (consecutive days where everything due was done), total
  completions, this week's rate. Then a bar chart of the last 8 weeks' completion rate (ember bars, labelled
  by week start, current week last).
- One card per active tracker: emoji + name, current streak, best streak, 30-day rate. A 12-week heatmap:
  7 columns Mon…Sun (aligned with the Week view), rows = weeks (oldest at the top, current week at the bottom);
  done → habit colour; scheduled-but-not-done → hairline outline; unscheduled / before createdAt / future → empty.
- Archived trackers at the bottom in a collapsed section with their final stats and a "Restore" action.

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
next midnight) and on `visibilitychange`/`focus`. `useReducedMotion()` in `src/lib/useReducedMotion.ts`.
`src/lib/platform.ts`: `isIOS()`, `isStandalone()`.

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
