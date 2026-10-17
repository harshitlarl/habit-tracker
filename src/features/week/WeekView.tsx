import { useMemo, useState, type ReactNode } from 'react';
import useStore from '../../lib/store';
import { addDays, formatWeekRange, formatWeekday, startOfWeekKey, weekKeys, weekdayOf } from '../../lib/dates';
import { habitsActiveBetween } from '../../lib/selectors';
import { weekSummary } from '../../lib/streaks';
import { getWeekSummaryMessage } from '../../lib/motivation';
import { useToday } from '../../lib/useToday';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { HabitEditor } from '../manage/HabitEditor';
import { WeekGrid } from './WeekGrid';
import { WeekTasks } from './WeekTasks';
import { relativeWeekLabel } from './weekModel';
import './WeekView.css';

const SUNDAY = 6;

/**
 * Week view: a Monday → Sunday ledger of every tracker, with the week's one-time tasks beneath it.
 * ‹ › move the week; a "This week" pill returns to the current one. Tapping a cell toggles that
 * day's completion. Without trackers the ledger gives way to an empty state, and the tasks section
 * still follows the week, so a first task can be planned before the first tracker.
 */
export function WeekView() {
  const habits = useStore((s) => s.habits);
  const completions = useStore((s) => s.completions);
  const toggleCompletion = useStore((s) => s.toggleCompletion);
  const today = useToday();

  // Weeks relative to the current one, so offset 0 keeps following `today` across midnight.
  const [offset, setOffset] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  const mondayKey = addDays(startOfWeekKey(today), offset * 7);
  const keys = useMemo(() => weekKeys(mondayKey), [mondayKey]);
  const rows = useMemo(() => habitsActiveBetween(habits, mondayKey, addDays(mondayKey, 6)), [habits, mondayKey]);
  const summary = useMemo(
    () => weekSummary(habits, completions, mondayKey, today),
    [habits, completions, mondayKey, today],
  );

  const go = (delta: number): void => {
    setOffset((o) => o + delta);
    setNavigated(true);
  };

  const hasHabits = habits.length > 0;
  const showNote = offset === 0 && summary.due > 0 && weekdayOf(today) !== SUNDAY;

  let ledger: ReactNode = null;
  if (hasHabits) {
    ledger =
      rows.length > 0 ? (
        <>
          <WeekGrid
            habits={habits}
            rows={rows}
            completions={completions}
            mondayKey={mondayKey}
            keys={keys}
            today={today}
            animateRows={!navigated}
            onToggle={toggleCompletion}
          />
          <div className="wk-summary">
            <p className="quote wk-summary__text">{getWeekSummaryMessage(summary.done, summary.due)}</p>
            {showNote ? <p className="small-caps wk-summary__note">Through {formatWeekday(today)}</p> : null}
          </div>
        </>
      ) : (
        <p className="wk-none muted">No trackers were active this week.</p>
      );
  }

  return (
    <section className="view" aria-labelledby="week-title">
      <header className="view-header wk-header">
        <div className="wk-header__text">
          <div className="wk-eyebrow">
            <p className="small-caps">{relativeWeekLabel(offset)}</p>
            {offset !== 0 ? (
              <Chip size="sm" onClick={() => go(-offset)}>
                <Icon name="restore" size={14} />
                This week
              </Chip>
            ) : null}
          </div>
          <h1 id="week-title" className="display display--xl wk-title">
            {formatWeekRange(mondayKey)}
          </h1>
        </div>
        <div className="wk-nav" role="group" aria-label="Change week">
          <button type="button" className="wk-nav__btn" aria-label="Previous week" onClick={() => go(-1)}>
            <Icon name="chevronLeft" />
          </button>
          <button type="button" className="wk-nav__btn" aria-label="Next week" onClick={() => go(1)}>
            <Icon name="chevronRight" />
          </button>
        </div>
      </header>

      {hasHabits ? null : (
        <EmptyState
          title="Nothing to track yet"
          body="Once you add a tracker, this page becomes your week at a glance: one row per habit, a mark for every day you show up."
          action={
            <Button size="lg" icon={<Icon name="plus" size={20} />} onClick={() => setEditorOpen(true)}>
              Add your first tracker
            </Button>
          }
        />
      )}

      {ledger !== null ? (
        <div key={mondayKey} className="fade-in">
          {ledger}
        </div>
      ) : null}

      <WeekTasks
        mondayKey={mondayKey}
        today={today}
        animate={!navigated}
        staggerFrom={rows.length}
        className={hasHabits ? undefined : 'wk-tasks--after-empty'}
      />

      <HabitEditor open={editorOpen} onClose={() => setEditorOpen(false)} />
    </section>
  );
}
