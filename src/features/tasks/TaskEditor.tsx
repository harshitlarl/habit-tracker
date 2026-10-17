import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import useStore from '../../lib/store';
import type { DateKey, Task } from '../../lib/types';
import { isDateKey } from '../../lib/dates';
import { TASK_NOTE_MAX, TASK_TITLE_MAX, isTimeString, quickDates } from '../../lib/tasks';
import { useToday } from '../../lib/useToday';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { InlineConfirm } from '../manage/InlineConfirm';
import { customDateLabel, formDate } from './taskModel';
import '../manage/fields.css';
import './TaskEditor.css';

export interface TaskEditorProps {
  open: boolean;
  /** Edit an existing task when set; create a new one otherwise. */
  taskId?: string;
  /** Pre-selected date for a new task (today when omitted). */
  defaultDate?: DateKey;
  onClose: () => void;
}

/**
 * Bottom sheet for creating or editing a one-time task (SPEC §14.7). Like HabitEditor, the form
 * remounts (and so resets) every time the sheet opens and whenever `taskId` changes while it is
 * open; while the sheet animates out it keeps showing the task it was opened for.
 *
 * Deviations from HabitEditor, on purpose: Save stays enabled and the inline errors appear on a
 * submit attempt (not on blur). This sheet is short, so an error line appearing while the
 * autofocused title blurs would grow the panel upward between pointer-down and pointer-up and the
 * Close button (or the backdrop) would miss the tap that caused the blur.
 *
 * Shared with HabitEditor: a task deleted on another device while its sheet is open is never saved
 * back as a new one (a status line says why Save and Delete are off), and a save or delete runs once
 * per open — a double tap on Save must not add the task twice.
 */
export function TaskEditor({ open, taskId, defaultDate, onClose }: TaskEditorProps) {
  const [latchedId, setLatchedId] = useState(taskId);
  const [latchedDate, setLatchedDate] = useState(defaultDate);
  const [wasOpen, setWasOpen] = useState(open);
  const [session, setSession] = useState(0);
  if (open && latchedId !== taskId) setLatchedId(taskId);
  if (open && latchedDate !== defaultDate) setLatchedDate(defaultDate);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((n) => n + 1);
  }
  const activeId = open ? taskId : latchedId;
  const activeDate = open ? defaultDate : latchedDate;
  const task = useStore((s) => (activeId === undefined ? undefined : s.tasks.find((t) => t.id === activeId)));

  return (
    <Sheet open={open} onClose={onClose} title={activeId === undefined ? 'New task' : 'Edit task'}>
      <TaskForm
        key={`${session}:${activeId ?? 'new'}`}
        task={task}
        taskId={activeId}
        defaultDate={activeDate}
        onClose={onClose}
      />
    </Sheet>
  );
}

interface TaskFormProps {
  task: Task | undefined;
  taskId: string | undefined;
  defaultDate: DateKey | undefined;
  onClose: () => void;
}

/** Native date/time control the user just revealed; it gets focus (and its picker) once mounted. */
type Reveal = 'date' | 'time' | null;

/** Focuses a native date/time input and opens its picker where the browser allows it. */
function focusNative(el: HTMLInputElement | null): void {
  if (!el) return;
  el.focus();
  try {
    el.showPicker();
  } catch {
    // Not supported, or the gesture has expired: the field is visible and focused; a tap opens it.
  }
}

function TaskForm({ task, taskId, defaultDate, onClose }: TaskFormProps) {
  const id = useId();
  const isEditing = taskId !== undefined;
  const today = useToday();
  const addTask = useStore((s) => s.addTask);
  const updateTask = useStore((s) => s.updateTask);
  const deleteTask = useStore((s) => s.deleteTask);

  const quick = useMemo(() => quickDates(today), [today]);

  const [title, setTitle] = useState(task?.title ?? '');
  /** A submit was attempted: from then on the title error shows and hides live. */
  const [submitted, setSubmitted] = useState(false);
  /**
   * The date the user picked; an existing task starts from its own. Null while a new task's date is
   * untouched: the form then follows `defaultDate`, so a sheet left open across midnight still saves
   * to the day "Today" names, not to the day before.
   */
  const [pickedDate, setPickedDate] = useState<string | null>(task?.date ?? null);
  const date = formDate(pickedDate, defaultDate, today);
  const inQuick = quick.some((q) => q.key === date);
  // The native picker shows for dates outside the quick row, and after "Pick a date…" is tapped.
  const [pickerOpen, setPickerOpen] = useState(!inQuick);
  // A date the quick row leaves behind while the sheet is open (midnight moves the row on) reveals the
  // field too, so the date that will be saved stays in view. Once shown, the field stays until a quick
  // chip is tapped: a date picked in it that lands inside the row must not pull it away mid-gesture.
  if (!inQuick && !pickerOpen) setPickerOpen(true);
  const [time, setTime] = useState(task?.time ?? '');
  const [timeOpen, setTimeOpen] = useState(Boolean(task?.time));
  const [note, setNote] = useState(task?.note ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The confirm's question, fixed when it opens: the store drops the task while the sheet slides out. */
  const [deleteName, setDeleteName] = useState('');
  /** Set by this sheet's own Delete, so the closing sheet never reads as "deleted on another device". */
  const [removed, setRemoved] = useState(false);
  /** A save or delete has gone through: the departing sheet ignores another (a double tap on Save). */
  const committed = useRef(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const addTimeRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const reveal = useRef<Reveal>(null);

  // Editing a task the store no longer holds: a tombstone from another device arrived while the sheet
  // was open. There is nothing left to save into, and saving must never create a fresh task.
  const gone = isEditing && task === undefined && !removed;

  const trimmedTitle = title.trim();
  const titleError = trimmedTitle.length === 0 ? 'Give it a title.' : null;
  const dateError = isDateKey(date) ? null : 'Pick a date.';
  const showTitleError = submitted && titleError !== null;
  const customSelected = pickerOpen || !inQuick;
  const customLabel = customDateLabel(date, quick);

  // A revealed native control takes focus and, where the browser allows it, opens its picker at once.
  useEffect(() => {
    const which = reveal.current;
    if (which === null) return;
    reveal.current = null;
    focusNative(which === 'date' ? dateRef.current : timeRef.current);
  }, [pickerOpen, timeOpen]);

  function pickQuick(key: DateKey): void {
    setPickedDate(key);
    setPickerOpen(false);
  }

  function openPicker(): void {
    // Already showing (a date outside the quick row, or a second tap): no state change, no effect.
    if (pickerOpen) {
      focusNative(dateRef.current);
      return;
    }
    reveal.current = 'date';
    setPickerOpen(true);
  }

  function addTime(): void {
    reveal.current = 'time';
    setTimeOpen(true);
  }

  function removeTime(): void {
    setTime('');
    setTimeOpen(false);
    // "Add a time" mounts again on this render; focus it once it exists.
    requestAnimationFrame(() => addTimeRef.current?.focus());
  }

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (committed.current || gone) return;
    if (titleError !== null || dateError !== null) {
      setSubmitted(true);
      if (titleError !== null) titleRef.current?.focus();
      else dateRef.current?.focus();
      return;
    }
    const cleanTime = isTimeString(time) ? time : undefined;
    const cleanNote = note.trim();
    if (taskId === undefined) {
      committed.current = true;
      addTask({ title: trimmedTitle, date, time: cleanTime, note: cleanNote || undefined });
    } else if (useStore.getState().tasks.some((t) => t.id === taskId)) {
      committed.current = true;
      // '' clears `time` / `note` (see TaskPatch).
      updateTask(taskId, { title: trimmedTitle, date, time: cleanTime ?? '', note: cleanNote });
    } else {
      return; // deleted elsewhere since this render: the next render shows why Save is off
    }
    onClose();
  }

  function askDelete(): void {
    setDeleteName(task?.title ?? 'this task');
    setConfirmDelete(true);
  }

  function remove(): void {
    if (taskId === undefined || committed.current) return;
    committed.current = true;
    setRemoved(true);
    deleteTask(taskId);
    onClose();
  }

  function cancelDelete(): void {
    setConfirmDelete(false);
    // The Delete button mounts again on this render; focus it once it exists.
    requestAnimationFrame(() => deleteRef.current?.focus());
  }

  const titleId = `${id}-title`;
  const titleErrorId = `${id}-title-error`;
  const dateId = `${id}-date`;
  const dateErrorId = `${id}-date-error`;
  const timeId = `${id}-time`;
  const noteId = `${id}-note`;

  return (
    <form className="task-editor" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={titleId} className="field__label">
          <span className="small-caps">Title</span>
          <span className="field__count tabular" aria-hidden="true">
            {title.length}/{TASK_TITLE_MAX}
          </span>
        </label>
        <input
          ref={titleRef}
          id={titleId}
          className="field__input"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TASK_TITLE_MAX}
          placeholder="e.g. Renew the gym membership"
          autoFocus={!isEditing}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="done"
          required
          aria-invalid={showTitleError || undefined}
          aria-describedby={showTitleError ? titleErrorId : undefined}
        />
        <p id={titleErrorId} className="field__error" role="status">
          {showTitleError ? titleError : null}
        </p>
      </div>

      <fieldset className="fieldset" aria-describedby={dateError ? dateErrorId : undefined}>
        <legend className="small-caps fieldset__legend">Date</legend>
        <div className="task-editor__dates">
          {quick.map((q) => (
            <Chip key={q.key} selected={!pickerOpen && date === q.key} onClick={() => pickQuick(q.key)}>
              {q.label}
            </Chip>
          ))}
          <Chip selected={customSelected} onClick={openPicker}>
            {customLabel}
          </Chip>
        </div>
        {pickerOpen ? (
          <div className="task-editor__native-row">
            <label htmlFor={dateId} className="sr-only">
              Date
            </label>
            <input
              ref={dateRef}
              id={dateId}
              className="field__input task-editor__native"
              type="date"
              value={date}
              onChange={(e) => setPickedDate(e.target.value)}
              required
              aria-invalid={dateError ? true : undefined}
              aria-describedby={dateError ? dateErrorId : undefined}
            />
          </div>
        ) : null}
        <p id={dateErrorId} className="field__error" role="status">
          {dateError}
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="small-caps fieldset__legend">Time</legend>
        {timeOpen ? (
          <div className="task-editor__native-row">
            <label htmlFor={timeId} className="sr-only">
              Time
            </label>
            <input
              ref={timeRef}
              id={timeId}
              className="field__input task-editor__native task-editor__time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
            <button type="button" className="task-editor__link" onClick={removeTime}>
              Remove<span className="sr-only"> time</span>
            </button>
          </div>
        ) : (
          <Button ref={addTimeRef} variant="ghost" icon={<Icon name="plus" size={20} />} onClick={addTime}>
            Add a time
          </Button>
        )}
      </fieldset>

      <div className="field">
        <label htmlFor={noteId} className="field__label">
          <span className="small-caps">Note</span>
          <span className="field__count tabular" aria-hidden="true">
            {note.length}/{TASK_NOTE_MAX}
          </span>
        </label>
        <input
          id={noteId}
          className="field__input"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={TASK_NOTE_MAX}
          placeholder="Optional, e.g. bring the signed form"
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="done"
        />
      </div>

      <div className="task-editor__save">
        {isEditing ? (
          <p className="task-editor__gone" role="status">
            {gone ? 'This task was deleted on another device.' : null}
          </p>
        ) : null}
        <Button type="submit" size="lg" full disabled={gone}>
          {isEditing ? 'Save' : 'Save task'}
        </Button>
      </div>

      {isEditing ? (
        confirmDelete && !gone ? (
          <InlineConfirm
            title={`Delete “${deleteName}”?`}
            body="There is no undo."
            confirmLabel="Delete"
            onConfirm={remove}
            onCancel={cancelDelete}
          />
        ) : (
          <div className="task-editor__manage">
            <Button
              ref={deleteRef}
              variant="danger"
              full
              icon={<Icon name="trash" size={20} />}
              onClick={askDelete}
              disabled={gone}
            >
              Delete task
            </Button>
          </div>
        )
      ) : null}
    </form>
  );
}
