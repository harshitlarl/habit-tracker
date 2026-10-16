import { useEffect, useState } from 'react';
import type { DateKey } from './types';
import { todayKey } from './dates';

/** Milliseconds from `now` until the next local midnight. */
export function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(0, next.getTime() - now.getTime());
}

/**
 * The current local DateKey. Re-evaluated at local midnight (timer to the next midnight),
 * and whenever the page becomes visible or focused again (iOS suspends timers in the background).
 */
export function useToday(): DateKey {
  const [today, setToday] = useState<DateKey>(() => todayKey());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function arm(): void {
      if (timer !== undefined) clearTimeout(timer);
      // +1s margin so we land safely on the new day.
      timer = setTimeout(refresh, msUntilNextMidnight() + 1000);
    }

    function refresh(): void {
      const k = todayKey();
      setToday((prev) => (prev === k ? prev : k));
      arm();
    }

    function onVisibility(): void {
      if (document.visibilityState === 'visible') refresh();
    }

    arm();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
    };
  }, []);

  return today;
}
