import { useState } from 'react';
import type { Completions, DateKey, Habit } from '../../lib/types';
import {
  WEEKDAY_LONG,
  WEEKDAY_SHORT,
  addDays,
  dayNumber,
  formatLongDate,
  formatWeekday,
  isFuture,
  weekdayOf,
} from '../../lib/dates';
import { isDone, toneClass } from '../../lib/selectors';
import { completionStats, dayProgress } from '../../lib/streaks';
import { Ring } from '../../components/Ring';
import { cx } from '../../components/cx';
import { cellModel, weekScope } from './weekModel';

export interface WeekGridProps {
  /** Every tracker, archived included — feeds the per-day totals. */
  habits: Habit[];
  /** The trackers shown as rows, in store order. */
  rows: Habit[];
  completions: Completions;
  mondayKey: DateKey;
  /** Mon → Sun of the shown week. */
  keys: DateKey[];
  today: DateKey;
  /** Play the staggered entrance on rows (first paint of the view only). */
  animateRows: boolean;
  onToggle: (habitId: string, dateKey: DateKey) => void;
}

type Toggle = WeekGridProps['onToggle'];

/**
 * The ledger: a sticky day header, one row per tracker (name line + seven cells) and a totals
 * row under a double rule. Today's column is tinted ember-soft from header to footer.
 */
export function WeekGrid({ habits, rows, completions, mondayKey, keys, today, animateRows, onToggle }: WeekGridProps) {
  const todayIndex = keys.indexOf(today);
  const sundayKey = addDays(mondayKey, 6);
  // Row totals count Monday → today, or the whole week once it has passed.
  const lastCounted = mondayKey <= today ? (sundayKey < today ? sundayKey : today) : undefined;
  // Row totals are labelled with the shown week, so "this week" never describes another one.
  const scope = weekScope(mondayKey, today);

  return (
    <div className="wk-grid">
      {todayIndex >= 0 ? <div className="wk-band" style={{ '--col': todayIndex }} aria-hidden="true" /> : null}

      <div className="wk-days wk-cols">
        {keys.map((k) => {
          const wd = weekdayOf(k);
          const isToday = k === today;
          return (
            <div key={k} className={cx('wk-day', isToday && 'is-today')}>
              <span className="sr-only">{`${WEEKDAY_LONG[wd]} ${dayNumber(k)}${isToday ? ', today' : ''}`}</span>
              <span className="wk-day__name small-caps" aria-hidden="true">
                {WEEKDAY_SHORT[wd]}
              </span>
              <span className="wk-day__num" aria-hidden="true">
                {dayNumber(k)}
              </span>
            </div>
          );
        })}
      </div>

      <ul className="wk-rows">
        {rows.map((habit, index) => (
          <WeekRow
            key={habit.id}
            habit={habit}
            completions={completions}
            keys={keys}
            mondayKey={mondayKey}
            lastCounted={lastCounted}
            scope={scope}
            today={today}
            index={index}
            animate={animateRows}
            onToggle={onToggle}
          />
        ))}
      </ul>

      <div className="wk-foot wk-cols" role="list" aria-label="Done per day">
        {keys.map((k) => {
          const progress = isFuture(k, today) ? null : dayProgress(habits, completions, k);
          const perfect = progress !== null && progress.due > 0 && progress.done === progress.due;
          const when = `${formatWeekday(k)} ${formatLongDate(k)}`;
          let text = '';
          let spoken = `${when}: upcoming`;
          if (progress) {
            if (progress.due > 0) {
              text = `${progress.done}/${progress.due}`;
              spoken = `${when}: ${progress.done} of ${progress.due} done`;
            } else {
              text = '–';
              spoken = `${when}: nothing due`;
            }
          }
          return (
            <div key={k} role="listitem" className={cx('wk-foot__cell', perfect && 'is-perfect')}>
              <span className="sr-only">{spoken}</span>
              <span className="tabular" aria-hidden="true">
                {text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface WeekRowProps {
  habit: Habit;
  completions: Completions;
  keys: DateKey[];
  mondayKey: DateKey;
  /** Last day counted in the row total; undefined for weeks entirely in the future. */
  lastCounted: DateKey | undefined;
  /** The shown week relative to today, for the total's label: "this week", "last week", … */
  scope: string;
  today: DateKey;
  index: number;
  animate: boolean;
  onToggle: Toggle;
}

function WeekRow({
  habit,
  completions,
  keys,
  mondayKey,
  lastCounted,
  scope,
  today,
  index,
  animate,
  onToggle,
}: WeekRowProps) {
  const stats = lastCounted === undefined ? null : completionStats(habit, completions, mondayKey, lastCounted);

  return (
    <li className={cx('wk-row', animate && 'rise')} style={animate ? { '--i': index } : undefined}>
      <div className="wk-row__label">
        <span className={cx('wk-emoji', toneClass(habit.color))} aria-hidden="true">
          {habit.emoji}
        </span>
        <span className="wk-name truncate">{habit.name}</span>
        {habit.archivedAt ? <span className="wk-tag small-caps">Archived</span> : null}
        {stats !== null && stats.due > 0 ? (
          <span className="wk-row__count">
            <Ring
              value={stats.done / stats.due}
              size={20}
              stroke={3}
              label={`${habit.name}, ${scope}`}
              valueText={`${stats.done} of ${stats.due} done`}
            />
            <span className="tabular" aria-hidden="true">
              {`${stats.done}/${stats.due}`}
            </span>
          </span>
        ) : null}
      </div>
      <div className="wk-cells wk-cols" role="group" aria-label={habit.name}>
        {keys.map((k) => (
          <WeekCell
            key={k}
            habit={habit}
            dateKey={k}
            today={today}
            done={isDone(completions, habit.id, k)}
            onToggle={onToggle}
          />
        ))}
      </div>
    </li>
  );
}

interface WeekCellProps {
  habit: Habit;
  dateKey: DateKey;
  today: DateKey;
  done: boolean;
  onToggle: Toggle;
}

/** One day for one tracker. The whole cell (≥44px) is the tap target; the mark is 26px. */
function WeekCell({ habit, dateKey, today, done, onToggle }: WeekCellProps) {
  const [pulse, setPulse] = useState(false);
  const cell = cellModel(habit, done, dateKey, today);
  // A toggle button like Today's Check: aria-pressed carries done / not done, so VoiceOver announces the
  // change (a scheduled day's name stays the same across the tap). Disabled cells are not toggles.
  const pressed = cell.disabled ? undefined : cell.state === 'done' || cell.state === 'bonus';

  return (
    <button
      type="button"
      className={cx(
        'wk-cell',
        `wk-cell--${cell.state}`,
        toneClass(habit.color),
        cell.future && 'is-future',
        pulse && 'is-pulse',
      )}
      aria-label={cell.label}
      aria-pressed={pressed}
      disabled={cell.disabled}
      onClick={() => {
        if (cell.disabled) return;
        setPulse(true);
        onToggle(habit.id, dateKey);
      }}
      onAnimationEnd={() => setPulse(false)}
    >
      {cell.state === 'outside' ? null : (
        <span className="wk-mark" aria-hidden="true">
          <svg className="wk-mark__check" viewBox="0 0 24 24">
            <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
          </svg>
        </span>
      )}
    </button>
  );
}
