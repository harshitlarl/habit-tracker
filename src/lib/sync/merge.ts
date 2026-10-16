import type { Completions, Habit } from '../types';
import type { LocalData, MergeResult, PushOp, RemoteHabit } from './types';

/**
 * PURE merge/diff logic (SPEC §13.5). No Firebase imports — this file is unit-tested in Node.
 * STUB: bodies are implemented by the sync-core owner; keep every exported name and signature.
 */

const STUB = 'merge.ts is a stub (sync-core implements it)';

/**
 * Validate one raw Firestore document into a RemoteHabit, or null when it is not usable
 * (missing/invalid required fields). Must never throw on arbitrary input.
 */
export function parseRemoteDoc(_id: string, _data: unknown): RemoteHabit | null {
  throw new Error(STUB);
}

/** Non-deleted docs → habits + completions (true-valued keys only); deleted docs → deletedIds. */
export function remoteToLocal(_remote: readonly RemoteHabit[]): LocalData {
  throw new Error(STUB);
}

/**
 * First-contact reconciliation: union by id, tombstones from either side win, remote fields win for
 * habits on both sides, completions are unioned. toPush carries what the cloud is missing.
 */
export function mergeSnapshots(_local: LocalData, _remote: readonly RemoteHabit[]): MergeResult {
  throw new Error(STUB);
}

/** Ops that turn the cloud state `prev` into `next`. Empty when sameData(prev, next). */
export function diffForPush(_prev: LocalData, _next: LocalData): PushOp[] {
  throw new Error(STUB);
}

/** Field-by-field equality of two habits (key order and object identity do not matter). */
export function sameHabit(a: Habit, b: Habit): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.emoji === b.emoji &&
    a.color === b.color &&
    (a.note ?? undefined) === (b.note ?? undefined) &&
    a.createdAt === b.createdAt &&
    (a.archivedAt ?? undefined) === (b.archivedAt ?? undefined) &&
    a.order === b.order &&
    a.days.length === b.days.length &&
    a.days.every((d, i) => d === b.days[i])
  );
}

/** Same habit ids with the same date sets (empty sets equal a missing entry). */
export function sameCompletions(a: Completions, b: Completions): boolean {
  const ids = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const id of ids) {
    const da = Object.keys(a[id] ?? {});
    const db = Object.keys(b[id] ?? {});
    if (da.length !== db.length) return false;
    const setB = new Set(db);
    if (!da.every((k) => setB.has(k))) return false;
  }
  return true;
}

/** Deep equality of habits (in order), completions and (order-insensitive) deletedIds. */
export function sameData(a: LocalData, b: LocalData): boolean {
  if (a.habits.length !== b.habits.length) return false;
  if (!a.habits.every((h, i) => sameHabit(h, b.habits[i] as Habit))) return false;
  if (!sameCompletions(a.completions, b.completions)) return false;
  const tb = new Set(b.deletedIds);
  const ta = new Set(a.deletedIds);
  return ta.size === tb.size && [...ta].every((id) => tb.has(id));
}
