import { Fragment, useState, type AnimationEvent, type ReactNode } from 'react';
import type { DateKey, Task } from '../../lib/types';
import { formatTime, relativeDayLabel } from '../../lib/tasks';
import { Check } from '../../components/Check';
import { cx } from '../../components/cx';
import { taskRowLabel } from '../tasks/taskModel';
import './TaskRow.css';

/**
 * How a row appears when it mounts: 'rise' (the staggered rise-in) for the rows of the section's first
 * paint, 'fade' for one that arrives later (a task just saved, a row that changed groups).
 */
export type TaskRowEntrance = 'rise' | 'fade';

export interface TaskRowProps {
  task: Task;
  today: DateKey;
  /** Planned for an earlier day: the meta line says where it came from. */
  carried?: boolean;
  /** Position in its list, for the staggered rise-in. */
  index: number;
  /** Read once, when the row mounts. */
  entrance: TaskRowEntrance;
  onToggle: () => void;
  /** Opens the editor; receives the row's button so focus can return to it when the sheet closes. */
  onOpen: (trigger: HTMLButtonElement) => void;
}

interface MetaPart {
  key: string;
  node: ReactNode;
  /** The same detail as the row's accessible name says it. */
  spoken: string;
}

/**
 * One task line on Today (SPEC §14.5): a square ember Check, then a text button filling the rest
 * of the row that opens the editor. Title on top; time, note and "From …" on the meta line.
 *
 * The entrance plays once and its class goes when it has run: React re-inserts the rows it moves (a
 * done task sinking to the bottom of its group, an un-check bringing it back), and WebKit restarts a
 * class-driven animation on every re-insertion — the row would blink out and rise again under the finger.
 */
export function TaskRow({ task, today, carried = false, index, entrance, onToggle, onOpen }: TaskRowProps) {
  const [entering, setEntering] = useState<TaskRowEntrance | null>(entrance);

  function onAnimationEnd(e: AnimationEvent<HTMLLIElement>): void {
    // The Check's own spring and stroke animations bubble up here; only the row's entrance counts.
    if (e.target === e.currentTarget) setEntering(null);
  }

  const meta: MetaPart[] = [];
  if (task.time) {
    const clock = formatTime(task.time);
    meta.push({ key: 'time', node: <span className="tabular">{clock}</span>, spoken: clock });
  }
  if (task.note) {
    meta.push({ key: 'note', node: <span>{task.note}</span>, spoken: task.note });
  }
  if (carried) {
    const from = relativeDayLabel(task.date, today);
    meta.push({ key: 'from', node: <span className="task-row__from">From {from}</span>, spoken: `from ${from}` });
  }

  return (
    <li
      className={cx(
        'task-row',
        entering === 'rise' && 'rise',
        entering === 'fade' && 'fade-in',
        task.done && 'is-done',
      )}
      style={entering === 'rise' ? { '--i': index } : undefined}
      data-task-id={task.id}
      onAnimationEnd={onAnimationEnd}
    >
      <span className="task-row__check">
        {/* A constant name: aria-pressed carries the state. */}
        <Check
          shape="square"
          tone="ember"
          size={36}
          checked={task.done}
          onChange={onToggle}
          label={`Mark ${task.title} done`}
        />
      </span>

      {/* Named in full ("Mentor meeting, 3:00 PM, Bring the portfolio, edit task"): the "·" between the
          meta parts is aria-hidden, and adjacent inline text would otherwise run "PM" into the note. */}
      <button
        type="button"
        className="task-row__body"
        aria-label={taskRowLabel(task.title, meta.map((part) => part.spoken))}
        onClick={(e) => onOpen(e.currentTarget)}
      >
        <span className="task-row__title">{task.title}</span>
        {meta.length > 0 ? (
          <span className="task-row__meta">
            {meta.map((part, i) => (
              <Fragment key={part.key}>
                {/* Only the dot is decoration: the spaces around it stay in the text. */}
                {i > 0 ? <>{' '}<span aria-hidden="true">·</span>{' '}</> : null}
                {part.node}
              </Fragment>
            ))}
          </span>
        ) : null}
      </button>
    </li>
  );
}
