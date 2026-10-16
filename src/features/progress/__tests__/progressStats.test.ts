import { describe, expect, it } from 'vitest';
import type { Habit } from '../../../lib/types';
import { addDays, weekdayOf } from '../../../lib/dates';
import {
  CHART_WEEKS,
  HEATMAP_WEEKS,
  buildHeatmap,
  formatMonday,
  lifetimeStats,
  monthShort,
  percent,
  plural,
  recentWeeks,
  sliceCompletions,
} from '../progressStats';

// TZ=America/New_York. Mon 2026-10-12 … Sun 2026-10-18; Fri 2026-10-16 is "today".
const TODAY = '2026-10-16';

const habit = (over: Partial<Habit> = {}): Habit => ({
  id: 'gym',
  name: 'Gym',
  emoji: '💪',
  color: 'sage',
  days: [0, 2, 4], // Mon / Wed / Fri
  createdAt: '2026-10-07', // Wednesday
  order: 0,
  ...over,
});

describe('recentWeeks', () => {
  it('returns 12 Mon→Sun rows, oldest first, ending with the current week', () => {
    const weeks = recentWeeks(TODAY);
    expect(weeks).toHaveLength(HEATMAP_WEEKS);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    expect(weeks.at(-1)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
    expect(weeks[0]?.[0]).toBe('2026-07-27');
    for (const [i, week] of weeks.entries()) {
      expect(weekdayOf(week[0] ?? '')).toBe(0);
      if (i > 0) expect(week[0]).toBe(addDays(weeks[i - 1]?.[0] ?? '', 7));
    }
  });

  it('spans the DST change without skipping or repeating a day', () => {
    const weeks = recentWeeks('2026-11-06', 2); // the week of 2026-11-01 (fall back) and the next
    const keys = weeks.flat();
    expect(keys).toHaveLength(14);
    expect(keys).toContain('2026-11-01');
    for (let i = 1; i < keys.length; i += 1) expect(keys[i]).toBe(addDays(keys[i - 1] ?? '', 1));
  });

  it('honours the count argument and keeps the chart width in step', () => {
    expect(recentWeeks(TODAY, 1)).toEqual([['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']]);
    expect(recentWeeks(TODAY, CHART_WEEKS)).toHaveLength(8);
  });
});

describe('buildHeatmap', () => {
  const weeks = recentWeeks(TODAY, 2); // 2026-10-05 … 2026-10-18
  const dates = { '2026-10-07': true, '2026-10-10': true, '2026-10-12': true, '2026-10-14': true } as const;

  it('maps every day to done / missed / pending / bonus / empty', () => {
    const heat = buildHeatmap(habit(), dates, weeks, TODAY);
    expect(heat.rows.map((row) => row.map((c) => c.state))).toEqual([
      // 05 (before createdAt) 06 07-done 08-off 09-missed 10-bonus(Sat) 11-off
      ['empty', 'empty', 'done', 'empty', 'missed', 'bonus', 'empty'],
      // 12-done 13-off 14-done 15-off 16-today pending 17-future 18-future
      ['empty', 'empty', 'done', 'empty', 'pending', 'empty', 'empty'].map((s, i) => (i === 0 ? 'done' : s)),
    ]);
    expect(heat).toMatchObject({ due: 5, done: 3, bonus: 1 });
    expect(heat.rows[1]?.[4]).toMatchObject({ key: TODAY, isToday: true, state: 'pending' });
    expect(heat.rows.flat().filter((c) => c.isToday)).toHaveLength(1);
  });

  it('counts only scheduled days as due and never marks the future', () => {
    const heat = buildHeatmap(habit(), undefined, weeks, TODAY);
    expect(heat).toMatchObject({ due: 5, done: 0, bonus: 0 });
    expect(heat.rows[1]?.slice(5).map((c) => c.state)).toEqual(['empty', 'empty']);
  });

  it('an archived tracker stops at archivedAt (no pending today, no missed days after)', () => {
    const heat = buildHeatmap(habit({ archivedAt: '2026-10-13' }), dates, weeks, TODAY);
    expect(heat.rows[1]?.map((c) => c.state)).toEqual(['done', 'empty', 'bonus', 'empty', 'empty', 'empty', 'empty']);
    expect(heat).toMatchObject({ due: 3, done: 2, bonus: 2 });
  });

  it('a tracker created today has a single pending cell', () => {
    const heat = buildHeatmap(habit({ createdAt: TODAY, days: [0, 1, 2, 3, 4, 5, 6] }), undefined, weeks, TODAY);
    const states = heat.rows.flat().map((c) => c.state);
    expect(states.filter((s) => s !== 'empty')).toEqual(['pending']);
    expect(heat).toMatchObject({ due: 1, done: 0, bonus: 0 });
  });
});

describe('lifetimeStats', () => {
  const daily = habit({ createdAt: '2026-10-05', days: [0, 1, 2, 3, 4, 5, 6] });
  const dates = { '2026-10-05': true, '2026-10-06': true, '2026-10-07': true, '2026-10-09': true } as const;

  it('covers createdAt → today for an active tracker', () => {
    expect(lifetimeStats(daily, dates, TODAY)).toEqual({
      due: 12,
      done: 4,
      bonus: 0,
      rate: 4 / 12,
      best: 3,
      total: 4,
    });
  });

  it('stops the day before archivedAt and still counts every completion in total', () => {
    const archived = { ...daily, archivedAt: '2026-10-08' };
    expect(lifetimeStats(archived, dates, TODAY)).toEqual({ due: 3, done: 3, bonus: 0, rate: 1, best: 3, total: 4 });
  });

  it('handles a tracker with no completions', () => {
    expect(lifetimeStats(daily, undefined, TODAY)).toEqual({ due: 12, done: 0, bonus: 0, rate: 0, best: 0, total: 0 });
  });
});

describe('formatting helpers', () => {
  it('percent rounds to a whole number', () => {
    expect(percent(0.857)).toBe(86);
    expect(percent(0)).toBe(0);
    expect(percent(1)).toBe(100);
    expect(percent(2 / 3)).toBe(67);
  });

  it('labels Mondays by day and month', () => {
    expect(formatMonday('2026-10-12')).toBe('12 Oct');
    expect(formatMonday('2026-01-05')).toBe('5 Jan');
    expect(monthShort('2026-10-12')).toBe('Oct');
    expect(monthShort('2026-12-28')).toBe('Dec');
  });

  it('slices completions down to one tracker', () => {
    expect(sliceCompletions('gym', undefined)).toEqual({});
    expect(sliceCompletions('gym', { '2026-10-01': true })).toEqual({ gym: { '2026-10-01': true } });
  });

  it('pluralises with an optional irregular form', () => {
    expect(plural(1, 'day')).toBe('day');
    expect(plural(0, 'day')).toBe('days');
    expect(plural(2, 'tracker')).toBe('trackers');
    expect(plural(3, 'check-in', 'check-ins')).toBe('check-ins');
  });
});
