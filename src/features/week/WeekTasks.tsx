import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import useStore from '../../lib/store';
import type { DateKey, Task } from '../../lib/types';
import { formatTime, taskStatus, tasksInWeek } from '../../lib/tasks';
import { Check } from '../../components/Check';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { TaskEditor } from '../tasks/TaskEditor';
import { taskRowLabel } from '../tasks/taskModel';
import { dayHeading, defaultTaskDate } from './weekTasksModel';
import './WeekTasks.css';

export interface WeekTasksProps {
  /** Monday of the shown week. */
  mondayKey: DateKey;
  today: DateKey;
  /** Play the staggered entrance on the day groups (first paint of the view only). */
  animate: boolean;
  /** Stagger index of the first group, so the cascade carries on below the grid's rows. */
  staggerFrom?: number;
  className?: string;
}

interface EditorState {
  open: boolean;
  taskId?: string;
}

interface Trigger {
  /** The control that opened the editor. */
  el: HTMLElement;
  /** The task it was opened for (a row), so a row that remounted while the sheet was open is found again. */
  taskId?: string;
}

/** The edit button of the row showing `taskId` in `scope`, if there is one. */
function rowButton(scope: HTMLElement | null, taskId: string | undefined): HTMLElement | null {
  if (scope === null || taskId === undefined) return null;
  const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-task-id]'));
  const row = rows.find((li) => li.dataset.taskId === taskId);
  return row?.querySelector<HTMLElement>('.wk-task__body') ?? null;
}

/**
 * "Tasks this week" (SPEC §14.6): the week's one-time tasks grouped under their day, below the
 * ledger. The "+" plans a task for this week, tapping a row edits it, and the square check marks
 * it done — early or late (a late check-off records today as `doneAt`). The ‹ › navigation reaches
 * it through `mondayKey`: the day groups are keyed by week and fade like the grid, while the head
 * and the editor stay mounted, so a week change (or midnight) never closes a sheet mid-edit.
 */
export function WeekTasks({ mondayKey, today, animate, staggerFrom = 0, className }: WeekTasksProps) {
  const headingId = useId();
  const [editor, setEditor] = useState<EditorState>({ open: false });
  /** The control that opened the editor; focus returns to it (or to "Add task") when the sheet closes. */
  const triggerRef = useRef<Trigger | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  const openNew = (el: HTMLElement): void => {
    triggerRef.current = { el };
    setEditor({ open: true });
  };
  const openEdit = (taskId: string, el: HTMLElement): void => {
    triggerRef.current = { el, taskId };
    setEditor({ open: true, taskId });
  };
  // `taskId` stays while the sheet slides out, so it keeps showing the task it was opened for.
  const closeEditor = (): void => setEditor((prev) => ({ ...prev, open: false }));

  // Runs after the commit that closed the editor (SPEC §14.7: focus returns to the row's button). A row
  // an edit moved to another day of the shown week has remounted under that day and is found again by
  // its task id; a row removed by "Delete task", or moved out of the shown week, is gone and focus lands
  // on "Add task" instead. iOS does not focus buttons on tap, so the Sheet's own restore (to what was
  // focused when it opened) is not enough on the phone — same approach as Today's TaskSection.
  useEffect(() => {
    if (editor.open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    triggerRef.current = null;
    const target = trigger.el.isConnected
      ? trigger.el
      : (rowButton(sectionRef.current, trigger.taskId) ?? addRef.current);
    target?.focus({ preventScroll: true });
  }, [editor.open]);

  return (
    <section ref={sectionRef} className={cx('wk-tasks', className)} aria-labelledby={headingId}>
      <div className="wk-tasks__head">
        <h2 id={headingId} className="small-caps small-caps--12">
          Tasks this week
        </h2>
        <button
          ref={addRef}
          type="button"
          className="wk-tasks__add"
          aria-label="Add task"
          onClick={(e) => openNew(e.currentTarget)}
        >
          <Icon name="plus" size={20} />
        </button>
      </div>

      <DayGroups
        key={mondayKey}
        mondayKey={mondayKey}
        today={today}
        animate={animate}
        staggerFrom={staggerFrom}
        onEdit={openEdit}
      />

      <TaskEditor
        open={editor.open}
        taskId={editor.taskId}
        defaultDate={defaultTaskDate(mondayKey, today)}
        onClose={closeEditor}
      />
    </section>
  );
}

type Entrance = 'rise' | 'fade' | 'none';

/** Opens the editor for a task; receives the row's button so focus can return to it when the sheet closes. */
type EditHandler = (taskId: string, trigger: HTMLButtonElement) => void;

interface DayGroupsProps {
  mondayKey: DateKey;
  today: DateKey;
  animate: boolean;
  staggerFrom: number;
  onEdit: EditHandler;
}

/** The shown week's days that have tasks, or the one-line empty state. Remounted per week. */
function DayGroups({ mondayKey, today, animate, staggerFrom, onEdit }: DayGroupsProps) {
  const tasks = useStore((s) => s.tasks);
  const toggleTask = useStore((s) => s.toggleTask);

  const groups = useMemo(() => [...tasksInWeek(tasks, mondayKey)], [tasks, mondayKey]);

  // The days present at first paint rise in with the grid's stagger. A day that appears later (a
  // task just saved) must not sit invisible until its turn in a cascade that already played, so it
  // gets a plain fade instead.
  const [initialDays] = useState(() => new Set(groups.map(([dateKey]) => dateKey)));
  const entranceFor = (dateKey: DateKey): Entrance => {
    if (!initialDays.has(dateKey)) return 'fade';
    return animate ? 'rise' : 'none';
  };

  return (
    <div className="fade-in">
      {groups.length === 0 ? (
        <p className={cx('wk-tasks__none', animate && 'rise')} style={animate ? { '--i': staggerFrom } : undefined}>
          No tasks this week.
        </p>
      ) : (
        groups.map(([dateKey, list], index) => (
          <DayGroup
            key={dateKey}
            dateKey={dateKey}
            tasks={list}
            today={today}
            entrance={entranceFor(dateKey)}
            index={staggerFrom + index}
            onToggle={(taskId) => toggleTask(taskId, today)}
            onEdit={onEdit}
          />
        ))
      )}
    </div>
  );
}

interface DayGroupProps {
  dateKey: DateKey;
  /** That day's tasks, sorted (tasksInWeek). */
  tasks: Task[];
  today: DateKey;
  entrance: Entrance;
  /** Stagger index for the 'rise' entrance. */
  index: number;
  onToggle: (taskId: string) => void;
  onEdit: EditHandler;
}

/** One day: a small-caps heading ("Tue 21 · Tomorrow") over its task rows. */
function DayGroup({ dateKey, tasks, today, entrance, index, onToggle, onEdit }: DayGroupProps) {
  const heading = dayHeading(dateKey, today);

  return (
    <section
      className={cx(
        'wk-tasks__group',
        dateKey === today && 'is-today',
        entrance === 'rise' && 'rise',
        entrance === 'fade' && 'fade-in',
      )}
      style={entrance === 'rise' ? { '--i': index } : undefined}
    >
      <h3 className="wk-tasks__day">
        <span className="sr-only">{heading.spoken}</span>
        <span className="small-caps" aria-hidden="true">
          {heading.short}
        </span>
        {heading.relative ? (
          <span className="small-caps" aria-hidden="true">
            · {heading.relative}
          </span>
        ) : null}
      </h3>
      <ul className="wk-tasks__list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            today={today}
            onToggle={() => onToggle(task.id)}
            onEdit={(trigger) => onEdit(task.id, trigger)}
          />
        ))}
      </ul>
    </section>
  );
}

interface TaskRowProps {
  task: Task;
  today: DateKey;
  onToggle: () => void;
  /** Opens the editor; receives the row's button so focus can return to it when the sheet closes. */
  onEdit: (trigger: HTMLButtonElement) => void;
}

interface MetaPart {
  key: string;
  node: ReactNode;
  /** The same detail as the row's accessible name says it. */
  spoken: string;
}

/**
 * One task line: the square ember check, then a button filling the row (title + meta) that opens
 * the editor. Rows keep their chronological place when checked — nothing moves under the finger.
 */
function TaskRow({ task, today, onToggle, onEdit }: TaskRowProps) {
  const status = taskStatus(task, today);

  const meta: MetaPart[] = [];
  if (task.time !== undefined) {
    const clock = formatTime(task.time);
    meta.push({ key: 'time', node: <span className="tabular">{clock}</span>, spoken: clock });
  }
  if (task.note) meta.push({ key: 'note', node: task.note, spoken: task.note });
  if (status === 'overdue') {
    const tag = <span className="small-caps wk-task__tag">Still open</span>;
    meta.push({ key: 'open', node: tag, spoken: 'still open' });
  }

  return (
    <li className={cx('wk-task', task.done && 'is-done')} data-status={status} data-task-id={task.id}>
      {/* A constant name: aria-pressed carries the state (see HabitRow). */}
      <Check
        className="wk-task__check"
        shape="square"
        tone="ember"
        size={32}
        checked={task.done}
        onChange={onToggle}
        label={`Mark ${task.title} done`}
      />
      {/* Named in full ("Mentor meeting, 3:00 PM, Bring the portfolio, edit task"), as on Today: the "·"
          between the meta parts is aria-hidden, and adjacent inline text would otherwise run together. */}
      <button
        type="button"
        className="wk-task__body"
        aria-label={taskRowLabel(task.title, meta.map((part) => part.spoken))}
        onClick={(e) => onEdit(e.currentTarget)}
      >
        <span className="wk-task__title">{task.title}</span>
        {meta.length > 0 ? (
          <span className="wk-task__meta">
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
