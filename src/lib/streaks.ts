import type { Completions, DateKey, Habit } from './types';
import { addDays, isScheduled, startOfWeekKey, weekKeys } from './dates';
import { isDone } from './selectors';

export const STREAK_MILESTONES: readonly number[] = [3, 7, 14, 21, 30, 50, 100, 365];

export interface CompletionStats {
  due: number;
  done: number;
  bonus: number;
  rate: number;
}

export interface WeekSummary {
  due: number;
  done: number;
  rate: number;
}

export interface WeekRate extends WeekSummary {
  mondayKey: DateKey;
}

export interface DayProgress {
  due: number;
  done: number;
}

/**
 * Walk backwards from `today`. A scheduled-but-pending today is skipped (it never breaks a
 * streak); unscheduled days neither count nor break; each scheduled done day adds one and the
 * first scheduled day not done stops the walk. Bonus completions on unscheduled days never count.
 */
export function currentStreak(habit: Habit, completions: Completions, today: DateKey): number {
  if (today < habit.createdAt || habit.days.length === 0) return 0;
  let k = today;
  if (isScheduled(habit, today) && !isDone(completions, habit.id, today)) k = addDays(today, -1);
  let streak = 0;
  while (k >= habit.createdAt) {
    if (isScheduled(habit, k)) {
      if (!isDone(completions, habit.id, k)) break;
      streak += 1;
    }
    k = addDays(k, -1);
  }
  return streak;
}

/** The longest streak (same rules as `currentStreak`) between `createdAt` and `today`. */
export function bestStreak(habit: Habit, completions: Completions, today: DateKey): number {
  if (today < habit.createdAt || habit.days.length === 0) return 0;
  let best = 0;
  let run = 0;
  for (let k = habit.createdAt; k <= today; k = addDays(k, 1)) {
    if (!isScheduled(habit, k)) continue;
    if (isDone(completions, habit.id, k)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * due = scheduled days in [from, to]; done = due days completed; bonus = completions on
 * unscheduled days in range; rate = done/due (0 when nothing was due).
 */
export function completionStats(
  habit: Habit,
  completions: Completions,
  from: DateKey,
  to: DateKey,
): CompletionStats {
  let due = 0;
  let done = 0;
  let bonus = 0;
  for (let k = from; k <= to; k = addDays(k, 1)) {
    const completed = isDone(completions, habit.id, k);
    if (isScheduled(habit, k)) {
      due += 1;
      if (completed) done += 1;
    } else if (completed) {
      bonus += 1;
    }
  }
  return { due, done, bonus, rate: due ? done / due : 0 };
}

/** Due/done counts for one day (bonus completions are not included). */
export function dayProgress(habits: Habit[], completions: Completions, dateKey: DateKey): DayProgress {
  let due = 0;
  let done = 0;
  for (const h of habits) {
    if (!isScheduled(h, dateKey)) continue;
    due += 1;
    if (isDone(completions, h.id, dateKey)) done += 1;
  }
  return { due, done };
}

/** True when at least one habit was due and every due habit was done. */
export function isPerfectDay(habits: Habit[], completions: Completions, dateKey: DateKey): boolean {
  const { due, done } = dayProgress(habits, completions, dateKey);
  return due > 0 && done === due;
}

/**
 * Consecutive perfect days ending today (or yesterday when today is still incomplete).
 * Days with nothing due are skipped. Pass ALL habits (archived ones count for the days they
 * were active) — `isScheduled` handles createdAt/archivedAt bounds.
 */
export function perfectDayStreak(habits: Habit[], completions: Completions, today: DateKey): number {
  if (habits.length === 0) return 0;
  const earliest = habits.reduce((min, h) => (h.createdAt < min ? h.createdAt : min), habits[0]?.createdAt ?? today);
  let k = today;
  const todayProgress = dayProgress(habits, completions, today);
  if (todayProgress.due > 0 && todayProgress.done < todayProgress.due) k = addDays(today, -1);
  let streak = 0;
  while (k >= earliest) {
    const { due, done } = dayProgress(habits, completions, k);
    if (due > 0) {
      if (done < due) break;
      streak += 1;
    }
    k = addDays(k, -1);
  }
  return streak;
}

/** Due/done over the week containing `mondayKey`, counting only days ≤ today. */
export function weekSummary(
  habits: Habit[],
  completions: Completions,
  mondayKey: DateKey,
  today: DateKey,
): WeekSummary {
  let due = 0;
  let done = 0;
  for (const k of weekKeys(mondayKey)) {
    if (k > today) break;
    const p = dayProgress(habits, completions, k);
    due += p.due;
    done += p.done;
  }
  return { due, done, rate: due ? done / due : 0 };
}

/** The last `weeks` weeks, oldest → newest, the current week last. */
export function weeklyRates(
  habits: Habit[],
  completions: Completions,
  today: DateKey,
  weeks = 8,
): WeekRate[] {
  const thisMonday = startOfWeekKey(today);
  const out: WeekRate[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const mondayKey = addDays(thisMonday, -7 * i);
    out.push({ mondayKey, ...weekSummary(habits, completions, mondayKey, today) });
  }
  return out;
}

/** Every completion, scheduled or bonus. */
export function totalCompletions(completions: Completions): number {
  let n = 0;
  for (const dates of Object.values(completions)) n += Object.keys(dates).length;
  return n;
}
