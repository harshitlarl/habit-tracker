import { useEffect, useRef, useState, type RefObject } from 'react';
import useStore from './lib/store';
import { Icon, type IconName } from './components/Icon';
import { cx } from './components/cx';
import { TodayView } from './features/today/TodayView';
import { WeekView } from './features/week/WeekView';
import { ProgressView } from './features/progress/ProgressView';
import { ManageView } from './features/manage/ManageView';
import { InstallHint } from './features/pwa/InstallHint';
import './App.css';

export type View = 'today' | 'week' | 'progress' | 'manage';

const TABS: ReadonlyArray<{ id: View; label: string; icon: IconName }> = [
  { id: 'today', label: 'Today', icon: 'sun' },
  { id: 'week', label: 'Week', icon: 'grid' },
  { id: 'progress', label: 'Progress', icon: 'chart' },
  { id: 'manage', label: 'Trackers', icon: 'list' },
];

/**
 * Applies settings.theme to <html data-theme>. 'system' follows prefers-color-scheme live.
 * Keeps <meta name="theme-color"> in sync with the resolved --bg so the iOS status bar matches.
 */
function useTheme(): void {
  const theme = useStore((s) => s.settings.theme);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = (): void => {
      const resolved: 'light' | 'dark' = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      root.dataset.theme = resolved;
      // The resolved --bg token (tokens.css) is the source of truth for the browser chrome colour.
      const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
      if (!bg) return;
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
        meta.removeAttribute('media');
        meta.setAttribute('content', bg);
      }
    };

    apply();
    if (theme !== 'system') return;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

/** Publishes the fixed bottom stack's height as --bottom-stack-h so content can clear it. */
function useBottomStackHeight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const update = (): void => {
      root.style.setProperty('--bottom-stack-h', `${Math.round(el.getBoundingClientRect().height)}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--bottom-stack-h');
    };
  }, [ref]);
}

export default function App() {
  const [view, setView] = useState<View>('today');
  const mainRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useTheme();
  useBottomStackHeight(bottomRef);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [view]);

  return (
    <div className="app">
      <main ref={mainRef} className="app__main" id="main">
        <div key={view} className="app__content fade-in">
          {view === 'today' && <TodayView />}
          {view === 'week' && <WeekView />}
          {view === 'progress' && <ProgressView />}
          {view === 'manage' && <ManageView />}
        </div>
      </main>

      <div ref={bottomRef} className="app__bottom">
        <InstallHint />
        <nav className="tabbar" aria-label="Sections">
          <div className="tabbar__inner">
            {TABS.map((tab) => {
              const active = tab.id === view;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={cx('tabbar__item', active && 'is-active')}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setView(tab.id)}
                >
                  <Icon name={tab.icon} size={24} />
                  <span className="tabbar__label small-caps">{tab.label}</span>
                  <span className="tabbar__dot" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </nav>
      </div>
    </div>
  );
}
