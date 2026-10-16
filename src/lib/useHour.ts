import { useEffect, useState } from 'react';

/** Milliseconds from `now` until the next full local hour. */
export function msUntilNextHour(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
  return Math.max(0, next.getTime() - now.getTime());
}

/**
 * The current local hour (0–23). Re-evaluated at every full hour (timer to the next one) and
 * whenever the page becomes visible or focused again (iOS suspends timers in the background), so
 * copy that depends on the time of day — morning / afternoon / evening — follows the clock while
 * the view stays open.
 */
export function useHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function arm(): void {
      if (timer !== undefined) clearTimeout(timer);
      // +1s margin so we land safely inside the new hour.
      timer = setTimeout(refresh, msUntilNextHour() + 1000);
    }

    function refresh(): void {
      const h = new Date().getHours();
      setHour((prev) => (prev === h ? prev : h));
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

  return hour;
}
