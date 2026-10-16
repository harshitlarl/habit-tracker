import type { HabitColor } from '../../lib/types';
import { WEEKDAY_SHORT } from '../../lib/dates';
import { toneClass } from '../../lib/selectors';
import { cx } from '../../components/cx';
import type { HeatmapData } from './progressStats';
import './Heatmap.css';

export interface HeatmapProps {
  data: HeatmapData;
  tone: HabitColor;
  /** Summary read by assistive tech; the cells themselves are presentational. */
  label: string;
}

/**
 * 12 rows (oldest at the top, the current week at the bottom) × 7 columns Mon…Sun, aligned with
 * the Week view. done → habit tone; scheduled-but-not-done → hairline outline (ember for a
 * still-open today); bonus → tone at reduced opacity; unscheduled / before createdAt / future → empty.
 * The header uses one letter per day (M T W T F S S): two letters do not fit a 16px column at the
 * standard label size, and the Monday-first order matches the Week view.
 */
export function Heatmap({ data, tone, label }: HeatmapProps) {
  return (
    <div className={cx('heat', toneClass(tone))} role="img" aria-label={label}>
      <div className="heat__head" aria-hidden="true">
        {WEEKDAY_SHORT.map((d) => (
          <span key={d} className="heat__day small-caps">
            {d.charAt(0)}
          </span>
        ))}
      </div>
      <div className="heat__grid" aria-hidden="true">
        {data.rows.map((row) =>
          row.map((cell) => (
            <span
              key={cell.key}
              className={cx('heat__cell', `is-${cell.state}`, cell.isToday && 'is-today')}
            />
          )),
        )}
      </div>
    </div>
  );
}
