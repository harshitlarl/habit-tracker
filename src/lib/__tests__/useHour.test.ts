import { describe, expect, it } from 'vitest';
import { msUntilNextHour } from '../useHour';

// TZ=America/New_York. The hook itself needs a DOM; its pure helper is tested here.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('msUntilNextHour', () => {
  it('counts to the next full hour on an ordinary day', () => {
    expect(msUntilNextHour(new Date(2026, 9, 16, 10, 0, 0))).toBe(HOUR);
    expect(msUntilNextHour(new Date(2026, 9, 16, 10, 30, 0))).toBe(30 * MINUTE);
    expect(msUntilNextHour(new Date(2026, 9, 16, 23, 59, 59, 999))).toBe(1);
  });

  it('crosses midnight into the next day', () => {
    const landing = new Date(new Date(2026, 9, 16, 23, 15).getTime() + msUntilNextHour(new Date(2026, 9, 16, 23, 15)));
    expect([landing.getDate(), landing.getHours(), landing.getMinutes()]).toEqual([17, 0, 0]);
  });

  it('is 30 minutes from 01:30 on the DST start day (02:00 does not exist, 03:00 EDT follows)', () => {
    const now = new Date(2026, 2, 8, 1, 30, 0);
    const ms = msUntilNextHour(now);
    expect(ms).toBe(30 * MINUTE);
    expect(new Date(now.getTime() + ms).getHours()).toBe(3);
  });

  it('never skips past the hour the clock will actually show on the DST end day', () => {
    // 01:30 happens twice on 2026-11-01; whichever instance the engine picks, the timer lands on
    // a full hour and the hour it lands on is still the one `new Date().getHours()` reports.
    const now = new Date(2026, 10, 1, 1, 30, 0);
    const ms = msUntilNextHour(now);
    expect([30 * MINUTE, 90 * MINUTE]).toContain(ms);
    const landing = new Date(now.getTime() + ms);
    expect([landing.getMinutes(), landing.getSeconds()]).toEqual([0, 0]);
    expect(landing.getHours()).toBe(2);
  });

  it('always lands on a full hour within two hours, including across DST and year ends', () => {
    for (const now of [
      new Date(2026, 2, 7, 22, 15),
      new Date(2026, 2, 8, 0, 59),
      new Date(2026, 2, 8, 12, 0),
      new Date(2026, 10, 1, 0, 0),
      new Date(2026, 10, 1, 1, 0),
      new Date(2026, 10, 1, 23, 0),
      new Date(2026, 11, 31, 23, 30),
      new Date(2026, 9, 16, 8, 0),
    ]) {
      const ms = msUntilNextHour(now);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(2 * HOUR);
      const landing = new Date(now.getTime() + ms);
      expect([landing.getMinutes(), landing.getSeconds(), landing.getMilliseconds()]).toEqual([0, 0, 0]);
      expect(landing.getHours()).toBe((now.getHours() + 1) % 24);
    }
  });

  it('is never negative and defaults to now', () => {
    const ms = msUntilNextHour();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThanOrEqual(2 * HOUR);
  });
});
