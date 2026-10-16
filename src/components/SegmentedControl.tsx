import { useRef, type KeyboardEvent } from 'react';
import { cx } from './cx';
import './SegmentedControl.css';

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible group name, e.g. "Theme". */
  label: string;
  className?: string;
}

/** Radio-group style control with a sliding thumb; arrow keys move the selection. */
export function SegmentedControl({ options, value, onChange, label, className }: SegmentedControlProps) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    let dir = 0;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') dir = 1;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') dir = -1;
    else if (e.key === 'Home') dir = -index;
    else if (e.key === 'End') dir = options.length - 1 - index;
    if (dir === 0 || options.length === 0) return;
    e.preventDefault();
    const nextIndex = (index + dir + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    buttons.current[nextIndex]?.focus();
  }

  return (
    <div
      className={cx('seg', className)}
      role="radiogroup"
      aria-label={label}
      style={{ '--count': options.length, '--index': index }}
      onKeyDown={onKeyDown}
    >
      <span className="seg__thumb" aria-hidden="true" />
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={cx('seg__option', selected && 'is-selected')}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
