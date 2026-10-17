import { useCallback, useMemo, useState } from 'react';
import useStore from '../../lib/store';
import type { DateKey } from '../../lib/types';
import { diffDays, startOfWeekKey } from '../../lib/dates';
import { activeHabits, archivedHabits } from '../../lib/selectors';
import { perfectDayStreak, totalCompletions, weekSummary, weeklyRates } from '../../lib/streaks';
import { useToday } from '../../lib/useToday';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { HabitEditor } from '../manage/HabitEditor';
import { ArchivedSection } from './ArchivedSection';
import { Stat } from './Stat';
import { TrackerCard } from './TrackerCard';
import { WeeklyBars } from './WeeklyBars';
import { CHART_WEEKS, percent, plural, recentWeeks } from './progressStats';
import './ProgressView.css';

/* Entrance stagger: the fixed sections first, then the tracker blocks, capped so a long list never waits. */
const FIRST_TRACKER_INDEX = 3;
const MAX_STAGGER_INDEX = 10;

interface EditorState {
  open: boolean;
  habitId?: string;
}

export function ProgressView() {
  const habits = useStore((s) => s.habits);
  const completions = useStore((s) => s.completions);
  const unarchiveHabit = useStore((s) => s.unarchiveHabit);
  const today = useToday();
  // The editor sheet, hosted here the way ManageView hosts it: a card's header (active or archived)
  // opens it for that tracker; the empty state opens it for a new one. Stable callbacks keep the
  // memoised cards from re-rendering when it opens or closes.
  const [editor, setEditor] = useState<EditorState>({ open: false });
  const openNew = useCallback((): void => setEditor({ open: true }), []);
  const openEdit = useCallback((habitId: string): void => setEditor({ open: true, habitId }), []);
  const closeEditor = useCallback((): void => setEditor((prev) => ({ ...prev, open: false })), []);

  const active = useMemo(() => activeHabits(habits), [habits]);
  const archived = useMemo(() => archivedHabits(habits), [habits]);
  const weeks = useMemo(() => recentWeeks(today), [today]);

  const overall = useMemo(
    () => ({
      perfect: perfectDayStreak(habits, completions, today),
      total: totalCompletions(completions),
      week: weekSummary(habits, completions, startOfWeekKey(today), today),
      rates: weeklyRates(habits, completions, today, CHART_WEEKS),
      firstDay: habits.reduce<DateKey | null>((min, h) => (min === null || h.createdAt < min ? h.createdAt : min), null),
    }),
    [habits, completions, today],
  );

  const dayCount = overall.firstDay ? Math.max(1, diffDays(overall.firstDay, today) + 1) : 0;
  const subtitle =
    active.length === 0
      ? `Day ${dayCount} · no active trackers`
      : `Day ${dayCount} · ${active.length} ${plural(active.length, 'tracker')}`;

  const { week } = overall;

  return (
    <section className="view progress" aria-labelledby="progress-title">
      <header className="view-header">
        <div>
          <h1 id="progress-title" className="display display--xl">
            Progress
          </h1>
          {habits.length > 0 ? <p className="small-caps progress__subtitle">{subtitle}</p> : null}
        </div>
      </header>

      {habits.length === 0 ? (
        <EmptyState
          title="Your history starts here."
          body="Add a tracker and check it off for a few days. Streaks, weekly rates and a twelve-week map will fill this page."
          action={
            <Button size="lg" icon={<Icon name="plus" size={20} />} onClick={openNew}>
              Add your first tracker
            </Button>
          }
        />
      ) : (
        <>
          <div className="progress__overall rise" style={{ '--i': 0 }}>
            <Stat
              size="lg"
              value={overall.perfect}
              label={plural(overall.perfect, 'Perfect day')}
              sub="in a row"
            />
            <Stat size="lg" value={overall.total} label="Completions" sub="all time" />
            <Stat
              size="lg"
              value={week.due ? percent(week.rate) : '–'}
              unit={week.due ? '%' : undefined}
              label="This week"
              sub={week.due ? `${week.done} of ${week.due}` : 'Nothing due yet'}
            />
          </div>

          <section className="progress__section rise" style={{ '--i': 1 }} aria-labelledby="progress-weeks">
            <h2 id="progress-weeks" className="small-caps small-caps--12 progress__label">
              Last {CHART_WEEKS} weeks
            </h2>
            <WeeklyBars rates={overall.rates} />
          </section>

          <section
            className="progress__section progress__section--ruled rise"
            style={{ '--i': 2 }}
            aria-labelledby="progress-trackers"
          >
            <h2 id="progress-trackers" className="small-caps small-caps--12 progress__label">
              Trackers
            </h2>
            {active.length === 0 ? (
              <p className="progress__note muted">All your trackers are archived. Restore one below to keep going.</p>
            ) : (
              <div className="progress__trackers">
                {active.map((h, i) => (
                  <TrackerCard
                    key={h.id}
                    habit={h}
                    dates={completions[h.id]}
                    today={today}
                    weeks={weeks}
                    index={Math.min(FIRST_TRACKER_INDEX + i, MAX_STAGGER_INDEX)}
                    onEdit={openEdit}
                  />
                ))}
              </div>
            )}
          </section>

          {archived.length > 0 ? (
            <ArchivedSection
              habits={archived}
              completions={completions}
              today={today}
              defaultOpen={active.length === 0}
              onRestore={unarchiveHabit}
              onEdit={openEdit}
            />
          ) : null}
        </>
      )}

      <HabitEditor open={editor.open} habitId={editor.habitId} onClose={closeEditor} />
    </section>
  );
}
