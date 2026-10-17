import { format } from 'date-fns';
import { addDays, diffDays, formatWeekday, fromKey, isDateKey, weekKeys, weekdayOf } from './dates';
import { isTimeString, type DateKey, type Task, type Weekday } from './types';

/**
 * Pure helpers for one-time tasks (SPEC §14.4). No React, no store, no Firebase — unit-tested in Node.
 * Every date here is a LOCAL calendar key ('YYYY-MM-DD', see dates.ts); nothing goes through
 * toISOString() or UTC getters, and the day arithmetic is DST-safe because it uses the date helpers.
 */

export { TASK_NOTE_MAX, TASK_TITLE_MAX, TIME_RE, isTimeString } from './types';

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
export function tasksOn(tasks: readonly Task[], dateKey: DateKey): Task[] {
  return sortTasks(tasks.filter((t) => t.date === dateKey));
}

/** Undone tasks whose date is before today, oldest first. */
export function carriedOver(tasks: readonly Task[], today: DateKey): Task[] {
  return sortTasks(tasks.filter((t) => !t.done && t.date < today));
}

/**
 * Carried-over tasks checked off today (`date < today`, done, `doneAt === today`), oldest first. Today
 * keeps them listed, struck through, until midnight — so a late check-off can be undone and the day's
 * work stays visible — whereas `carriedOver` (and so `tasksForToday`) lists open items only.
 */
export function carriedOverDone(tasks: readonly Task[], today: DateKey): Task[] {
  return sortTasks(tasks.filter((t) => t.done && t.date < today && t.doneAt === today));
}

export interface TodayTasks {
  /** Undone tasks from earlier days, oldest first. */
  carried: Task[];
  /** Tasks planned for today (any state), sorted. */
  scheduled: Task[];
  /** Undone items across both lists. */
  openCount: number;
}

const countOpen = (list: readonly Task[]): number => list.reduce((n, t) => (t.done ? n : n + 1), 0);

export function tasksForToday(tasks: readonly Task[], today: DateKey): TodayTasks {
  const carried = carriedOver(tasks, today);
  const scheduled = tasksOn(tasks, today);
  return { carried, scheduled, openCount: countOpen(carried) + countOpen(scheduled) };
}

/**
 * Only days that have tasks, Monday → Sunday, each list sorted. Any key of the week works as the
 * anchor (weekKeys normalises to its Monday), so a view may pass the day it is showing.
 */
export function tasksInWeek(tasks: readonly Task[], mondayKey: DateKey): Map<DateKey, Task[]> {
  const days = weekKeys(mondayKey);
  const buckets = new Map<DateKey, Task[]>(days.map((day) => [day, []]));
  for (const task of tasks) buckets.get(task.date)?.push(task);
  const byDay = new Map<DateKey, Task[]>();
  for (const day of days) {
    const list = buckets.get(day);
    if (list && list.length > 0) byDay.set(day, list.sort(compareTasks));
  }
  return byDay;
}

export type TaskStatus = 'done' | 'open' | 'overdue' | 'upcoming';

/** done → 'done'; otherwise 'open' on its day, 'overdue' before it, 'upcoming' after it. */
export function taskStatus(task: Task, today: DateKey): TaskStatus {
  if (task.done) return 'done';
  if (task.date === today) return 'open';
  return task.date < today ? 'overdue' : 'upcoming';
}

/** The next occurrence of `weekday` strictly after today (1–7 days ahead; the same weekday → a week ahead). */
export function nextWeekdayKey(today: DateKey, weekday: Weekday): DateKey {
  const ahead = (weekday - weekdayOf(today) + 7) % 7;
  return addDays(today, ahead === 0 ? 7 : ahead);
}

export interface QuickDate {
  key: DateKey;
  /** 'Today', 'Tomorrow', then e.g. 'Tue 21'. */
  label: string;
}

/** Today, tomorrow and the five days after that. */
export function quickDates(today: DateKey): QuickDate[] {
  return Array.from({ length: 7 }, (_, i) => {
    const key = addDays(today, i);
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : format(fromKey(key), 'EEE d');
    return { key, label };
  });
}

/**
 * 'Today' / 'Tomorrow' / 'Yesterday' / the weekday name within 6 days either way / 'Tue 21 Oct'.
 * The store only ever holds real dates; a damaged key is returned as is rather than throwing in a row.
 */
export function relativeDayLabel(dateKey: DateKey, today: DateKey): string {
  if (!isDateKey(dateKey) || !isDateKey(today)) return dateKey;
  const ahead = diffDays(today, dateKey);
  if (ahead === 0) return 'Today';
  if (ahead === 1) return 'Tomorrow';
  if (ahead === -1) return 'Yesterday';
  if (Math.abs(ahead) <= 6) return formatWeekday(dateKey);
  return format(fromKey(dateKey), 'EEE d MMM');
}

/**
 * A LOCAL Date reading `hours:minutes` on the wall clock. It is pinned to a mid-January day (mid-July
 * as the fallback) because those host no DST transition anywhere: built on today, '02:30' would read
 * 03:30 on the spring-forward day.
 */
function localClock(hours: number, minutes: number): Date {
  const january = new Date(2001, 0, 15, hours, minutes);
  if (january.getHours() === hours && january.getMinutes() === minutes) return january;
  const july = new Date(2001, 6, 15, hours, minutes);
  return july.getHours() === hours && july.getMinutes() === minutes ? july : january;
}

/** Device-locale clock for an 'HH:mm' string ('3:00 pm' or '15:00'); returns the input unchanged when invalid. */
export function formatTime(time: string): string {
  if (!isTimeString(time)) return time;
  const hours = Number(time.slice(0, 2));
  const minutes = Number(time.slice(3, 5));
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
      localClock(hours, minutes),
    );
  } catch {
    return time;
  }
}
