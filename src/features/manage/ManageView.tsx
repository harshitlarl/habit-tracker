import { useMemo, useRef, useState, type MouseEvent } from 'react';
import useStore from '../../lib/store';
import { activeHabits, toneClass } from '../../lib/selectors';
import { prefersReducedMotion } from '../../lib/useReducedMotion';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { HabitEditor } from './HabitEditor';
import { SettingsSection } from './SettingsSection';
import { daysSummary } from './daysSummary';
import './ManageView.css';

interface EditorState {
  open: boolean;
  habitId?: string;
}

export function ManageView() {
  const habits = useStore((s) => s.habits);
  const reorderHabits = useStore((s) => s.reorderHabits);
  const active = useMemo(() => activeHabits(habits), [habits]);
  const archivedCount = habits.length - active.length;

  const [editor, setEditor] = useState<EditorState>({ open: false });
  const [announcement, setAnnouncement] = useState('');
  const settingsTitleRef = useRef<HTMLHeadingElement>(null);

  const openNew = (): void => setEditor({ open: true });
  const openEdit = (habitId: string): void => setEditor({ open: true, habitId });
  const closeEditor = (): void => setEditor((prev) => ({ ...prev, open: false }));

  /** The gear: Settings sits below the tracker list, so bring its heading into view and focus it. */
  function goToSettings(): void {
    const title = settingsTitleRef.current;
    if (!title) return;
    title.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    title.focus({ preventScroll: true });
  }

  function move(index: number, direction: -1 | 1, e: MouseEvent<HTMLButtonElement>): void {
    const target = index + direction;
    const ids = active.map((h) => h.id);
    const a = ids[index];
    const b = ids[target];
    if (a === undefined || b === undefined) return;
    ids[index] = b;
    ids[target] = a;
    reorderHabits(ids);

    const moved = active[index];
    if (moved) {
      setAnnouncement(`${moved.name} moved ${direction < 0 ? 'up' : 'down'}, now ${target + 1} of ${ids.length}.`);
    }
    // When the row reaches an end this button becomes disabled; keep focus on its sibling.
    const button = e.currentTarget;
    requestAnimationFrame(() => {
      if (!button.disabled) return;
      button.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
  }

  const subtitle =
    active.length === 0 && archivedCount === 0
      ? null
      : `${active.length} active${archivedCount > 0 ? ` · ${archivedCount} archived` : ''}`;

  return (
    <section className="view" aria-labelledby="manage-title">
      <header className="view-header">
        <div>
          <h1 id="manage-title" className="display display--xl">
            Trackers
          </h1>
          {subtitle ? <p className="small-caps manage__sub">{subtitle}</p> : null}
        </div>
        <button type="button" className="manage__settings" aria-label="Settings" onClick={goToSettings}>
          <Icon name="gear" size={22} />
        </button>
      </header>

      {active.length === 0 ? (
        <EmptyState
          title="Nothing to track yet"
          body="Add the first thing you want to keep doing. Gym, a walk, two pages of a book: small and specific works best."
          action={
            <Button size="lg" icon={<Icon name="plus" size={20} />} onClick={openNew}>
              Add your first tracker
            </Button>
          }
        />
      ) : (
        <>
          <ul className="tracker-list card" aria-label="Your trackers">
            {active.map((h, i) => (
              <li key={h.id} className="manage-row rise" style={{ '--i': i }}>
                <button type="button" className="manage-row__main" onClick={() => openEdit(h.id)}>
                  <span className={cx('manage-row__emoji', toneClass(h.color))} aria-hidden="true">
                    {h.emoji}
                  </span>
                  <span className="manage-row__text">
                    <span className="manage-row__name truncate">{h.name}</span>
                    <span className="manage-row__meta">
                      <span className="small-caps small-caps--12 manage-row__days">{daysSummary(h.days)}</span>
                      {h.note ? <span className="manage-row__note truncate">· {h.note}</span> : null}
                    </span>
                  </span>
                  <span className="sr-only">, edit</span>
                  <Icon name="chevronRight" size={18} className="manage-row__chevron" />
                </button>
                <div className="manage-row__reorder">
                  <button
                    type="button"
                    className="manage-row__move"
                    aria-label={`Move ${h.name} up`}
                    disabled={i === 0}
                    onClick={(e) => move(i, -1, e)}
                  >
                    <Icon name="up" size={20} />
                  </button>
                  <button
                    type="button"
                    className="manage-row__move"
                    aria-label={`Move ${h.name} down`}
                    disabled={i === active.length - 1}
                    onClick={(e) => move(i, 1, e)}
                  >
                    <Icon name="down" size={20} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="sr-only" role="status">
            {announcement}
          </p>
          <div className="manage__add">
            <Button size="lg" full icon={<Icon name="plus" size={20} />} onClick={openNew}>
              Add tracker
            </Button>
          </div>
        </>
      )}

      <SettingsSection titleRef={settingsTitleRef} />

      <HabitEditor open={editor.open} habitId={editor.habitId} onClose={closeEditor} />
    </section>
  );
}
