import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';
import './Button.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'subtle';
  size?: 'md' | 'lg';
  /** Stretch to the container width. */
  full?: boolean;
  /** Optional leading icon, e.g. <Icon name="plus" size={20} />. */
  icon?: ReactNode;
  /** The underlying button, e.g. to return focus after an inline confirmation. */
  ref?: Ref<HTMLButtonElement>;
}

/** Pill button. 44px tall (md) or 52px (lg); accessible colour pairs per variant. */
export function Button({
  variant = 'primary',
  size = 'md',
  full = false,
  icon,
  className,
  type = 'button',
  children,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', `btn--${variant}`, `btn--${size}`, full && 'btn--full', className)}
      {...rest}
    >
      {icon ? (
        <span className="btn__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}
