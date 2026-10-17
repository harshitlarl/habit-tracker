import { isDateKey } from '../dates';
import {
  isHabitColor,
  isTimeString,
  isValidId,
  isWeekday,
  type Completions,
  type DateKey,
  type Habit,
  type Task,
} from '../types';
import type { LocalData, LocalTasks } from './types';

/**
 * The sync engine's memory between launches (SPEC §13.5, step 2 as implemented; §14.8 for tasks): per
 * account, the cloud state this device last saw the server confirm — trackers and tasks, two
 * collections — plus the ids the server has acknowledged holding in each. With it, a relaunch
 * reconciles the first server snapshot three-way (local edits since the baseline replayed over the
 * cloud) instead of unioning the whole store with the cloud, so a check-in removed, a tracker renamed
 * or a task un-checked on another device while this one was closed is not resurrected here. Without
 * it (first sign-in on this device) the engine falls back to the first-contact union.
 *
 * Stored in localStorage under `momentum-sync-base:<uid>`, with an in-memory fallback when the browser
 * refuses (private mode, quota) or there is no browser at all (tests). A damaged record reads as "no
 * baseline", which is always safe: the union never drops local data. A v1 record (saved by phase 2,
 * before tasks existed) reads with an empty tasks side, which is exact: no task could have been in the
 * cloud when it was written. No Firebase imports here.
 *
 * Who forgets a baseline: a clean sign-out (bootstrap.ts; one that could not confirm writes made offline
 * keeps it, so the next sign-in by the same account replays them three-way), another account signing
 * in (clearOtherBaselines), "Delete cloud data" (engine.ts) and "Reset this device" (clearAllBaselines).
 *
 * The same storage holds one more flag: whether this device has a sync session to restore at launch
 * (`momentum-sync-session`). bootstrap.ts downloads the Firebase SDK at launch only when it does, so a
 * device that has never signed in neither fetches the SDK nor gets Firebase's IndexedDB databases.
 */

export const BASELINE_KEY_PREFIX = 'momentum-sync-base:';
/** '1' while an account is signed in on this device, '0' once it has signed out; absent before either. */
export const SYNC_SESSION_KEY = 'momentum-sync-session';

export interface SyncBaseline {
  /** The cloud state as this device last knew it: the `base` side of mergeWithBase. */
  data: LocalData;
  /** Ids of documents (trackers and tombstones) the server has acknowledged holding. */
  acked: string[];
  /** The tasks collection as this device last knew it: the `base` side of mergeTasksWithBase. */
  tasks: LocalTasks;
  /** Ids of task documents (tasks and tombstones) the server has acknowledged holding. */
  ackedTasks: string[];
}

/** What writeBaseline accepts: a record without the tasks side saves an empty one. */
export type SyncBaselineInput = Pick<SyncBaseline, 'data' | 'acked'> & Partial<Pick<SyncBaseline, 'tasks' | 'ackedTasks'>>;

/** v1 held trackers only; v2 adds the tasks side. */
interface StoredBaseline extends SyncBaseline {
  v: 2;
}

const memory = new Map<string, string>();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const emptyTasks = (): LocalTasks => ({ tasks: [], deletedTaskIds: [] });

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const keyFor = (uid: string): string => `${BASELINE_KEY_PREFIX}${uid}`;

/* ---------- validation: the record is ours, but a damaged one must read as "no baseline" ---------- */

function parseHabit(raw: unknown): Habit | null {
  if (!isRecord(raw)) return null;
  const { id, name, emoji, color, note, days, createdAt, archivedAt, order } = raw;
  if (!isValidId(id) || typeof name !== 'string' || typeof emoji !== 'string' || !isHabitColor(color)) return null;
  if (!Array.isArray(days) || days.length === 0 || !days.every(isWeekday)) return null;
  if (!isDateKey(createdAt) || typeof order !== 'number' || !Number.isFinite(order)) return null;
  if (note !== undefined && typeof note !== 'string') return null;
  if (archivedAt !== undefined && !isDateKey(archivedAt)) return null;
  const habit: Habit = { id, name, emoji, color, days: [...days], createdAt, order };
  if (note !== undefined) habit.note = note;
  if (archivedAt !== undefined) habit.archivedAt = archivedAt;
  return habit;
}

function parseData(raw: unknown): LocalData | null {
  if (!isRecord(raw) || !Array.isArray(raw.habits) || !isRecord(raw.completions)) return null;
  const habits: Habit[] = [];
  const ids = new Set<string>();
  for (const item of raw.habits) {
    const habit = parseHabit(item);
    if (!habit || ids.has(habit.id)) return null;
    ids.add(habit.id);
    habits.push(habit);
  }
  const completions: Completions = {};
  for (const [habitId, dates] of Object.entries(raw.completions)) {
    if (!ids.has(habitId) || !isRecord(dates)) return null;
    const set: Record<DateKey, true> = {};
    for (const [k, v] of Object.entries(dates)) {
      if (v !== true || !isDateKey(k)) return null;
      set[k] = true;
    }
    if (Object.keys(set).length > 0) completions[habitId] = set;
  }
  const deletedIds = parseIds(raw.deletedIds);
  return deletedIds ? { habits, completions, deletedIds } : null;
}

/** A task as the store holds it; the record was written from validated state, so anything off is damage. */
function parseTask(raw: unknown): Task | null {
  if (!isRecord(raw)) return null;
  const { id, title, note, date, time, done, doneAt, createdAt } = raw;
  if (!isValidId(id) || typeof title !== 'string' || title.trim() === '' || !isDateKey(date)) return null;
  if (typeof done !== 'boolean' || !isDateKey(createdAt)) return null;
  if (note !== undefined && typeof note !== 'string') return null;
  if (time !== undefined && !isTimeString(time)) return null;
  if (doneAt !== undefined && (!done || !isDateKey(doneAt))) return null;
  const task: Task = { id, title, date, done, createdAt };
  if (note !== undefined) task.note = note;
  if (time !== undefined) task.time = time;
  if (doneAt !== undefined) task.doneAt = doneAt;
  return task;
}

function parseTasks(raw: unknown): LocalTasks | null {
  if (!isRecord(raw) || !Array.isArray(raw.tasks)) return null;
  const tasks: Task[] = [];
  const ids = new Set<string>();
  for (const item of raw.tasks) {
    const task = parseTask(item);
    if (!task || ids.has(task.id)) return null;
    ids.add(task.id);
    tasks.push(task);
  }
  const deletedTaskIds = parseIds(raw.deletedTaskIds);
  return deletedTaskIds ? { tasks, deletedTaskIds } : null;
}

/** A list of document ids, de-duplicated; null when anything in it could not be one. */
function parseIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const ids: string[] = [];
  for (const item of raw) {
    if (!isValidId(item)) return null;
    ids.push(item);
  }
  return [...new Set(ids)];
}

function parseBaseline(json: string): SyncBaseline | null {
  try {
    const raw: unknown = JSON.parse(json);
    if (!isRecord(raw)) return null;
    const data = parseData(raw.data);
    const acked = parseIds(raw.acked);
    if (!data || !acked) return null;
    // Phase 2 wrote v1: trackers only. No task existed then, so the tasks side it would have recorded is empty.
    if (raw.v === 1) return { data, acked, tasks: emptyTasks(), ackedTasks: [] };
    if (raw.v !== 2) return null;
    const tasks = parseTasks(raw.tasks);
    const ackedTasks = parseIds(raw.ackedTasks);
    return tasks && ackedTasks ? { data, acked, tasks, ackedTasks } : null;
  } catch {
    return null;
  }
}

/* ---------- API ---------- */

/** The baseline saved for `uid`, or null when there is none (or it is unreadable). Never throws. */
export function readBaseline(uid: string): SyncBaseline | null {
  const key = keyFor(uid);
  let json: string | null = null;
  try {
    json = browserStorage()?.getItem(key) ?? null;
  } catch {
    /* fall through to memory */
  }
  json ??= memory.get(key) ?? null;
  return json === null ? null : parseBaseline(json);
}

/** Save the baseline for `uid`. A refused browser write keeps the in-memory copy for this session. Never throws. */
export function writeBaseline(uid: string, baseline: SyncBaselineInput): void {
  const key = keyFor(uid);
  const stored: StoredBaseline = {
    v: 2,
    data: baseline.data,
    acked: baseline.acked,
    tasks: baseline.tasks ?? emptyTasks(),
    ackedTasks: baseline.ackedTasks ?? [],
  };
  const json = JSON.stringify(stored);
  memory.set(key, json);
  try {
    browserStorage()?.setItem(key, json);
  } catch (error) {
    console.warn('Momentum sync: could not save the sync baseline.', error);
  }
}

/** Forget the baseline for `uid`: the next sync of this account on this device is a first contact. */
export function clearBaseline(uid: string): void {
  const key = keyFor(uid);
  memory.delete(key);
  try {
    browserStorage()?.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}

/**
 * Forget every account's baseline and the sync-session flag ("Reset this device"): the next launch
 * neither restores a session nor downloads the SDK until someone signs in.
 */
export function clearAllBaselines(): void {
  memory.clear();
  removeStored((key) => key.startsWith(BASELINE_KEY_PREFIX) || key === SYNC_SESSION_KEY);
}

/**
 * Forget the baselines of every account but `uid` (called when `uid` signs in). A baseline kept by a
 * sign-out that could not confirm writes made offline describes that account's cloud relative to this
 * device's store; once another account syncs into the store it no longer does, and replaying "local
 * edits since the baseline" from it would send the other account's data along.
 */
export function clearOtherBaselines(uid: string): void {
  const own = keyFor(uid);
  for (const key of [...memory.keys()]) {
    if (key.startsWith(BASELINE_KEY_PREFIX) && key !== own) memory.delete(key);
  }
  removeStored((key) => key.startsWith(BASELINE_KEY_PREFIX) && key !== own);
}

/* ---------- the sync-session flag ---------- */

/**
 * True when this device has a sync session to restore at launch. A device that has never recorded one
 * either way synced before the flag existed (or never signed in): it counts as signed in when it holds
 * a saved baseline, which earlier builds kept only while an account was signed in. Its session is then
 * restored once, and the auth callback records the answer (setSyncSession). Never throws.
 */
export function hasSyncSession(): boolean {
  const flag = memory.get(SYNC_SESSION_KEY) ?? readStored(SYNC_SESSION_KEY);
  if (flag !== null) return flag === '1';
  if ([...memory.keys()].some((key) => key.startsWith(BASELINE_KEY_PREFIX))) return true;
  return storedKeys().some((key) => key.startsWith(BASELINE_KEY_PREFIX));
}

/** Record that an account is signed in on this device (true) or that it signed out (false). Never throws. */
export function setSyncSession(signedIn: boolean): void {
  const value = signedIn ? '1' : '0';
  memory.set(SYNC_SESSION_KEY, value);
  try {
    browserStorage()?.setItem(SYNC_SESSION_KEY, value);
  } catch {
    /* the in-memory copy answers for this session */
  }
}

/* ---------- storage helpers ---------- */

function readStored(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Every key in browser storage; empty when there is none or it refuses. */
function storedKeys(): string[] {
  const storage = browserStorage();
  if (!storage) return [];
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function removeStored(match: (key: string) => boolean): void {
  const storage = browserStorage();
  if (!storage) return;
  try {
    for (const key of storedKeys().filter(match)) storage.removeItem(key);
  } catch {
    /* storage unavailable: nothing is saved there */
  }
}
