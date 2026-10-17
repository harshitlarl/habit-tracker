import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import {
  HABIT_COLORS,
  HABIT_EMOJI_MAX,
  HABIT_NAME_MAX,
  HABIT_NOTE_MAX,
  TASK_NOTE_MAX,
  TASK_TITLE_MAX,
  isHabitColor,
  isIdLike,
  isTimeString,
  isValidId,
  isWeekday,
  type AppData,
  type Completions,
  type DateKey,
  type Habit,
  type HabitColor,
  type Settings,
  type Task,
  type Theme,
  type Weekday,
} from './types';
import { addDays, isDateKey, isScheduled, todayKey } from './dates';
import { newId } from './ids';
import { isDone } from './selectors';
import { clampText } from './text';
import { clearAllBaselines } from './sync/baseline';
import { sameData } from './sync/merge';
import { sameTasks } from './sync/tasksMerge';
import type { LocalData, LocalTasks } from './sync/types';

export const STORAGE_KEY = 'momentum-v1';

export const DEFAULT_SETTINGS: Settings = { theme: 'system', installHintDismissed: false };

/*
 * Field limits, the same ones the editor enforces: a backup must not install a tracker the editor
 * could never have saved (and could not re-save without the owner retyping the field). They live in
 * types.ts, shared with the cloud parser (sync/merge.ts), and are re-exported here for existing imports.
 */
export { HABIT_EMOJI_MAX, HABIT_NAME_MAX, HABIT_NOTE_MAX, TASK_NOTE_MAX, TASK_TITLE_MAX } from './types';

export interface HabitInput {
  name: string;
  emoji: string;
  color: HabitColor;
  note?: string;
  days: Weekday[];
  createdAt?: DateKey;
}

export type HabitPatch = Partial<Omit<Habit, 'id' | 'createdAt' | 'order'>>;

/** A new one-time task (SPEC §14.3). `time` must be 'HH:mm' or it is dropped; blank `note` is dropped. */
export interface TaskInput {
  title: string;
  date: DateKey;
  time?: string;
  note?: string;
  createdAt?: DateKey;
}

/** `note` and `time` are clearable (undefined or ''); `title` never becomes blank; `date` must be a real date. */
export type TaskPatch = Partial<Pick<Task, 'title' | 'note' | 'date' | 'time'>>;

export type ImportResult = { ok: true } | { ok: false; error: string };

export type ValidationResult = { ok: true; data: AppData } | { ok: false; error: string };

export interface StoreState {
  habits: Habit[];
  completions: Completions;
  settings: Settings;
  /**
   * Tombstones (SPEC §13.4): ids of trackers deleted on this device, or learned from the cloud.
   * Kept so cloud sync never resurrects a deleted tracker. Cleared only by resetAll.
   */
  deletedIds: string[];
  /** One-time tasks (SPEC §14): dated items next to the trackers; never part of streaks or the ring. */
  tasks: Task[];
  /** Tombstones of deleted tasks, kept for the same reason as `deletedIds`. Cleared only by resetAll. */
  deletedTaskIds: string[];

  addHabit: (input: HabitInput) => Habit;
  updateHabit: (id: string, patch: HabitPatch) => void;
  archiveHabit: (id: string) => void;
  unarchiveHabit: (id: string) => void;
  deleteHabit: (id: string) => void;
  reorderHabits: (orderedIds: string[]) => void;

  addTask: (input: TaskInput) => Task;
  updateTask: (id: string, patch: TaskPatch) => void;
  /** `today` is the LOCAL date recorded as `doneAt` when checking off (defaults to todayKey()). */
  setTaskDone: (id: string, done: boolean, today?: DateKey) => void;
  toggleTask: (id: string, today?: DateKey) => void;
  /** Removes the task and leaves a tombstone in `deletedTaskIds`. Unknown ids are ignored. */
  deleteTask: (id: string) => void;

  toggleCompletion: (habitId: string, dateKey: DateKey) => void;
  setCompletion: (habitId: string, dateKey: DateKey, done: boolean) => void;

  setTheme: (theme: Theme) => void;
  dismissInstallHint: () => void;

  exportData: () => AppData;
  importData: (raw: unknown) => ImportResult;
  /** Local only: wipes trackers, completions, tasks, tombstones and settings on this device. */
  resetAll: () => void;

  /**
   * Sync engine only (SPEC §13.4): replace habits, completions and tombstones wholesale with the
   * reconciled cloud state. No-op (no set, no persist write) when nothing changed.
   */
  applyRemote: (data: LocalData) => void;
  /** Sync engine only (SPEC §14.8): the same for tasks and their tombstones. No-op when nothing changed. */
  applyRemoteTasks: (data: LocalTasks) => void;
}

type PersistedState = Pick<
  StoreState,
  'habits' | 'completions' | 'settings' | 'deletedIds' | 'tasks' | 'deletedTaskIds'
>;
/** v1: pre-sync (no tombstones); v2: tombstones; v3: one-time tasks and their tombstones. */
export const PERSIST_VERSION = 3;

/* ---------- helpers ---------- */

/** Unique, ascending. */
export function normalizeDays(days: readonly Weekday[]): Weekday[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

const EVERY_DAY: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * Days for a stored habit: normalised and never empty. The data model requires at least one
 * scheduled weekday (the editor enforces it too), so an empty selection falls back to the
 * default of every day rather than producing a tracker that is never due and cannot be re-imported.
 */
function scheduleDays(days: readonly Weekday[]): Weekday[] {
  const normalized = normalizeDays(days);
  return normalized.length > 0 ? normalized : [...EVERY_DAY];
}

/** Already unique and ascending — the exact shape the store writes and the importer demands. */
const isSortedUnique = (days: readonly Weekday[]): boolean =>
  days.every((d, i) => i === 0 || d > (days[i - 1] ?? -1));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** What the import flow says about JSON that some other app (or a person) wrote. */
export const NOT_A_BACKUP = 'This file is not a Momentum backup.';

/**
 * Strict shape validation of a backup file (version, arrays, ids, colours, days, date keys,
 * completion references, settings). Returns normalised data ready to replace the store.
 * Exposed so the import flow can show a preview before confirming.
 */
export function validateAppData(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return fail('The file is not a Momentum backup (expected a JSON object).');
  // An object without a numeric version, or without trackers and check-ins at all, is somebody else's
  // JSON: say so rather than "Unsupported backup version: undefined." A real backup carrying a number
  // this build does not know (a newer Momentum) keeps naming that number.
  if (
    typeof raw.version !== 'number' ||
    !Number.isFinite(raw.version) ||
    raw.habits === undefined ||
    raw.completions === undefined
  ) {
    return fail(NOT_A_BACKUP);
  }
  if (raw.version !== 1) return fail(`Unsupported backup version: ${raw.version}.`);
  if (!Array.isArray(raw.habits)) return fail('"habits" must be an array.');
  if (!isRecord(raw.completions)) return fail('"completions" must be an object.');
  if (!isRecord(raw.settings)) return fail('"settings" must be an object.');
  if (raw.exportedAt !== undefined && typeof raw.exportedAt !== 'string') {
    return fail('"exportedAt" must be a string.');
  }
  if (raw.deletedIds !== undefined) {
    if (!Array.isArray(raw.deletedIds)) return fail('"deletedIds" must be an array.');
    if (!raw.deletedIds.every(isValidId)) return fail('"deletedIds" must contain only tracker ids.');
  }

  const ids = new Set<string>();
  const habits: Habit[] = [];
  for (const [index, item] of raw.habits.entries()) {
    const where = `Tracker #${index + 1}`;
    if (!isRecord(item)) return fail(`${where} is not an object.`);
    const { id, name, emoji, color, note, days, createdAt, archivedAt, order } = item;
    if (!isValidId(id)) return fail(`${where} has an invalid id.`);
    if (ids.has(id)) return fail(`${where} duplicates the id "${id}".`);
    if (typeof name !== 'string' || name.trim() === '') return fail(`${where} needs a name.`);
    const trimmedName = name.trim();
    if (trimmedName.length > HABIT_NAME_MAX) {
      return fail(`${where} has a name longer than ${HABIT_NAME_MAX} characters.`);
    }
    if (typeof emoji !== 'string') return fail(`${where} has an invalid emoji.`);
    const trimmedEmoji = emoji.trim();
    if (trimmedEmoji.length > HABIT_EMOJI_MAX) {
      return fail(`${where} has an emoji longer than ${HABIT_EMOJI_MAX} characters.`);
    }
    if (!isHabitColor(color)) return fail(`${where} has an unknown colour "${String(color)}".`);
    if (note !== undefined && typeof note !== 'string') return fail(`${where} has an invalid note.`);
    const trimmedNote = note?.trim();
    if (trimmedNote !== undefined && trimmedNote.length > HABIT_NOTE_MAX) {
      return fail(`${where} has a note longer than ${HABIT_NOTE_MAX} characters.`);
    }
    if (!Array.isArray(days) || days.length === 0 || !days.every(isWeekday)) {
      return fail(`${where} has invalid days (expected a non-empty list of 0–6).`);
    }
    if (!isSortedUnique(days)) {
      return fail(`${where} has days out of order or repeated (expected unique weekdays, ascending).`);
    }
    if (!isDateKey(createdAt)) return fail(`${where} has an invalid createdAt date.`);
    if (archivedAt !== undefined && !isDateKey(archivedAt)) {
      return fail(`${where} has an invalid archivedAt date.`);
    }
    if (typeof order !== 'number' || !Number.isFinite(order)) return fail(`${where} has an invalid order.`);

    ids.add(id);
    // Trimmed like addHabit / updateHabit store them, so an import re-exports byte for byte.
    const habit: Habit = {
      id,
      name: trimmedName,
      emoji: trimmedEmoji,
      color,
      days: normalizeDays(days),
      createdAt,
      order,
    };
    if (trimmedNote) habit.note = trimmedNote;
    if (archivedAt) habit.archivedAt = archivedAt;
    habits.push(habit);
  }

  const completions: Completions = {};
  for (const [habitId, dates] of Object.entries(raw.completions)) {
    if (!ids.has(habitId)) return fail(`Completions reference an unknown tracker "${habitId}".`);
    if (!isRecord(dates)) return fail(`Completions for "${habitId}" must be an object.`);
    const set: Record<DateKey, true> = {};
    for (const [k, v] of Object.entries(dates)) {
      if (!isDateKey(k)) return fail(`Invalid date "${k}" in completions.`);
      if (v !== true) return fail(`Completion values must be true (found ${JSON.stringify(v)}).`);
      set[k] = true;
    }
    if (Object.keys(set).length > 0) completions[habitId] = set;
  }

  const { theme, installHintDismissed } = raw.settings;
  if (!isTheme(theme)) return fail(`Unknown theme "${String(theme)}".`);
  if (typeof installHintDismissed !== 'boolean') {
    return fail('"settings.installHintDismissed" must be true or false.');
  }

  // One-time tasks (SPEC §14.3): optional in the file (older backups), strict when present.
  const taskIds = new Set<string>();
  const tasks: Task[] = [];
  if (raw.tasks !== undefined) {
    if (!Array.isArray(raw.tasks)) return fail('"tasks" must be an array.');
    for (const [index, item] of raw.tasks.entries()) {
      const where = `Task #${index + 1}`;
      if (!isRecord(item)) return fail(`${where} is not an object.`);
      const { id, title, note, date, time, done, doneAt, createdAt } = item;
      if (!isValidId(id)) return fail(`${where} has an invalid id.`);
      if (taskIds.has(id)) return fail(`${where} duplicates the id "${id}".`);
      if (typeof title !== 'string' || title.trim() === '') return fail(`${where} needs a title.`);
      const trimmedTitle = title.trim();
      if (trimmedTitle.length > TASK_TITLE_MAX) {
        return fail(`${where} has a title longer than ${TASK_TITLE_MAX} characters.`);
      }
      if (note !== undefined && typeof note !== 'string') return fail(`${where} has an invalid note.`);
      const trimmedNote = note?.trim();
      if (trimmedNote !== undefined && trimmedNote.length > TASK_NOTE_MAX) {
        return fail(`${where} has a note longer than ${TASK_NOTE_MAX} characters.`);
      }
      if (!isDateKey(date)) return fail(`${where} has an invalid date.`);
      if (time !== undefined && !isTimeString(time)) return fail(`${where} has an invalid time (expected HH:mm).`);
      if (typeof done !== 'boolean') return fail(`${where} has an invalid done flag.`);
      if (doneAt !== undefined && !isDateKey(doneAt)) return fail(`${where} has an invalid doneAt date.`);
      if (!isDateKey(createdAt)) return fail(`${where} has an invalid createdAt date.`);

      taskIds.add(id);
      const task: Task = { id, title: trimmedTitle, date, done, createdAt };
      if (trimmedNote) task.note = trimmedNote;
      if (isTimeString(time)) task.time = time;
      if (done && isDateKey(doneAt)) task.doneAt = doneAt; // doneAt only means something while done
      tasks.push(task);
    }
  }
  if (raw.deletedTaskIds !== undefined) {
    if (!Array.isArray(raw.deletedTaskIds)) return fail('"deletedTaskIds" must be an array.');
    if (!raw.deletedTaskIds.every(isValidId)) return fail('"deletedTaskIds" must contain only task ids.');
  }

  const data: AppData = {
    version: 1,
    habits,
    completions,
    settings: { theme, installHintDismissed },
  };
  if (typeof raw.exportedAt === 'string') data.exportedAt = raw.exportedAt;
  if (Array.isArray(raw.deletedIds)) {
    // Validated above; a tracker present in the file is, by definition, not deleted.
    data.deletedIds = uniqueIds(raw.deletedIds as string[]).filter((id) => !ids.has(id));
  }
  if (Array.isArray(raw.tasks)) data.tasks = tasks;
  if (Array.isArray(raw.deletedTaskIds)) {
    data.deletedTaskIds = uniqueIds(raw.deletedTaskIds as string[]).filter((id) => !taskIds.has(id));
  }
  return { ok: true, data };
}

/** Unique, insertion order kept. */
export function uniqueIds(idList: readonly string[]): string[] {
  return [...new Set(idList)];
}

/* ---------- storage: localStorage when it works, in-memory otherwise (tests, private mode) ---------- */

const memory = new Map<string, string>();

/** Whether this device is keeping what the owner does, published for Settings ("not saving changes"). */
export interface StorageHealth {
  /** The error thrown by the latest attempted localStorage write (quota, storage disabled); null once a write lands. */
  error: Error | null;
  /**
   * True in a browser (a window exists) that offers no usable localStorage at all — missing, or access
   * refused: every change lives in memory only. Never set outside a browser (tests, node), where the
   * in-memory copy is the expected storage.
   */
  unavailable: boolean;
}

/**
 * Storage health, reactive (a tiny zustand store, not persisted). Updated by every write persist makes
 * through safeStorage and by importData's pre-write (tryWriteRecord); a write that lands clears it.
 */
export const useStorageHealth = create<StorageHealth>()(() => ({ error: null, unavailable: false }));

/** Publishes the outcome of a write attempt; subscribers hear only actual changes. */
function recordWrite(error: Error | null, unavailable: boolean): void {
  const current = useStorageHealth.getState();
  if (current.error === error && current.unavailable === unavailable) return;
  useStorageHealth.setState({ error, unavailable });
}

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/** A browser is running this code, so a missing localStorage means changes will not survive a reload. */
const inBrowser = (): boolean => typeof window !== 'undefined';

/**
 * Why the most recent localStorage write failed (quota exceeded, storage disabled), or null when it
 * succeeded or there was no browser storage to write to. While it is set, changes live only in
 * memory and will not survive a reload: `importData` refuses to report success in that state, and
 * Settings warns that changes are not being saved (see useStorageHealth).
 */
export function lastStorageError(): Error | null {
  return useStorageHealth.getState().error;
}

/** Names browsers give a full-storage failure (WebKit/Blink, then Gecko). */
const QUOTA_ERROR_NAMES: ReadonlySet<string> = new Set(['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']);

function describeWriteError(error: Error): string {
  return QUOTA_ERROR_NAMES.has(error.name)
    ? 'This backup is too large to store on this device.'
    : 'This device is not saving changes right now, so the backup was not imported.';
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Write the record persist would write for `state` (same key, same shape, same size) straight to the
 * browser, before the store changes. Returns the browser's error when it refuses, null when the write
 * landed or there is no browser storage to refuse it. The storage health follows the outcome, as it
 * does for persist's own writes.
 */
function tryWriteRecord(state: PersistedState): Error | null {
  const storage = browserStorage();
  if (!storage) {
    recordWrite(null, inBrowser());
    return null;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ state, version: PERSIST_VERSION }));
    recordWrite(null, false);
    return null;
  } catch (error) {
    const refused = toError(error);
    recordWrite(refused, false);
    return refused;
  }
}

const safeStorage: StateStorage = {
  getItem: (name) => {
    const storage = browserStorage();
    // Known at launch (hydration reads first): a browser with no usable localStorage keeps nothing.
    if (!storage && inBrowser()) recordWrite(null, true);
    try {
      const value = storage?.getItem(name);
      if (value !== undefined && value !== null) return value;
    } catch {
      /* fall through to memory */
    }
    return memory.get(name) ?? null;
  },
  setItem: (name, value) => {
    memory.set(name, value);
    const storage = browserStorage();
    if (!storage) {
      recordWrite(null, inBrowser());
      return;
    }
    try {
      storage.setItem(name, value);
      recordWrite(null, false);
    } catch (error) {
      // Quota exceeded / storage disabled: the in-memory copy keeps the session working. persist
      // writes synchronously inside every action's set(), after the state change has applied, so
      // throwing here would surface as an error in each tap; the failure is recorded instead, checked
      // where a false "saved" would mislead (importData) and shown in Settings (useStorageHealth).
      recordWrite(toError(error), false);
    }
  },
  removeItem: (name) => {
    memory.delete(name);
    try {
      browserStorage()?.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/* ---------- hydration repair (SPEC §13.4: a damaged blob never crashes hydration) ---------- */

/**
 * A persisted tracker, repaired field by field. Only a record without an id is dropped (nothing could
 * address it); an id the cloud could not hold (a hand-edited backup imported before ids were checked
 * for that) is replaced by a fresh one, and every other damaged field falls back to something the
 * editor could have saved, so a corrupted blob can neither crash a view nor produce an export that
 * fails validateAppData. Valid records come through unchanged.
 */
function repairHabit(raw: unknown): Habit | null {
  if (!isRecord(raw) || !isIdLike(raw.id)) return null;
  const name = typeof raw.name === 'string' ? clampText(raw.name, HABIT_NAME_MAX) : '';
  const habit: Habit = {
    id: isValidId(raw.id) ? raw.id : newId(),
    name: name || 'Untitled',
    emoji: typeof raw.emoji === 'string' ? clampText(raw.emoji, HABIT_EMOJI_MAX) : '',
    color: isHabitColor(raw.color) ? raw.color : HABIT_COLORS[0],
    days: scheduleDays(Array.isArray(raw.days) ? raw.days.filter(isWeekday) : []),
    createdAt: isDateKey(raw.createdAt) ? raw.createdAt : todayKey(),
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0,
  };
  const note = typeof raw.note === 'string' ? clampText(raw.note, HABIT_NOTE_MAX) : '';
  if (note) habit.note = note;
  if (isDateKey(raw.archivedAt)) habit.archivedAt = raw.archivedAt;
  return habit;
}

/**
 * A persisted task, repaired field by field like repairHabit: only a record without an id is dropped, a
 * blank title becomes 'Untitled', a damaged date falls back to createdAt (then today), a damaged optional
 * field is dropped, and `doneAt` is kept only while done.
 */
function repairTask(raw: unknown): Task | null {
  if (!isRecord(raw) || !isIdLike(raw.id)) return null;
  const title = typeof raw.title === 'string' ? clampText(raw.title, TASK_TITLE_MAX) : '';
  const createdAt = isDateKey(raw.createdAt) ? raw.createdAt : todayKey();
  const done = raw.done === true;
  const task: Task = {
    id: isValidId(raw.id) ? raw.id : newId(),
    title: title || 'Untitled',
    date: isDateKey(raw.date) ? raw.date : createdAt,
    done,
    createdAt,
  };
  const note = typeof raw.note === 'string' ? clampText(raw.note, TASK_NOTE_MAX) : '';
  if (note) task.note = note;
  if (isTimeString(raw.time)) task.time = raw.time;
  if (done && isDateKey(raw.doneAt)) task.doneAt = raw.doneAt;
  return task;
}

/**
 * Re-validate a persisted blob field by field: damaged trackers and tasks are repaired, duplicate ids keep
 * their first record, orphan or malformed completions are dropped, settings fall back to `current`,
 * tombstones are deduplicated and never name a tracker that is present. Hydration happens once at
 * launch, when `current` is the initial state, so the blob (not memory) is the source of truth.
 */
function repairPersisted(persisted: unknown, current: PersistedState): PersistedState {
  const p: Record<string, unknown> = isRecord(persisted) ? persisted : {};

  const habits: Habit[] = [];
  const ids = new Set<string>();
  /** Stored id → the fresh id repairHabit gave a tracker the cloud could not address; its check-ins follow it. */
  const rekeyed = new Map<string, string>();
  for (const item of Array.isArray(p.habits) ? p.habits : []) {
    const habit = repairHabit(item);
    if (!habit) continue;
    const storedId = isRecord(item) && typeof item.id === 'string' ? item.id : habit.id;
    if (ids.has(habit.id) || rekeyed.has(storedId)) continue;
    if (storedId !== habit.id) rekeyed.set(storedId, habit.id);
    ids.add(habit.id);
    habits.push(habit);
  }

  const completions: Completions = {};
  if (isRecord(p.completions)) {
    for (const [storedId, dates] of Object.entries(p.completions)) {
      const habitId = rekeyed.get(storedId) ?? storedId;
      if (!ids.has(habitId) || !isRecord(dates)) continue;
      const set: Record<DateKey, true> = {};
      for (const [k, v] of Object.entries(dates)) if (v === true && isDateKey(k)) set[k] = true;
      if (Object.keys(set).length > 0) completions[habitId] = set;
    }
  }

  const s: Record<string, unknown> = isRecord(p.settings) ? p.settings : {};
  const settings: Settings = {
    theme: isTheme(s.theme) ? s.theme : current.settings.theme,
    installHintDismissed:
      typeof s.installHintDismissed === 'boolean' ? s.installHintDismissed : current.settings.installHintDismissed,
  };

  const deletedIds = Array.isArray(p.deletedIds)
    ? uniqueIds(p.deletedIds.filter(isValidId)).filter((id) => !ids.has(id))
    : [];

  const tasks: Task[] = [];
  const taskIds = new Set<string>();
  /** Stored ids repairTask re-keyed, so a second record under the same unusable id is dropped like a duplicate. */
  const rekeyedTasks = new Set<string>();
  for (const item of Array.isArray(p.tasks) ? p.tasks : []) {
    const task = repairTask(item);
    if (!task) continue;
    const storedId = isRecord(item) && typeof item.id === 'string' ? item.id : task.id;
    if (taskIds.has(task.id) || rekeyedTasks.has(storedId)) continue;
    if (storedId !== task.id) rekeyedTasks.add(storedId);
    taskIds.add(task.id);
    tasks.push(task);
  }
  const deletedTaskIds = Array.isArray(p.deletedTaskIds)
    ? uniqueIds(p.deletedTaskIds.filter(isValidId)).filter((id) => !taskIds.has(id))
    : [];

  return { habits, completions, settings, deletedIds, tasks, deletedTaskIds };
}

/* ---------- store ---------- */

const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      habits: [],
      completions: {},
      settings: { ...DEFAULT_SETTINGS },
      deletedIds: [],
      tasks: [],
      deletedTaskIds: [],

      addHabit: (input) => {
        const { habits } = get();
        const order = habits.reduce((max, h) => Math.max(max, h.order), -1) + 1;
        const habit: Habit = {
          id: newId(),
          name: input.name.trim(),
          emoji: input.emoji.trim(),
          color: input.color,
          days: scheduleDays(input.days),
          createdAt: input.createdAt ?? todayKey(),
          order,
        };
        const note = input.note?.trim();
        if (note) habit.note = note;
        set({ habits: [...habits, habit] });
        return habit;
      },

      // Field by field (never `{ ...h, ...patch }`): a sparse patch with explicit `undefined`
      // values must not blank required fields. `note` / `archivedAt` are clearable.
      updateHabit: (id, patch) =>
        set((s) => ({
          habits: s.habits.map((h) => {
            if (h.id !== id) return h;
            const next: Habit = { ...h };
            if (typeof patch.name === 'string') next.name = patch.name.trim();
            if (typeof patch.emoji === 'string') next.emoji = patch.emoji.trim();
            if (patch.color !== undefined) next.color = patch.color;
            if (patch.days !== undefined) next.days = scheduleDays(patch.days);
            if ('note' in patch) {
              const note = patch.note?.trim();
              if (note) next.note = note;
              else delete next.note;
            }
            if ('archivedAt' in patch) {
              if (patch.archivedAt) next.archivedAt = patch.archivedAt;
              else delete next.archivedAt;
            }
            return next;
          }),
        })),

      // archivedAt is exclusive (isScheduled needs k < archivedAt). Archiving after today's check-in
      // moves it to tomorrow so the completed day stays a scheduled, done day — the streak and rate
      // the owner saw a moment earlier are what the archive card keeps — instead of becoming a
      // bonus. Otherwise it is today, so a pending day is neither due nor a miss (SPEC §5 says
      // todayKey() unconditionally; the done-today case is the one deliberate deviation).
      // Already-archived trackers keep their original archivedAt: moving it forward would turn
      // the gap into scheduled-but-missed days and rewrite streaks and rates retroactively.
      archiveHabit: (id) =>
        set((s) => ({
          habits: s.habits.map((h) => {
            if (h.id !== id || h.archivedAt) return h;
            const today = todayKey();
            const doneToday = isScheduled(h, today) && isDone(s.completions, h.id, today);
            return { ...h, archivedAt: doneToday ? addDays(today, 1) : today };
          }),
        })),

      unarchiveHabit: (id) =>
        set((s) => ({
          habits: s.habits.map((h) => {
            if (h.id !== id) return h;
            const next: Habit = { ...h };
            delete next.archivedAt;
            return next;
          }),
        })),

      // Leaves a tombstone so a synced copy of the tracker cannot come back (SPEC §13.4).
      deleteHabit: (id) =>
        set((s) => {
          if (!s.habits.some((h) => h.id === id)) return s;
          const completions = { ...s.completions };
          delete completions[id];
          return {
            habits: s.habits.filter((h) => h.id !== id),
            completions,
            deletedIds: uniqueIds([...s.deletedIds, id]),
          };
        }),

      reorderHabits: (orderedIds) =>
        set((s) => {
          const byId = new Map(s.habits.map((h) => [h.id, h] as const));
          const seen = new Set<string>();
          const sequence: Habit[] = [];
          for (const id of orderedIds) {
            const h = byId.get(id);
            if (h && !seen.has(id)) {
              seen.add(id);
              sequence.push(h);
            }
          }
          const rest = s.habits.filter((h) => !seen.has(h.id)).sort((a, b) => a.order - b.order);
          const habits = [...sequence, ...rest].map((h, i) => (h.order === i ? h : { ...h, order: i }));
          return { habits };
        }),

      addTask: (input) => {
        const title = clampText(input.title, TASK_TITLE_MAX);
        const createdAt = isDateKey(input.createdAt) ? input.createdAt : todayKey();
        const task: Task = {
          id: newId(),
          title: title || 'Untitled',
          date: isDateKey(input.date) ? input.date : createdAt,
          done: false,
          createdAt,
        };
        const note = typeof input.note === 'string' ? clampText(input.note, TASK_NOTE_MAX) : '';
        if (note) task.note = note;
        if (isTimeString(input.time)) task.time = input.time;
        set((s) => ({ tasks: [...s.tasks, task] }));
        return task;
      },

      // Field by field, like updateHabit. `note` / `time` are clearable with undefined or ''; a blank
      // title, an invalid date and an invalid non-empty time are ignored (SPEC §14.3).
      updateTask: (id, patch) =>
        set((s) => {
          if (!s.tasks.some((t) => t.id === id)) return s;
          return {
            tasks: s.tasks.map((t) => {
              if (t.id !== id) return t;
              const next: Task = { ...t };
              if (typeof patch.title === 'string') {
                const title = clampText(patch.title, TASK_TITLE_MAX);
                if (title) next.title = title;
              }
              if ('note' in patch) {
                const note = typeof patch.note === 'string' ? clampText(patch.note, TASK_NOTE_MAX) : '';
                if (note) next.note = note;
                else delete next.note;
              }
              if (isDateKey(patch.date)) next.date = patch.date;
              if ('time' in patch) {
                if (isTimeString(patch.time)) next.time = patch.time;
                else if (patch.time === undefined || patch.time === '') delete next.time;
              }
              return next;
            }),
          };
        }),

      // `doneAt` is the LOCAL date of the check-off, which differs from `date` for a task done late.
      setTaskDone: (id, done, today = todayKey()) =>
        set((s) => {
          const task = s.tasks.find((t) => t.id === id);
          if (!task || task.done === done) return s;
          const doneAt = isDateKey(today) ? today : todayKey();
          return {
            tasks: s.tasks.map((t) => {
              if (t.id !== id) return t;
              const next: Task = { ...t, done };
              if (done) next.doneAt = doneAt;
              else delete next.doneAt;
              return next;
            }),
          };
        }),

      toggleTask: (id, today) => {
        const task = get().tasks.find((t) => t.id === id);
        if (task) get().setTaskDone(id, !task.done, today);
      },

      // Leaves a tombstone so a synced copy of the task cannot come back (SPEC §14.3).
      deleteTask: (id) =>
        set((s) => {
          if (!s.tasks.some((t) => t.id === id)) return s;
          return {
            tasks: s.tasks.filter((t) => t.id !== id),
            deletedTaskIds: uniqueIds([...s.deletedTaskIds, id]),
          };
        }),

      setCompletion: (habitId, dateKey, done) =>
        set((s) => {
          // Unknown ids and malformed keys are ignored so the data always passes the importer.
          if (!isDateKey(dateKey) || !s.habits.some((h) => h.id === habitId)) return s;
          const current = s.completions[habitId] ?? {};
          const already = current[dateKey] === true;
          if (done === already) return s;
          const completions = { ...s.completions };
          if (done) {
            completions[habitId] = { ...current, [dateKey]: true };
          } else {
            const dates = { ...current };
            delete dates[dateKey];
            if (Object.keys(dates).length > 0) completions[habitId] = dates;
            else delete completions[habitId];
          }
          return { completions };
        }),

      toggleCompletion: (habitId, dateKey) => {
        const { completions, setCompletion } = get();
        setCompletion(habitId, dateKey, completions[habitId]?.[dateKey] !== true);
      },

      setTheme: (theme) => set((s) => ({ settings: { ...s.settings, theme } })),

      dismissInstallHint: () => set((s) => ({ settings: { ...s.settings, installHintDismissed: true } })),

      exportData: () => {
        const { habits, completions, settings, deletedIds, tasks, deletedTaskIds } = get();
        return {
          version: 1,
          habits,
          completions,
          settings,
          deletedIds,
          tasks,
          deletedTaskIds,
          exportedAt: new Date().toISOString(),
        };
      },

      importData: (raw) => {
        const result = validateAppData(raw);
        if (!result.ok) return { ok: false, error: result.error };
        const { settings } = result.data;
        const previous: PersistedState = {
          habits: get().habits,
          completions: get().completions,
          settings: get().settings,
          deletedIds: get().deletedIds,
          tasks: get().tasks,
          deletedTaskIds: get().deletedTaskIds,
        };
        // Tombstones are the union of what this device knows and what the backup carries. A tracker
        // in the backup whose id is tombstoned here was deleted after that backup was taken: it is
        // restored under a NEW id (same name, same history) so the deletion stays final everywhere
        // a synced copy might live, while the owner still gets their tracker back.
        const tombstoned = new Set(previous.deletedIds);
        const completions: Completions = {};
        const habits = result.data.habits.map((h) => {
          const id = tombstoned.has(h.id) ? newId() : h.id;
          const dates = result.data.completions[h.id];
          if (dates) completions[id] = dates;
          return id === h.id ? h : { ...h, id };
        });
        // The trackers this import replaces are tombstoned too: "Replace" must hold on a signed-in
        // device, where a tracker that merely vanished from the array would come straight back from
        // the cloud. Locally the extra tombstones are inert metadata.
        const kept = new Set(habits.map((h) => h.id));
        const replaced = previous.habits.map((h) => h.id).filter((id) => !kept.has(id));
        const deletedIds = uniqueIds([...previous.deletedIds, ...(result.data.deletedIds ?? []), ...replaced]);
        // Tasks follow the same two rules. A backup without tasks (pre-phase-3) replaces them with none.
        const tombstonedTasks = new Set(previous.deletedTaskIds);
        const tasks = (result.data.tasks ?? []).map((t) => (tombstonedTasks.has(t.id) ? { ...t, id: newId() } : t));
        const keptTasks = new Set(tasks.map((t) => t.id));
        const replacedTasks = previous.tasks.map((t) => t.id).filter((id) => !keptTasks.has(id));
        const deletedTaskIds = uniqueIds([
          ...previous.deletedTaskIds,
          ...(result.data.deletedTaskIds ?? []),
          ...replacedTasks,
        ]);
        const next: PersistedState = { habits, completions, settings, deletedIds, tasks, deletedTaskIds };
        // The device decides before anything changes: the exact record persist is about to write is
        // written first. Should the browser refuse it (quota, storage disabled), the store is never
        // set, so no subscriber — the sync engine included — ever sees a replacement that did not
        // happen, and the tombstones for the trackers it would have replaced never reach the cloud.
        const writeError = tryWriteRecord(next);
        if (writeError) return { ok: false, error: describeWriteError(writeError) };
        set(next);
        return { ok: true };
      },

      resetAll: () => {
        // "Reset this device" also forgets what the sync engine knew about every account's cloud copy.
        clearAllBaselines();
        set({
          habits: [],
          completions: {},
          settings: { ...DEFAULT_SETTINGS },
          deletedIds: [],
          tasks: [],
          deletedTaskIds: [],
        });
      },

      // Compared BEFORE set(): persist writes storage on every set() call, even one whose updater
      // returns the same state, and an unchanged snapshot must cost neither a write nor a render.
      applyRemote: (data) => {
        const { habits, completions, deletedIds } = get();
        if (sameData({ habits, completions, deletedIds }, data)) return;
        set({ habits: data.habits, completions: data.completions, deletedIds: uniqueIds(data.deletedIds) });
      },

      applyRemoteTasks: (data) => {
        const { tasks, deletedTaskIds } = get();
        if (sameTasks({ tasks, deletedTaskIds }, data)) return;
        set({ tasks: data.tasks, deletedTaskIds: uniqueIds(data.deletedTaskIds) });
      },
    }),
    {
      name: STORAGE_KEY,
      version: PERSIST_VERSION,
      storage: createJSONStorage(() => safeStorage),
      partialize: (s): PersistedState => ({
        habits: s.habits,
        completions: s.completions,
        settings: s.settings,
        deletedIds: s.deletedIds,
        tasks: s.tasks,
        deletedTaskIds: s.deletedTaskIds,
      }),
      // v1 → v2 added tombstones; v2 → v3 added one-time tasks and their tombstones. Anything older or
      // partial gets empty lists; `merge` below re-validates every field, so a damaged blob can never
      // crash hydration.
      migrate: (persisted, version) => {
        const p: Record<string, unknown> = isRecord(persisted) ? persisted : {};
        return {
          ...p,
          deletedIds: version >= 2 && Array.isArray(p.deletedIds) ? p.deletedIds : [],
          tasks: version >= 3 && Array.isArray(p.tasks) ? p.tasks : [],
          deletedTaskIds: version >= 3 && Array.isArray(p.deletedTaskIds) ? p.deletedTaskIds : [],
        } as PersistedState;
      },
      merge: (persisted, current) => ({ ...current, ...repairPersisted(persisted, current) }),
    },
  ),
);

export default useStore;
