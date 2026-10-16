import { describe, expect, it } from 'vitest';
import {
  activeHabits,
  archivedHabits,
  byOrder,
  dueHabits,
  habitById,
  habitColorSoftVar,
  habitColorVar,
  habitsActiveBetween,
  isDone,
  toneClass,
} from '../selectors';
import { weekKeys } from '../dates';
import { HABIT_COLORS, type Completions, type Habit } from '../types';

// TZ=America/New_York. Mon 2026-10-12 … Sun 2026-10-18; Fri 2026-10-16 is "today".
const TODAY = '2026-10-16';

const habit = (id: string, over: Partial<Habit> = {}): Habit => ({
  id,
  name: id.toUpperCase(),
  emoji: '✓',
  color: 'sage',
  days: [0, 1, 2, 3, 4, 5, 6],
  createdAt: '2026-10-01',
  order: 0,
  ...over,
});

const a = habit('a', { order: 2 });
const b = habit('b', { order: 0, days: [0, 2, 4] }); // Mon/Wed/Fri
const c = habit('c', { order: 1, archivedAt: '2026-10-15' });
const d = habit('d', { order: 3, createdAt: '2026-10-14' }); // created Wednesday
const all = [a, b, c, d];

describe('activeHabits / archivedHabits', () => {
  it('split by archivedAt and sort by order', () => {
    expect(activeHabits(all).map((h) => h.id)).toEqual(['b', 'a', 'd']);
    expect(archivedHabits(all).map((h) => h.id)).toEqual(['c']);
  });

  it('return new arrays and never mutate the input', () => {
    const input = [a, b, c, d];
    const active = activeHabits(input);
    expect(active).not.toBe(input);
    expect(input.map((h) => h.id)).toEqual(['a', 'b', 'c', 'd']);
    active.reverse();
    expect(activeHabits(input).map((h) => h.id)).toEqual(['b', 'a', 'd']);
  });

  it('handle empty input and all-archived input', () => {
    expect(activeHabits([])).toEqual([]);
    expect(archivedHabits([])).toEqual([]);
    const archivedOnly = [habit('x', { archivedAt: '2026-10-01' })];
    expect(activeHabits(archivedOnly)).toEqual([]);
    expect(archivedHabits(archivedOnly)).toHaveLength(1);
  });

  it('an archived tracker with a future archivedAt still counts as archived (the flag, not the date)', () => {
    const future = habit('f', { archivedAt: '2026-12-01' });
    expect(activeHabits([future])).toEqual([]);
    expect(archivedHabits([future])).toEqual([future]);
  });
});

describe('habitById', () => {
  it('finds by id or returns undefined', () => {
    expect(habitById(all, 'c')).toBe(c);
    expect(habitById(all, 'nope')).toBeUndefined();
    expect(habitById([], 'a')).toBeUndefined();
  });
});

describe('isDone', () => {
  const completions: Completions = { a: { '2026-10-15': true } };

  it('is true only for a recorded completion', () => {
    expect(isDone(completions, 'a', '2026-10-15')).toBe(true);
    expect(isDone(completions, 'a', '2026-10-16')).toBe(false);
    expect(isDone(completions, 'b', '2026-10-15')).toBe(false);
    expect(isDone({}, 'a', '2026-10-15')).toBe(false);
  });

  it('does not treat inherited properties as completions', () => {
    expect(isDone(completions, 'a', 'toString')).toBe(false);
    expect(isDone(completions, 'constructor', '2026-10-15')).toBe(false);
  });
});

describe('dueHabits', () => {
  it('returns the habits scheduled on the day, sorted by order', () => {
    // Fri 16th: a (every day), b (Fri), d (created Wed); c archived on the 15th.
    expect(dueHabits(all, TODAY).map((h) => h.id)).toEqual(['b', 'a', 'd']);
    // Thu 15th: b is off, c is archived (exclusive), d is active since Wed.
    expect(dueHabits(all, '2026-10-15').map((h) => h.id)).toEqual(['a', 'd']);
    // Tue 13th: b off, c still active, d not yet created.
    expect(dueHabits(all, '2026-10-13').map((h) => h.id)).toEqual(['c', 'a']);
  });

  it('a habit created mid-week is not due earlier that week', () => {
    expect(weekKeys(TODAY).map((k) => dueHabits([d], k).length)).toEqual([0, 0, 1, 1, 1, 1, 1]);
  });

  it('an archived habit is due only before archivedAt', () => {
    expect(weekKeys(TODAY).map((k) => dueHabits([c], k).length)).toEqual([1, 1, 1, 0, 0, 0, 0]);
  });

  it('a weekday schedule follows Mon = 0 … Sun = 6', () => {
    expect(weekKeys(TODAY).map((k) => dueHabits([b], k).length)).toEqual([1, 0, 1, 0, 1, 0, 0]);
    const weekend = habit('w', { days: [5, 6] });
    expect(weekKeys(TODAY).map((k) => dueHabits([weekend], k).length)).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it('returns a new array and leaves the input untouched', () => {
    const input = [a, b];
    const due = dueHabits(input, TODAY);
    expect(due).not.toBe(input);
    expect(input).toEqual([a, b]);
    expect(dueHabits([], TODAY)).toEqual([]);
  });

  it('is stable for equal orders', () => {
    const x = habit('x', { order: 0 });
    const y = habit('y', { order: 0 });
    expect(dueHabits([x, y], TODAY).map((h) => h.id)).toEqual(['x', 'y']);
    expect(dueHabits([y, x], TODAY).map((h) => h.id)).toEqual(['y', 'x']);
  });
});

describe('byOrder', () => {
  it('sorts ascending by order', () => {
    expect(byOrder(a, b)).toBeGreaterThan(0);
    expect(byOrder(b, a)).toBeLessThan(0);
    expect(byOrder(a, habit('z', { order: 2 }))).toBe(0);
    expect([a, b, c, d].sort(byOrder).map((h) => h.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('colour helpers', () => {
  it('map every habit colour to its CSS variables and tone class', () => {
    for (const color of HABIT_COLORS) {
      expect(habitColorVar(color)).toBe(`var(--c-${color})`);
      expect(habitColorSoftVar(color)).toBe(`var(--c-${color}-soft)`);
      expect(toneClass(color)).toBe(`tone-${color}`);
    }
    expect(habitColorVar('terracotta')).toBe('var(--c-terracotta)');
    expect(HABIT_COLORS).toHaveLength(8);
  });
});

describe('habitsActiveBetween', () => {
  // Mon 2026-10-12 … Sun 2026-10-18 is "this week".
  const MON = '2026-10-12';
  const SUN = '2026-10-18';

  it('keeps every tracker live for at least one day of the range, sorted by order', () => {
    // c is archived on the Thursday (still live Mon–Wed); d is created on the Wednesday.
    expect(habitsActiveBetween(all, MON, SUN).map((h) => h.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('drops trackers archived on or before the first day (archivedAt is exclusive)', () => {
    expect(habitsActiveBetween(all, '2026-10-19', '2026-10-25').map((h) => h.id)).toEqual(['b', 'a', 'd']);
    const onMonday = habit('m', { archivedAt: MON });
    const onTuesday = habit('t', { archivedAt: '2026-10-13' });
    expect(habitsActiveBetween([onMonday, onTuesday], MON, SUN).map((h) => h.id)).toEqual(['t']);
  });

  it('drops trackers created after the last day, keeps one created on it', () => {
    expect(habitsActiveBetween(all, '2026-10-05', '2026-10-11').map((h) => h.id)).toEqual(['b', 'c', 'a']);
    const onSunday = habit('s', { createdAt: SUN });
    const nextMonday = habit('n', { createdAt: '2026-10-19' });
    expect(habitsActiveBetween([onSunday, nextMonday], MON, SUN).map((h) => h.id)).toEqual(['s']);
  });

  it('works for a single day and agrees with the week membership the Week view shows', () => {
    expect(habitsActiveBetween(all, '2026-10-15', '2026-10-15').map((h) => h.id)).toEqual(['b', 'a', 'd']);
    expect(habitsActiveBetween(all, '2026-10-14', '2026-10-14').map((h) => h.id)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns a new array and leaves the input untouched', () => {
    const input = [a, b];
    const live = habitsActiveBetween(input, MON, SUN);
    expect(live).not.toBe(input);
    expect(input).toEqual([a, b]);
    expect(habitsActiveBetween([], MON, SUN)).toEqual([]);
  });
});
