import { addDays as addDaysFns, differenceInCalendarDays, format } from 'date-fns';
import type { DateKey, Habit, Weekday } from './types';

/*
 * All dates are LOCAL calendar dates encoded as 'YYYY-MM-DD'. Never derive a key from
 * toISOString()/UTC getters — a late-evening check would land on the wrong day.
 */

export const WEEKDAY_SHORT = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
export const WEEKDAY_LONG = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const;

export const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Local calendar date of `d` as a DateKey. */
export function toKey(d: Date): DateKey {
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight of the given key. */
export function fromKey(k: DateKey): Date {
  const y = Number(k.slice(0, 4));
  const m = Number(k.slice(5, 7));
  const d = Number(k.slice(8, 10));
  return new Date(y, m - 1, d);
}

export function todayKey(now: Date = new Date()): DateKey {
  return toKey(now);
}

/** Monday = 0 … Sunday = 6. */
export function weekdayOf(k: DateKey): Weekday {
  return ((fromKey(k).getDay() + 6) % 7) as Weekday;
}

export function addDays(k: DateKey, n: number): DateKey {
  return toKey(addDaysFns(fromKey(k), n));
}

/** Calendar days from `a` to `b` (b − a). DST-safe. */
export function diffDays(a: DateKey, b: DateKey): number {
  return differenceInCalendarDays(fromKey(b), fromKey(a));
}

/** The Monday of the week containing `k`. */
export function startOfWeekKey(k: DateKey): DateKey {
  return addDays(k, -weekdayOf(k));
}

/** The 7 keys Mon→Sun of the week containing `anchor`. */
export function weekKeys(anchor: DateKey): DateKey[] {
  const monday = startOfWeekKey(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** String comparison is valid for this fixed-width format. */
export function compareKeys(a: DateKey, b: DateKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isFuture(k: DateKey, today: DateKey): boolean {
  return k > today;
}

/** Scheduled on `k`: the weekday is in `habit.days`, k ≥ createdAt and (if archived) k < archivedAt. */
export function isScheduled(habit: Habit, k: DateKey): boolean {
  return (
    habit.days.includes(weekdayOf(k)) &&
    k >= habit.createdAt &&
    (!habit.archivedAt || k < habit.archivedAt)
  );
}

/** Strict DateKey check: format AND a real calendar date (rejects 2026-02-30). */
export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== 'string' || !DATE_KEY_RE.test(value)) return false;
  const d = fromKey(value);
  return !Number.isNaN(d.getTime()) && toKey(d) === value;
}

/* ---------- Formatting ---------- */

/** "Thursday" */
export function formatWeekday(k: DateKey): string {
  return WEEKDAY_LONG[weekdayOf(k)];
}

/** "16 October" */
export function formatLongDate(k: DateKey): string {
  return format(fromKey(k), 'd MMMM');
}

/** "13 – 19 Oct", or "29 Sep – 5 Oct" when the week crosses a month boundary. */
export function formatWeekRange(mondayKey: DateKey): string {
  const monday = startOfWeekKey(mondayKey);
  const start = fromKey(monday);
  const end = fromKey(addDays(monday, 6));
  if (start.getMonth() === end.getMonth()) {
    return `${format(start, 'd')} – ${format(end, 'd MMM')}`;
  }
  return `${format(start, 'd MMM')} – ${format(end, 'd MMM')}`;
}

/** 16 */
export function dayNumber(k: DateKey): number {
  return Number(k.slice(8, 10));
}
