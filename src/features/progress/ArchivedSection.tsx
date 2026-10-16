import { memo, useId, useMemo, useState } from 'react';
import type { Completions, DateKey, Habit } from '../../lib/types';
import { addDays, formatLongDate } from '../../lib/dates';
import { toneClass } from '../../lib/selectors';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { lifetimeStats, percent, plural, type DateSet } from './progressStats';
import './ArchivedSection.css';

export interface ArchivedSectionProps {
  /** Archived trackers, in order. */
  habits: Habit[];
  completions: Completions;
  today: DateKey;
  /** Start expanded (used when nothing else is left to show). */
  defaultOpen?: boolean;
  onRestore: (id: string) => void;
}

/* The view remounts on every tab switch; remember the disclosure state for the session. */
let rememberedOpen: boolean | null = null;

/** Collapsed list of archived trackers with their final stats and a Restore action. */
export function ArchivedSection({ habits, completions, today, defaultOpen = false, onRestore }: ArchivedSectionProps) {
  const [open, setOpen] = useState<boolean>(() => rememberedOpen ?? defaultOpen);
  const panelId = useId();
  const headingId = useId();

  function toggle(): void {
    setOpen((v) => {
      rememberedOpen = !v;
      return !v;
    });
  }

  return (
    <section className="archived" aria-labelledby={headingId}>
      <h2 id={headingId} className="archived__heading">
        <button
          type="button"
          className="archived__toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          <span className="small-caps small-caps--12">Archived</span>
          <span className="archived__count tabular">{habits.length}</span>
          <Icon name="chevronRight" size={18} className={cx('archived__chevron', open && 'is-open')} />
        </button>
      </h2>

      {open ? (
        <ul id={panelId} className="archived__list fade-in">
          {habits.map((h) => (
            <ArchivedRow key={h.id} habit={h} dates={completions[h.id]} today={today} onRestore={onRestore} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface ArchivedRowProps {
  habit: Habit;
  dates: DateSet;
  today: DateKey;
  onRestore: (id: string) => void;
}

const ArchivedRow = memo(function ArchivedRow({ habit, dates, today, onRestore }: ArchivedRowProps) {
  const stats = useMemo(() => lifetimeStats(habit, dates, today), [habit, dates, today]);

  const facts: string[] = [];
  if (habit.archivedAt) {
    // archivedAt is the first day the tracker was no longer scheduled (an exclusive bound: archiving
    // after today's check-in stores tomorrow, see archiveHabit), so the card names the last day it
    // was active. A tracker archived before it ever had a scheduled day shows the archive date itself.
    const lastDay = addDays(habit.archivedAt, -1);
    facts.push(
      lastDay >= habit.createdAt
        ? `Last day ${formatLongDate(lastDay)}`
        : `Archived ${formatLongDate(habit.archivedAt)}`,
    );
  }
  facts.push(`Best ${stats.best} ${plural(stats.best, 'day')}`);
  facts.push(`${stats.total} done`);
  if (stats.due > 0) facts.push(`${percent(stats.rate)}%`);

  return (
    <li className="archived__item">
      <span className={cx('archived__emoji', toneClass(habit.color))} aria-hidden="true">
        {habit.emoji}
      </span>
      <div className="archived__meta">
        <div className="archived__name truncate">{habit.name}</div>
        <div className="archived__facts tabular">{facts.join(' · ')}</div>
      </div>
      <Button
        variant="ghost"
        icon={<Icon name="restore" size={18} />}
        aria-label={`Restore ${habit.name}`}
        onClick={() => onRestore(habit.id)}
      >
        Restore
      </Button>
    </li>
  );
});
