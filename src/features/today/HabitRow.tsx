import { useRef, type MouseEvent } from 'react';
import type { Habit } from '../../lib/types';
import { toneClass } from '../../lib/selectors';
import { Check } from '../../components/Check';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import './HabitRow.css';

export interface HabitRowProps {
  habit: Habit;
  done: boolean;
  /** Current streak in days; the chip shows from 2 up. */
  streak: number;
  /** Not scheduled today, so a completion is a bonus. */
  bonus?: boolean;
  /** Position in its list, for the staggered rise-in. */
  index: number;
  onToggle: () => void;
}

/**
 * One tracker line: tinted emoji disc, name, note, streak chip and the big Check. The row is a
 * hit extender for the Check — a tap anywhere on it clicks the real button, so the toggle, its
 * accessible label and its spring animation all live in one place and the row never reorders.
 */
export function HabitRow({ habit, done, streak, bonus = false, index, onToggle }: HabitRowProps) {
  const checkRef = useRef<HTMLButtonElement>(null);

  function onRowClick(e: MouseEvent<HTMLLIElement>): void {
    // Clicks on the Check itself (direct or delegated) already toggle; do not double up.
    if (e.target instanceof Element && e.target.closest('button')) return;
    checkRef.current?.click();
  }

  const emoji = habit.emoji.trim();
  const initial = habit.name.trim().charAt(0).toUpperCase();
  const showBonus = bonus && done;
  const hasMeta = Boolean(habit.note) || showBonus;

  return (
    <li
      className={cx('habit-row', 'rise', toneClass(habit.color), done && 'is-done')}
      style={{ '--i': index }}
      onClick={onRowClick}
    >
      <span className={cx('habit-row__emoji', !emoji && 'habit-row__emoji--initial')} aria-hidden="true">
        {emoji || initial}
      </span>

      <div className="habit-row__text">
        <span className="habit-row__name">{habit.name}</span>
        {hasMeta ? (
          <span className="habit-row__meta">
            {habit.note}
            {/* Only the dot is decoration: the spaces stay in the text, so "2 hours" and "Bonus" read apart. */}
            {habit.note && showBonus ? <>{' '}<span aria-hidden="true">·</span>{' '}</> : null}
            {showBonus ? <span className="habit-row__bonus">Bonus</span> : null}
          </span>
        ) : null}
      </div>

      {streak >= 2 ? (
        <span className="habit-row__streak tabular">
          <Icon name="flame" size={14} />
          {streak}
          <span className="sr-only"> day streak</span>
        </span>
      ) : null}

      <span className="habit-row__check">
        {/* A constant name: aria-pressed carries the state, so VoiceOver never hears "not done, selected". */}
        <Check
          ref={checkRef}
          checked={done}
          onChange={onToggle}
          tone={habit.color}
          size={52}
          label={`Mark ${habit.name} done`}
        />
      </span>
    </li>
  );
}
