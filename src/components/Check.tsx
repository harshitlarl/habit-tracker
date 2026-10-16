import { useState, type Ref } from 'react';
import type { HabitColor } from '../lib/types';
import { toneClass } from '../lib/selectors';
import { cx } from './cx';
import './Check.css';

export interface CheckProps {
  checked: boolean;
  onChange: () => void;
  tone: HabitColor;
  /** Visual diameter in px (default 44). The hit area is always at least 44px. */
  size?: number;
  disabled?: boolean;
  /** Accessible name, e.g. "Mark Gym done". */
  label: string;
  className?: string;
  /** The underlying button, e.g. so a row can forward its own tap to it. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Round toggle button. Filled with the habit tone when checked, with a spring scale and a
 * stroke-drawn checkmark on toggle. Uses aria-pressed; the spring only plays on user toggles.
 */
export function Check({ checked, onChange, tone, size = 44, disabled = false, label, className, ref }: CheckProps) {
  const [pulse, setPulse] = useState(false);

  return (
    <button
      ref={ref}
      type="button"
      className={cx('check', toneClass(tone), checked && 'is-checked', pulse && 'is-pulse', className)}
      style={{ '--check-size': `${size}px` }}
      aria-pressed={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        setPulse(true);
        onChange();
      }}
      onAnimationEnd={() => setPulse(false)}
    >
      <span className="check__ring" aria-hidden="true">
        <svg className="check__mark" viewBox="0 0 24 24">
          <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
        </svg>
      </span>
    </button>
  );
}
