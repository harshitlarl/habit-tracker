import { describe, expect, it } from 'vitest';
import { ALL_DAYS, WEEKDAYS, WEEKENDS, daysSummary } from '../daysSummary';

describe('daysSummary', () => {
  it('names the three presets', () => {
    expect(daysSummary(ALL_DAYS)).toBe('Every day');
    expect(daysSummary(WEEKDAYS)).toBe('Weekdays');
    expect(daysSummary(WEEKENDS)).toBe('Weekends');
  });

  it('lists other schedules as sorted two-letter days, ignoring order and repeats', () => {
    expect(daysSummary([0, 2, 4])).toBe('Mo We Fr');
    expect(daysSummary([4, 0, 2, 2])).toBe('Mo We Fr');
    expect(daysSummary([6])).toBe('Su');
    expect(daysSummary([0, 1, 2, 3, 4, 5])).toBe('Mo Tu We Th Fr Sa');
  });

  it('recognises presets regardless of input order', () => {
    expect(daysSummary([6, 5])).toBe('Weekends');
    expect(daysSummary([4, 3, 2, 1, 0])).toBe('Weekdays');
    expect(daysSummary([6, 0, 1, 2, 3, 4, 5, 5])).toBe('Every day');
  });

  it('describes an empty selection (the editor blocks saving it)', () => {
    expect(daysSummary([])).toBe('No days');
  });

  it('exposes the preset constants in ascending order', () => {
    expect(ALL_DAYS).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(WEEKDAYS).toEqual([0, 1, 2, 3, 4]);
    expect(WEEKENDS).toEqual([5, 6]);
  });
});
