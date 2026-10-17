import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { msUntilNextHour, useHour } from '../useHour';
import { fakeTarget, hookValue, mountHook, resetHook } from './fakeReact';

// TZ=America/New_York. The hook runs on a stand-in for React's hooks and the DOM (fakeReact.ts).
vi.mock('react', async () => (await import('./fakeReact')).fakeReact);

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

describe('useHour', () => {
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

  it('re-reads the hour when it mounts: rendered just before the hour turns, mounted just after', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 11, 59, 59, 995));
    useHour(); // the render
    expect(hookValue()).toBe(11);
    vi.setSystemTime(new Date(2026, 9, 17, 12, 0, 0, 20)); // React runs the passive effect a moment later
    mountHook();
    expect(hookValue()).toBe(12);
  });

  it('follows the clock hour by hour while mounted, re-reads it on focus, and stops once unmounted', () => {
    vi.setSystemTime(new Date(2026, 9, 17, 10, 30, 0));
    useHour();
    const unmount = mountHook();
    vi.advanceTimersByTime(30 * MINUTE); // 11:00:00.000; the timer keeps a 1 s margin
    expect(hookValue()).toBe(10);
    vi.advanceTimersByTime(1000);
    expect(hookValue()).toBe(11);
    vi.advanceTimersByTime(HOUR);
    expect(hookValue()).toBe(12);
    vi.setSystemTime(new Date(2026, 9, 17, 18, 5, 0)); // timers suspended in the background
    win.dispatch('focus');
    expect(hookValue()).toBe(18);
    unmount();
    expect(doc.listenerCount() + win.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * HOUR);
    expect(hookValue()).toBe(18);
  });
});
