import type { ReactNode } from 'react';
import { cx } from './cx';
import './Ring.css';

export interface RingProps {
  /** 0..1 */
  value: number;
  size?: number;
  stroke?: number;
  /** Centre content, e.g. "3/5". */
  children?: ReactNode;
  /** Accessible name for the progressbar, e.g. "Today's progress". */
  label?: string;
  className?: string;
}

/** SVG progress ring: ember arc on a --line track; the arc animates on change. */
export function Ring({ value, size = 56, stroke = 5, children, label, className }: RingProps) {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const half = size / 2;

  return (
    <div
      className={cx('ring', className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      aria-label={label}
    >
      <svg className="ring__svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring__track" cx={half} cy={half} r={r} strokeWidth={stroke} />
        <circle
          className="ring__value"
          cx={half}
          cy={half}
          r={r}
          strokeWidth={stroke}
          strokeDasharray={c}
          style={{ strokeDashoffset: c * (1 - v) }}
          transform={`rotate(-90 ${half} ${half})`}
        />
      </svg>
      {children !== undefined && children !== null ? <div className="ring__label tabular">{children}</div> : null}
    </div>
  );
}
