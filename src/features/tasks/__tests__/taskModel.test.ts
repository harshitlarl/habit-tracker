import { describe, expect, it } from 'vitest';
import { quickDates } from '../../../lib/tasks';
import { PICK_DATE_LABEL, customDateLabel, formDate, taskRowLabel } from '../taskModel';

// TZ=America/New_York. Sat 2026-10-17 is "today"; its quick row runs Sat 17 … Fri 23 Oct.
const TODAY = '2026-10-17';
const QUICK = quickDates(TODAY);

describe('customDateLabel', () => {
  it('reads "Pick a date…" while the date is one of the quick chips', () => {
    for (const q of QUICK) expect(customDateLabel(q.key, QUICK)).toBe(PICK_DATE_LABEL);
  });

  it('writes a past date out in full, never as a bare weekday next to the quick "Wed 21"', () => {
    expect(QUICK.map((q) => q.label)).toContain('Wed 21');
    expect(customDateLabel('2026-10-14', QUICK)).toBe('Wed 14 Oct'); // 3 days ago, was "Wednesday"
    expect(customDateLabel('2026-10-16', QUICK)).toBe('Fri 16 Oct'); // yesterday
    expect(customDateLabel('2026-10-11', QUICK)).toBe('Sun 11 Oct'); // 6 days ago
  });

  it('writes a date past the quick row out in full, across a month and the DST change', () => {
    expect(customDateLabel('2026-10-24', QUICK)).toBe('Sat 24 Oct'); // 7 days ahead
    expect(customDateLabel('2026-11-02', QUICK)).toBe('Mon 2 Nov'); // after 1 Nov (DST ends)
    expect(customDateLabel('2027-01-05', QUICK)).toBe('Tue 5 Jan');
  });

  it('falls back to "Pick a date…" for a value that is not a real date (a cleared field)', () => {
    expect(customDateLabel('', QUICK)).toBe(PICK_DATE_LABEL);
    expect(customDateLabel('2026-02-30', QUICK)).toBe(PICK_DATE_LABEL);
  });

  it('follows the quick row it is given: after midnight the old "Today" is written out', () => {
    const nextDay = quickDates('2026-10-18');
    expect(customDateLabel(TODAY, QUICK)).toBe(PICK_DATE_LABEL);
    expect(customDateLabel(TODAY, nextDay)).toBe('Sat 17 Oct');
  });
});

describe('formDate', () => {
  it('keeps the date the user picked (or the task’s own), whatever the default says', () => {
    expect(formDate('2026-10-14', '2026-10-17', TODAY)).toBe('2026-10-14');
    expect(formDate('2026-10-14', undefined, '2026-10-18')).toBe('2026-10-14');
  });

  it('keeps a cleared native field as is, so the inline error can say why Save did nothing', () => {
    expect(formDate('', '2026-10-17', TODAY)).toBe('');
  });

  it('follows the default while untouched, so "Today" still means today after midnight', () => {
    expect(formDate(null, '2026-10-17', '2026-10-17')).toBe('2026-10-17');
    expect(formDate(null, '2026-10-18', '2026-10-18')).toBe('2026-10-18');
    expect(formDate(null, '2026-10-26', TODAY)).toBe('2026-10-26'); // Week: a future week's Monday
  });

  it('uses today when there is no usable default', () => {
    expect(formDate(null, undefined, TODAY)).toBe(TODAY);
    expect(formDate(null, 'tomorrow', TODAY)).toBe(TODAY);
    expect(formDate(null, '2026-13-01', '2026-10-18')).toBe('2026-10-18');
  });
});

describe('taskRowLabel', () => {
  it('separates title, time, note and the action with commas', () => {
    expect(taskRowLabel('Mentor meeting', ['3:00 PM', 'Bring the portfolio'])).toBe(
      'Mentor meeting, 3:00 PM, Bring the portfolio, edit task',
    );
  });

  it('names a task without details by its title and the action', () => {
    expect(taskRowLabel('Renew membership', [])).toBe('Renew membership, edit task');
  });

  it('keeps every detail in order, the carried and still-open labels included', () => {
    expect(taskRowLabel('Return the library books', ['9:30 AM', 'bring the card', 'from Wednesday'])).toBe(
      'Return the library books, 9:30 AM, bring the card, from Wednesday, edit task',
    );
    expect(taskRowLabel('Return the library books', ['still open'])).toBe(
      'Return the library books, still open, edit task',
    );
  });

  it('leaves blank parts out, so no empty pause is spoken', () => {
    expect(taskRowLabel('Call the bank', ['', '  ', 'before 5'])).toBe('Call the bank, before 5, edit task');
  });
});
