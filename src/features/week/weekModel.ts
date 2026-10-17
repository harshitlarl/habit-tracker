import type { DateKey, Habit } from '../../lib/types';
import { diffDays, formatLongDate, formatWeekday, isFuture, isScheduled, startOfWeekKey } from '../../lib/dates';

/** Visual state of one grid cell; `future`/`disabled` are reported alongside. */
export type CellState = 'done' | 'bonus' | 'due' | 'off' | 'outside';

export interface CellModel {
  state: CellState;
  future: boolean;
  disabled: boolean;
  /**
   * e.g. "Gym, Tuesday 14 October", "Gym, Thursday 15 October, bonus". Done / not done is not in the
   * name: a tappable cell is a toggle button and aria-pressed carries it, so the name of a scheduled day
   * never changes under a tap. Only a disabled future cell, which has no aria-pressed, says "done".
   */
  label: string;
}

/** Suffix after the name and date; '' where aria-pressed (set on every tappable cell) says everything. */
const STATUS: Readonly<Record<CellState, string>> = {
  done: '',
  bonus: 'bonus',
  due: '',
  off: 'not scheduled',
  outside: 'not tracked',
};

/**
 * done + scheduled → filled check; done + unscheduled → bonus (tone ring + check); scheduled → outline;
 * unscheduled → dash; before createdAt / from archivedAt → empty. Future days are disabled.
 */
export function cellModel(habit: Habit, done: boolean, dateKey: DateKey, today: DateKey): CellModel {
  const archivedAt = habit.archivedAt;
  const outside = dateKey < habit.createdAt || (archivedAt !== undefined && dateKey >= archivedAt);
  const future = isFuture(dateKey, today);
  const scheduled = isScheduled(habit, dateKey);

  let state: CellState;
  if (done) state = scheduled ? 'done' : 'bonus';
  else if (outside) state = 'outside';
  else state = scheduled ? 'due' : 'off';

  // Future cells are disabled and carry no aria-pressed: a scheduled one reads "upcoming", and a
  // completion already logged there (an import, another device's clock) keeps its "done".
  let status = STATUS[state];
  if (future && state === 'due') status = 'upcoming';
  else if (future && state === 'done') status = 'done';
  const name = `${habit.name}, ${formatWeekday(dateKey)} ${formatLongDate(dateKey)}`;
  return {
    state,
    future,
    // A stray completion outside the tracker's active range stays tappable so it can be cleared.
    disabled: future || (outside && !done),
    label: status === '' ? name : `${name}, ${status}`,
  };
}

/** "This week" · "Last week" · "2 weeks ago" · "Next week" · "In 2 weeks" */
export function relativeWeekLabel(offset: number): string {
  if (offset === 0) return 'This week';
  if (offset === -1) return 'Last week';
  if (offset === 1) return 'Next week';
  return offset < 0 ? `${-offset} weeks ago` : `In ${offset} weeks`;
}

/**
 * The week starting `mondayKey` relative to `today`, in lower case for use mid-sentence:
 * "this week" · "last week" · "2 weeks ago" · "next week".
 */
export function weekScope(mondayKey: DateKey, today: DateKey): string {
  const offset = Math.round(diffDays(startOfWeekKey(today), mondayKey) / 7);
  const label = relativeWeekLabel(offset);
  return label.charAt(0).toLowerCase() + label.slice(1);
}
