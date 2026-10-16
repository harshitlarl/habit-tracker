import type { WeekRate } from '../../lib/streaks';
import { dayNumber } from '../../lib/dates';
import { cx } from '../../components/cx';
import { formatMonday, monthShort, percent } from './progressStats';
import './WeeklyBars.css';

export interface WeeklyBarsProps {
  /** Oldest → newest, the current week last. */
  rates: WeekRate[];
}

function describe(rates: WeekRate[]): string {
  if (rates.length === 0) return 'No weeks to show yet.';
  const last = rates.length - 1;
  const parts = rates.map((w, i) => {
    const label = i === last ? `${formatMonday(w.mondayKey)} (this week)` : formatMonday(w.mondayKey);
    return w.due === 0 ? `${label}: nothing due` : `${label}: ${percent(w.rate)}%, ${w.done} of ${w.due}`;
  });
  return `Completion rate by week, oldest first. ${parts.join('; ')}.`;
}

/** Eight ember columns on a hairline baseline, labelled by each week's Monday. Plain divs, no library. */
export function WeeklyBars({ rates }: WeeklyBarsProps) {
  const last = rates.length - 1;
  return (
    <div className="bars" role="img" aria-label={describe(rates)}>
      <div className="bars__tracks" aria-hidden="true">
        {rates.map((w, i) => (
          <div
            key={w.mondayKey}
            className={cx('bars__col', i === last && 'is-current', w.due === 0 && 'is-empty')}
            style={{ '--i': i, '--rate': w.due ? w.rate : 0 }}
          >
            {w.due > 0 && w.done > 0 ? <div className="bars__bar" /> : null}
            <span className="bars__value tabular">{w.due === 0 ? '–' : percent(w.rate)}</span>
          </div>
        ))}
      </div>
      <div className="bars__axis" aria-hidden="true">
        {rates.map((w, i) => (
          <div key={w.mondayKey} className={cx('bars__tick', i === last && 'is-current')}>
            <span className="bars__day tabular">{dayNumber(w.mondayKey)}</span>
            <span className="bars__month small-caps">{monthShort(w.mondayKey)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
