import { memo, useId, useMemo } from 'react';
import type { DateKey, Habit } from '../../lib/types';
import { addDays } from '../../lib/dates';
import { toneClass } from '../../lib/selectors';
import { bestStreak, completionStats, currentStreak } from '../../lib/streaks';
import { cx } from '../../components/cx';
import { Heatmap } from './Heatmap';
import { Stat } from './Stat';
import { HEATMAP_WEEKS, buildHeatmap, percent, plural, sliceCompletions, type DateSet } from './progressStats';
import './TrackerCard.css';

export interface TrackerCardProps {
  habit: Habit;
  /** `completions[habit.id]` — passed as a slice so other trackers' toggles do not re-render this card. */
  dates: DateSet;
  today: DateKey;
  /** Shared 12-week grid from `recentWeeks(today)`. */
  weeks: DateKey[][];
  /** Stagger index for the entrance animation. */
  index: number;
}

/** One active tracker: emoji + name, three numerals and the 12-week heatmap. Memoised per habit. */
export const TrackerCard = memo(function TrackerCard({ habit, dates, today, weeks, index }: TrackerCardProps) {
  const titleId = useId();

  const stats = useMemo(() => {
    const completions = sliceCompletions(habit.id, dates);
    return {
      streak: currentStreak(habit, completions, today),
      best: bestStreak(habit, completions, today),
      month: completionStats(habit, completions, addDays(today, -29), today),
      heat: buildHeatmap(habit, dates, weeks, today),
    };
  }, [habit, dates, today, weeks]);

  const { streak, best, month, heat } = stats;
  const heatLabel =
    heat.due === 0
      ? `${habit.name}, last ${HEATMAP_WEEKS} weeks: nothing scheduled yet.`
      : `${habit.name}, last ${HEATMAP_WEEKS} weeks: ${heat.done} of ${heat.due} scheduled ${plural(heat.due, 'day')} done` +
        (heat.bonus ? `, plus ${heat.bonus} bonus.` : '.');

  return (
    <article className="tracker rise" style={{ '--i': index }} aria-labelledby={titleId}>
      <header className="tracker__head">
        <span className={cx('tracker__emoji', toneClass(habit.color))} aria-hidden="true">
          {habit.emoji}
        </span>
        <div className="tracker__title">
          <h3 id={titleId} className="display display--md truncate">
            {habit.name}
          </h3>
          {habit.note ? <p className="tracker__note muted truncate">{habit.note}</p> : null}
        </div>
      </header>

      <div className="tracker__body">
        <div className="tracker__stats">
          <Stat value={streak} label="Current streak" sub={plural(streak, 'day')} />
          <Stat value={best} label="Best streak" sub={plural(best, 'day')} />
          <Stat
            value={month.due ? percent(month.rate) : '–'}
            unit={month.due ? '%' : undefined}
            label="Last 30 days"
            sub={month.due ? `${month.done} of ${month.due}` : 'Nothing due yet'}
          />
        </div>
        <Heatmap data={heat} tone={habit.color} label={heatLabel} />
      </div>
    </article>
  );
});
