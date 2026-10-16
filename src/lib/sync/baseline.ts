import { isDateKey } from '../dates';
import { isHabitColor, isValidId, isWeekday, type Completions, type DateKey, type Habit } from '../types';
import type { LocalData } from './types';

/**
 * The sync engine's memory between launches (SPEC §13.5, step 2 as implemented): per account, the
 * cloud state this device last saw the server confirm, plus the ids the server has acknowledged
 * holding. With it, a relaunch reconciles the first server snapshot three-way (local edits since the
 * baseline replayed over the cloud) instead of unioning the whole store with the cloud, so a check-in
 * removed or a tracker renamed on another device while this one was closed is not resurrected here.
 * Without it (first sign-in on this device) the engine falls back to the first-contact union.
 *
 * Stored in localStorage under `momentum-sync-base:<uid>`, with an in-memory fallback when the browser
 * refuses (private mode, quota) or there is no browser at all (tests). A damaged record reads as "no
 * baseline", which is always safe: the union never drops local data. No Firebase imports here.
 */

export const BASELINE_KEY_PREFIX = 'momentum-sync-base:';

export interface SyncBaseline {
  /** The cloud state as this device last knew it: the `base` side of mergeWithBase. */
  data: LocalData;
  /** Ids of documents (trackers and tombstones) the server has acknowledged holding. */
  acked: string[];
}

interface StoredBaseline extends SyncBaseline {
  v: 1;
}

const memory = new Map<string, string>();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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
  if (!isRecord(raw) || !Array.isArray(raw.habits) || !isRecord(raw.completions) || !Array.isArray(raw.deletedIds)) {
    return null;
  }
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
  if (!raw.deletedIds.every(isValidId)) return null;
  return { habits, completions, deletedIds: [...new Set(raw.deletedIds as string[])] };
}

function parseBaseline(json: string): SyncBaseline | null {
  try {
    const raw: unknown = JSON.parse(json);
    if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.acked) || !raw.acked.every(isValidId)) return null;
    const data = parseData(raw.data);
    return data ? { data, acked: [...new Set(raw.acked as string[])] } : null;
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
export function writeBaseline(uid: string, baseline: SyncBaseline): void {
  const key = keyFor(uid);
  const stored: StoredBaseline = { v: 1, data: baseline.data, acked: baseline.acked };
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

/** Forget every account's baseline ("Reset this device"). */
export function clearAllBaselines(): void {
  memory.clear();
  const storage = browserStorage();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(BASELINE_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    /* storage unavailable: nothing is saved there */
  }
}
