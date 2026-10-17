import type { DateKey } from '../../lib/types';
import { dayNumber, formatLongDate, formatWeekday } from '../../lib/dates';
import { relativeDayLabel } from '../../lib/tasks';

/**
 * Default date for a task added from the shown week (SPEC §14.6): today while the week is the
 * current or a past one, that week's Monday when it lies ahead.
 */
export function defaultTaskDate(mondayKey: DateKey, today: DateKey): DateKey {
  return mondayKey > today ? mondayKey : today;
}

/** The only relative labels a day heading repeats; weekday names and dates add nothing to "Tue 21". */
const NEAR_LABELS: ReadonlySet<string> = new Set(['Today', 'Tomorrow', 'Yesterday']);

export interface DayHeading {
  /** "Tue 21" */
  short: string;
  /** "Tomorrow" — only for today, tomorrow and yesterday; null otherwise. */
  relative: string | null;
  /** Screen-reader text: "Tuesday 21 October, tomorrow". */
  spoken: string;
}

/** Heading of one day group: "Tue 21", plus "· Tomorrow" when `relativeDayLabel` says it is near. */
export function dayHeading(dateKey: DateKey, today: DateKey): DayHeading {
  const label = relativeDayLabel(dateKey, today);
  const relative = NEAR_LABELS.has(label) ? label : null;
  const weekday = formatWeekday(dateKey);
  return {
    short: `${weekday.slice(0, 3)} ${dayNumber(dateKey)}`,
    relative,
    spoken: `${weekday} ${formatLongDate(dateKey)}${relative ? `, ${relative.toLowerCase()}` : ''}`,
  };
}
