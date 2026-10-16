import { describe, expect, it } from 'vitest';
import { msUntilNextMidnight } from '../useToday';
import { addDays, todayKey } from '../dates';

// TZ=America/New_York. The hook itself needs a DOM; its pure helper is tested here.
const HOUR = 3_600_000;

describe('msUntilNextMidnight', () => {
  it('counts to the next local midnight on an ordinary day', () => {
    expect(msUntilNextMidnight(new Date(2026, 9, 16, 10, 0, 0))).toBe(14 * HOUR);
    expect(msUntilNextMidnight(new Date(2026, 9, 16, 0, 0, 0))).toBe(24 * HOUR);
    expect(msUntilNextMidnight(new Date(2026, 9, 16, 23, 59, 59, 999))).toBe(1);
  });

  it('is 23 hours on the DST start day and 25 hours on the DST end day', () => {
    expect(msUntilNextMidnight(new Date(2026, 2, 8, 0, 0, 0))).toBe(23 * HOUR);
    expect(msUntilNextMidnight(new Date(2026, 2, 8, 1, 0, 0))).toBe(22 * HOUR);
    expect(msUntilNextMidnight(new Date(2026, 10, 1, 0, 0, 0))).toBe(25 * HOUR);
    expect(msUntilNextMidnight(new Date(2026, 10, 1, 3, 0, 0))).toBe(21 * HOUR); // 03:00 EST, after the fall-back
    // 01:30 happens twice; whichever one the engine picks, the remainder is 23.5h (EDT) or 22.5h (EST).
    expect([23.5 * HOUR, 22.5 * HOUR]).toContain(msUntilNextMidnight(new Date(2026, 10, 1, 1, 30, 0)));
  });

  it('always lands on the next calendar day, including across DST and year ends', () => {
    for (const now of [
      new Date(2026, 2, 7, 22, 15),
      new Date(2026, 2, 8, 0, 0),
      new Date(2026, 2, 8, 12, 0),
      new Date(2026, 10, 1, 0, 0),
      new Date(2026, 10, 1, 1, 0),
      new Date(2026, 10, 1, 23, 0),
      new Date(2026, 11, 31, 23, 30),
      new Date(2026, 9, 16, 8, 0),
    ]) {
      const ms = msUntilNextMidnight(now);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(25 * HOUR);
      const landing = new Date(now.getTime() + ms);
      expect(todayKey(landing)).toBe(addDays(todayKey(now), 1));
      expect([landing.getHours(), landing.getMinutes(), landing.getSeconds()]).toEqual([0, 0, 0]);
    }
  });

  it('is never negative and defaults to now', () => {
    const ms = msUntilNextMidnight();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(25 * HOUR);
  });
});
