import type { ReactNode } from 'react';
import { cx } from './cx';
import './EmptyState.css';

export interface EmptyStateProps {
  title: string;
  body: string;
  action?: ReactNode;
  className?: string;
}

/** Warm empty state: ember ornament, display title, muted body, optional action. */
export function EmptyState({ title, body, action, className }: EmptyStateProps) {
  return (
    <section className={cx('empty', className)}>
      <span className="empty__ornament" aria-hidden="true" />
      <h2 className="display display--lg empty__title">{title}</h2>
      <p className="empty__body">{body}</p>
      {action ? <div className="empty__action">{action}</div> : null}
    </section>
  );
}
