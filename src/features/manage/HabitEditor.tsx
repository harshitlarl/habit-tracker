import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import useStore, { normalizeDays } from '../../lib/store';
import { HABIT_COLORS, type Habit, type HabitColor, type Weekday } from '../../lib/types';
import { WEEKDAY_LONG, WEEKDAY_SHORT } from '../../lib/dates';
import { habitById, toneClass } from '../../lib/selectors';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { cx } from '../../components/cx';
import { InlineConfirm } from './InlineConfirm';
import { ALL_DAYS, WEEKDAYS, WEEKENDS } from './daysSummary';
import { DEFAULT_EMOJI, EMOJI_OPTIONS, firstGrapheme, isCuratedEmoji } from './emojis';
import './HabitEditor.css';

export interface HabitEditorProps {
  open: boolean;
  /** Edit an existing tracker when set; create a new one otherwise. */
  habitId?: string;
  onClose: () => void;
}

const NAME_MAX = 40;
const NOTE_MAX = 40;

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

function EditorForm({ habit, habitId, onClose }: EditorFormProps) {
  const id = useId();
  const isEditing = habitId !== undefined;
  const addHabit = useStore((s) => s.addHabit);
  const updateHabit = useStore((s) => s.updateHabit);
  const archiveHabit = useStore((s) => s.archiveHabit);
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
  const [color, setColor] = useState<HabitColor>(() => habit?.color ?? suggestColor(useStore.getState().habits));
  const [note, setNote] = useState(habit?.note ?? '');
  const [days, setDays] = useState<Weekday[]>(() => (habit ? normalizeDays(habit.days) : [...ALL_DAYS]));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);

  const trimmedName = name.trim();
  const nameError =
    trimmedName.length === 0
      ? 'Give it a name.'
      : trimmedName.length > NAME_MAX
        ? `Keep it under ${NAME_MAX} characters.`
        : null;
  const emojiError = emoji === '' ? 'Pick an emoji.' : null;
  const daysError = days.length === 0 ? 'Pick at least one day.' : null;
  const valid = nameError === null && emojiError === null && daysError === null;
  const showNameError = nameTouched && nameError !== null;

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
    if (!valid) {
      setNameTouched(true);
      return;
    }
    const input = { name: trimmedName, emoji, color, note: note.trim(), days: normalizeDays(days) };
    if (habitId !== undefined && habitById(useStore.getState().habits, habitId)) {
      updateHabit(habitId, input);
    } else {
      addHabit(input);
    }
    onClose();
  }

  function archive(): void {
    if (habitId === undefined) return;
    archiveHabit(habitId);
    onClose();
  }

  function remove(): void {
    if (habitId === undefined) return;
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
  const daysErrorId = `${id}-days-error`;
  const trackerName = habit?.name ?? 'this tracker';

  return (
    <form className="editor" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={nameId} className="field__label">
          <span className="small-caps">Name</span>
          <span className="field__count tabular" aria-hidden="true">
            {name.length}/{NAME_MAX}
          </span>
        </label>
        <input
          id={nameId}
          className="field__input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setNameTouched(true)}
          maxLength={NAME_MAX}
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
            id={customId}
            className="field__input editor__custom"
            type="text"
            value={customEmoji}
            onChange={onCustomEmoji}
            placeholder="Or type your own"
            maxLength={16}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
          />
        </div>
        <div className="emoji-grid">
          {EMOJI_OPTIONS.map((option) => (
            <label key={option.char} className="emoji-cell">
              <input
                type="radio"
                name={`${id}-emoji`}
                value={option.char}
                className="sr-only"
                checked={emoji === option.char}
                onChange={() => pickEmoji(option.char)}
              />
              <span className="emoji-cell__face" aria-hidden="true">
                {option.char}
              </span>
              <span className="sr-only">{option.name}</span>
            </label>
          ))}
        </div>
        <p className="field__error" role="status">
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
                checked={color === c}
                onChange={() => setColor(c)}
              />
              <span className="swatch__dot" aria-hidden="true" />
              <span className="sr-only">{COLOR_NAMES[c]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor={noteId} className="field__label">
          <span className="small-caps">Note</span>
          <span className="field__count tabular" aria-hidden="true">
            {note.length}/{NOTE_MAX}
          </span>
        </label>
        <input
          id={noteId}
          className="field__input"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
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
        <div className="editor__days">
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
        <Button type="submit" size="lg" full disabled={!valid}>
          Save
        </Button>
      </div>

      {isEditing ? (
        confirmDelete ? (
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
            <Button variant="subtle" icon={<Icon name="archive" size={20} />} onClick={archive}>
              Archive
            </Button>
            <Button
              ref={deleteRef}
              variant="danger"
              icon={<Icon name="trash" size={20} />}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
            <p className="editor__manage-hint">Archiving keeps the history. Restore it any time from Progress.</p>
          </div>
        )
      ) : null}
    </form>
  );
}
