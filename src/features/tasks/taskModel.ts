import { format } from 'date-fns';
import { fromKey, isDateKey } from '../../lib/dates';
import type { QuickDate } from '../../lib/tasks';
import type { DateKey } from '../../lib/types';

/*
 * Pure text and state helpers shared by the task editor and the two task rows (Today, Week). No
 * React, no store — unit-tested in Node (src/features/tasks/__tests__/taskModel.test.ts).
 */

/** The last date chip's label while the date sits in the quick row (or is not a real date yet). */
export const PICK_DATE_LABEL = 'Pick a date…';

/**
 * The last chip of the editor's date row (SPEC §14.7): "Pick a date…", or — when the date lies outside
 * the quick row — that date written out, "Wed 14 Oct". Never a bare weekday name: beside the quick
 * chip "Wed 21", a selected "Wednesday" reads as the coming one, not last week's.
 */
export function customDateLabel(date: string, quick: readonly QuickDate[]): string {
  if (!isDateKey(date) || quick.some((q) => q.key === date)) return PICK_DATE_LABEL;
  return format(fromKey(date), 'EEE d MMM');
}

/**
 * The date the editor holds: the one the user picked (an existing task starts from its own), or,
 * while a new task's date is untouched (`picked === null`), the default — today when none is given.
 * Derived on every render, so a sheet left open across midnight keeps meaning "today".
 */
export function formDate(picked: string | null, defaultDate: DateKey | undefined, today: DateKey): string {
  if (picked !== null) return picked;
  return isDateKey(defaultDate) ? defaultDate : today;
}

/**
 * Accessible name of a task row's edit button: title, then each detail the meta line shows, then the
 * action — "Mentor meeting, 3:00 PM, Bring the portfolio, edit task". The visible meta line separates
 * its parts with an aria-hidden "·", so the name spells the pauses out instead of running "PM" into the
 * note. Blank parts are left out.
 */
export function taskRowLabel(title: string, details: readonly string[]): string {
  return [title, ...details]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .concat('edit task')
    .join(', ');
}
