import type { ReactNode } from 'react';
import { cx } from '../../components/cx';
import './Stat.css';

export interface StatProps {
  /** The numeral (or an em dash when there is nothing to show). */
  value: ReactNode;
  /** Trailing unit set smaller, e.g. "%". */
  unit?: string;
  label: string;
  /** Secondary line under the label, e.g. "18 of 21". */
  sub?: string;
  size?: 'lg' | 'md';
  className?: string;
}

/** A big Fraunces numeral with a small-caps label beneath — the typographic unit of this view. */
export function Stat({ value, unit, label, sub, size = 'md', className }: StatProps) {
  return (
    <div className={cx('stat', `stat--${size}`, className)}>
      <div className="stat__value display tabular">
        {value}
        {unit ? <span className="stat__unit">{unit}</span> : null}
      </div>
      <div className="stat__label small-caps">{label}</div>
      {sub ? <div className="stat__sub tabular">{sub}</div> : null}
    </div>
  );
}
