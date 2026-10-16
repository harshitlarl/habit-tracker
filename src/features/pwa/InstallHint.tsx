import { useEffect, useRef, useState } from 'react';
import useStore from '../../lib/store';
import { isIOS, isStandalone } from '../../lib/platform';
import { prefersReducedMotion } from '../../lib/useReducedMotion';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import './InstallHint.css';

const EXIT_MS = 200;

/**
 * Slim "Add to Home Screen" banner, rendered by App directly above the tab bar. Shows only in
 * iOS Safari (never once installed) until dismissed; the dismissal persists in settings.
 */
export function InstallHint() {
  const dismissed = useStore((s) => s.settings.installHintDismissed);
  const dismissInstallHint = useStore((s) => s.dismissInstallHint);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  if (dismissed || !isIOS() || isStandalone()) return null;

  const close = (): void => {
    if (closing) return;
    setClosing(true);
    // Let the banner collapse before the store change removes it for good.
    timer.current = setTimeout(dismissInstallHint, prefersReducedMotion() ? 0 : EXIT_MS);
  };

  return (
    <aside className={cx('install-hint', closing && 'is-closing')} aria-label="Install Momentum">
      <div className="install-hint__inner">
        <div className="install-hint__row">
          <p className="install-hint__text">
            <strong>Install Momentum:</strong> tap{' '}
            <span className="install-hint__share">
              <Icon name="share" size={16} />
              Share
            </span>
            , then Add to Home Screen
          </p>
          <button
            type="button"
            className="install-hint__close"
            onClick={close}
            aria-label="Dismiss install hint"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
}
