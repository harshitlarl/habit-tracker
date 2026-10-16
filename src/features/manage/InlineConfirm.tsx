import { useEffect, useId, useRef, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import './InlineConfirm.css';

export interface InlineConfirmProps {
  /** The question, e.g. "Delete Gym and its history?" */
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  /** 'danger' for destructive actions, 'primary' for replace-style confirmations. */
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Two-step confirmation rendered in place (never window.confirm). Takes focus when it appears
 * so assistive tech reads the question; the caller returns focus to its trigger on cancel.
 */
export function InlineConfirm({ title, body, confirmLabel, tone = 'danger', onConfirm, onCancel }: InlineConfirmProps) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div ref={ref} className="confirm" role="group" aria-labelledby={id} tabIndex={-1}>
      <p id={id} className="confirm__title display display--md">
        {title}
      </p>
      {body ? <p className="confirm__body">{body}</p> : null}
      <div className="confirm__actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={tone} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
