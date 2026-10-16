import { describe, expect, it } from 'vitest';
import {
  STREAK_MILESTONES,
  bestStreak,
  completionStats,
  currentStreak,
  dayProgress,
  isPerfectDay,
  perfectDayStreak,
  totalCompletions,
  weekSummary,
  weeklyRates,
} from '../streaks';
import { addDays } from '../dates';
import type { Completions, DateKey, Habit, Weekday } from '../types';

// TZ=America/New_York. Calendar for the scenarios:
//   Mon 2026-10-05 … Sun 2026-10-11, Mon 2026-10-12 … Fri 2026-10-16 (today), Sat 17, Sun 18.
const TODAY: DateKey = '2026-10-16';
const EVERY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const MWF: Weekday[] = [0, 2, 4];
const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4];

const habit = (id: string, over: Partial<Habit> = {}): Habit => ({
  id,
  name: id,
  emoji: '✓',
  color: 'sage',
  days: EVERY,
  createdAt: '2026-10-01',
  order: 0,
  ...over,
});

const done = (entries: Record<string, DateKey[]>): Completions => {
  const out: Completions = {};
  for (const [id, keys] of Object.entries(entries)) {
    out[id] = Object.fromEntries(keys.map((k) => [k, true as const]));
  }
  return out;
};

/** `n` consecutive keys ending on `last` (inclusive). */
const runEnding = (last: DateKey, n: number): DateKey[] => Array.from({ length: n }, (_, i) => addDays(last, -i));

/** Every key from `from` to `to` inclusive. */
const span = (from: DateKey, to: DateKey): DateKey[] => {
  const out: DateKey[] = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
};

describe('currentStreak', () => {
  it('counts consecutive scheduled done days, skipping a pending today', () => {
    const h = habit('a');
    const c = done({ a: ['2026-10-13', '2026-10-14', '2026-10-15'] });
    expect(currentStreak(h, c, TODAY)).toBe(3);
  });

  it('includes today once it is done', () => {
    const h = habit('a');
    const c = done({ a: ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'] });
    expect(currentStreak(h, c, TODAY)).toBe(4);
  });

  it('stops at the first scheduled day that was not done', () => {
    const h = habit('a');
    const c = done({ a: ['2026-10-12', '2026-10-13', '2026-10-15'] }); // 14th missed
    expect(currentStreak(h, c, TODAY)).toBe(1);
  });

  it('yesterday missed means 0, even with a long run before it', () => {
    const h = habit('a');
    const c = done({ a: span('2026-10-01', '2026-10-14') }); // 15th missed, today pending
    expect(currentStreak(h, c, TODAY)).toBe(0);
    expect(currentStreak(h, done({ a: [...span('2026-10-01', '2026-10-14'), TODAY] }), TODAY)).toBe(1);
  });

  it('skips unscheduled days without breaking', () => {
    const h = habit('a', { days: MWF, createdAt: '2026-10-05' });
    const c = done({ a: ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14'] });
    // Today (Fri 16th) is scheduled and pending → skipped; Tue/Thu/Sat/Sun are skipped.
    expect(currentStreak(h, c, TODAY)).toBe(5);
  });

  it('a weekly schedule bridges six unscheduled days at a time', () => {
    const mondays = habit('m', { days: [0], createdAt: '2026-09-01' });
    const c = done({ m: ['2026-09-28', '2026-10-05', '2026-10-12'] });
    expect(currentStreak(mondays, c, TODAY)).toBe(3);
    expect(currentStreak(mondays, done({ m: ['2026-09-28', '2026-10-12'] }), TODAY)).toBe(1);
  });

  it('ignores bonus completions on unscheduled days', () => {
    const h = habit('a', { days: MWF, createdAt: '2026-10-05' });
    const c = done({ a: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15'] }); // 13th & 15th are bonus
    // 9th (Fri) not done → stops after 14th and 12th.
    expect(currentStreak(h, c, TODAY)).toBe(2);
  });

  it('a bonus day cannot rescue a missed scheduled day', () => {
    const h = habit('a', { days: MWF, createdAt: '2026-10-05' });
    const c = done({ a: ['2026-10-14', '2026-10-13'] }); // Mon 12th missed, Tue 13th bonus
    expect(currentStreak(h, c, TODAY)).toBe(1);
  });

  it('a bonus completion on an unscheduled today neither counts nor breaks', () => {
    const h = habit('a', { days: [0, 1, 2, 3], createdAt: '2026-10-05' }); // Mon–Thu; Fri 16th is off
    const c = done({ a: ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'] });
    expect(currentStreak(h, c, TODAY)).toBe(3);
    expect(currentStreak(h, done({ a: ['2026-10-13', '2026-10-14', '2026-10-15'] }), TODAY)).toBe(3);
  });

  it('returns 0 when nothing is done or today is before createdAt', () => {
    expect(currentStreak(habit('a'), {}, TODAY)).toBe(0);
    expect(currentStreak(habit('a', { createdAt: '2026-10-20' }), done({ a: ['2026-10-16'] }), TODAY)).toBe(0);
  });

  it('a tracker created today is 1 once done and 0 while pending', () => {
    const h = habit('a', { createdAt: TODAY });
    expect(currentStreak(h, {}, TODAY)).toBe(0);
    expect(currentStreak(h, done({ a: [TODAY] }), TODAY)).toBe(1);
  });

  it('does not walk before createdAt (habit created mid-week)', () => {
    const h = habit('a', { createdAt: '2026-10-14' });
    const c = done({ a: ['2026-10-14', '2026-10-15', '2026-10-13', '2026-10-12'] }); // 12/13 predate creation
    expect(currentStreak(h, c, TODAY)).toBe(2);
  });

  it('keeps the final streak of an archived habit', () => {
    const h = habit('a', { archivedAt: '2026-10-15' });
    const c = done({ a: ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'] });
    expect(currentStreak(h, c, TODAY)).toBe(5);
    // Completions on or after archivedAt are bonus and do not count.
    expect(currentStreak(h, done({ a: [...span('2026-10-10', '2026-10-14'), '2026-10-15', TODAY] }), TODAY)).toBe(5);
  });

  it('reaches every milestone exactly, done today or pending today', () => {
    const h = habit('a', { createdAt: '2025-01-01' });
    for (const n of STREAK_MILESTONES) {
      expect(currentStreak(h, done({ a: runEnding(TODAY, n) }), TODAY)).toBe(n);
      expect(currentStreak(h, done({ a: runEnding(addDays(TODAY, -1), n) }), TODAY)).toBe(n);
      expect(currentStreak(h, done({ a: runEnding(TODAY, n + 1) }), TODAY)).toBe(n + 1);
    }
  });

  it('spans the DST transitions without skipping or doubling a day', () => {
    const autumn = habit('a', { createdAt: '2026-10-20' });
    expect(currentStreak(autumn, done({ a: span('2026-10-25', '2026-11-05') }), '2026-11-05')).toBe(12);
    expect(bestStreak(autumn, done({ a: span('2026-10-25', '2026-11-05') }), '2026-11-05')).toBe(12);
    const spring = habit('a', { createdAt: '2026-02-20' });
    expect(currentStreak(spring, done({ a: span('2026-03-01', '2026-03-14') }), '2026-03-14')).toBe(14);
    expect(bestStreak(spring, done({ a: span('2026-03-01', '2026-03-14') }), '2026-03-14')).toBe(14);
  });

  it('has empty days → 0', () => {
    expect(currentStreak(habit('a', { days: [] }), done({ a: [TODAY] }), TODAY)).toBe(0);
  });
});

describe('bestStreak', () => {
  it('finds the longest run between createdAt and today', () => {
    const h = habit('a');
    const c = done({
      a: [
        '2026-10-01', '2026-10-02', '2026-10-03', // 3
        '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', // 5
        '2026-10-13', '2026-10-14', '2026-10-15', // 3 (current; today pending is skipped)
      ],
    });
    expect(bestStreak(h, c, TODAY)).toBe(5);
    expect(currentStreak(h, c, TODAY)).toBe(3);
  });

  it('is never smaller than the current streak', () => {
    const h = habit('a', { days: MWF, createdAt: '2026-10-05' });
    const c = done({ a: ['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14'] });
    expect(bestStreak(h, c, TODAY)).toBe(5);
    expect(bestStreak(h, c, TODAY)).toBeGreaterThanOrEqual(currentStreak(h, c, TODAY));
  });

  it('a pending today does not lower the best', () => {
    const h = habit('a');
    const c = done({ a: span('2026-10-10', '2026-10-15') });
    expect(bestStreak(h, c, TODAY)).toBe(6);
    expect(currentStreak(h, c, TODAY)).toBe(6);
  });

  it('only counts scheduled days', () => {
    const h = habit('a', { days: [0], createdAt: '2026-10-05' }); // Mondays only
    const c = done({ a: ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-12'] });
    expect(bestStreak(h, c, TODAY)).toBe(2);
  });

  it('ignores completions before createdAt', () => {
    const h = habit('a', { createdAt: '2026-10-14' });
    const c = done({ a: span('2026-10-01', '2026-10-15') });
    expect(bestStreak(h, c, TODAY)).toBe(2);
  });

  it('is frozen for an archived habit', () => {
    const h = habit('a', { archivedAt: '2026-10-06' });
    const c = done({ a: [...span('2026-10-01', '2026-10-05'), ...span('2026-10-06', '2026-10-16')] });
    expect(bestStreak(h, c, TODAY)).toBe(5);
    expect(currentStreak(h, c, TODAY)).toBe(5);
  });

  it('handles a habit created mid-week with a weekday schedule', () => {
    const h = habit('a', { days: MWF, createdAt: '2026-10-14' }); // Wednesday
    const c = done({ a: ['2026-10-14', '2026-10-16'] });
    expect(bestStreak(h, c, TODAY)).toBe(2);
    expect(currentStreak(h, c, TODAY)).toBe(2);
  });

  it('returns 0 with no completions, before createdAt, or with empty days', () => {
    expect(bestStreak(habit('a'), {}, TODAY)).toBe(0);
    expect(bestStreak(habit('a', { createdAt: '2026-10-20' }), done({ a: [TODAY] }), TODAY)).toBe(0);
    expect(bestStreak(habit('a', { days: [] }), done({ a: [TODAY] }), TODAY)).toBe(0);
  });

  it('matches the milestone ladder for long runs', () => {
    const h = habit('a', { createdAt: '2025-01-01' });
    expect(bestStreak(h, done({ a: runEnding(TODAY, 100) }), TODAY)).toBe(100);
    expect(bestStreak(h, done({ a: [...runEnding('2026-05-01', 30), ...runEnding(TODAY, 7)] }), TODAY)).toBe(30);
  });
});

describe('completionStats', () => {
  it('splits due / done / bonus and computes the rate', () => {
    const h = habit('a', { days: MWF, createdAt: '2026-10-05' });
    const c = done({ a: ['2026-10-05', '2026-10-07', '2026-10-12', '2026-10-06'] }); // 6th is a Tuesday bonus
    const stats = completionStats(h, c, '2026-10-05', '2026-10-16');
    expect(stats).toEqual({ due: 6, done: 3, bonus: 1, rate: 0.5 });
  });

  it('rate is 0 when nothing was due', () => {
    const h = habit('a', { createdAt: '2026-10-20' });
    expect(completionStats(h, {}, '2026-10-01', '2026-10-16')).toEqual({ due: 0, done: 0, bonus: 0, rate: 0 });
  });

  it('is empty when from is after to', () => {
    expect(completionStats(habit('a'), done({ a: [TODAY] }), '2026-10-16', '2026-10-10')).toEqual({
      due: 0,
      done: 0,
      bonus: 0,
      rate: 0,
    });
  });

  it('a single-day range', () => {
    const h = habit('a');
    expect(completionStats(h, done({ a: [TODAY] }), TODAY, TODAY)).toEqual({ due: 1, done: 1, bonus: 0, rate: 1 });
    expect(completionStats(h, {}, TODAY, TODAY)).toEqual({ due: 1, done: 0, bonus: 0, rate: 0 });
  });

  it('ignores completions outside the range on both sides, including days after `to`', () => {
    const h = habit('a');
    const c = done({ a: ['2026-10-09', '2026-10-12', '2026-10-13', '2026-10-17', '2026-10-18'] });
    // Pass `to = today` to exclude the future: the 17th/18th are not counted at all.
    expect(completionStats(h, c, '2026-10-12', TODAY)).toEqual({ due: 5, done: 2, bonus: 0, rate: 0.4 });
  });

  it('30-day window the way the Progress view calls it', () => {
    const from = addDays(TODAY, -29);
    expect(from).toBe('2026-09-17');
    const old = habit('a', { createdAt: '2026-09-01' });
    expect(completionStats(old, done({ a: span('2026-09-17', '2026-10-16') }), from, TODAY)).toEqual({
      due: 30,
      done: 30,
      bonus: 0,
      rate: 1,
    });
    const recent = habit('b', { createdAt: '2026-10-10' });
    expect(completionStats(recent, done({ b: span('2026-10-10', '2026-10-13') }), from, TODAY)).toEqual({
      due: 7,
      done: 4,
      bonus: 0,
      rate: 4 / 7,
    });
  });

  it('respects createdAt and archivedAt inside the range', () => {
    const h = habit('a', { createdAt: '2026-10-10', archivedAt: '2026-10-14' });
    const c = done({ a: ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'] });
    const stats = completionStats(h, c, '2026-10-01', '2026-10-16');
    expect(stats.due).toBe(4); // 10,11,12,13
    expect(stats.done).toBe(4);
    expect(stats.bonus).toBe(1); // the 14th, after archiving
    expect(stats.rate).toBe(1);
  });

  it('weekday-only schedule across two weeks', () => {
    const h = habit('a', { days: WEEKDAYS, createdAt: '2026-10-05' });
    const c = done({ a: [...span('2026-10-05', '2026-10-09'), '2026-10-10', '2026-10-12'] }); // Sat 10th bonus
    expect(completionStats(h, c, '2026-10-05', '2026-10-18')).toEqual({ due: 10, done: 6, bonus: 1, rate: 0.6 });
  });
});

describe('dayProgress / isPerfectDay', () => {
  it('counts due and done for one day, excluding bonus', () => {
    const habits = [habit('a'), habit('b', { days: MWF })];
    const c = done({ a: ['2026-10-15'], b: ['2026-10-15'] }); // Thu: b is not due → bonus
    expect(dayProgress(habits, c, '2026-10-15')).toEqual({ due: 1, done: 1 });
    expect(isPerfectDay(habits, c, '2026-10-15')).toBe(true);
    expect(isPerfectDay(habits, c, '2026-10-14')).toBe(false);
    expect(isPerfectDay([habit('a', { days: [0] })], {}, '2026-10-15')).toBe(false); // nothing due
  });

  it('respects createdAt and archivedAt', () => {
    const habits = [habit('a', { createdAt: '2026-10-14' }), habit('b', { archivedAt: '2026-10-14' })];
    expect(dayProgress(habits, {}, '2026-10-13')).toEqual({ due: 1, done: 0 }); // only b
    expect(dayProgress(habits, {}, '2026-10-14')).toEqual({ due: 1, done: 0 }); // only a
    expect(dayProgress([], {}, TODAY)).toEqual({ due: 0, done: 0 });
  });

  it('never exceeds due', () => {
    const habits = [habit('a', { days: [0] })];
    expect(dayProgress(habits, done({ a: [TODAY] }), TODAY)).toEqual({ due: 0, done: 0 });
  });
});

describe('perfectDayStreak', () => {
  const habits = [habit('a'), habit('b', { days: MWF })];

  it('starts yesterday when today is incomplete, skips days with nothing due', () => {
    const c = done({ a: ['2026-10-13', '2026-10-14', '2026-10-15'], b: ['2026-10-14'] });
    // 16 (today, Fri): a+b due, nothing done → start at 15.
    // 15 Thu: a ✓ · 14 Wed: a ✓ b ✓ · 13 Tue: a ✓ · 12 Mon: a missed → stop.
    expect(perfectDayStreak(habits, c, TODAY)).toBe(3);
  });

  it('a partially done today still starts from yesterday', () => {
    const c = done({ a: ['2026-10-14', '2026-10-15', '2026-10-16'], b: ['2026-10-14'] }); // b pending today
    expect(perfectDayStreak(habits, c, TODAY)).toBe(2);
  });

  it('includes today when today is complete', () => {
    const c = done({ a: ['2026-10-15', '2026-10-16'], b: ['2026-10-16'] });
    expect(perfectDayStreak(habits, c, TODAY)).toBe(2);
  });

  it('breaks when any due habit was missed', () => {
    const c = done({ a: ['2026-10-14', '2026-10-15'] }); // b due on the 14th and not done
    expect(perfectDayStreak(habits, c, TODAY)).toBe(1);
  });

  it('skips days with zero due habits', () => {
    const mondays = [habit('m', { days: [0], createdAt: '2026-10-05' })];
    const c = done({ m: ['2026-10-05', '2026-10-12'] });
    expect(perfectDayStreak(mondays, c, TODAY)).toBe(2);
  });

  it('weekend rest days do not break a weekday-only streak', () => {
    const weekdays = [habit('w', { days: WEEKDAYS, createdAt: '2026-10-05' })];
    const c = done({ w: [...span('2026-10-05', '2026-10-09'), ...span('2026-10-12', '2026-10-16')] });
    expect(perfectDayStreak(weekdays, c, TODAY)).toBe(10);
    expect(perfectDayStreak(weekdays, c, '2026-10-18')).toBe(10); // Sunday: nothing due, streak holds
  });

  it('a rest day today does not hide a miss yesterday', () => {
    const mondays = [habit('m', { days: [0], createdAt: '2026-10-05' })];
    expect(perfectDayStreak(mondays, done({ m: ['2026-10-05'] }), TODAY)).toBe(0); // Mon 12th missed
  });

  it('counts an archived habit on the days it was active', () => {
    const mixed = [habit('a'), habit('b', { archivedAt: '2026-10-15' })];
    const c = done({ a: span('2026-10-12', '2026-10-16'), b: span('2026-10-12', '2026-10-14') });
    // 16 ✓(a) · 15 ✓(a; b archived) · 14 ✓(a,b) · 13 ✓ · 12 ✓ · 11: a due, missed → 5
    expect(perfectDayStreak(mixed, c, TODAY)).toBe(5);
    // b missed on the 13th while it was still active → 3
    expect(perfectDayStreak(mixed, done({ a: span('2026-10-12', '2026-10-16'), b: ['2026-10-12', '2026-10-14'] }), TODAY)).toBe(3);
  });

  it('a habit created mid-week bounds the walk', () => {
    const fresh = [habit('a', { createdAt: '2026-10-14' })];
    expect(perfectDayStreak(fresh, done({ a: span('2026-10-14', '2026-10-16') }), TODAY)).toBe(3);
    expect(perfectDayStreak(fresh, done({ a: span('2026-10-01', '2026-10-16') }), TODAY)).toBe(3);
  });

  it('is 0 without habits or completions', () => {
    expect(perfectDayStreak([], {}, TODAY)).toBe(0);
    expect(perfectDayStreak(habits, {}, TODAY)).toBe(0);
  });

  it('spans the DST end transition', () => {
    const h = [habit('a', { createdAt: '2026-10-20' })];
    expect(perfectDayStreak(h, done({ a: span('2026-10-28', '2026-11-04') }), '2026-11-04')).toBe(8);
  });
});

describe('weekSummary', () => {
  const habits = [habit('a'), habit('b', { days: MWF })];

  it('counts only days ≤ today', () => {
    const c = done({ a: ['2026-10-12', '2026-10-13', '2026-10-14'], b: ['2026-10-12'] });
    // Mon–Fri: a 5 due, b 3 due (Mon/Wed/Fri) → 8 due, 4 done.
    expect(weekSummary(habits, c, '2026-10-12', TODAY)).toEqual({ due: 8, done: 4, rate: 0.5 });
    expect(weekSummary(habits, c, '2026-10-12', '2026-10-14')).toEqual({ due: 5, done: 4, rate: 0.8 });
  });

  it('on a Monday only Monday counts', () => {
    expect(weekSummary(habits, {}, '2026-10-12', '2026-10-12')).toEqual({ due: 2, done: 0, rate: 0 });
  });

  it('covers a full past week', () => {
    expect(weekSummary(habits, {}, '2026-10-05', TODAY)).toEqual({ due: 10, done: 0, rate: 0 });
  });

  it('does not count bonus completions', () => {
    const c = done({ b: ['2026-10-13'] }); // Tuesday bonus
    expect(weekSummary(habits, c, '2026-10-12', TODAY).done).toBe(0);
  });

  it('is empty for a future week', () => {
    expect(weekSummary(habits, {}, '2026-10-19', TODAY)).toEqual({ due: 0, done: 0, rate: 0 });
  });

  it('accepts any day of the week as the anchor', () => {
    expect(weekSummary(habits, {}, '2026-10-16', TODAY).due).toBe(8);
    expect(weekSummary(habits, {}, '2026-10-18', TODAY).due).toBe(8);
  });

  it('a habit created mid-week is due only from its creation day', () => {
    const fresh = [habit('a', { createdAt: '2026-10-14' })];
    expect(weekSummary(fresh, done({ a: ['2026-10-14'] }), '2026-10-12', TODAY)).toEqual({ due: 3, done: 1, rate: 1 / 3 });
  });

  it('an archived habit is due only before archivedAt', () => {
    const archived = [habit('a', { archivedAt: '2026-10-15' })];
    expect(weekSummary(archived, done({ a: span('2026-10-12', '2026-10-16') }), '2026-10-12', TODAY)).toEqual({
      due: 3,
      done: 3,
      rate: 1,
    });
  });

  it('is empty with no habits', () => {
    expect(weekSummary([], {}, '2026-10-12', TODAY)).toEqual({ due: 0, done: 0, rate: 0 });
  });
});

describe('weeklyRates', () => {
  const habits = [habit('a', { createdAt: '2026-08-01' })];

  it('returns `weeks` entries, oldest first, current week last', () => {
    const rates = weeklyRates(habits, {}, TODAY);
    expect(rates).toHaveLength(8);
    expect(rates[0]?.mondayKey).toBe('2026-08-24');
    expect(rates[7]?.mondayKey).toBe('2026-10-12');
    expect(rates.map((r) => r.mondayKey)).toEqual([...rates.map((r) => r.mondayKey)].sort());
    expect(weeklyRates(habits, {}, TODAY, 4)).toHaveLength(4);
    expect(weeklyRates(habits, {}, TODAY, 1).map((r) => r.mondayKey)).toEqual(['2026-10-12']);
  });

  it('consecutive entries are exactly seven days apart and every key is a Monday', () => {
    const rates = weeklyRates(habits, {}, TODAY, 12);
    for (let i = 0; i < rates.length; i += 1) {
      const r = rates[i];
      expect(r && addDays(r.mondayKey, -0)).toBe(r?.mondayKey);
      if (i > 0) expect(addDays(rates[i - 1]?.mondayKey ?? '', 7)).toBe(r?.mondayKey);
    }
  });

  it('computes each week with weekSummary semantics', () => {
    const c = done({ a: ['2026-10-05', '2026-10-06', '2026-10-07'] });
    const rates = weeklyRates(habits, c, TODAY, 2);
    expect(rates[0]).toEqual({ mondayKey: '2026-10-05', due: 7, done: 3, rate: 3 / 7 });
    expect(rates[1]).toEqual({ mondayKey: '2026-10-12', due: 5, done: 0, rate: 0 });
  });

  it('past weeks count seven due days for an every-day habit; the current week only up to today', () => {
    const rates = weeklyRates(habits, {}, TODAY, 3);
    expect(rates.map((r) => r.due)).toEqual([7, 7, 5]);
  });

  it('weeks before createdAt have nothing due', () => {
    const fresh = [habit('a', { createdAt: '2026-10-14' })];
    expect(weeklyRates(fresh, {}, TODAY, 3).map((r) => r.due)).toEqual([0, 0, 3]);
  });

  it('is correct across the DST end transition', () => {
    const rates = weeklyRates(habits, {}, '2026-11-04', 2);
    expect(rates.map((r) => r.mondayKey)).toEqual(['2026-10-26', '2026-11-02']);
    expect(rates.map((r) => r.due)).toEqual([7, 3]);
  });

  it('is correct across the DST start transition', () => {
    const h = [habit('a', { createdAt: '2026-01-01' })];
    const rates = weeklyRates(h, {}, '2026-03-11', 2);
    expect(rates.map((r) => r.mondayKey)).toEqual(['2026-03-02', '2026-03-09']);
    expect(rates.map((r) => r.due)).toEqual([7, 3]);
  });

  it('is correct across a year boundary', () => {
    const h = [habit('a', { createdAt: '2025-01-01' })];
    expect(weeklyRates(h, {}, '2026-01-07', 2).map((r) => r.mondayKey)).toEqual(['2025-12-29', '2026-01-05']);
  });
});

describe('totalCompletions / STREAK_MILESTONES', () => {
  it('counts every completion including bonus days', () => {
    expect(totalCompletions({})).toBe(0);
    expect(totalCompletions(done({ a: ['2026-10-01', '2026-10-02'], b: ['2026-10-02'] }))).toBe(3);
    expect(totalCompletions({ a: {}, b: { '2026-10-02': true } })).toBe(1);
  });

  it('exposes the milestone ladder, ascending', () => {
    expect(STREAK_MILESTONES).toEqual([3, 7, 14, 21, 30, 50, 100, 365]);
    expect([...STREAK_MILESTONES].sort((x, y) => x - y)).toEqual([...STREAK_MILESTONES]);
  });
});
