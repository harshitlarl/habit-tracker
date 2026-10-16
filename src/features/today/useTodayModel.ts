import { useMemo } from 'react';
import useStore from '../../lib/store';
import type { DateKey, Habit } from '../../lib/types';
import { addDays } from '../../lib/dates';
import { activeHabits, dueHabits, isDone } from '../../lib/selectors';
import { currentStreak, perfectDayStreak } from '../../lib/streaks';
import { getMotivation, type Motivation } from '../../lib/motivation';
import { useHour } from '../../lib/useHour';
import { useToday } from '../../lib/useToday';

export interface TodayModel {
  today: DateKey;
  /** Active trackers in `order`. */
  active: Habit[];
  /** Active trackers scheduled today, in `order`. */
  due: Habit[];
  /** Active trackers not scheduled today; completing one is a bonus. */
  unscheduled: Habit[];
  /** Ids of active trackers completed today, scheduled or not. */
  doneIds: ReadonlySet<string>;
  /** Due trackers completed today (bonus completions excluded). */
  doneCount: number;
  /** Something was due and all of it is done. */
  allDone: boolean;
  /** Current streak per active tracker id. */
  streaks: ReadonlyMap<string, number>;
  motivation: Motivation;
}

/** Everything the Today view derives from the store for the current local day. */
export function useTodayModel(): TodayModel {
  const habits = useStore((s) => s.habits);
  const completions = useStore((s) => s.completions);
  const today = useToday();
  // Only the morning / afternoon / evening bucket influences the message, and the pick is a
  // hash of (day, state), so keying on the hour keeps the line stable within a state. useHour
  // ticks at each full hour, so the line follows the clock while the view stays open.
  const hour = useHour();

  const active = useMemo(() => activeHabits(habits), [habits]);

  const { due, unscheduled } = useMemo(() => {
    const dueToday = dueHabits(active, today);
    const dueIds = new Set(dueToday.map((h) => h.id));
    return { due: dueToday, unscheduled: active.filter((h) => !dueIds.has(h.id)) };
  }, [active, today]);

  const doneIds = useMemo(
    () => new Set(active.filter((h) => isDone(completions, h.id, today)).map((h) => h.id)),
    [active, completions, today],
  );

  const doneCount = useMemo(() => due.filter((h) => doneIds.has(h.id)).length, [due, doneIds]);

  const streaks = useMemo(
    () => new Map(active.map((h) => [h.id, currentStreak(h, completions, today)] as const)),
    [active, completions, today],
  );

  /** The active tracker with the longest current streak; null below 2 days. Ties keep `order`. */
  const bestCurrentStreak = useMemo(() => {
    let best: { habitName: string; days: number } | null = null;
    for (const h of active) {
      const days = streaks.get(h.id) ?? 0;
      if (days >= 2 && (best === null || days > best.days)) best = { habitName: h.name, days };
    }
    return best;
  }, [active, streaks]);

  // All habits, not just active ones: a tracker archived today was still due yesterday
  // (isScheduled handles the archivedAt bound), matching perfectDayStreak's view of the past.
  const missedYesterday = useMemo(() => {
    const yesterday = addDays(today, -1);
    return dueHabits(habits, yesterday).some((h) => !isDone(completions, h.id, yesterday));
  }, [habits, completions, today]);

  const perfect = useMemo(() => perfectDayStreak(habits, completions, today), [habits, completions, today]);

  const motivation = useMemo(
    () =>
      getMotivation({
        dateKey: today,
        hour,
        habitsCount: active.length,
        dueCount: due.length,
        doneCount,
        bestCurrentStreak,
        perfectDayStreak: perfect,
        missedYesterday,
      }),
    [today, hour, active.length, due.length, doneCount, bestCurrentStreak, perfect, missedYesterday],
  );

  return {
    today,
    active,
    due,
    unscheduled,
    doneIds,
    doneCount,
    allDone: due.length > 0 && doneCount === due.length,
    streaks,
    motivation,
  };
}
