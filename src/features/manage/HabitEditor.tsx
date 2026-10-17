import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import useStore, { normalizeDays } from '../../lib/store';
import {
  HABIT_COLORS,
  HABIT_EMOJI_MAX,
  HABIT_NAME_MAX,
  HABIT_NOTE_MAX,
  type Habit,
  type HabitColor,
  type Weekday,
} from '../../lib/types';
import { WEEKDAY_LONG, WEEKDAY_SHORT } from '../../lib/dates';
import { habitById, toneClass } from '../../lib/selectors';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { InlineConfirm } from './InlineConfirm';
import { ALL_DAYS, WEEKDAYS, WEEKENDS } from './daysSummary';
import { DEFAULT_EMOJI, firstGrapheme, isCuratedEmoji, visibleEmojiOptions } from './emojis';
import './fields.css';
import './HabitEditor.css';

export interface HabitEditorProps {
  open: boolean;
  /** Edit an existing tracker when set; create a new one otherwise. */
  habitId?: string;
  onClose: () => void;
}

const COLOR_NAMES: Record<HabitColor, string> = {
  terracotta: 'Terracotta',
  ochre: 'Ochre',
  sage: 'Sage',
  slate: 'Slate',
  plum: 'Plum',
  rose: 'Rose',
  moss: 'Moss',
  graphite: 'Graphite',
};

/** First colour no active tracker uses, otherwise cycle through the palette. */
function suggestColor(habits: Habit[]): HabitColor {
  const used = new Set(habits.filter((h) => !h.archivedAt).map((h) => h.color));
  return (
    HABIT_COLORS.find((c) => !used.has(c)) ?? HABIT_COLORS[habits.length % HABIT_COLORS.length] ?? 'terracotta'
  );
}

/**
 * Bottom sheet for creating or editing a tracker. The form remounts (and so resets) every time
 * the sheet opens and whenever `habitId` changes while it is open; while the sheet animates out
 * it keeps showing the tracker it was opened for.
 */
export function HabitEditor({ open, habitId, onClose }: HabitEditorProps) {
  const [latchedId, setLatchedId] = useState(habitId);
  const [wasOpen, setWasOpen] = useState(open);
  const [session, setSession] = useState(0);
  if (open && latchedId !== habitId) setLatchedId(habitId);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((n) => n + 1);
  }
  const activeId = open ? habitId : latchedId;
  const habit = useStore((s) => (activeId === undefined ? undefined : habitById(s.habits, activeId)));

  return (
    <Sheet open={open} onClose={onClose} title={activeId === undefined ? 'New tracker' : 'Edit tracker'}>
      <EditorForm key={`${session}:${activeId ?? 'new'}`} habit={habit} habitId={activeId} onClose={onClose} />
    </Sheet>
  );
}

interface EditorFormProps {
  habit: Habit | undefined;
  habitId: string | undefined;
  onClose: () => void;
}

/**
 * The form. Save stays enabled: a submit with something missing marks every error (aria-invalid,
 * the inline lines announced through their always-present status regions) and moves focus to the
 * first field that needs work, so the length and day errors are reachable rather than hidden behind
 * a disabled button. Save sits in a sticky footer, in reach the moment the sheet opens.
 */
function EditorForm({ habit, habitId, onClose }: EditorFormProps) {
  const id = useId();
  const isEditing = habitId !== undefined;
  const addHabit = useStore((s) => s.addHabit);
  const updateHabit = useStore((s) => s.updateHabit);
  const archiveHabit = useStore((s) => s.archiveHabit);
  const unarchiveHabit = useStore((s) => s.unarchiveHabit);
  const deleteHabit = useStore((s) => s.deleteHabit);
  const completionCount = useStore((s) =>
    habitId === undefined ? 0 : Object.keys(s.completions[habitId] ?? {}).length,
  );

  const [name, setName] = useState(habit?.name ?? '');
  const [nameTouched, setNameTouched] = useState(false);
  const [emoji, setEmoji] = useState(habit?.emoji ?? DEFAULT_EMOJI);
  const [customEmoji, setCustomEmoji] = useState(() =>
    habit && habit.emoji !== '' && !isCuratedEmoji(habit.emoji) ? habit.emoji : '',
  );
  const [allEmoji, setAllEmoji] = useState(false);
  const [color, setColor] = useState<HabitColor>(() => habit?.color ?? suggestColor(useStore.getState().habits));
  const [note, setNote] = useState(habit?.note ?? '');
  const [days, setDays] = useState<Weekday[]>(() => (habit ? normalizeDays(habit.days) : [...ALL_DAYS]));
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Read once per open: archiving from this sheet must not swap Archive for Restore while it slides out.
  const [archived] = useState(() => Boolean(habit?.archivedAt));
  // Set by this sheet's own Delete, so the closing sheet never reads as "deleted on another device".
  const [removed, setRemoved] = useState(false);
  // A save, archive or delete has gone through: the departing sheet ignores another one (a second
  // Enter, or the keyboard's Done tapped twice, before the sheet has left).
  const committed = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const daysRef = useRef<HTMLDivElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);

  // Editing a tracker the store no longer holds: a tombstone from another device arrived while the
  // sheet was open. There is nothing left to save into, and saving must never create a fresh tracker.
  const gone = isEditing && habit === undefined && !removed;

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0
      ? 'Give it a name.'
      : trimmedName.length > HABIT_NAME_MAX
        ? `Keep it under ${HABIT_NAME_MAX} characters.`
        : null;
  const emojiError = emoji === '' ? 'Pick an emoji.' : null;
  const daysError = days.length === 0 ? 'Pick at least one day.' : null;
  const showNameError = nameTouched && nameError !== null;
  const shownEmoji = visibleEmojiOptions(emoji, allEmoji);

  function onCustomEmoji(e: ChangeEvent<HTMLInputElement>): void {
    const value = e.target.value;
    setCustomEmoji(value);
    const glyph = firstGrapheme(value);
    if (glyph !== '') setEmoji(glyph);
  }

  function pickEmoji(char: string): void {
    setEmoji(char);
    setCustomEmoji('');
  }

  function toggleDay(day: Weekday): void {
    setDays((prev) => normalizeDays(prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (gone || committed.current) return;
    if (nameError !== null || emojiError !== null || daysError !== null) {
      setNameTouched(true);
      if (nameError !== null) nameRef.current?.focus();
      else if (emojiError !== null) customRef.current?.focus();
      else daysRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      return;
    }
    const input = { name: trimmedName, emoji, color, note: note.trim(), days: normalizeDays(days) };
    if (habitId === undefined) {
      committed.current = true;
      addHabit(input);
    } else if (habitById(useStore.getState().habits, habitId)) {
      committed.current = true;
      updateHabit(habitId, input);
    } else {
      return; // deleted elsewhere since this render: the next render shows why Save is off
    }
    onClose();
  }

  function archive(): void {
    if (habitId === undefined || committed.current) return;
    committed.current = true;
    archiveHabit(habitId);
    onClose();
  }

  function restore(): void {
    if (habitId === undefined || committed.current) return;
    committed.current = true;
    unarchiveHabit(habitId);
    onClose();
  }

  function remove(): void {
    if (habitId === undefined || committed.current) return;
    committed.current = true;
    setRemoved(true);
    deleteHabit(habitId);
    onClose();
  }

  function cancelDelete(): void {
    setConfirmDelete(false);
    // The Delete button mounts again on this render; focus it once it exists.
    requestAnimationFrame(() => deleteRef.current?.focus());
  }

  const nameId = `${id}-name`;
  const nameErrorId = `${id}-name-error`;
  const noteId = `${id}-note`;
  const customId = `${id}-custom`;
  const emojiGridId = `${id}-emoji-grid`;
  const emojiErrorId = `${id}-emoji-error`;
  const daysErrorId = `${id}-days-error`;
  const trackerName = habit?.name ?? 'this tracker';

  return (
    <form className="editor" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={nameId} className="field__label">
          <span className="small-caps">Name</span>
          <span className="field__count tabular" aria-hidden="true">
            {name.length}/{HABIT_NAME_MAX}
          </span>
        </label>
        <input
          ref={nameRef}
          id={nameId}
          className="field__input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setNameTouched(true)}
          maxLength={HABIT_NAME_MAX}
          placeholder="e.g. Gym"
          autoFocus={!isEditing}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="done"
          required
          aria-invalid={showNameError || undefined}
          aria-describedby={showNameError ? nameErrorId : undefined}
        />
        <p id={nameErrorId} className="field__error" role="status">
          {showNameError ? nameError : null}
        </p>
      </div>

      <fieldset className={cx('fieldset', toneClass(color))}>
        <legend className="small-caps fieldset__legend">Emoji</legend>
        <div className="editor__identity">
          <span className="editor__preview" aria-hidden="true">
            {emoji}
          </span>
          <label htmlFor={customId} className="sr-only">
            Type your own emoji
          </label>
          <input
            ref={customRef}
            id={customId}
            className="field__input editor__custom"
            type="text"
            value={customEmoji}
            onChange={onCustomEmoji}
            placeholder="Or type your own"
            maxLength={HABIT_EMOJI_MAX}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            aria-invalid={emojiError !== null || undefined}
            aria-describedby={emojiError !== null ? emojiErrorId : undefined}
          />
        </div>
        <div id={emojiGridId} className="emoji-grid">
          {shownEmoji.map((option) => (
            <label key={option.char} className="emoji-cell">
              <input
                type="radio"
                name={`${id}-emoji`}
                value={option.char}
                className="sr-only"
                aria-label={option.name}
                checked={emoji === option.char}
                onChange={() => pickEmoji(option.char)}
              />
              <span className="emoji-cell__face" aria-hidden="true">
                {option.char}
              </span>
            </label>
          ))}
        </div>
        <Chip
          className="editor__more"
          aria-expanded={allEmoji}
          aria-controls={emojiGridId}
          onClick={() => setAllEmoji((v) => !v)}
        >
          {allEmoji ? 'Fewer emoji' : 'More emoji'}
          <Icon name="chevronRight" size={16} className={cx('editor__more-chevron', allEmoji && 'is-open')} />
        </Chip>
        <p id={emojiErrorId} className="field__error" role="status">
          {emojiError}
        </p>
      </fieldset>

      <fieldset className="fieldset">
        <legend className="small-caps fieldset__legend">Colour</legend>
        <div className="swatches">
          {HABIT_COLORS.map((c) => (
            <label key={c} className={cx('swatch', toneClass(c))}>
              <input
                type="radio"
                name={`${id}-color`}
                value={c}
                className="sr-only"
                aria-label={COLOR_NAMES[c]}
                checked={color === c}
                onChange={() => setColor(c)}
              />
              <span className="swatch__dot" aria-hidden="true" />
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor={noteId} className="field__label">
          <span className="small-caps">Note</span>
          <span className="field__count tabular" aria-hidden="true">
            {note.length}/{HABIT_NOTE_MAX}
          </span>
        </label>
        <input
          id={noteId}
          className="field__input"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={HABIT_NOTE_MAX}
          placeholder="e.g. 2 hours, by 8 AM"
          autoComplete="off"
          enterKeyHint="done"
          aria-describedby={`${id}-note-hint`}
        />
        <p id={`${id}-note-hint`} className="field__hint">
          Optional. Shows under the name on Today.
        </p>
      </div>

      <fieldset className="fieldset" aria-describedby={daysError ? daysErrorId : undefined}>
        <legend className="small-caps fieldset__legend">Days</legend>
        <div ref={daysRef} className="editor__days">
          {ALL_DAYS.map((day) => (
            <Chip
              key={day}
              selected={days.includes(day)}
              tone={color}
              aria-label={WEEKDAY_LONG[day]}
              onClick={() => toggleDay(day)}
            >
              {WEEKDAY_SHORT[day]}
            </Chip>
          ))}
        </div>
        <div className="editor__presets">
          <Chip onClick={() => setDays([...ALL_DAYS])}>Every day</Chip>
          <Chip onClick={() => setDays([...WEEKDAYS])}>Weekdays</Chip>
          <Chip onClick={() => setDays([...WEEKENDS])}>Weekends</Chip>
        </div>
        <p id={daysErrorId} className="field__error" role="status">
          {daysError}
        </p>
      </fieldset>

      <div className="editor__save">
        {isEditing ? (
          <p className="editor__gone" role="status">
            {gone ? 'This tracker was deleted on another device.' : null}
          </p>
        ) : null}
        <Button type="submit" size="lg" full disabled={gone}>
          Save
        </Button>
      </div>

      {isEditing ? (
        confirmDelete && !gone ? (
          <InlineConfirm
            title={`Delete ${trackerName} and its history?`}
            body={
              completionCount === 0
                ? 'Nothing has been checked off yet. There is no undo.'
                : `${completionCount} check-in${completionCount === 1 ? '' : 's'} will be removed. There is no undo.`
            }
            confirmLabel="Delete"
            onConfirm={remove}
            onCancel={cancelDelete}
          />
        ) : (
          <div className="editor__manage">
            {archived ? (
              <Button variant="subtle" icon={<Icon name="restore" size={20} />} onClick={restore} disabled={gone}>
                Restore
              </Button>
            ) : (
              <Button variant="subtle" icon={<Icon name="archive" size={20} />} onClick={archive} disabled={gone}>
                Archive
              </Button>
            )}
            <Button
              ref={deleteRef}
              variant="danger"
              icon={<Icon name="trash" size={20} />}
              onClick={() => setConfirmDelete(true)}
              disabled={gone}
            >
              Delete
            </Button>
            <p className="editor__manage-hint">
              {archived
                ? 'Archived trackers keep their history. Restore puts this one back on Today.'
                : 'Archiving keeps the history. Restore it any time from Progress.'}
            </p>
          </div>
        )
      ) : null}
    </form>
  );
}
