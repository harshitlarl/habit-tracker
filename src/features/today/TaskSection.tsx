import { useEffect, useId, useMemo, useRef, useState } from 'react';
import useStore from '../../lib/store';
import type { DateKey, Task } from '../../lib/types';
import { carriedOverDone, tasksForToday } from '../../lib/tasks';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { TaskEditor } from '../tasks/TaskEditor';
import { TaskRow, type TaskRowEntrance } from './TaskRow';
import './TaskSection.css';

export interface TaskSectionProps {
  /** The current local day, shared with the rest of Today. */
  today: DateKey;
}

interface EditorState {
  open: boolean;
  /** The task being edited; undefined for a new one. Kept while the sheet animates out. */
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
  return row?.querySelector<HTMLElement>('.task-row__body') ?? null;
}

/** Undone first, then done, each part keeping its order. */
function sinkDone(list: readonly Task[]): Task[] {
  return [...list.filter((t) => !t.done), ...list.filter((t) => t.done)];
}

function statusText(total: number, openCount: number): string | null {
  if (total === 0) return null;
  if (openCount === 0) return 'All done';
  return `${openCount} left`;
}

/**
 * Today → "Tasks" (SPEC §14.5): carried-over tasks first (oldest first), then today's, done ones
 * sinking to the bottom of their group. Owns its "Add task" button and the TaskEditor sheet.
 */
export function TaskSection({ today }: TaskSectionProps) {
  const tasks = useStore((s) => s.tasks);
  const toggleTask = useStore((s) => s.toggleTask);
  const headingId = useId();
  const [editor, setEditor] = useState<EditorState>({ open: false });
  /** The control that opened the editor; focus returns to it (or to "Add task") when the sheet closes. */
  const triggerRef = useRef<Trigger | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  /**
   * True for the section's first paint only. Rows rendered then rise in with the stagger; a row that
   * mounts afterwards (a task just saved, one that changed groups, a new day's list) fades in instead
   * of waiting, invisible, for its turn in a cascade that already played — as Week's day groups do.
   */
  const [firstPaint, setFirstPaint] = useState(true);
  useEffect(() => setFirstPaint(false), []);
  const entrance: TaskRowEntrance = firstPaint ? 'rise' : 'fade';

  const { carried, scheduled, openCount } = useMemo(() => {
    const model = tasksForToday(tasks, today);
    // carriedOver() lists only open items. One finished today stays on today's page, checked, until
    // midnight — so it can be unchecked, and the day's work is still visible (carriedOverDone).
    return {
      carried: [...model.carried, ...carriedOverDone(tasks, today)],
      scheduled: sinkDone(model.scheduled),
      openCount: model.openCount,
    };
  }, [tasks, today]);

  const total = carried.length + scheduled.length;
  const status = statusText(total, openCount);

  function openEditor(el: HTMLElement, taskId?: string): void {
    triggerRef.current = { el, taskId };
    setEditor(taskId === undefined ? { open: true } : { open: true, taskId });
  }

  function closeEditor(): void {
    setEditor((s) => ({ ...s, open: false }));
  }

  // Runs after the commit that closed the editor, so the store's change is on screen by then: a row
  // an edit moved into the other group (carried ↔ today) has remounted and is found again by its task
  // id, and a row removed by "Delete task" is gone, so focus lands on "Add task" instead. iOS does not
  // focus buttons on tap, so the Sheet's own restore (to what was focused when it opened) is not
  // enough on the phone.
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
    <section ref={sectionRef} className="today__section tasks" aria-labelledby={headingId}>
      <div className="tasks__head">
        <h2 id={headingId} className="small-caps small-caps--12">
          Tasks
        </h2>
        <div className="tasks__tools">
          {status !== null ? (
            <span className={cx('small-caps small-caps--12 tabular', openCount === 0 && 'accent')}>{status}</span>
          ) : null}
          <button
            ref={addRef}
            type="button"
            className="tasks__add"
            aria-label="Add task"
            onClick={(e) => openEditor(e.currentTarget)}
          >
            <Icon name="plus" size={20} />
          </button>
        </div>
      </div>

      {total > 0 ? (
        <ul className="tasks__list">
          {carried.map((t, i) => (
            <TaskRow
              key={t.id}
              task={t}
              today={today}
              carried
              index={i}
              entrance={entrance}
              onToggle={() => toggleTask(t.id, today)}
              onOpen={(el) => openEditor(el, t.id)}
            />
          ))}
          {scheduled.map((t, i) => (
            <TaskRow
              key={t.id}
              task={t}
              today={today}
              index={carried.length + i}
              entrance={entrance}
              onToggle={() => toggleTask(t.id, today)}
              onOpen={(el) => openEditor(el, t.id)}
            />
          ))}
        </ul>
      ) : (
        <p className="tasks__empty">Nothing planned today.</p>
      )}

      <TaskEditor open={editor.open} taskId={editor.taskId} defaultDate={today} onClose={closeEditor} />
    </section>
  );
}
