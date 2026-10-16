import { describe, expect, it } from 'vitest';
import type { Habit } from '../../../lib/types';
import { cellModel, relativeWeekLabel, weekScope } from '../weekModel';

// TZ=America/New_York. Mon 2026-10-12 … Sun 2026-10-18; Fri 2026-10-16 is "today".
const TODAY = '2026-10-16';

const gym: Habit = {
  id: 'gym',
  name: 'Gym',
  emoji: '💪',
  color: 'terracotta',
  days: [0, 2, 4], // Mon / Wed / Fri
  createdAt: '2026-10-13', // Tuesday
  order: 0,
};

describe('cellModel', () => {
  it('a scheduled day in the past is done or not done', () => {
    expect(cellModel(gym, true, '2026-10-14', TODAY)).toEqual({
      state: 'done',
      future: false,
      disabled: false,
      label: 'Gym, Wednesday 14 October, done',
    });
    expect(cellModel(gym, false, '2026-10-14', TODAY)).toMatchObject({
      state: 'due',
      disabled: false,
      label: 'Gym, Wednesday 14 October, not done',
    });
  });

  it('today is tappable and still "not done" (never "upcoming")', () => {
    expect(cellModel(gym, false, TODAY, TODAY)).toMatchObject({
      state: 'due',
      future: false,
      disabled: false,
      label: 'Gym, Friday 16 October, not done',
    });
  });

  it('an unscheduled day shows a dash and stays tappable; a completion there is a bonus', () => {
    expect(cellModel(gym, false, '2026-10-13', TODAY)).toMatchObject({
      state: 'off',
      disabled: false,
      label: 'Gym, Tuesday 13 October, not scheduled',
    });
    expect(cellModel(gym, true, '2026-10-15', TODAY)).toMatchObject({
      state: 'bonus',
      disabled: false,
      label: 'Gym, Thursday 15 October, done as a bonus',
    });
  });

  it('future days are disabled, scheduled ones read "upcoming"', () => {
    expect(cellModel(gym, false, '2026-10-19', TODAY)).toEqual({
      state: 'due',
      future: true,
      disabled: true,
      label: 'Gym, Monday 19 October, upcoming',
    });
    expect(cellModel(gym, false, '2026-10-17', TODAY)).toMatchObject({
      state: 'off',
      future: true,
      disabled: true,
      label: 'Gym, Saturday 17 October, not scheduled',
    });
  });

  it('days before createdAt are empty and disabled, unless a stray completion needs clearing', () => {
    expect(cellModel(gym, false, '2026-10-12', TODAY)).toEqual({
      state: 'outside',
      future: false,
      disabled: true,
      label: 'Gym, Monday 12 October, not tracked',
    });
    expect(cellModel(gym, true, '2026-10-12', TODAY)).toMatchObject({ state: 'bonus', disabled: false });
  });

  it('days from archivedAt onward are outside the tracker, past or future', () => {
    const archived: Habit = { ...gym, archivedAt: '2026-10-15' };
    expect(cellModel(archived, false, '2026-10-15', TODAY)).toMatchObject({ state: 'outside', disabled: true });
    expect(cellModel(archived, false, '2026-10-16', TODAY)).toMatchObject({
      state: 'outside',
      disabled: true,
      label: 'Gym, Friday 16 October, not tracked',
    });
    expect(cellModel(archived, false, '2026-10-19', TODAY)).toMatchObject({
      state: 'outside',
      future: true,
      disabled: true,
      label: 'Gym, Monday 19 October, not tracked',
    });
    // The last live day still behaves normally.
    expect(cellModel(archived, true, '2026-10-14', TODAY)).toMatchObject({ state: 'done', disabled: false });
  });
});

describe('relativeWeekLabel', () => {
  it('names the current, adjacent and distant weeks', () => {
    expect(relativeWeekLabel(0)).toBe('This week');
    expect(relativeWeekLabel(-1)).toBe('Last week');
    expect(relativeWeekLabel(1)).toBe('Next week');
    expect(relativeWeekLabel(-2)).toBe('2 weeks ago');
    expect(relativeWeekLabel(-12)).toBe('12 weeks ago');
    expect(relativeWeekLabel(3)).toBe('In 3 weeks');
  });
});

describe('weekScope', () => {
  it('names the shown week relative to today, in mid-sentence case', () => {
    expect(weekScope('2026-10-12', TODAY)).toBe('this week');
    expect(weekScope('2026-10-05', TODAY)).toBe('last week');
    expect(weekScope('2026-09-28', TODAY)).toBe('2 weeks ago');
    expect(weekScope('2026-10-19', TODAY)).toBe('next week');
  });

  it('follows today through the week, not a fixed Monday', () => {
    expect(weekScope('2026-10-12', '2026-10-12')).toBe('this week');
    expect(weekScope('2026-10-12', '2026-10-18')).toBe('this week');
    expect(weekScope('2026-10-12', '2026-10-19')).toBe('last week');
  });

  it('is unaffected by the DST change inside a week', () => {
    // New York leaves DST on Sun 2026-11-01.
    expect(weekScope('2026-10-26', '2026-11-02')).toBe('last week');
    expect(weekScope('2026-10-19', '2026-11-04')).toBe('2 weeks ago');
    expect(weekScope('2026-03-02', '2026-03-12')).toBe('last week'); // DST began Sun 2026-03-08
  });
});
