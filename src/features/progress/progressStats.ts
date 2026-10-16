import { format } from 'date-fns';
import type { Completions, DateKey, Habit } from '../../lib/types';
import { addDays, fromKey, isScheduled, startOfWeekKey, weekKeys } from '../../lib/dates';
import { bestStreak, completionStats, type CompletionStats } from '../../lib/streaks';

export const HEATMAP_WEEKS = 12;
export const CHART_WEEKS = 8;

/** One habit's completion set (`completions[habit.id]`), or undefined when it has none. */
export type DateSet = Record<DateKey, true> | undefined;

/** Mon→Sun keys for the last `count` weeks, oldest first, the current week last. */
export function recentWeeks(today: DateKey, count = HEATMAP_WEEKS): DateKey[][] {
  const monday = startOfWeekKey(today);
  return Array.from({ length: count }, (_, i) => weekKeys(addDays(monday, -7 * (count - 1 - i))));
}

export type HeatCellState = 'empty' | 'missed' | 'pending' | 'done' | 'bonus';

export interface HeatCell {
  key: DateKey;
  state: HeatCellState;
  isToday: boolean;
}

export interface HeatmapData {
  /** Oldest week first; each row is Mon→Sun. */
  rows: HeatCell[][];
  due: number;
  done: number;
  bonus: number;
}

/**
 * Cell states for the heatmap. Future days and days before `createdAt` are empty; scheduled
 * days are done / pending (today) / missed; a completion on an unscheduled day is a bonus.
 */
export function buildHeatmap(habit: Habit, dates: DateSet, weeks: DateKey[][], today: DateKey): HeatmapData {
  let due = 0;
  let done = 0;
  let bonus = 0;
  const rows = weeks.map((week) =>
    week.map((key): HeatCell => {
      const isToday = key === today;
      if (key > today || key < habit.createdAt) return { key, state: 'empty', isToday };
      const completed = dates?.[key] === true;
      let state: HeatCellState = 'empty';
      if (isScheduled(habit, key)) {
        due += 1;
        if (completed) {
          done += 1;
          state = 'done';
        } else {
          state = isToday ? 'pending' : 'missed';
        }
      } else if (completed) {
        bonus += 1;
        state = 'bonus';
      }
      return { key, state, isToday };
    }),
  );
  return { rows, due, done, bonus };
}

/** 0.857 → 86 */
export function percent(rate: number): number {
  return Math.round(rate * 100);
}

/** "Oct" */
export function monthShort(key: DateKey): string {
  return format(fromKey(key), 'MMM');
}

/** "13 Oct" */
export function formatMonday(key: DateKey): string {
  return format(fromKey(key), 'd MMM');
}

/** Completions narrowed to one habit, so per-habit memos depend only on that habit's dates. */
export function sliceCompletions(habitId: string, dates: DateSet): Completions {
  return dates ? { [habitId]: dates } : {};
}

export interface LifetimeStats extends CompletionStats {
  best: number;
  /** Every completion for the habit, scheduled or bonus. */
  total: number;
}

/** Whole-life stats for a habit up to `today` (or its archive date, whichever is earlier). */
export function lifetimeStats(habit: Habit, dates: DateSet, today: DateKey): LifetimeStats {
  const completions = sliceCompletions(habit.id, dates);
  const lastActive = habit.archivedAt ? addDays(habit.archivedAt, -1) : today;
  const to = lastActive < today ? lastActive : today;
  return {
    ...completionStats(habit, completions, habit.createdAt, to),
    best: bestStreak(habit, completions, today),
    total: dates ? Object.keys(dates).length : 0,
  };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
