import { useEffect, useState } from 'react';
import type { DateKey } from '../../lib/types';

/* Module-level so the record survives tab switches (the view remounts on every switch). */
const celebratedDays = new Set<DateKey>();
let observedOnce = false;

/**
 * The `fire` flag for the Confetti: true right after every due tracker becomes done, once per
 * day per session, false otherwise so it can re-arm the next day. A day that is already complete
 * when the view first appears in this session is recorded without a burst, so merely re-opening
 * the app does not shower confetti.
 */
export function useCelebration(allDone: boolean, today: DateKey): boolean {
  const [fire, setFire] = useState(false);

  useEffect(() => {
    if (!observedOnce) {
      observedOnce = true;
      if (allDone) celebratedDays.add(today);
    }
    if (allDone && !celebratedDays.has(today)) {
      celebratedDays.add(today);
      setFire(true);
    } else {
      setFire(false);
    }
  }, [allDone, today]);

  return fire;
}
