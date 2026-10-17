import { describe, expect, it } from 'vitest';
import { dayHeading, defaultTaskDate } from '../weekTasksModel';

// TZ=America/New_York. Mon 2026-10-12 … Sun 2026-10-18; Fri 2026-10-16 is "today".
const TODAY = '2026-10-16';
const THIS_MONDAY = '2026-10-12';

describe('defaultTaskDate', () => {
  it('is today for the current week, wherever today falls in it', () => {
    expect(defaultTaskDate(THIS_MONDAY, TODAY)).toBe(TODAY);
    expect(defaultTaskDate(THIS_MONDAY, '2026-10-12')).toBe('2026-10-12'); // a Monday
    expect(defaultTaskDate(THIS_MONDAY, '2026-10-18')).toBe('2026-10-18'); // a Sunday
  });

  it('is that week’s Monday for a future week', () => {
    expect(defaultTaskDate('2026-10-19', TODAY)).toBe('2026-10-19');
    expect(defaultTaskDate('2026-11-02', TODAY)).toBe('2026-11-02'); // past the DST change
  });

  it('is today for a past week (a task is never planned into the past by default)', () => {
    expect(defaultTaskDate('2026-10-05', TODAY)).toBe(TODAY);
    expect(defaultTaskDate('2026-03-02', TODAY)).toBe(TODAY);
  });
});

describe('dayHeading', () => {
  it('names the day as "Tue 21" and spells it out for screen readers', () => {
    expect(dayHeading('2026-10-20', TODAY)).toEqual({
      short: 'Tue 20',
      relative: null,
      spoken: 'Tuesday 20 October',
    });
  });

  it('adds Today, Tomorrow and Yesterday — and only those', () => {
    expect(dayHeading(TODAY, TODAY)).toEqual({
      short: 'Fri 16',
      relative: 'Today',
      spoken: 'Friday 16 October, today',
    });
    expect(dayHeading('2026-10-17', TODAY)).toEqual({
      short: 'Sat 17',
      relative: 'Tomorrow',
      spoken: 'Saturday 17 October, tomorrow',
    });
    expect(dayHeading('2026-10-15', TODAY)).toEqual({
      short: 'Thu 15',
      relative: 'Yesterday',
      spoken: 'Thursday 15 October, yesterday',
    });
    // Within six days relativeDayLabel gives a weekday name, which "Mon 12" already says.
    expect(dayHeading('2026-10-12', TODAY).relative).toBeNull();
    expect(dayHeading('2026-10-18', TODAY).relative).toBeNull();
    // Far away it gives a date, which adds nothing either.
    expect(dayHeading('2026-11-03', TODAY)).toEqual({
      short: 'Tue 3',
      relative: null,
      spoken: 'Tuesday 3 November',
    });
  });

  it('is unaffected by the DST change inside a week', () => {
    // New York leaves DST on Sun 2026-11-01.
    expect(dayHeading('2026-11-01', '2026-10-31')).toMatchObject({ short: 'Sun 1', relative: 'Tomorrow' });
    expect(dayHeading('2026-10-31', '2026-11-01')).toMatchObject({ short: 'Sat 31', relative: 'Yesterday' });
    expect(dayHeading('2026-11-02', '2026-11-01')).toMatchObject({ short: 'Mon 2', relative: 'Tomorrow' });
  });
});
