import { useId, useMemo, useState } from 'react';
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

interface UnscheduledSectionProps {
  habits: Habit[];
  doneIds: ReadonlySet<string>;
  streaks: ReadonlyMap<string, number>;
  onToggle: (habit: Habit) => void;
}

/** "Not scheduled today": collapsed by default, every tracker still checkable as a bonus. */
function UnscheduledSection({ habits, doneIds, streaks, onToggle }: UnscheduledSectionProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();

  return (
    <section className="today__section">
      <h2 className="today__section-head">
        <button
          type="button"
          className="today__toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="small-caps small-caps--12">Not scheduled today</span>
          <span className="small-caps small-caps--12 tabular today__toggle-count">{habits.length}</span>
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
  const dueHeadingId = useId();

  const fire = useCelebration(allDone, today);
  const confettiColors = useMemo(() => [...new Set(due.map((h) => habitColorVar(h.color)))], [due]);

  const toggle = (habit: Habit): void => toggleCompletion(habit.id, today);
  const openEditor = (): void => setEditorOpen(true);
  const closeEditor = (): void => setEditorOpen(false);

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
        {due.length > 0 ? (
          <Ring value={doneCount / due.length} size={56} label="Today's progress" className="today__ring">
            <span>
              {doneCount}/{due.length}
            </span>
          </Ring>
        ) : null}
      </header>

      {active.length === 0 ? (
        // No trackers: the deterministic noHabits copy becomes the empty state's own words.
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

          {unscheduled.length > 0 ? (
            <UnscheduledSection habits={unscheduled} doneIds={doneIds} streaks={streaks} onToggle={toggle} />
          ) : null}
        </>
      )}

      <button type="button" className="fab" aria-label="Add tracker" onClick={openEditor}>
        <Icon name="plus" size={28} />
      </button>

      <Confetti fire={fire} colors={confettiColors} />
      <HabitEditor open={editorOpen} onClose={closeEditor} />
    </section>
  );
}
