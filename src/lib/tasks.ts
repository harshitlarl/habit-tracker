import type { DateKey, Task, Weekday } from './types';

/**
 * Pure helpers for one-time tasks (SPEC §14.4). No React, no store, no Firebase — unit-tested in Node.
 * compareTasks and sortTasks are implemented (the sync layer orders by them); the remaining bodies are
 * STUBS implemented by the tasks-core owner. Keep every exported name and signature.
 */

export { TASK_NOTE_MAX, TASK_TITLE_MAX, TIME_RE, isTimeString } from './types';

const STUB = 'tasks.ts is a stub (tasks-core implements it)';

/** Total order: date, then timed before untimed, then time, then createdAt, then id. */
export function compareTasks(a: Task, b: Task): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const at = a.time ?? null;
  const bt = b.time ?? null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return at < bt ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A sorted copy (compareTasks); the input is not mutated. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(compareTasks);
}

/** Every task (any state) planned for that day, sorted. */
export function tasksOn(_tasks: readonly Task[], _dateKey: DateKey): Task[] {
  throw new Error(STUB);
}

/** Undone tasks whose date is before today, oldest first. */
export function carriedOver(_tasks: readonly Task[], _today: DateKey): Task[] {
  throw new Error(STUB);
}

export interface TodayTasks {
  /** Undone tasks from earlier days, oldest first. */
  carried: Task[];
  /** Tasks planned for today (any state), sorted. */
  scheduled: Task[];
  /** Undone items across both lists. */
  openCount: number;
}

export function tasksForToday(_tasks: readonly Task[], _today: DateKey): TodayTasks {
  throw new Error(STUB);
}

/** Only days that have tasks, Monday → Sunday, each list sorted. */
export function tasksInWeek(_tasks: readonly Task[], _mondayKey: DateKey): Map<DateKey, Task[]> {
  throw new Error(STUB);
}

export type TaskStatus = 'done' | 'open' | 'overdue' | 'upcoming';

/** done → 'done'; otherwise 'open' on its day, 'overdue' before it, 'upcoming' after it. */
export function taskStatus(_task: Task, _today: DateKey): TaskStatus {
  throw new Error(STUB);
}

/** The next occurrence of `weekday` strictly after today (1–7 days ahead). */
export function nextWeekdayKey(_today: DateKey, _weekday: Weekday): DateKey {
  throw new Error(STUB);
}

export interface QuickDate {
  key: DateKey;
  /** 'Today', 'Tomorrow', then e.g. 'Tue 21'. */
  label: string;
}

/** Today, tomorrow and the five days after that. */
export function quickDates(_today: DateKey): QuickDate[] {
  throw new Error(STUB);
}

/** 'Today' / 'Tomorrow' / 'Yesterday' / weekday name within 6 days either way / 'Tue 21 Oct'. */
export function relativeDayLabel(_dateKey: DateKey, _today: DateKey): string {
  throw new Error(STUB);
}

/** Device-locale clock for an 'HH:mm' string ('3:00 pm' or '15:00'); returns the input unchanged when invalid. */
export function formatTime(_time: string): string {
  throw new Error(STUB);
}
