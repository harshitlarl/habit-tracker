import { isDateKey } from '../dates';
import { newId } from '../ids';
import { clampText } from '../text';
import {
  HABIT_EMOJI_MAX,
  HABIT_NAME_MAX,
  HABIT_NOTE_MAX,
  isHabitColor,
  isValidId,
  isWeekday,
  type Completions,
  type DateKey,
  type Habit,
  type Weekday,
} from '../types';
import type { LocalData, MergeResult, PushOp, RemoteHabit } from './types';

/**
 * PURE merge/diff logic (SPEC §13.5). No Firebase imports — this file is unit-tested in Node. It must
 * not import store.ts either: store.ts imports sameData from here.
 */

type DateSet = Record<DateKey, true>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Absent in a Firestore document: the field is missing, or a client wrote null to clear it. */
const isAbsent = (v: unknown): v is undefined | null => v === undefined || v === null;

/** `raw`'s true-valued entries whose keys are real calendar dates; everything else is dropped. */
function parseDateSet(raw: unknown): DateSet {
  const set: DateSet = {};
  if (!isRecord(raw)) return set;
  for (const [k, v] of Object.entries(raw)) if (v === true && isDateKey(k)) set[k] = true;
  return set;
}

/** A fresh copy of an already-parsed set, keeping only true-valued keys. */
function copyDateSet(set: Readonly<Record<string, unknown>>): DateSet {
  const copy: DateSet = {};
  for (const [k, v] of Object.entries(set)) if (v === true) copy[k] = true;
  return copy;
}

/** Habit fields of a document (completions, deleted and updatedAt stripped). */
function toHabit(doc: RemoteHabit): Habit {
  const habit: Habit = {
    id: doc.id,
    name: doc.name,
    emoji: doc.emoji,
    color: doc.color,
    days: [...doc.days],
    createdAt: doc.createdAt,
    order: doc.order,
  };
  if (doc.note !== undefined) habit.note = doc.note;
  if (doc.archivedAt !== undefined) habit.archivedAt = doc.archivedAt;
  return habit;
}

/** The deterministic order the merged list keeps: order, then createdAt, then id. */
function compareHabits(a: Habit, b: Habit): number {
  if (a.order !== b.order) return a.order - b.order;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Re-number 0..n-1 only when two trackers share an order; gaps are fine (the store leaves them too). */
function renumberIfNeeded(sorted: Habit[]): Habit[] {
  const distinct = new Set(sorted.map((h) => h.order));
  if (distinct.size === sorted.length) return sorted;
  return sorted.map((h, i) => (h.order === i ? h : { ...h, order: i }));
}

/** Live docs by id and the set of tombstoned ids. A tombstone wins over a live doc with the same id. */
function splitRemote(remote: readonly RemoteHabit[]): { live: Map<string, RemoteHabit>; deletedIds: Set<string> } {
  const live = new Map<string, RemoteHabit>();
  const deletedIds = new Set<string>();
  for (const doc of remote) {
    if (doc.deleted) deletedIds.add(doc.id);
    else live.set(doc.id, doc);
  }
  for (const id of deletedIds) live.delete(id);
  return { live, deletedIds };
}

/**
 * Inert habit fields for a tombstone that never held a tracker. The engine writes
 * `{ deleted: true, updatedAt }` for every id newly tombstoned locally, including ids the cloud never
 * saw as a tracker (restored from a backup, deleted before the first push); that document has no
 * habit fields, but its id still has to win over a late device that holds the tracker live.
 */
const TOMBSTONE_FIELDS: Readonly<Omit<Habit, 'id'>> = {
  name: 'Deleted',
  emoji: '',
  color: 'graphite',
  days: [0, 1, 2, 3, 4, 5, 6],
  createdAt: '1970-01-01',
  order: 0,
};

/** The habit fields of a raw document, validated like the importer validates a backup, or null. */
function parseHabitFields(id: string, data: Record<string, unknown>): Habit | null {
  const { name, emoji, color, note, days, createdAt, archivedAt, order } = data;
  if (typeof name !== 'string') return null;
  const trimmedName = clampText(name, HABIT_NAME_MAX);
  if (trimmedName === '') return null;
  if (typeof emoji !== 'string') return null;
  if (!isHabitColor(color)) return null;
  if (!isAbsent(note) && typeof note !== 'string') return null;
  if (!Array.isArray(days) || days.length === 0 || !days.every(isWeekday)) return null;
  if (!isDateKey(createdAt)) return null;
  if (!isAbsent(archivedAt) && !isDateKey(archivedAt)) return null;
  const finalOrder = isAbsent(order) ? 0 : order;
  if (typeof finalOrder !== 'number' || !Number.isFinite(finalOrder)) return null;

  const habit: Habit = {
    id,
    name: trimmedName,
    emoji: clampText(emoji, HABIT_EMOJI_MAX),
    color,
    days: [...new Set<Weekday>(days)].sort((a, b) => a - b),
    createdAt,
    order: finalOrder,
  };
  const trimmedNote = typeof note === 'string' ? clampText(note, HABIT_NOTE_MAX) : '';
  if (trimmedNote) habit.note = trimmedNote;
  if (isDateKey(archivedAt)) habit.archivedAt = archivedAt;
  return habit;
}

/**
 * Validate one raw Firestore document into a RemoteHabit, or null when it is not usable. The doc id is
 * authoritative (`data.id` may be absent, but must not disagree); name is trimmed and capped, days are
 * normalised, order defaults to 0, only true-valued real dates survive in completions, deleted defaults
 * to false and unknown keys are dropped. A tombstone without habit fields parses as a bare tombstone
 * (see TOMBSTONE_FIELDS). Never throws on arbitrary input.
 */
export function parseRemoteDoc(id: string, data: unknown): RemoteHabit | null {
  if (!isValidId(id) || !isRecord(data)) return null;
  if (!isAbsent(data.id) && data.id !== id) return null;
  const deleted = data.deleted === true;
  const fields = parseHabitFields(id, data);
  if (!fields && !deleted) return null;

  const doc: RemoteHabit = {
    ...(fields ?? { id, ...TOMBSTONE_FIELDS, days: [...TOMBSTONE_FIELDS.days] }),
    completions: fields ? parseDateSet(data.completions) : {},
    deleted,
  };
  if (!isAbsent(data.updatedAt)) doc.updatedAt = data.updatedAt;
  return doc;
}

/**
 * Non-deleted docs → habits (completions/deleted/updatedAt stripped) + completions (true-valued keys
 * only, empty sets omitted); deleted docs → deletedIds. Habits come back in the merge order (order,
 * createdAt, id) so an unchanged cloud compares equal (sameData) to a store that already holds it.
 */
export function remoteToLocal(remote: readonly RemoteHabit[]): LocalData {
  const { live, deletedIds } = splitRemote(remote);
  const habits: Habit[] = [];
  const completions: Completions = {};
  for (const doc of live.values()) {
    habits.push(toHabit(doc));
    const dates = copyDateSet(doc.completions);
    if (Object.keys(dates).length > 0) completions[doc.id] = dates;
  }
  habits.sort(compareHabits);
  return { habits, completions, deletedIds: [...deletedIds] };
}

/**
 * First-contact reconciliation. Tombstones = union of both sides and always win. Habits = union by id
 * minus tombstoned ids; for an id on both sides the REMOTE fields win; completions are unioned per
 * surviving habit. The list is sorted (order, createdAt, id) and re-numbered only if orders collide.
 * toPush makes the cloud converge to `merged`: setHabit for local-only trackers (and for the rare
 * remote tracker whose order was re-numbered — without it the next snapshot would undo the fix),
 * addCompletion for local dates the cloud lacks on trackers that will exist there after the push, and
 * tombstone for ids tombstoned locally that the cloud still holds live. Ids the cloud has never seen
 * get no tombstone op.
 */
export function mergeSnapshots(local: LocalData, remote: readonly RemoteHabit[]): MergeResult {
  const { live, deletedIds: remoteDeleted } = splitRemote(remote);
  const tombstones = new Set<string>([...local.deletedIds, ...remoteDeleted]);

  const byId = new Map<string, Habit>();
  for (const doc of live.values()) if (!tombstones.has(doc.id)) byId.set(doc.id, toHabit(doc));
  for (const h of local.habits) if (!tombstones.has(h.id) && !byId.has(h.id)) byId.set(h.id, h);
  const habits = renumberIfNeeded([...byId.values()].sort(compareHabits));

  const completions: Completions = {};
  const toPush: PushOp[] = [];
  for (const habit of habits) {
    const doc = live.get(habit.id);
    if (!doc || !sameHabit(habit, toHabit(doc))) toPush.push({ type: 'setHabit', habit });
    const union: DateSet = doc ? copyDateSet(doc.completions) : {};
    for (const dateKey of Object.keys(local.completions[habit.id] ?? {})) {
      if (union[dateKey] !== true) toPush.push({ type: 'addCompletion', habitId: habit.id, dateKey });
      union[dateKey] = true;
    }
    if (Object.keys(union).length > 0) completions[habit.id] = union;
  }
  for (const id of new Set(local.deletedIds)) if (live.has(id)) toPush.push({ type: 'tombstone', habitId: id });

  return { merged: { habits, completions, deletedIds: [...tombstones] }, toPush };
}

/**
 * `target` with every field that changed between `before` and `after` taken from `after`, field by
 * field, so an edit made here survives next to a different edit made elsewhere on the same tracker.
 */
function patchFields(target: Habit, before: Habit, after: Habit): Habit {
  const patched: Habit = { ...target };
  if (before.name !== after.name) patched.name = after.name;
  if (before.emoji !== after.emoji) patched.emoji = after.emoji;
  if (before.color !== after.color) patched.color = after.color;
  if (before.createdAt !== after.createdAt) patched.createdAt = after.createdAt;
  if (before.order !== after.order) patched.order = after.order;
  if (before.note !== after.note) {
    if (after.note === undefined) delete patched.note;
    else patched.note = after.note;
  }
  if (before.archivedAt !== after.archivedAt) {
    if (after.archivedAt === undefined) delete patched.archivedAt;
    else patched.archivedAt = after.archivedAt;
  }
  if (before.days.length !== after.days.length || before.days.some((d, i) => d !== after.days[i])) {
    patched.days = [...after.days];
  }
  return patched;
}

/**
 * Three-way reconciliation for a device that has synced this account before (the engine's step 2 and 3,
 * see engine.ts). `base` is the cloud state as this device last knew it, `local` the store now, `remote`
 * the cloud now. The local edits since `base` are replayed on top of the cloud: a tracker added here is
 * kept and pushed; a tracker edited here carries its changed fields over the cloud's copy, field by
 * field (a rename here and a recolour there both survive); check-ins added here are added and check-ins
 * removed here are removed. Everything else follows the cloud, so an un-check or a rename made on another
 * device sticks. Tombstones are the union of both sides and always win. A tracker the cloud no longer
 * holds live and has not tombstoned is kept and pushed again: sync never hard-deletes, so it is either a
 * write that never landed or a wiped collection, which the engine recognises before calling this. The
 * list is sorted (order, createdAt, id) and re-numbered only if orders collide. toPush makes the cloud
 * converge to `merged`, with tombstones only for ids the cloud still holds live (as in mergeSnapshots).
 */
export function mergeWithBase(base: LocalData, local: LocalData, remote: readonly RemoteHabit[]): MergeResult {
  const { live, deletedIds: remoteDeleted } = splitRemote(remote);
  const cloud = remoteToLocal(remote);
  const tombstones = new Set<string>([...local.deletedIds, ...remoteDeleted]);
  const baseById = new Map(base.habits.map((h) => [h.id, h] as const));
  const cloudById = new Map(cloud.habits.map((h) => [h.id, h] as const));

  const byId = new Map<string, Habit>();
  const completions: Completions = {};
  for (const h of cloud.habits) {
    if (tombstones.has(h.id)) continue;
    byId.set(h.id, h);
    const dates = cloud.completions[h.id];
    if (dates) completions[h.id] = copyDateSet(dates);
  }

  for (const h of local.habits) {
    if (tombstones.has(h.id)) continue;
    const before = baseById.get(h.id);
    const inCloud = cloudById.get(h.id);
    const localDates = local.completions[h.id] ?? {};
    const dates: DateSet = completions[h.id] ?? {};
    if (inCloud) {
      // Known to both sides. Without a common past (the same backup restored on two devices) the
      // cloud's fields win and the check-ins are unioned, as on first contact.
      if (before && !sameHabit(before, h)) byId.set(h.id, patchFields(inCloud, before, h));
      const baseDates = before ? (base.completions[h.id] ?? {}) : {};
      for (const k of Object.keys(localDates)) if (baseDates[k] !== true) dates[k] = true;
      for (const k of Object.keys(baseDates)) if (localDates[k] !== true) delete dates[k];
    } else {
      byId.set(h.id, h);
      for (const k of Object.keys(localDates)) if (localDates[k] === true) dates[k] = true;
    }
    if (Object.keys(dates).length > 0) completions[h.id] = dates;
    else delete completions[h.id];
  }

  const habits = renumberIfNeeded([...byId.values()].sort(compareHabits));
  const merged: LocalData = { habits, completions, deletedIds: [...tombstones] };
  const toPush = diffForPush(cloud, merged).filter((op) => op.type !== 'tombstone' || live.has(op.habitId));
  return { merged, toPush };
}

/**
 * The importData re-key rule (SPEC §13.4) applied at reconciliation: a local tracker whose id the cloud
 * has tombstoned, while this device holds no tombstone for it, was restored here from a backup after
 * the deletion. It comes back under a fresh id (same fields, same check-ins) so the deletion stays
 * final everywhere and the restored data survives. Trackers in `base` (the cloud state this device last
 * knew) are exempt: those were deleted elsewhere since this device last synced, and the tombstone wins.
 * Returns `local` itself when nothing needs re-keying.
 */
export function restoreTombstoned(
  local: LocalData,
  remote: readonly RemoteHabit[],
  base: LocalData | null,
  makeId: () => string = newId,
): LocalData {
  const remoteDeleted = new Set<string>();
  for (const doc of remote) if (doc.deleted) remoteDeleted.add(doc.id);
  if (remoteDeleted.size === 0) return local;
  const localDeleted = new Set(local.deletedIds);
  const known = new Set(base?.habits.map((h) => h.id) ?? []);
  const ids = new Map<string, string>();
  for (const h of local.habits) {
    if (remoteDeleted.has(h.id) && !localDeleted.has(h.id) && !known.has(h.id)) ids.set(h.id, makeId());
  }
  if (ids.size === 0) return local;
  const habits = local.habits.map((h) => {
    const id = ids.get(h.id);
    return id === undefined ? h : { ...h, id };
  });
  const completions: Completions = {};
  for (const [habitId, dates] of Object.entries(local.completions)) completions[ids.get(habitId) ?? habitId] = dates;
  return { habits, completions, deletedIds: local.deletedIds };
}

/**
 * Ops that turn the cloud state `prev` into `next`: setHabit for trackers added or whose fields differ
 * (field comparison, never identity), addCompletion/removeCompletion per date key for trackers present
 * in `next`, tombstone for ids newly in next.deletedIds. A tracker removed without a tombstone yields
 * nothing, and so does a mere reordering of the habits array. Empty when sameData(prev, next).
 */
export function diffForPush(prev: LocalData, next: LocalData): PushOp[] {
  const ops: PushOp[] = [];
  const prevById = new Map(prev.habits.map((h) => [h.id, h] as const));
  const nextTombstones = new Set(next.deletedIds);

  for (const habit of next.habits) {
    if (nextTombstones.has(habit.id)) continue; // contradictory state: the tombstone below wins
    const before = prevById.get(habit.id);
    if (!before || !sameHabit(before, habit)) ops.push({ type: 'setHabit', habit });
    const was = prev.completions[habit.id] ?? {};
    const now = next.completions[habit.id] ?? {};
    for (const dateKey of Object.keys(now)) {
      if (was[dateKey] !== true) ops.push({ type: 'addCompletion', habitId: habit.id, dateKey });
    }
    for (const dateKey of Object.keys(was)) {
      if (now[dateKey] !== true) ops.push({ type: 'removeCompletion', habitId: habit.id, dateKey });
    }
  }

  const prevTombstones = new Set(prev.deletedIds);
  for (const habitId of nextTombstones) if (!prevTombstones.has(habitId)) ops.push({ type: 'tombstone', habitId });
  return ops;
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
