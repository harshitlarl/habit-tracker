import type { DateKey } from './types';
import { STREAK_MILESTONES } from './streaks';

export interface MotivationContext {
  dateKey: DateKey;
  hour: number;
  habitsCount: number;
  /** Habits scheduled today. */
  dueCount: number;
  /** Due habits done today (bonus completions are not counted here). */
  doneCount: number;
  bestCurrentStreak: { habitName: string; days: number } | null;
  perfectDayStreak: number;
  /** At least one due habit yesterday was not done. */
  missedYesterday: boolean;
}

export interface Motivation {
  title: string;
  body?: string;
  tone: 'calm' | 'warm' | 'celebrate' | 'nudge';
}

interface Variant {
  title: string;
  body?: string;
}

export type MotivationState =
  | 'noHabits'
  | 'allDone'
  | 'milestone'
  | 'restDay'
  | 'comeback'
  | 'nothingYet.morning'
  | 'nothingYet.afternoon'
  | 'nothingYet.evening'
  | 'partial.low'
  | 'partial.high';

/** FNV-1a 32-bit. Stable across runs, always non-negative. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ---------- Copy. Warm, direct, short. Titles ≤ 60 chars, no emoji, no exclamation spam. ---------- */

const NO_HABITS: readonly Variant[] = [
  { title: 'A quiet page, waiting for its first line.', body: 'Add one tracker. Small and specific beats big and vague.' },
  { title: 'Start with one thing you want to keep doing.', body: 'Gym, a walk, two pages of a book. You can add more later.' },
  { title: 'Nothing here yet, and that is fine.', body: 'Pick the habit you would miss most if it slipped.' },
  { title: 'Every streak starts with a name.', body: 'Add your first tracker and give it a colour.' },
  { title: 'Begin where you are.', body: 'One tracker is plenty for a first week.' },
];

const ALL_DONE: readonly Variant[] = [
  { title: 'Perfect day. You showed up for everything.', body: 'Rest is part of the work.' },
  { title: 'All done. The whole list, quietly handled.' },
  { title: 'Everything due is done. Enjoy the rest of the day.' },
  { title: 'Clean sweep. Tomorrow starts from a good place.' },
  { title: 'Done, done and done. Nothing left but the evening.' },
  { title: 'Full marks today. Notice how that feels.' },
];

/** {n} and {name} are replaced with the streak length and habit name. */
const MILESTONE: readonly Variant[] = [
  { title: '{n} days straight on {name}. That is a habit forming.' },
  { title: '{name}, {n} days running. Steady is the point.' },
  { title: '{n} in a row on {name}. Look at that line.' },
  { title: '{name}: {n} days without a gap. Keep the rhythm.' },
  { title: 'A {n}-day run on {name}. Quietly impressive.', body: 'Milestones are nice. The next ordinary day matters more.' },
];

const REST_DAY: readonly Variant[] = [
  { title: 'Nothing scheduled today. Rest is part of the plan.' },
  { title: 'A free day. Anything you do is a bonus.' },
  { title: 'No trackers due today. Let the week breathe.' },
  { title: 'Off day. The streaks will be right here tomorrow.' },
];

const COMEBACK: readonly Variant[] = [
  { title: 'Back at it. Showing up again is the whole game.' },
  { title: 'Yesterday slipped. Today did not. That is momentum.' },
  { title: 'One missed day is a blip. You are already moving.' },
  { title: 'Good to see you back. The line picks up from here.' },
  { title: 'A reset, not a restart. Nice work getting going.' },
];

const MORNING: readonly Variant[] = [
  { title: 'Fresh day. Pick the easiest one and begin.' },
  { title: 'Morning. One small check is enough to start.' },
  { title: 'The day is open. Start with whatever feels light.' },
  { title: 'Nothing done yet, nothing missed. A good place to start.' },
  { title: 'Coffee first, then the first check.' },
];

const AFTERNOON: readonly Variant[] = [
  { title: 'Afternoon already. There is plenty of day left.' },
  { title: 'Not started yet. Begin with the two-minute version.' },
  { title: 'Midday check-in: pick one and knock it out.' },
  { title: 'Still open. The easiest tracker first, then see.' },
  { title: 'Half the day left, the whole list available.' },
];

const EVENING: readonly Variant[] = [
  { title: 'Still time for one. Make it the small one.' },
  { title: 'Evening. One check keeps the streak honest.' },
  { title: 'Not every day is big. One thing before bed counts.' },
  { title: 'Late, not lost. Pick one and close the day well.' },
  { title: 'A short version still counts. Ten minutes is fine.' },
];

const PARTIAL_LOW: readonly Variant[] = [
  { title: 'Underway. The first one is always the hardest.' },
  { title: 'Started. That is the part most people skip.' },
  { title: 'Good start. Momentum likes company.' },
  { title: 'You have begun. The rest is lighter than it looks.' },
  { title: 'A check on the board. Build on it.' },
];

const PARTIAL_HIGH: readonly Variant[] = [
  { title: 'More than halfway. Finish strong.' },
  { title: 'Most of it done. The last ones go quick.' },
  { title: 'Over the hump. What is left goes quickly.' },
  { title: 'Nearly there. Finish the list and call it a day.' },
  { title: 'The hard part is behind you. Close it out.' },
];

export const MOTIVATION_POOLS: Readonly<Record<MotivationState, readonly Variant[]>> = {
  noHabits: NO_HABITS,
  allDone: ALL_DONE,
  milestone: MILESTONE,
  restDay: REST_DAY,
  comeback: COMEBACK,
  'nothingYet.morning': MORNING,
  'nothingYet.afternoon': AFTERNOON,
  'nothingYet.evening': EVENING,
  'partial.low': PARTIAL_LOW,
  'partial.high': PARTIAL_HIGH,
};

const TONES: Readonly<Record<MotivationState, Motivation['tone']>> = {
  noHabits: 'calm',
  allDone: 'celebrate',
  milestone: 'celebrate',
  restDay: 'calm',
  comeback: 'warm',
  'nothingYet.morning': 'calm',
  'nothingYet.afternoon': 'warm',
  'nothingYet.evening': 'nudge',
  'partial.low': 'warm',
  'partial.high': 'nudge',
};

function pick(pool: readonly Variant[], dateKey: DateKey, state: MotivationState): Variant {
  const variant = pool[hashString(`${dateKey}:${state}`) % pool.length];
  if (!variant) throw new Error(`Empty motivation pool for ${state}`);
  return variant;
}

function fill(text: string, streak: { habitName: string; days: number }): string {
  // Function replacers insert the values literally; string replacers would interpret `$$`, `$&`
  // and friends inside a habit name such as "Save $$".
  return text.replaceAll('{n}', () => String(streak.days)).replaceAll('{name}', () => streak.habitName);
}

/**
 * Which state the context resolves to, in the spec's priority order.
 *
 * Deviation from SPEC §8 (documented, deliberate): a seventh state, `restDay`, resolves
 * `dueCount === 0` with trackers present (for example only weekday trackers, viewed on a Saturday).
 * The spec's six-state list would route that day to `nothingYet` ("Fresh day. Pick the easiest one
 * and begin."), nudging toward trackers that are not due. `restDay` sits after `milestone` (a
 * streak milestone still deserves its line) and before `comeback`, with tone 'calm'; its copy is
 * in `MOTIVATION_POOLS.restDay`. `partial` would also divide by zero there, so the state is needed.
 */
export function motivationState(ctx: MotivationContext): MotivationState {
  if (ctx.habitsCount === 0) return 'noHabits';
  if (ctx.dueCount > 0 && ctx.doneCount === ctx.dueCount) return 'allDone';
  if (ctx.bestCurrentStreak && STREAK_MILESTONES.includes(ctx.bestCurrentStreak.days)) return 'milestone';
  if (ctx.dueCount === 0) return 'restDay';
  if (ctx.missedYesterday && ctx.doneCount > 0) return 'comeback';
  if (ctx.doneCount === 0) {
    if (ctx.hour < 12) return 'nothingYet.morning';
    if (ctx.hour < 18) return 'nothingYet.afternoon';
    return 'nothingYet.evening';
  }
  return ctx.doneCount / ctx.dueCount < 0.5 ? 'partial.low' : 'partial.high';
}

/**
 * Deterministic for a given day + state: hashString(dateKey + ':' + state) % pool.length,
 * so the line never changes across re-renders within the same state.
 */
export function getMotivation(ctx: MotivationContext): Motivation {
  const state = motivationState(ctx);
  const variant = pick(MOTIVATION_POOLS[state], ctx.dateKey, state);
  const tone = TONES[state];
  if (state === 'milestone' && ctx.bestCurrentStreak) {
    const streak = ctx.bestCurrentStreak;
    const result: Motivation = { title: fill(variant.title, streak), tone };
    if (variant.body) result.body = fill(variant.body, streak);
    return result;
  }
  const result: Motivation = { title: variant.title, tone };
  if (variant.body) result.body = variant.body;
  return result;
}

/** "18 of 21 done · 86%" */
export function getWeekSummaryMessage(done: number, due: number): string {
  if (due <= 0) return 'Nothing due yet this week';
  const pct = Math.round((done / due) * 100);
  return `${done} of ${due} done · ${pct}%`;
}
