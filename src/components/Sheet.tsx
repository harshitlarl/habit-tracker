import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { prefersReducedMotion } from '../lib/useReducedMotion';
import { cx } from './cx';
import './Sheet.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Accessible name when there is no title. */
  label?: string;
}

const EXIT_MS = 240;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* Body scroll lock shared by all mounted sheets. */
let lockCount = 0;
let savedOverflow = '';
function lockBody(): void {
  if (lockCount === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.dataset.sheetOpen = '';
  }
  lockCount += 1;
}
function unlockBody(): void {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0) {
    document.body.style.overflow = savedOverflow;
    delete document.documentElement.dataset.sheetOpen;
  }
}

/* Only the top-most sheet reacts to Escape. */
const stack: symbol[] = [];

/**
 * Bottom sheet rendered in a portal above the tab bar. role="dialog" + aria-modal, closes on
 * Escape, backdrop tap and the close button, locks body scroll, traps Tab focus, restores focus
 * on close, pads the bottom safe area, slides up 240ms and animates out before unmounting.
 */
export function Sheet({ open, onClose, title, children, label }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Mount on open; on close, play the exit animation then unmount.
  useEffect(() => {
    if (open) {
      setClosing(false);
      setMounted(true);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(
      () => {
        setMounted(false);
        setClosing(false);
      },
      prefersReducedMotion() ? 0 : EXIT_MS,
    );
    return () => clearTimeout(timer);
  }, [open, mounted]);

  // While mounted: lock scroll, handle Escape + Tab, manage focus.
  useEffect(() => {
    if (!mounted) return;
    const id = Symbol('sheet');
    stack.push(id);
    lockBody();
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Move focus into the dialog, unless a field inside it (e.g. an autoFocus input) already has it.
    const focusTimer = setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      panel.focus({ preventScroll: true });
    }, 20);

    function onKeyDown(e: KeyboardEvent): void {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      unlockBody();
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div className={cx('sheet', closing && 'is-closing')} data-state={closing ? 'closing' : 'open'}>
      <div className="sheet__backdrop" onClick={() => onCloseRef.current()} aria-hidden="true" />
      <div
        ref={panelRef}
        className="sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : (label ?? 'Dialog')}
        tabIndex={-1}
      >
        <div className="sheet__top">
          <div className="sheet__handle" aria-hidden="true" />
          <div className="sheet__header">
            {title ? (
              <h2 id={titleId} className="display display--md sheet__title">
                {title}
              </h2>
            ) : (
              <span />
            )}
            <button type="button" className="sheet__close" onClick={() => onCloseRef.current()} aria-label="Close">
              <Icon name="close" size={20} />
            </button>
          </div>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
