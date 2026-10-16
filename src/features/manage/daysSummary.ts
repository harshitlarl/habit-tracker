import type { Weekday } from '../../lib/types';
import { WEEKDAY_SHORT } from '../../lib/dates';
import { normalizeDays } from '../../lib/store';

export const ALL_DAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4];
export const WEEKENDS: readonly Weekday[] = [5, 6];

const sameDays = (a: readonly Weekday[], b: readonly Weekday[]): boolean =>
  a.length === b.length && a.every((d, i) => d === b[i]);

/** "Every day" · "Weekdays" · "Weekends" · "Mo We Fr" (sorted, unique). */
export function daysSummary(days: readonly Weekday[]): string {
  const sorted = normalizeDays(days);
  if (sorted.length === 7) return 'Every day';
  if (sameDays(sorted, WEEKDAYS)) return 'Weekdays';
  if (sameDays(sorted, WEEKENDS)) return 'Weekends';
  if (sorted.length === 0) return 'No days';
  return sorted.map((d) => WEEKDAY_SHORT[d]).join(' ');
}
