import { useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import useStore from '../../lib/store';
import type { Habit } from '../../lib/types';
import { formatLongDate, formatWeekday } from '../../lib/dates';
import { habitColorVar } from '../../lib/selectors';
import type { Motivation } from '../../lib/motivation';
import { Button } from '../../components/Button';
import { Confetti } from '../../components/Confetti';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { Ring } from '../../components/Ring';
import { cx } from '../../components/cx';
import { HabitEditor } from '../manage/HabitEditor';
import { HabitRow } from './HabitRow';
import { TaskSection } from './TaskSection';
import { useCelebration } from './useCelebration';
import { useTodayModel } from './useTodayModel';
import './TodayView.css';

/** Italic serif pull-quote. Keyed on the title so a state change cross-fades the line. */
function MotivationLine({ motivation }: { motivation: Motivation }) {
  return (
    <div key={motivation.title} className="today__motivation fade-in" data-tone={motivation.tone}>
      <p className="quote">{motivation.title}</p>
      {motivation.body ? <p className="today__motivation-body">{motivation.body}</p> : null}
    </div>
  );
}

function dueStatus(dueCount: number, remaining: number): string {
  if (dueCount === 0) return 'Rest day';
  if (remaining === 0) return 'All done';
  return `${remaining} left`;
}

/* The view remounts on every tab switch; remember the disclosure's state for the session, as Progress
   does for "Archived". Null until the user has toggled it, so the per-day default applies until then
   (and keeps following the day while the view stays open: a rest day reached at midnight opens it). */
let rememberedOpen: boolean | null = null;

interface UnscheduledSectionProps {
  habits: Habit[];
  doneIds: ReadonlySet<string>;
  streaks: ReadonlyMap<string, number>;
  /**
   * Start expanded: on a rest day nothing else competes for attention, and a tracker just created for
   * other days must not vanish into a collapsed row. The user's toggle wins afterwards.
   */
  defaultOpen: boolean;
  onToggle: (habit: Habit) => void;
}

/** "Not scheduled today": collapsed by default (open on a rest day); every tracker still checkable as a bonus. */
function UnscheduledSection({ habits, doneIds, streaks, defaultOpen, onToggle }: UnscheduledSectionProps) {
  const [chosen, setChosen] = useState<boolean | null>(rememberedOpen);
  const open = chosen ?? defaultOpen;
  const listId = useId();

  function toggle(): void {
    rememberedOpen = !open;
    setChosen(!open);
  }

  return (
    <section className="today__section">
      <h2 className="today__section-head">
        <button
          type="button"
          className="today__toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={toggle}
        >
          {/* Spoken as "Not scheduled today, 2 trackers": the hidden spans keep label and count apart. */}
          <span className="small-caps small-caps--12">Not scheduled today</span>
          <span className="sr-only">, </span>
          <span className="small-caps small-caps--12 tabular today__toggle-count">{habits.length}</span>
          <span className="sr-only"> {habits.length === 1 ? 'tracker' : 'trackers'}</span>
          <Icon name="chevronRight" size={18} className="today__chevron" />
        </button>
      </h2>
      {open ? (
        <ul id={listId} className="today__list">
          {habits.map((h, i) => (
            <HabitRow
              key={h.id}
              habit={h}
              done={doneIds.has(h.id)}
              streak={streaks.get(h.id) ?? 0}
              bonus
              index={i}
              onToggle={() => onToggle(h)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function TodayView() {
  const { today, active, due, unscheduled, doneIds, doneCount, allDone, streaks, motivation } = useTodayModel();
  const toggleCompletion = useStore((s) => s.toggleCompletion);
  const [editorOpen, setEditorOpen] = useState(false);
  /** The control that opened the tracker sheet; focus goes back to it when the sheet closes. */
  const editorTriggerRef = useRef<HTMLElement | null>(null);
  const addTrackerRef = useRef<HTMLButtonElement>(null);
  const dueHeadingId = useId();

  const fire = useCelebration(allDone, today);
  const confettiColors = useMemo(() => [...new Set(due.map((h) => habitColorVar(h.color)))], [due]);

  const toggle = (habit: Habit): void => toggleCompletion(habit.id, today);
  const openEditor = (e: MouseEvent<HTMLButtonElement>): void => {
    editorTriggerRef.current = e.currentTarget;
    setEditorOpen(true);
  };
  const closeEditor = (): void => setEditorOpen(false);

  // After the commit that closed the tracker sheet, focus returns to the button that opened it — or,
  // when that was the empty state's "Add your first tracker" (gone once the first tracker is saved),
  // to the header's "Add tracker" that took its place. WebKit does not focus a tapped button, so the
  // Sheet's own restore has nothing to return to on the phone; the Tasks section does the same (§14.10).
  useEffect(() => {
    if (editorOpen) return;
    const trigger = editorTriggerRef.current;
    if (!trigger) return;
    editorTriggerRef.current = null;
    const target = trigger.isConnected ? trigger : addTrackerRef.current;
    target?.focus({ preventScroll: true });
  }, [editorOpen]);

  const remaining = due.length - doneCount;
  const weekday = formatWeekday(today);

  return (
    <section className="view today" aria-labelledby="today-title">
      <header className="view-header today__header">
        <div className="today__title">
          <h1 id="today-title" className="display display--xl">
            {weekday}
          </h1>
          <p className="small-caps small-caps--12 today__date">{formatLongDate(today)}</p>
        </div>
        {active.length > 0 ? (
          <div className="today__tools">
            {due.length > 0 ? (
              <Ring
                value={doneCount / due.length}
                size={56}
                label="Today's progress"
                valueText={`${doneCount} of ${due.length} done`}
                className="today__ring"
              >
                <span>
                  {doneCount}/{due.length}
                </span>
              </Ring>
            ) : null}
            {/* "Add tracker" lives up here, not in a floating corner (a deliberate SPEC §3.1 deviation): a
                fixed "+" shared its x-band with every row's Check and caught taps meant for a check. Without
                trackers the empty state below carries the primary button instead. */}
            <button
              ref={addTrackerRef}
              type="button"
              className="today__add"
              aria-label="Add tracker"
              onClick={openEditor}
            >
              <Icon name="plus" size={20} />
            </button>
          </div>
        ) : null}
      </header>

      {active.length === 0 ? (
        // No trackers: the deterministic noHabits copy becomes the empty state's own words.
        // Tasks still follow, so a first task can be planned before the first tracker.
        <EmptyState
          className="today__empty"
          title={motivation.title}
          body={motivation.body ?? 'Add one tracker. Small and specific beats big and vague.'}
          action={
            <Button size="lg" icon={<Icon name="plus" size={20} />} onClick={openEditor}>
              Add your first tracker
            </Button>
          }
        />
      ) : (
        <>
          <MotivationLine motivation={motivation} />

          <section className="today__section" aria-labelledby={dueHeadingId}>
            <div className="today__section-head">
              <h2 id={dueHeadingId} className="small-caps small-caps--12">
                Due today
              </h2>
              <span className={cx('small-caps small-caps--12 tabular', allDone && 'accent')}>
                {dueStatus(due.length, remaining)}
              </span>
            </div>
            {due.length > 0 ? (
              <ul className="today__list">
                {due.map((h, i) => (
                  <HabitRow
                    key={h.id}
                    habit={h}
                    done={doneIds.has(h.id)}
                    streak={streaks.get(h.id) ?? 0}
                    index={i}
                    onToggle={() => toggle(h)}
                  />
                ))}
              </ul>
            ) : (
              <p className="today__rest">Nothing is scheduled on {weekday}s.</p>
            )}
          </section>
        </>
      )}

      {/* One fixed slot whether or not trackers exist: the first tracker arriving (or the last one
          leaving, through sync) must not remount the section and close a task sheet mid-edit. */}
      <TaskSection today={today} />

      {unscheduled.length > 0 ? (
        <UnscheduledSection
          habits={unscheduled}
          doneIds={doneIds}
          streaks={streaks}
          defaultOpen={due.length === 0}
          onToggle={toggle}
        />
      ) : null}

      <Confetti fire={fire} colors={confettiColors} />
      <HabitEditor open={editorOpen} onClose={closeEditor} />
    </section>
  );
}
