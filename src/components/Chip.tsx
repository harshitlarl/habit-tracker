import type { ButtonHTMLAttributes } from 'react';
import type { HabitColor } from '../lib/types';
import { toneClass } from '../lib/selectors';
import { cx } from './cx';
import './Chip.css';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** When provided, the chip is a toggle (aria-pressed) and renders its selected state. */
  selected?: boolean;
  /** Habit tone: selected chips fill with --tone-soft and outline in --tone. */
  tone?: HabitColor;
  /** 'md' is a 36px pill; 'sm' is a 28px pill for eyebrow lines. Both keep a 44px hit area. */
  size?: 'md' | 'sm';
}

/** Pill-shaped button/toggle with a 44px hit area. */
export function Chip({ selected, tone, size = 'md', className, type = 'button', children, ...rest }: ChipProps) {
  return (
    <button
      type={type}
      className={cx('chip', size === 'sm' && 'chip--sm', tone && toneClass(tone), selected && 'is-selected', className)}
      data-tone={tone}
      aria-pressed={selected === undefined ? undefined : selected}
      {...rest}
    >
      {children}
    </button>
  );
}
