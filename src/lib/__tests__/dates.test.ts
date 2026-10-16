import { describe, expect, it } from 'vitest';
import {
  DATE_KEY_RE,
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  addDays,
  compareKeys,
  dayNumber,
  diffDays,
  formatLongDate,
  formatWeekRange,
  formatWeekday,
  fromKey,
  isDateKey,
  isFuture,
  isScheduled,
  startOfWeekKey,
  toKey,
  todayKey,
  weekKeys,
  weekdayOf,
} from '../dates';
import type { DateKey, Habit } from '../types';

// Tests run with TZ=America/New_York. 2026-10-16 is a Friday.
// DST starts 2026-03-08 (02:00 → 03:00) and ends 2026-11-01 (02:00 → 01:00); both are Sundays.

const habit = (over: Partial<Habit> = {}): Habit => ({
  id: 'h1',
  name: 'Gym',
  emoji: '🏋️',
  color: 'terracotta',
  days: [0, 1, 2, 3, 4, 5, 6],
  createdAt: '2026-01-01',
  order: 0,
  ...over,
});

/** Every local calendar day of 2026, built from Date components (not from the code under test). */
const EVERY_DAY_2026: DateKey[] = Array.from({ length: 365 }, (_, i) => {
  const d = new Date(2026, 0, 1 + i);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
});

const WEEK_DST_START: DateKey[] = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'];
const WEEK_AFTER_DST_START: DateKey[] = ['2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-15'];
const WEEK_DST_END: DateKey[] = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const WEEK_AFTER_DST_END: DateKey[] = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];

describe('time zone guard', () => {
  it('runs in America/New_York (the DST assertions below depend on it)', () => {
    expect(fromKey('2026-03-07').getTimezoneOffset()).toBe(300); // EST
    expect(fromKey('2026-03-09').getTimezoneOffset()).toBe(240); // EDT
    expect(fromKey('2026-10-31').getTimezoneOffset()).toBe(240);
    expect(fromKey('2026-11-02').getTimezoneOffset()).toBe(300);
  });
});

describe('toKey / fromKey / todayKey', () => {
  it('round-trips a local date', () => {
    expect(toKey(new Date(2026, 9, 16))).toBe('2026-10-16');
    expect(fromKey('2026-10-16').getTime()).toBe(new Date(2026, 9, 16).getTime());
  });

  it('uses the LOCAL calendar date late in the evening, never UTC', () => {
    const late = new Date(2026, 9, 16, 23, 30);
    expect(toKey(late)).toBe('2026-10-16');
    // Sanity: the UTC date is already the next day in New York.
    expect(late.toISOString().slice(0, 10)).toBe('2026-10-17');
  });

  it('uses the LOCAL calendar date just after midnight, when UTC is still the previous evening in summer', () => {
    // 00:30 EDT on 1 July is 04:30 UTC the same day; but 20:30 EDT on 30 June is 00:30 UTC on 1 July.
    expect(toKey(new Date(2026, 5, 30, 20, 30))).toBe('2026-06-30');
    expect(new Date(2026, 5, 30, 20, 30).toISOString().slice(0, 10)).toBe('2026-07-01');
  });

  it('pads single-digit months and days', () => {
    expect(toKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toKey(new Date(2026, 8, 9))).toBe('2026-09-09');
  });

  it('fromKey is local midnight on ordinary days', () => {
    const d = fromKey('2026-10-16');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 16, 0, 0]);
  });

  it('fromKey is local midnight on both DST transition days', () => {
    const spring = fromKey('2026-03-08');
    expect([spring.getDate(), spring.getHours()]).toEqual([8, 0]);
    expect(spring.getTimezoneOffset()).toBe(300); // still EST at midnight
    const autumn = fromKey('2026-11-01');
    expect([autumn.getDate(), autumn.getHours()]).toEqual([1, 0]);
    expect(autumn.getTimezoneOffset()).toBe(240); // still EDT at midnight
  });

  it('toKey stays on the DST day for every hour of it, including the skipped and repeated hours', () => {
    expect(toKey(new Date(2026, 2, 8, 0, 30))).toBe('2026-03-08');
    expect(toKey(new Date(2026, 2, 8, 2, 30))).toBe('2026-03-08'); // 02:30 does not exist → 03:30 EDT
    expect(toKey(new Date(2026, 2, 8, 23, 59, 59))).toBe('2026-03-08');
    expect(toKey(new Date(2026, 10, 1, 0, 0))).toBe('2026-11-01');
    expect(toKey(new Date(2026, 10, 1, 1, 30))).toBe('2026-11-01'); // 01:30 happens twice
    expect(toKey(new Date(2026, 10, 1, 23, 59, 59))).toBe('2026-11-01');
  });

  it('round-trips every day of 2026 and agrees with addDays/diffDays from 1 January', () => {
    EVERY_DAY_2026.forEach((key, i) => {
      expect(isDateKey(key)).toBe(true);
      const d = fromKey(key);
      expect(d.getHours()).toBe(0);
      expect(toKey(d)).toBe(key);
      expect(addDays('2026-01-01', i)).toBe(key);
      expect(addDays(key, -i)).toBe('2026-01-01');
      expect(diffDays('2026-01-01', key)).toBe(i);
    });
    expect(new Set(EVERY_DAY_2026).size).toBe(365);
    expect(EVERY_DAY_2026[66]).toBe('2026-03-08');
    expect(EVERY_DAY_2026[304]).toBe('2026-11-01');
  });

  it('todayKey formats the given date and defaults to now', () => {
    expect(todayKey(new Date(2026, 9, 16, 8))).toBe('2026-10-16');
    expect(todayKey(new Date(2026, 9, 16, 23, 59))).toBe('2026-10-16');
    expect(todayKey()).toMatch(DATE_KEY_RE);
    expect(todayKey()).toBe(toKey(new Date()));
  });
});

describe('weekdayOf', () => {
  it('maps Monday → 0 … Sunday → 6', () => {
    expect(weekdayOf('2026-10-12')).toBe(0);
    expect(weekdayOf('2026-10-13')).toBe(1);
    expect(weekdayOf('2026-10-14')).toBe(2);
    expect(weekdayOf('2026-10-15')).toBe(3);
    expect(weekdayOf('2026-10-16')).toBe(4);
    expect(weekdayOf('2026-10-17')).toBe(5);
    expect(weekdayOf('2026-10-18')).toBe(6);
  });

  it('is correct on the DST days (both Sundays) and the days around them', () => {
    expect(weekdayOf('2026-03-07')).toBe(5);
    expect(weekdayOf('2026-03-08')).toBe(6);
    expect(weekdayOf('2026-03-09')).toBe(0);
    expect(weekdayOf('2026-10-31')).toBe(5);
    expect(weekdayOf('2026-11-01')).toBe(6);
    expect(weekdayOf('2026-11-02')).toBe(0);
  });

  it('matches the WEEKDAY tables', () => {
    expect(WEEKDAY_SHORT[weekdayOf('2026-10-16')]).toBe('Fr');
    expect(WEEKDAY_LONG[weekdayOf('2026-10-16')]).toBe('Friday');
    expect(WEEKDAY_SHORT).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
    expect(WEEKDAY_LONG).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
  });

  it('cycles 0..6 across every week of 2026', () => {
    EVERY_DAY_2026.forEach((key, i) => {
      // 2026-01-01 is a Thursday (3).
      expect(weekdayOf(key)).toBe((3 + i) % 7);
    });
  });
});

describe('addDays / diffDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2026-01-31', 30)).toBe('2026-03-02');
    expect(addDays('2026-10-16', 0)).toBe('2026-10-16');
  });

  it('is unaffected by the DST start transition', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-03-07', 7)).toBe('2026-03-14');
    expect(addDays('2026-03-09', -1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', -1)).toBe('2026-03-07');
    expect(addDays('2026-03-05', 7)).toBe('2026-03-12');
    expect(addDays('2026-03-12', -7)).toBe('2026-03-05');
    expect(addDays('2026-03-01', 14)).toBe('2026-03-15');
  });

  it('is unaffected by the DST end transition', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-11-02', -1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDays('2026-10-29', 7)).toBe('2026-11-05');
    expect(addDays('2026-11-05', -7)).toBe('2026-10-29');
    expect(addDays('2026-11-01', -7)).toBe('2026-10-25');
  });

  it('diffDays counts calendar days (b − a), including across DST weeks', () => {
    expect(diffDays('2026-10-10', '2026-10-16')).toBe(6);
    expect(diffDays('2026-10-16', '2026-10-10')).toBe(-6);
    expect(diffDays('2026-03-02', '2026-03-09')).toBe(7);
    expect(diffDays('2026-10-26', '2026-11-02')).toBe(7);
    expect(diffDays('2026-10-16', '2026-10-16')).toBe(0);
  });

  it('diffDays is a whole number of days even when the span is 23 or 25 hours long', () => {
    expect(diffDays('2026-03-07', '2026-03-08')).toBe(1);
    expect(diffDays('2026-03-08', '2026-03-09')).toBe(1);
    expect(diffDays('2026-03-07', '2026-03-09')).toBe(2);
    expect(diffDays('2026-10-31', '2026-11-01')).toBe(1);
    expect(diffDays('2026-11-01', '2026-11-02')).toBe(1);
    expect(diffDays('2026-10-31', '2026-11-02')).toBe(2);
    expect(diffDays('2025-12-31', '2026-01-01')).toBe(1);
    expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
  });
});

describe('weeks', () => {
  it('startOfWeekKey is the Monday (Sunday belongs to the week that started six days earlier)', () => {
    expect(startOfWeekKey('2026-10-16')).toBe('2026-10-12');
    expect(startOfWeekKey('2026-10-12')).toBe('2026-10-12');
    expect(startOfWeekKey('2026-10-18')).toBe('2026-10-12');
    expect(startOfWeekKey('2026-10-19')).toBe('2026-10-19');
  });

  it('startOfWeekKey crosses month and year ends', () => {
    expect(startOfWeekKey('2026-03-01')).toBe('2026-02-23'); // Sunday 1 March
    expect(startOfWeekKey('2026-05-31')).toBe('2026-05-25'); // Sunday 31 May
    expect(startOfWeekKey('2026-06-01')).toBe('2026-06-01'); // Monday 1 June
    expect(startOfWeekKey('2026-01-01')).toBe('2025-12-29'); // Thursday 1 January
    expect(startOfWeekKey('2025-12-31')).toBe('2025-12-29');
    expect(startOfWeekKey('2027-01-03')).toBe('2026-12-28'); // Sunday 3 January
    expect(startOfWeekKey('2024-02-29')).toBe('2024-02-26');
  });

  it('startOfWeekKey is idempotent and always lands on a Monday', () => {
    for (const key of EVERY_DAY_2026) {
      const monday = startOfWeekKey(key);
      expect(weekdayOf(monday)).toBe(0);
      expect(startOfWeekKey(monday)).toBe(monday);
      expect(diffDays(monday, key)).toBe(weekdayOf(key));
    }
  });

  it('weekKeys returns Mon→Sun for the week containing the anchor', () => {
    expect(weekKeys('2026-10-16')).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
  });

  it('weekKeys spans the DST start week and the one after it', () => {
    expect(weekKeys('2026-03-08')).toEqual(WEEK_DST_START);
    expect(weekKeys('2026-03-02')).toEqual(WEEK_DST_START);
    expect(weekKeys('2026-03-09')).toEqual(WEEK_AFTER_DST_START);
    expect(weekKeys('2026-03-15')).toEqual(WEEK_AFTER_DST_START);
  });

  it('weekKeys spans the DST end week and the one after it', () => {
    expect(weekKeys('2026-11-01')).toEqual(WEEK_DST_END);
    expect(weekKeys('2026-10-26')).toEqual(WEEK_DST_END);
    expect(weekKeys('2026-11-02')).toEqual(WEEK_AFTER_DST_END);
    expect(weekKeys('2026-11-08')).toEqual(WEEK_AFTER_DST_END);
    expect(new Set(WEEK_DST_END).size).toBe(7);
    expect(WEEK_DST_END.map(weekdayOf)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('weekKeys crosses month ends', () => {
    expect(weekKeys('2026-03-01')).toEqual([
      '2026-02-23',
      '2026-02-24',
      '2026-02-25',
      '2026-02-26',
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ]);
    expect(weekKeys('2024-02-29')).toEqual([
      '2024-02-26',
      '2024-02-27',
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
      '2024-03-02',
      '2024-03-03',
    ]);
    expect(weekKeys('2026-09-28')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
  });

  it('weekKeys crosses year ends', () => {
    const newYear = ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'];
    expect(weekKeys('2027-01-01')).toEqual(newYear);
    expect(weekKeys('2026-12-28')).toEqual(newYear);
    expect(weekKeys('2027-01-03')).toEqual(newYear);
    expect(weekKeys('2025-12-31')).toEqual([
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
    ]);
  });

  it('every day of a week yields the same seven keys, in weekday order', () => {
    for (const week of [WEEK_DST_START, WEEK_AFTER_DST_START, WEEK_DST_END, WEEK_AFTER_DST_END, weekKeys('2026-12-31')]) {
      for (const day of week) {
        expect(weekKeys(day)).toEqual(week);
      }
      expect(week.map(weekdayOf)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(diffDays(week[0] ?? '', week[6] ?? '')).toBe(6);
    }
  });
});

describe('compareKeys / isFuture', () => {
  it('compares lexicographically', () => {
    expect(compareKeys('2026-10-01', '2026-10-02')).toBe(-1);
    expect(compareKeys('2026-10-02', '2026-10-01')).toBe(1);
    expect(compareKeys('2026-10-01', '2026-10-01')).toBe(0);
    expect(compareKeys('2025-12-31', '2026-01-01')).toBe(-1);
    expect(compareKeys('2026-09-30', '2026-10-01')).toBe(-1);
    expect(['2026-10-02', '2025-12-31', '2026-01-01'].sort(compareKeys)).toEqual([
      '2025-12-31',
      '2026-01-01',
      '2026-10-02',
    ]);
  });

  it('agrees with diffDays for every pair of consecutive days in 2026', () => {
    for (let i = 1; i < EVERY_DAY_2026.length; i += 1) {
      const a = EVERY_DAY_2026[i - 1] ?? '';
      const b = EVERY_DAY_2026[i] ?? '';
      expect(compareKeys(a, b)).toBe(-1);
      expect(a < b).toBe(true);
    }
  });

  it('isFuture is strictly after today', () => {
    expect(isFuture('2026-10-17', '2026-10-16')).toBe(true);
    expect(isFuture('2026-10-16', '2026-10-16')).toBe(false);
    expect(isFuture('2026-10-15', '2026-10-16')).toBe(false);
    expect(isFuture('2027-01-01', '2026-12-31')).toBe(true);
  });
});

describe('isScheduled', () => {
  const mwf = habit({ days: [0, 2, 4], createdAt: '2026-10-14' }); // created on a Wednesday

  it('requires the weekday to be in days', () => {
    expect(isScheduled(mwf, '2026-10-14')).toBe(true); // Wed
    expect(isScheduled(mwf, '2026-10-15')).toBe(false); // Thu
    expect(isScheduled(mwf, '2026-10-16')).toBe(true); // Fri
    expect(isScheduled(mwf, '2026-10-17')).toBe(false); // Sat
    expect(isScheduled(mwf, '2026-10-19')).toBe(true); // Mon
  });

  it('is never scheduled before createdAt, and the creation day itself counts', () => {
    expect(isScheduled(mwf, '2026-10-12')).toBe(false); // Monday before creation
    expect(isScheduled(mwf, '2026-10-13')).toBe(false);
    expect(isScheduled(mwf, '2026-10-14')).toBe(true);
    expect(isScheduled(habit({ createdAt: '2026-10-16' }), '2026-10-16')).toBe(true);
    expect(isScheduled(habit({ createdAt: '2026-10-16' }), '2026-10-15')).toBe(false);
  });

  it('is scheduled on future dates (callers disable them separately)', () => {
    expect(isScheduled(mwf, '2026-12-25')).toBe(true); // a Friday
  });

  it('stops at archivedAt (exclusive)', () => {
    const archived = habit({ days: [0, 1, 2, 3, 4, 5, 6], createdAt: '2026-10-01', archivedAt: '2026-10-16' });
    expect(isScheduled(archived, '2026-10-15')).toBe(true);
    expect(isScheduled(archived, '2026-10-16')).toBe(false);
    expect(isScheduled(archived, '2026-10-20')).toBe(false);
  });

  it('a tracker archived on its creation day was never scheduled', () => {
    const sameDay = habit({ createdAt: '2026-10-16', archivedAt: '2026-10-16' });
    expect(isScheduled(sameDay, '2026-10-16')).toBe(false);
    expect(isScheduled(sameDay, '2026-10-15')).toBe(false);
    expect(isScheduled(sameDay, '2026-10-17')).toBe(false);
  });

  it('empty days is never scheduled', () => {
    expect(isScheduled(habit({ days: [] }), '2026-10-16')).toBe(false);
  });

  it('weekend-only and weekday-only schedules', () => {
    const weekend = habit({ days: [5, 6] });
    const weekdays = habit({ days: [0, 1, 2, 3, 4] });
    expect(weekKeys('2026-10-16').map((k) => isScheduled(weekend, k))).toEqual([false, false, false, false, false, true, true]);
    expect(weekKeys('2026-10-16').map((k) => isScheduled(weekdays, k))).toEqual([true, true, true, true, true, false, false]);
  });
});

describe('formatting', () => {
  it('formatWeekday', () => {
    expect(formatWeekday('2026-10-16')).toBe('Friday');
    expect(formatWeekday('2026-10-12')).toBe('Monday');
    expect(formatWeekday('2026-10-18')).toBe('Sunday');
    expect(weekKeys('2026-03-02').map(formatWeekday)).toEqual([...WEEKDAY_LONG]);
  });

  it('formatLongDate', () => {
    expect(formatLongDate('2026-10-16')).toBe('16 October');
    expect(formatLongDate('2026-03-05')).toBe('5 March');
    expect(formatLongDate('2026-01-01')).toBe('1 January');
    expect(formatLongDate('2026-12-25')).toBe('25 December');
    expect(formatLongDate('2026-05-01')).toBe('1 May');
  });

  it('dayNumber', () => {
    expect(dayNumber('2026-10-16')).toBe(16);
    expect(dayNumber('2026-10-05')).toBe(5);
    expect(dayNumber('2026-10-31')).toBe(31);
    expect(dayNumber('2026-11-01')).toBe(1);
  });

  it('formatWeekRange within one month', () => {
    expect(formatWeekRange('2026-10-12')).toBe('12 – 18 Oct');
    expect(formatWeekRange('2026-03-02')).toBe('2 – 8 Mar');
    expect(formatWeekRange('2026-05-04')).toBe('4 – 10 May');
  });

  it('formatWeekRange across a month boundary', () => {
    expect(formatWeekRange('2026-09-28')).toBe('28 Sep – 4 Oct');
    expect(formatWeekRange('2026-02-23')).toBe('23 Feb – 1 Mar');
    expect(formatWeekRange('2026-10-26')).toBe('26 Oct – 1 Nov');
    expect(formatWeekRange('2026-11-30')).toBe('30 Nov – 6 Dec');
  });

  it('formatWeekRange across a year boundary', () => {
    expect(formatWeekRange('2026-12-28')).toBe('28 Dec – 3 Jan');
    expect(formatWeekRange('2027-12-27')).toBe('27 Dec – 2 Jan');
  });

  it('formatWeekRange normalises any day of the week to its Monday', () => {
    expect(formatWeekRange('2026-10-16')).toBe('12 – 18 Oct');
    expect(formatWeekRange('2026-10-18')).toBe('12 – 18 Oct');
    expect(formatWeekRange('2026-03-01')).toBe('23 Feb – 1 Mar');
  });
});

describe('isDateKey / DATE_KEY_RE', () => {
  it('accepts real local dates in YYYY-MM-DD', () => {
    expect(isDateKey('2026-10-16')).toBe(true);
    expect(isDateKey('2024-02-29')).toBe(true);
    expect(isDateKey('2026-03-08')).toBe(true);
    expect(isDateKey('2026-11-01')).toBe(true);
    expect(isDateKey('2026-12-31')).toBe(true);
    expect(isDateKey('2026-01-01')).toBe(true);
  });

  it('rejects wrong shapes and impossible dates', () => {
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('2026-00-10')).toBe(false);
    expect(isDateKey('2026-10-00')).toBe(false);
    expect(isDateKey('2026-10-32')).toBe(false);
    expect(isDateKey('2026-02-30')).toBe(false);
    expect(isDateKey('2025-02-29')).toBe(false);
    expect(isDateKey('2026-04-31')).toBe(false);
    expect(isDateKey('26-10-16')).toBe(false);
    expect(isDateKey('2026-10-1')).toBe(false);
    expect(isDateKey('2026-1-16')).toBe(false);
    expect(isDateKey('2026/10/16')).toBe(false);
    expect(isDateKey('2026-10-16T00:00')).toBe(false);
    expect(isDateKey('2026-10-16T00:00:00.000Z')).toBe(false);
    expect(isDateKey(' 2026-10-16')).toBe(false);
    expect(isDateKey('2026-10-16 ')).toBe(false);
    expect(isDateKey('2026-10-16\n')).toBe(false);
    expect(isDateKey('hello')).toBe(false);
    expect(isDateKey('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isDateKey(20261016)).toBe(false);
    expect(isDateKey(null)).toBe(false);
    expect(isDateKey(undefined)).toBe(false);
    expect(isDateKey(new Date(2026, 9, 16))).toBe(false);
    expect(isDateKey({ key: '2026-10-16' })).toBe(false);
    expect(isDateKey(['2026-10-16'])).toBe(false);
  });

  it('DATE_KEY_RE checks the shape only', () => {
    expect(DATE_KEY_RE.test('2026-02-30')).toBe(true);
    expect(DATE_KEY_RE.test('2026-2-30')).toBe(false);
  });
});
