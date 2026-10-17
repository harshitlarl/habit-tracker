import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
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

/** A press on a departing sheet's backdrop must not move focus off the control the caller just focused. */
function keepFocus(e: MouseEvent): void {
  e.preventDefault();
}

/**
 * Bottom sheet rendered in a portal above the tab bar. role="dialog" + aria-modal, closes on
 * Escape, backdrop tap and the close button, locks body scroll, traps Tab focus, returns focus to
 * the opener on close, pads the bottom safe area, slides up 240ms and animates out before unmounting.
 */
export function Sheet({ open, onClose, title, children, label }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  // A mounted sheet that is no longer open is on its way out: the exit animation plays and it takes no
  // more taps. Read from `open` itself, so it holds from the very render that closes the sheet; a state
  // flag set afterwards left a few milliseconds in which a quick second tap still reached Save.
  const closing = !open;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  /** The element focused when the sheet was asked to open; focus goes back to it once the sheet has left. */
  const openerRef = useRef<HTMLElement | null>(null);
  /** The deferred "move focus into the dialog" step armed at mount; cancelled when the sheet starts closing. */
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Remember the opener the moment `open` turns true. A layout effect runs in the commit before the
  // panel mounts, so a field the form autofocuses cannot be mistaken for the opener — a passive effect
  // after mount used to capture the Name input, which is unmounted by the time focus should go back,
  // and focus landed on <body>. Focus already inside the panel (opened again while closing) is ignored.
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (panelRef.current?.contains(active)) return;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  const cancelFocusTimer = (): void => {
    if (focusTimer.current === null) return;
    clearTimeout(focusTimer.current);
    focusTimer.current = null;
  };

  // Mount on open; on close, play the exit animation then unmount.
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    // A sheet closed within 20ms of opening (Escape right after a tap) must not have the pending focus
    // step below pull focus back into a panel that is on its way out — the opener has just placed it.
    cancelFocusTimer();
    const timer = setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  // While mounted: lock scroll, handle Escape + Tab, manage focus. A layout effect, so all of it is in place
  // in the very commit that inserts the panel. As a passive effect it ran a commit (and a paint) later, and an
  // Escape pressed the moment the sheet appeared was lost: the sheet stayed open and then took focus (QA round 2).
  useLayoutEffect(() => {
    if (!mounted) return;
    const id = Symbol('sheet');
    stack.push(id);
    lockBody();

    // Move focus into the dialog, unless a field inside it (e.g. an autoFocus input) already has it.
    focusTimer.current = setTimeout(() => {
      focusTimer.current = null;
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
      cancelFocusTimer();
      document.removeEventListener('keydown', onKeyDown);
      const i = stack.indexOf(id);
      if (i >= 0) stack.splice(i, 1);
      unlockBody();
      openerRef.current?.focus({ preventScroll: true });
    };
  }, [mounted]);

  if (!mounted) return null;

  return createPortal(
    <div className={cx('sheet', closing && 'is-closing')} data-state={closing ? 'closing' : 'open'}>
      {/* While the sheet slides out, its panel lets taps through (Sheet.css) and the backdrop takes them
          without effect: a quick second tap on Save neither submits again nor pulls focus into a panel
          about to unmount, which would leave it on <body>. */}
      <div
        className="sheet__backdrop"
        onMouseDown={closing ? keepFocus : undefined}
        onClick={closing ? undefined : () => onCloseRef.current()}
        aria-hidden="true"
      />
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
