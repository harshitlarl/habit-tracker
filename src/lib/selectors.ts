import type { Completions, DateKey, Habit, HabitColor } from './types';
import { isScheduled } from './dates';

export const byOrder = (a: Habit, b: Habit): number => a.order - b.order;

/** Not archived, sorted by `order`. */
export function activeHabits(habits: Habit[]): Habit[] {
  return habits.filter((h) => !h.archivedAt).sort(byOrder);
}

/** Archived, sorted by `order`. */
export function archivedHabits(habits: Habit[]): Habit[] {
  return habits.filter((h) => Boolean(h.archivedAt)).sort(byOrder);
}

export function habitById(habits: Habit[], id: string): Habit | undefined {
  return habits.find((h) => h.id === id);
}

export function isDone(completions: Completions, habitId: string, dateKey: DateKey): boolean {
  return completions[habitId]?.[dateKey] === true;
}

/** Habits scheduled on `dateKey` (see `isScheduled`), sorted by `order`. */
export function dueHabits(habits: Habit[], dateKey: DateKey): Habit[] {
  return habits.filter((h) => isScheduled(h, dateKey)).sort(byOrder);
}

/**
 * Habits live for at least one day of [from, to]: created on or before `to` and not archived on
 * or before `from` (archivedAt is exclusive). Sorted by `order`. The Week and Progress views use
 * this so they agree on which trackers belong to a period.
 */
export function habitsActiveBetween(habits: Habit[], from: DateKey, to: DateKey): Habit[] {
  return habits.filter((h) => h.createdAt <= to && (!h.archivedAt || h.archivedAt > from)).sort(byOrder);
}

/** 'var(--c-terracotta)' */
export function habitColorVar(color: HabitColor): string {
  return `var(--c-${color})`;
}

/** 'var(--c-terracotta-soft)' */
export function habitColorSoftVar(color: HabitColor): string {
  return `var(--c-${color}-soft)`;
}

/** 'tone-terracotta' (or 'tone-ember') — the base.css helper class that sets --tone / --tone-soft. */
export function toneClass(color: HabitColor | 'ember'): string {
  return `tone-${color}`;
}
