import { isDateKey } from '../dates';
import { newId } from '../ids';
import { sortTasks } from '../tasks';
import { TASK_NOTE_MAX, TASK_TITLE_MAX, isTimeString, isValidId, type DateKey, type Task } from '../types';
import type { LocalTasks, RemoteTask, TaskPushOp, TasksMergeResult } from './types';

/**
 * PURE merge/diff logic for one-time tasks (SPEC §14.8), the counterpart of merge.ts for the second
 * collection users/{uid}/tasks. No Firebase imports — unit-tested in Node. Must not import store.ts
 * (store.ts imports sameTasks from here).
 *
 * Rules, mirroring the habit layer: tombstones are the union of both sides and always win; a task on
 * both sides takes the REMOTE fields on first contact, except that a side holding the task done wins
 * (a check-off made offline is never lost); with a baseline the local edits since it are replayed field
 * by field over the cloud's copy (mergeTasksWithBase). A task is only ever tombstoned, never
 * hard-deleted, so a task the cloud no longer shows and has not tombstoned is kept and pushed again.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Absent in a Firestore document: the field is missing, or a client wrote null to clear it. */
const isAbsent = (v: unknown): v is undefined | null => v === undefined || v === null;

/** Task fields of a document (deleted and updatedAt stripped). */
function toTask(doc: RemoteTask): Task {
  const task: Task = { id: doc.id, title: doc.title, date: doc.date, done: doc.done, createdAt: doc.createdAt };
  if (doc.note !== undefined) task.note = doc.note;
  if (doc.time !== undefined) task.time = doc.time;
  if (doc.doneAt !== undefined) task.doneAt = doc.doneAt;
  return task;
}

/** Live docs by id and the set of tombstoned ids. A tombstone wins over a live doc with the same id. */
function splitRemote(remote: readonly RemoteTask[]): { live: Map<string, RemoteTask>; deletedIds: Set<string> } {
  const live = new Map<string, RemoteTask>();
  const deletedIds = new Set<string>();
  for (const doc of remote) {
    if (doc.deleted) deletedIds.add(doc.id);
    else live.set(doc.id, doc);
  }
  for (const id of deletedIds) live.delete(id);
  return { live, deletedIds };
}

/**
 * Inert fields for a tombstone that never held a task: the engine writes `{ deleted: true, updatedAt }`
 * for every id newly tombstoned locally, including ids the cloud never saw (deleted before the first
 * push, restored from a backup); that id still has to win over a late device holding the task live.
 */
const TOMBSTONE_FIELDS: Readonly<Omit<Task, 'id'>> = {
  title: 'Deleted',
  date: '1970-01-01',
  done: false,
  createdAt: '1970-01-01',
};

/**
 * The task fields of a raw document, or null when it is not a usable task. Required: a non-blank title
 * (trimmed, capped) and a real `date`. Optional fields that are damaged are dropped rather than failing
 * the whole task (a bad `time` loses the time, not the task); `createdAt` falls back to `date`; `doneAt`
 * is kept only while `done`.
 */
function parseTaskFields(id: string, data: Record<string, unknown>): Task | null {
  const { title, note, date, time, done, doneAt, createdAt } = data;
  if (typeof title !== 'string') return null;
  const trimmedTitle = title.trim().slice(0, TASK_TITLE_MAX);
  if (trimmedTitle === '') return null;
  if (!isDateKey(date)) return null;
  const isDone = done === true;

  const task: Task = {
    id,
    title: trimmedTitle,
    date,
    done: isDone,
    createdAt: isDateKey(createdAt) ? createdAt : date,
  };
  const trimmedNote = typeof note === 'string' ? note.trim().slice(0, TASK_NOTE_MAX) : '';
  if (trimmedNote) task.note = trimmedNote;
  if (isTimeString(time)) task.time = time;
  if (isDone && isDateKey(doneAt)) task.doneAt = doneAt;
  return task;
}

/**
 * Validate one raw Firestore document into a RemoteTask, or null when it is not usable. The doc id is
 * authoritative (`data.id` may be absent, but must not disagree); `deleted` defaults to false; unknown
 * keys are dropped. A tombstone without task fields parses as a bare tombstone (TOMBSTONE_FIELDS).
 * Never throws on arbitrary input.
 */
export function parseRemoteTask(id: string, data: unknown): RemoteTask | null {
  if (!isValidId(id) || !isRecord(data)) return null;
  if (!isAbsent(data.id) && data.id !== id) return null;
  const deleted = data.deleted === true;
  const fields = parseTaskFields(id, data);
  if (!fields && !deleted) return null;

  const doc: RemoteTask = { ...(fields ?? { id, ...TOMBSTONE_FIELDS }), deleted };
  if (!isAbsent(data.updatedAt)) doc.updatedAt = data.updatedAt;
  return doc;
}

/** Non-deleted docs → tasks in compareTasks order (so an unchanged cloud compares sameTasks-equal); deleted docs → deletedTaskIds. */
export function remoteTasksToLocal(remote: readonly RemoteTask[]): LocalTasks {
  const { live, deletedIds } = splitRemote(remote);
  const tasks = sortTasks([...live.values()].map(toTask));
  return { tasks, deletedTaskIds: [...deletedIds] };
}

/** `task` checked off, dated `doneAt`. */
function markDone(task: Task, doneAt: DateKey): Task {
  return { ...task, done: true, doneAt };
}

/**
 * First-contact reconciliation (no baseline). Tombstones = union of both sides and always win. Tasks =
 * union by id minus tombstoned ids; for an id on both sides the REMOTE fields win, except that a side
 * holding the task done wins on `done`/`doneAt` (a check-off made offline is never lost). toPush makes
 * the cloud converge to `merged`: setTask for local-only tasks and for tasks whose merged fields differ
 * from the cloud's, tombstoneTask for locally tombstoned ids the cloud still holds live. Ids the cloud
 * has never seen get no tombstone op.
 */
export function mergeTasks(local: LocalTasks, remote: readonly RemoteTask[]): TasksMergeResult {
  const { live, deletedIds: remoteDeleted } = splitRemote(remote);
  const tombstones = new Set<string>([...local.deletedTaskIds, ...remoteDeleted]);

  const byId = new Map<string, Task>();
  for (const doc of live.values()) if (!tombstones.has(doc.id)) byId.set(doc.id, toTask(doc));
  for (const t of local.tasks) {
    if (tombstones.has(t.id)) continue;
    const cloud = byId.get(t.id);
    if (!cloud) byId.set(t.id, t);
    else if (t.done && !cloud.done) byId.set(t.id, markDone(cloud, t.doneAt ?? t.date));
  }
  const tasks = sortTasks([...byId.values()]);

  const toPush: TaskPushOp[] = [];
  for (const task of tasks) {
    const doc = live.get(task.id);
    if (!doc || !sameTask(task, toTask(doc))) toPush.push({ type: 'setTask', task });
  }
  for (const id of new Set(local.deletedTaskIds)) if (live.has(id)) toPush.push({ type: 'tombstoneTask', taskId: id });

  return { merged: { tasks, deletedTaskIds: [...tombstones] }, toPush };
}

/**
 * `target` with every field that changed between `before` and `after` taken from `after`, field by
 * field (done and doneAt move together), so an edit made here survives next to a different edit made
 * elsewhere on the same task.
 */
function patchTaskFields(target: Task, before: Task, after: Task): Task {
  const patched: Task = { ...target };
  if (before.title !== after.title) patched.title = after.title;
  if (before.date !== after.date) patched.date = after.date;
  if (before.createdAt !== after.createdAt) patched.createdAt = after.createdAt;
  if ((before.note ?? undefined) !== (after.note ?? undefined)) {
    if (after.note === undefined) delete patched.note;
    else patched.note = after.note;
  }
  if ((before.time ?? undefined) !== (after.time ?? undefined)) {
    if (after.time === undefined) delete patched.time;
    else patched.time = after.time;
  }
  if (before.done !== after.done || (before.doneAt ?? undefined) !== (after.doneAt ?? undefined)) {
    patched.done = after.done;
    if (after.doneAt === undefined) delete patched.doneAt;
    else patched.doneAt = after.doneAt;
  }
  return patched;
}

/**
 * Three-way reconciliation for a device that has synced this account before. `base` is the cloud state
 * as this device last knew it, `local` the store now, `remote` the cloud now. Local edits since `base`
 * are replayed on top of the cloud: a task added here is kept and pushed; a task edited here carries
 * its changed fields (an un-check included) over the cloud's copy, field by field. Everything else
 * follows the cloud, so an edit made on another device sticks. A task known to both sides but absent
 * from `base` (the same backup restored on two devices) follows the first-contact rule. Tombstones are
 * the union of both sides and always win. A task the cloud no longer holds live and has not tombstoned
 * is kept and pushed again (sync never hard-deletes). toPush converges the cloud to `merged`, with
 * tombstones only for ids the cloud still holds live.
 */
export function mergeTasksWithBase(base: LocalTasks, local: LocalTasks, remote: readonly RemoteTask[]): TasksMergeResult {
  const { live, deletedIds: remoteDeleted } = splitRemote(remote);
  const cloud = remoteTasksToLocal(remote);
  const tombstones = new Set<string>([...local.deletedTaskIds, ...remoteDeleted]);
  const baseById = new Map(base.tasks.map((t) => [t.id, t] as const));
  const cloudById = new Map(cloud.tasks.map((t) => [t.id, t] as const));

  const byId = new Map<string, Task>();
  for (const t of cloud.tasks) if (!tombstones.has(t.id)) byId.set(t.id, t);
  for (const t of local.tasks) {
    if (tombstones.has(t.id)) continue;
    const before = baseById.get(t.id);
    const inCloud = cloudById.get(t.id);
    if (!inCloud) byId.set(t.id, t);
    else if (before) {
      if (!sameTask(before, t)) byId.set(t.id, patchTaskFields(inCloud, before, t));
    } else if (t.done && !inCloud.done) byId.set(t.id, markDone(inCloud, t.doneAt ?? t.date));
  }

  const merged: LocalTasks = { tasks: sortTasks([...byId.values()]), deletedTaskIds: [...tombstones] };
  const toPush = diffTasksForPush(cloud, merged).filter((op) => op.type !== 'tombstoneTask' || live.has(op.taskId));
  return { merged, toPush };
}

/**
 * The importData re-key rule applied at reconciliation (see merge.ts restoreTombstoned): a local task
 * whose id the cloud has tombstoned, while this device holds no tombstone for it and did not know it
 * from `base`, was restored here from a backup after the deletion. It comes back under a fresh id so
 * the deletion stays final everywhere and the restored task survives. Returns `local` itself when
 * nothing needs re-keying.
 */
export function restoreTombstonedTasks(
  local: LocalTasks,
  remote: readonly RemoteTask[],
  base: LocalTasks | null,
  makeId: () => string = newId,
): LocalTasks {
  const remoteDeleted = new Set<string>();
  for (const doc of remote) if (doc.deleted) remoteDeleted.add(doc.id);
  if (remoteDeleted.size === 0) return local;
  const localDeleted = new Set(local.deletedTaskIds);
  const known = new Set(base?.tasks.map((t) => t.id) ?? []);
  let changed = false;
  const tasks = local.tasks.map((t) => {
    if (!remoteDeleted.has(t.id) || localDeleted.has(t.id) || known.has(t.id)) return t;
    changed = true;
    return { ...t, id: makeId() };
  });
  return changed ? { tasks, deletedTaskIds: local.deletedTaskIds } : local;
}

/**
 * Ops that turn the cloud state `prev` into `next`: setTask for tasks added or whose fields differ
 * (field comparison, never identity), tombstoneTask for ids newly in next.deletedTaskIds. A task removed
 * without a tombstone yields nothing, and so does a mere reordering. Empty when sameTasks(prev, next).
 */
export function diffTasksForPush(prev: LocalTasks, next: LocalTasks): TaskPushOp[] {
  const ops: TaskPushOp[] = [];
  const prevById = new Map(prev.tasks.map((t) => [t.id, t] as const));
  const nextTombstones = new Set(next.deletedTaskIds);
  for (const task of next.tasks) {
    if (nextTombstones.has(task.id)) continue; // contradictory state: the tombstone below wins
    const before = prevById.get(task.id);
    if (!before || !sameTask(before, task)) ops.push({ type: 'setTask', task });
  }
  const prevTombstones = new Set(prev.deletedTaskIds);
  for (const taskId of nextTombstones) if (!prevTombstones.has(taskId)) ops.push({ type: 'tombstoneTask', taskId });
  return ops;
}

/** Field-by-field equality of two tasks (key order and object identity do not matter). */
export function sameTask(a: Task, b: Task): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    (a.note ?? undefined) === (b.note ?? undefined) &&
    a.date === b.date &&
    (a.time ?? undefined) === (b.time ?? undefined) &&
    a.done === b.done &&
    (a.doneAt ?? undefined) === (b.doneAt ?? undefined) &&
    a.createdAt === b.createdAt
  );
}

/** Same tasks by id (order-insensitive: views sort for themselves) and the same tombstone set. */
export function sameTasks(a: LocalTasks, b: LocalTasks): boolean {
  if (a.tasks.length !== b.tasks.length) return false;
  const byId = new Map(b.tasks.map((t) => [t.id, t] as const));
  if (byId.size !== b.tasks.length) return false;
  for (const t of a.tasks) {
    const other = byId.get(t.id);
    if (!other || !sameTask(t, other)) return false;
  }
  const ta = new Set(a.deletedTaskIds);
  const tb = new Set(b.deletedTaskIds);
  return ta.size === tb.size && [...ta].every((id) => tb.has(id));
}
