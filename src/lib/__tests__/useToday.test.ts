import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msUntilNextMidnight, useToday } from '../useToday';
import { addDays, todayKey } from '../dates';
import { fakeTarget, hookValue, mountHook, resetHook } from './fakeReact';

// TZ=America/New_York. The hook runs on a stand-in for React's hooks and the DOM (fakeReact.ts).
vi.mock('react', async () => (await import('./fakeReact')).fakeReact);

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

describe('useToday', () => {
  let doc = fakeTarget({ visibilityState: 'visible' });
  let win = fakeTarget({});

  beforeEach(() => {
    vi.useFakeTimers();
    resetHook();
    doc = fakeTarget({ visibilityState: 'visible' });
    win = fakeTarget({});
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('re-reads the date when it mounts: rendered just before midnight, mounted just after, it shows the new day', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 23, 59, 59, 995));
    useToday(); // the render
    expect(hookValue()).toBe('2026-10-17');
    vi.setSystemTime(new Date(2026, 9, 18, 0, 0, 0, 20)); // React runs the passive effect a moment later
    mountHook();
    expect(hookValue()).toBe('2026-10-18');
    vi.advanceTimersByTime(HOUR);
    expect(hookValue()).toBe('2026-10-18');
  });

  it('mounted mid-day, keeps the date until just after midnight, then follows the next midnight too', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 10, 0, 0));
    useToday();
    mountHook();
    expect(hookValue()).toBe('2026-10-17');
    vi.advanceTimersByTime(14 * HOUR); // 00:00:00.000; the timer keeps a 1 s margin
    expect(hookValue()).toBe('2026-10-17');
    vi.advanceTimersByTime(1000);
    expect(hookValue()).toBe('2026-10-18');
    vi.advanceTimersByTime(24 * HOUR);
    expect(hookValue()).toBe('2026-10-19');
  });

  it('re-reads the date on visibilitychange (when visible), focus and pageshow, since iOS suspends timers in the background', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 22, 0, 0));
    useToday();
    mountHook();
    vi.setSystemTime(new Date(2026, 9, 18, 7, 0, 0)); // the clock moved on while no timer ran
    doc.visibilityState = 'hidden';
    doc.dispatch('visibilitychange');
    expect(hookValue()).toBe('2026-10-17');
    doc.visibilityState = 'visible';
    doc.dispatch('visibilitychange');
    expect(hookValue()).toBe('2026-10-18');
    vi.setSystemTime(new Date(2026, 9, 19, 7, 0, 0));
    win.dispatch('focus');
    expect(hookValue()).toBe('2026-10-19');
    vi.setSystemTime(new Date(2026, 9, 20, 7, 0, 0));
    win.dispatch('pageshow');
    expect(hookValue()).toBe('2026-10-20');
  });

  it('unmounting clears the timer and every listener', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 10, 0, 0));
    useToday();
    const unmount = mountHook();
    expect(doc.listenerCount() + win.listenerCount()).toBe(3);
    unmount();
    expect(doc.listenerCount() + win.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(48 * HOUR);
    expect(hookValue()).toBe('2026-10-17');
  });
});
