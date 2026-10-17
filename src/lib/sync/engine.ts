import type { DocumentData, DocumentReference, FirestoreError, QuerySnapshot, WriteBatch } from 'firebase/firestore';
import useStore, { type StoreState } from '../store';
import { clearBaseline, readBaseline, setSyncSession, writeBaseline } from './baseline';
import { loadFirebase, type FirebaseHandles, type FirebaseSdk } from './firebase';
import {
  diffForPush,
  mergeSnapshots,
  mergeWithBase,
  parseRemoteDoc,
  remoteToLocal,
  restoreTombstoned,
  sameData,
} from './merge';
import { useSyncStore } from './syncStore';
import {
  diffTasksForPush,
  mergeTasks,
  mergeTasksWithBase,
  parseRemoteTask,
  remoteTasksToLocal,
  restoreTombstonedTasks,
  sameTasks,
} from './tasksMerge';
import type { LocalData, LocalTasks, PushOp, RemoteHabit, RemoteTask, TaskPushOp } from './types';

/**
 * Sync engine (SPEC §13.5 steps 1–5, §14.8): one Firestore onSnapshot listener per collection —
 * users/{uid}/habits and users/{uid}/tasks — plus a store subscription that pushes diffs in chunked
 * write batches, with an echo-loop guard.
 *
 * Model: the engine keeps "the cloud state as this device last knew it" — `lastPushed` within a session,
 * and a per-account baseline saved in localStorage across launches (baseline.ts). Every snapshot is
 * reconciled three-way against it (mergeWithBase / mergeTasksWithBase): the local edits made since are
 * replayed over the cloud's view and sent, everything else follows the cloud. With no local edits that
 * is exactly "remote is authoritative"; with some, an edit that has not reached the cloud yet survives
 * the snapshot instead of being undone by it. Only a device that has never synced the account (no
 * baseline) starts with the first-contact union of mergeSnapshots / mergeTasks, which uploads whatever
 * is only on this device. Tombstones are the exception in every phase: one this device holds is never
 * dropped, and when the cloud still shows that document live (a device that was offline when it was
 * deleted) the tombstone is pushed, so a deletion stays final (SPEC §13.4, §14.3). Firestore's latency
 * compensation echoes local writes back in the next snapshot, where sameData() / sameTasks() find
 * nothing to apply.
 *
 * Two channels, one engine (SPEC §14.8). Trackers and tasks are two collections with parallel pure
 * layers (merge.ts, tasksMerge.ts); a `Kind` adapter hands each one's functions to the same state
 * machine. Each channel keeps its own confirmed / acknowledged / last-known state and makes its own
 * first-contact-or-three-way choice. Everything that belongs to the account rather than a collection
 * is shared: the write batches (one batch may carry both kinds of ops; a rejected batch rolls back each
 * side of `lastPushed` it wrote, so both for a mixed batch), the `applyingRemote` guard, the store
 * subscription, the status ('synced' only once both collections have been heard from the server;
 * `pending` while either has writes waiting), the saved baseline (written once both are server-confirmed
 * with no pending writes) and the "cloud cleared" pause (an acknowledged document of either collection
 * vanishing).
 *
 * Deviations from the literal SPEC:
 * - Step 2 says every snapshot before the first server-confirmed one is a union of the whole local store
 *   with the cloud. That is what happens on first contact only. A device that has synced before would
 *   otherwise resurrect, at every launch, a check-in removed on another device while it was closed, and
 *   push it back; with the saved baseline the relaunch is a three-way merge instead, and cache snapshots
 *   before the server answers are left alone (the store already holds what this device knew; a stale or
 *   empty cache cannot improve on it).
 * - Step 3 (`applyRemote(remoteToLocal(remote))`): the authoritative phase is the same three-way merge,
 *   which is remoteToLocal plus the tombstone rule above, the order re-numbering when two devices created
 *   trackers with the same `order` while apart, and the survival of an unpushed local edit (a rejected
 *   batch is rolled out of `lastPushed`, so the edit is re-sent instead of being wiped by the rollback).
 * - "Delete cloud data" on another device is recognised by a document the server once acknowledged
 *   vanishing from the server's view, not by an empty snapshot: a pending write here can overlay a
 *   document onto an emptied collection, and sync itself never hard-deletes anything.
 * - §14.8 "a rejected batch rolls BOTH channels back": it rolls back the channels it wrote (both, for a
 *   mixed batch). A channel the batch did not write had its snapshots reconciled while the batch was in
 *   flight (they are held back only by batches writing their own collection); rewinding it would turn
 *   cloud changes it has already applied into "local edits" that the next three-way merge replays over
 *   newer cloud values, and could re-key and re-upload a document deleted elsewhere (see rollBack).
 */

/** Firestore accepts 500 writes per batch; 400 leaves headroom. */
const BATCH_LIMIT = 400;
/** A start that has not heard from the server (on both collections) after this long is reported as offline. */
export const CONFIRM_TIMEOUT_MS = 10_000;
/** Each step of "Delete cloud data" gives up after this long, so the button never hangs on "Deleting…". */
export const DELETE_STEP_TIMEOUT_MS = 20_000;
/** Snapshot-driven re-sends after a rejected batch, before the engine waits for the owner's next change. */
const RETRY_LIMIT = 3;

const LOAD_FAILED_MESSAGE = 'Sync could not start. Your data is safe on this device.';
const GENERIC_SYNC_MESSAGE = 'Sync hit a problem. Your data is safe on this device.';
const CLOUD_CLEARED_MESSAGE =
  'Your cloud data was deleted from another device, so sync is paused. Your trackers and tasks are still on this device. Sign out, then sign in again to upload them.';

/** Codes for which the SDK has given up and a retry needs something to change first. */
const FINAL_PUSH_CODES: ReadonlySet<string> = new Set([
  'permission-denied',
  'unauthenticated',
  'resource-exhausted',
  'invalid-argument',
  'failed-precondition',
  'not-found',
  'already-exists',
  'out-of-range',
  'unimplemented',
  'data-loss',
]);

/** The two collections under users/{uid} the engine mirrors. */
type CollectionName = 'habits' | 'tasks';
const COLLECTIONS: readonly CollectionName[] = ['habits', 'tasks'];

/** Both sides of a push: ops for either collection, possibly empty. */
interface Ops {
  readonly habits: readonly PushOp[];
  readonly tasks: readonly TaskPushOp[];
}

/** Both sides of "the cloud state as known": null for a collection that has not delivered a snapshot yet. */
interface Prev {
  readonly habits: LocalData | null;
  readonly tasks: LocalTasks | null;
}

/** Ids whose writes could not be addressed, per collection (see push). */
interface Skipped {
  readonly habits: Set<string>;
  readonly tasks: Set<string>;
}

/**
 * What one channel needs from its pure layer: merge.ts for trackers, tasksMerge.ts for tasks. `T` is
 * the synced slice (LocalData / LocalTasks), `Op` a write (PushOp / TaskPushOp), `Doc` a parsed cloud
 * document (RemoteHabit / RemoteTask).
 */
interface Kind<T, Op, Doc> {
  readonly collection: CollectionName;
  /** Shown when a write of this collection cannot be addressed (never for a valid id; see isValidId). */
  readonly unaddressableMessage: string;
  /** Validates one raw document; null drops it. */
  parse(id: string, data: unknown): Doc | null;
  current(state: StoreState): T;
  /** The store change touched this slice (reference comparison; settings never sync). */
  changed(state: StoreState, prev: StoreState): boolean;
  same(a: T, b: T): boolean;
  apply(store: StoreState, data: T): void;
  /** The importData re-key rule at reconciliation (restoreTombstoned / restoreTombstonedTasks). */
  restore(local: T, remote: readonly Doc[], base: T | null): T;
  /** First contact: the union. */
  mergeFirst(local: T, remote: readonly Doc[]): { merged: T; toPush: Op[] };
  /** Three-way: local edits since `base` replayed over the cloud. */
  mergeBase(base: T, local: T, remote: readonly Doc[]): { merged: T; toPush: Op[] };
  /** What the cloud holds as `remote` shows it, plus every tombstone `merged` knows (see knownCloud). */
  known(remote: readonly Doc[], merged: T): T;
  diff(prev: T, next: T): Op[];
  /** `data` without the given documents (tombstones untouched). */
  without(data: T, ids: ReadonlySet<string>): T;
  opId(op: Op): string;
  /** A tombstone for an id that cannot be addressed protects nothing: skipping it is not a loss. */
  isTombstone(op: Op): boolean;
  write(fs: FirebaseSdk['firestore'], batch: WriteBatch, ref: DocumentReference, op: Op): void;
  /** `ops` on this channel's side of a push, nothing on the other. */
  ops(ops: readonly Op[]): Ops;
  /** This channel's side of `prev`. */
  prevOf(prev: Prev): T | null;
  /** `prev` with this channel's side replaced by `cloud`. */
  prevWith(prev: Prev, cloud: T): Prev;
}

/** One collection's state within a session. */
interface Channel<T, Op, Doc> {
  readonly kind: Kind<T, Op, Doc>;
  unsubscribe: (() => void) | null;
  /** Set once a server-confirmed snapshot has been reconciled. */
  confirmed: boolean;
  /** From an earlier launch: the server-confirmed cloud state this device last saw for this account. Null on first contact. */
  readonly baseline: T | null;
  /** Ids of documents (live and tombstones) the server has acknowledged holding; saved with the baseline. */
  readonly acked: Set<string>;
  /** The cloud state as this device last knew it: the `prev` side of diff. Null until the first snapshot. */
  lastPushed: T | null;
  /** The cloud's own view from the last reconciled server snapshot: what the baseline records. Null until then. */
  cloud: T | null;
  /** That view carried no pending write of this device, so it is the server's word and fit for the baseline. */
  cloudAcked: boolean;
  /** The latest snapshot of this collection carried pending writes of this device (the UI's `pending`). */
  pending: boolean;
}

/** A write batch handed to Firestore. */
interface Batch {
  readonly seq: number;
  /**
   * The cloud state as known before this batch. For each collection the batch writes (`touches`; the
   * other side is never read), `lastPushed` returns here if the commit is rejected. Rebased when an
   * earlier batch writing the same collection is rejected (see rollBack).
   */
  prev: Prev;
  /** The collections this batch writes to: a snapshot of one of them may predate the batch (see onRemoteSnapshot). */
  readonly touches: ReadonlySet<CollectionName>;
}

interface Session {
  readonly uid: string;
  handles: FirebaseHandles | null;
  readonly habits: Channel<LocalData, PushOp, RemoteHabit>;
  readonly tasks: Channel<LocalTasks, TaskPushOp, RemoteTask>;
  unsubscribeStore: (() => void) | null;
  confirmTimer: ReturnType<typeof setTimeout> | null;
  /** The confirm timer fired before the server answered on both collections. */
  timedOut: boolean;
  /** Batches handed to Firestore whose commit has not settled yet, oldest first (see the guard in onRemoteSnapshot). */
  inFlight: Batch[];
  seq: number;
  /** The last rejected push, shown until a later push succeeds. */
  pushError: string | null;
  /** Snapshot-driven re-sends left while `pushError` stands; the owner's next change always re-sends. */
  retriesLeft: number;
}

let session: Session | null = null;
/** Loop guard: true while the store applies a snapshot, so the store subscription ignores that change. */
let applyingRemote = false;

/* ---------- the two kinds ---------- */

const HABITS: Kind<LocalData, PushOp, RemoteHabit> = {
  collection: 'habits',
  unaddressableMessage: 'One tracker could not be saved to the cloud. Close and reopen the app to repair it.',
  parse: parseRemoteDoc,
  current: (state) => ({ habits: state.habits, completions: state.completions, deletedIds: state.deletedIds }),
  changed: (state, prev) =>
    state.habits !== prev.habits || state.completions !== prev.completions || state.deletedIds !== prev.deletedIds,
  same: sameData,
  apply: (store, data) => store.applyRemote(data),
  restore: (local, remote, base) => restoreTombstoned(local, remote, base),
  mergeFirst: mergeSnapshots,
  mergeBase: mergeWithBase,
  known: (remote, merged) => {
    const cloud = remoteToLocal(remote);
    return { habits: cloud.habits, completions: cloud.completions, deletedIds: merged.deletedIds };
  },
  diff: diffForPush,
  without: (data, ids) => {
    const completions = { ...data.completions };
    for (const id of ids) delete completions[id];
    return { habits: data.habits.filter((h) => !ids.has(h.id)), completions, deletedIds: data.deletedIds };
  },
  opId: (op) => (op.type === 'setHabit' ? op.habit.id : op.habitId),
  isTombstone: (op) => op.type === 'tombstone',
  write: writeHabitOp,
  ops: (ops) => ({ habits: ops, tasks: [] }),
  prevOf: (prev) => prev.habits,
  prevWith: (prev, cloud) => ({ habits: cloud, tasks: prev.tasks }),
};

const TASKS: Kind<LocalTasks, TaskPushOp, RemoteTask> = {
  collection: 'tasks',
  unaddressableMessage: 'One task could not be saved to the cloud. Close and reopen the app to repair it.',
  parse: parseRemoteTask,
  current: (state) => ({ tasks: state.tasks, deletedTaskIds: state.deletedTaskIds }),
  changed: (state, prev) => state.tasks !== prev.tasks || state.deletedTaskIds !== prev.deletedTaskIds,
  same: sameTasks,
  apply: (store, data) => store.applyRemoteTasks(data),
  restore: (local, remote, base) => restoreTombstonedTasks(local, remote, base),
  mergeFirst: mergeTasks,
  mergeBase: mergeTasksWithBase,
  known: (remote, merged) => ({ tasks: remoteTasksToLocal(remote).tasks, deletedTaskIds: merged.deletedTaskIds }),
  diff: diffTasksForPush,
  without: (data, ids) => ({ tasks: data.tasks.filter((t) => !ids.has(t.id)), deletedTaskIds: data.deletedTaskIds }),
  opId: (op) => (op.type === 'setTask' ? op.task.id : op.taskId),
  isTombstone: (op) => op.type === 'tombstoneTask',
  write: writeTaskOp,
  ops: (ops) => ({ habits: [], tasks: ops }),
  prevOf: (prev) => prev.tasks,
  prevWith: (prev, cloud) => ({ habits: prev.habits, tasks: cloud }),
};

function newChannel<T, Op, Doc>(kind: Kind<T, Op, Doc>, baseline: T | null, acked: readonly string[]): Channel<T, Op, Doc> {
  return {
    kind,
    unsubscribe: null,
    confirmed: false,
    baseline,
    acked: new Set(acked),
    lastPushed: null,
    cloud: null,
    cloudAcked: false,
    pending: false,
  };
}

/* ---------- lifecycle ---------- */

/** Start listening to users/{uid}/habits and users/{uid}/tasks and mirroring the local store. Idempotent per uid. */
export async function startSync(uid: string): Promise<void> {
  if (session?.uid === uid) return;
  if (session) stopSync();

  const saved = readBaseline(uid);
  const s: Session = {
    uid,
    handles: null,
    habits: newChannel(HABITS, saved?.data ?? null, saved?.acked ?? []),
    tasks: newChannel(TASKS, saved?.tasks ?? null, saved?.ackedTasks ?? []),
    unsubscribeStore: null,
    confirmTimer: null,
    timedOut: false,
    inFlight: [],
    seq: 0,
    pushError: null,
    retriesLeft: RETRY_LIMIT,
  };
  session = s;
  const sync = useSyncStore.getState();
  sync.setPending(false);
  sync.setStatus('connecting');

  let handles: FirebaseHandles;
  try {
    handles = await loadFirebase();
  } catch (error) {
    if (session !== s) return;
    console.error('Momentum sync: Firebase failed to load.', error);
    session = null;
    sync.setError(LOAD_FAILED_MESSAGE);
    return;
  }
  if (session !== s) return; // stopped while loading

  s.handles = handles;
  try {
    s.habits.unsubscribe = listen(s, handles, s.habits);
    s.tasks.unsubscribe = listen(s, handles, s.tasks);
  } catch (error) {
    console.error('Momentum sync: could not listen to the cloud.', error);
    session = null;
    teardown(s);
    sync.setError(GENERIC_SYNC_MESSAGE);
    return;
  }
  // Changes made before this point (while the SDK was loading) are not lost: the first snapshot of
  // each collection reconciles the whole slice, not a diff.
  s.unsubscribeStore = useStore.subscribe((state, prev) => onLocalChange(s, state, prev));
  s.confirmTimer = setTimeout(() => {
    s.confirmTimer = null;
    if (session !== s || bothConfirmed(s)) return;
    s.timedOut = true;
    const current = useSyncStore.getState();
    if (current.status === 'connecting') current.setStatus('offline');
  }, CONFIRM_TIMEOUT_MS);
}

function listen<T, Op, Doc>(s: Session, handles: FirebaseHandles, ch: Channel<T, Op, Doc>): () => void {
  const { db, sdk } = handles;
  const { collection, onSnapshot } = sdk.firestore;
  return onSnapshot(
    collection(db, 'users', s.uid, ch.kind.collection),
    { includeMetadataChanges: true },
    (snapshot) => onRemoteSnapshot(s, ch, snapshot),
    (error) => onListenError(s, error),
  );
}

/** Unsubscribe both snapshot listeners and the store subscription; reset module state. Safe to call twice. */
export function stopSync(): void {
  const s = session;
  session = null;
  applyingRemote = false;
  if (s) teardown(s);
}

/**
 * Hard-delete every document under users/{uid}/habits and users/{uid}/tasks in chunked batches (used by
 * "Delete cloud data"). Stops the engine first: a running listener would mirror the vanishing documents
 * into the local store, and local data must survive this. Rejects with a friendly Error on failure; when
 * nothing was deleted and the engine was running it resumes syncing, when the sweep was partial the
 * engine stays stopped (with a sticky error) so the gaps are not mirrored locally. After a complete sweep
 * this device's memory of the account's cloud copy is cleared too, so the next sign-in is a first
 * contact, and the device no longer counts as having a sync session to restore at launch. The caller
 * signs out after success (SPEC §13.6).
 */
export async function deleteCloudData(uid: string): Promise<void> {
  const wasSyncing = session?.uid === uid;
  stopSync();
  let deletedAny = false;
  try {
    const { db, sdk } = await loadFirebase();
    const fs = sdk.firestore;
    if (isBrowserOffline()) throw new Error('The device is offline.');
    // Queued writes land first so a tracker checked off a moment ago cannot reappear after the sweep.
    await withTimeout(fs.waitForPendingWrites(db), DELETE_STEP_TIMEOUT_MS, 'waiting for pending writes');
    const refs: DocumentReference[] = [];
    for (const name of COLLECTIONS) {
      const snapshot = await withTimeout(
        fs.getDocsFromServer(fs.collection(db, 'users', uid, name)),
        DELETE_STEP_TIMEOUT_MS,
        `listing the cloud ${name}`,
      );
      for (const d of snapshot.docs) refs.push(d.ref);
    }
    for (let start = 0; start < refs.length; start += BATCH_LIMIT) {
      const batch = fs.writeBatch(db);
      for (const ref of refs.slice(start, start + BATCH_LIMIT)) batch.delete(ref);
      await withTimeout(batch.commit(), DELETE_STEP_TIMEOUT_MS, 'deleting a batch');
      deletedAny = true;
    }
    clearBaseline(uid);
    setSyncSession(false);
  } catch (error) {
    console.warn('Momentum sync: deleting cloud data failed.', error);
    if (deletedAny) {
      // Half-deleted: the engine stays stopped so the gaps are not mirrored locally. A retry finishes the job;
      // the next launch re-uploads whatever is only on this device.
      const message = 'Some of your cloud data could not be deleted. Check your connection and try again.';
      useSyncStore.getState().setError(message);
      throw new Error(message);
    }
    if (wasSyncing) void startSync(uid); // nothing changed in the cloud: carry on syncing
    throw new Error('Could not reach the cloud to delete your data. Check your connection and try again.');
  }
}

/* ---------- snapshots → store ---------- */

function onRemoteSnapshot<T, Op, Doc>(s: Session, ch: Channel<T, Op, Doc>, snapshot: QuerySnapshot): void {
  if (session !== s) return;
  const { fromCache, hasPendingWrites } = snapshot.metadata;
  const sync = useSyncStore.getState();

  try {
    if (ch.lastPushed !== null && inFlightOn(s, ch)) {
      // A batch this device handed to Firestore that writes this collection has not settled: this view
      // may predate it (the commit promise settles before the view that includes it is delivered), or
      // include an earlier batch but not the latest. Applying it would briefly undo the owner's last
      // tap. The view that follows the acknowledgement (or the rollback) carries everything, remote
      // changes included, and is applied. A batch on the other collection cannot date this view.
    } else if (!fromCache && isCloudCleared(ch, snapshot)) {
      // Sync only ever tombstones, so a document the server once acknowledged can vanish from the
      // server's view only through "Delete cloud data" on another device. Mirroring that would wipe
      // this device too; keep the local copy, pause, and say so.
      onCloudCleared(s);
      return;
    } else if (!ch.confirmed && fromCache && ch.baseline !== null) {
      // A device that has synced this account before already holds everything it knew in its store. A
      // cache view cannot be ahead of that, and may be behind it or empty (memory cache, cleared site
      // data): wait for the server's view, which follows as soon as the device is online.
    } else {
      // On first contact a cache snapshot may be stale or empty: the union is applied locally so nothing
      // is wiped, but the diff is only pushed once it has been computed against the server's view.
      const cloud = reconcile(s, ch, parseSnapshot(snapshot, ch.kind), fromCache);
      if (!fromCache) {
        ch.confirmed = true;
        for (const d of snapshot.docs) if (!d.metadata.hasPendingWrites) ch.acked.add(d.id);
        // A fully acknowledged server view is what the next launch reconciles against — once both
        // collections have one (saveBaseline).
        ch.cloud = cloud;
        ch.cloudAcked = !hasPendingWrites;
        if (ch.cloudAcked) saveBaseline(s);
      }
    }
  } catch (error) {
    console.error('Momentum sync: could not apply a snapshot.', error);
    sync.setError(GENERIC_SYNC_MESSAGE);
    return;
  }

  ch.pending = hasPendingWrites;
  sync.setPending(s.habits.pending || s.tasks.pending);
  if (!fromCache) {
    // The server has been heard from on this collection; 'synced' needs both.
    if (bothConfirmed(s)) sync.markSynced(Date.now());
    else sync.setStatus('connecting');
  } else if (bothConfirmed(s) || s.timedOut || isBrowserOffline()) {
    sync.setStatus('offline');
  } else {
    // The cache answers first even when online; keep "connecting" until the server has been heard from.
    sync.setStatus('connecting');
  }
  if (s.pushError !== null) sync.setError(s.pushError);
}

/**
 * Reconcile one snapshot of `ch` with the store and send the cloud what it lacks. First contact (no
 * baseline from an earlier launch, nothing reconciled yet this session): the whole local slice takes
 * part through the union of mergeFirst, so a device signing in for the first time uploads what is
 * only on it. Afterwards: three-way, with the local edits since the cloud state this device last knew
 * (the saved baseline at launch, `lastPushed` within the session) replayed over the cloud's view, so a
 * change made on another device sticks here and an unpushed change made here survives the snapshot and
 * is sent. Returns the cloud's own view (see Kind.known), which is what the saved baseline records.
 */
function reconcile<T, Op, Doc>(s: Session, ch: Channel<T, Op, Doc>, remote: readonly Doc[], fromCache: boolean): T {
  const k = ch.kind;
  const base = ch.confirmed ? ch.lastPushed : ch.baseline;
  const local = k.restore(k.current(useStore.getState()), remote, base);
  const { merged, toPush } = base === null ? k.mergeFirst(local, remote) : k.mergeBase(base, local, remote);
  applyToStore(ch, merged);
  const cloud = k.known(remote, merged);

  // First contact from the cache: the diff waits for the server's view.
  const deferred = !ch.confirmed && fromCache;
  if (toPush.length === 0 || deferred) {
    ch.lastPushed = merged;
    return cloud;
  }
  if (s.pushError !== null) {
    // A rejected batch triggers a rollback snapshot, which would re-send and be rejected again: retries
    // from here are bounded. The edit stays in the store either way, and the owner's next change
    // re-sends everything the cloud lacks.
    if (s.retriesLeft <= 0) {
      ch.lastPushed = cloud;
      return cloud;
    }
    s.retriesLeft -= 1;
  }
  const prev: Prev = k.prevWith({ habits: s.habits.lastPushed, tasks: s.tasks.lastPushed }, cloud);
  const skipped = push(s, k.ops(toPush), prev);
  ch.lastPushed = skippedOf(skipped, k).size === 0 ? merged : k.without(merged, skippedOf(skipped, k));
  return cloud;
}

/**
 * True when a document the server once acknowledged is missing from the server's view of this
 * collection entirely. A document this device is still writing shows up regardless (latency
 * compensation), so a pending write can neither hide a wipe nor fake one.
 */
function isCloudCleared<T, Op, Doc>(ch: Channel<T, Op, Doc>, snapshot: QuerySnapshot): boolean {
  if (ch.acked.size === 0) return false;
  const present = new Set(snapshot.docs.map((d) => d.id));
  for (const id of ch.acked) if (!present.has(id)) return true;
  return false;
}

function onCloudCleared(s: Session): void {
  console.warn('Momentum sync: the cloud collection was emptied elsewhere; sync paused to keep the local copy.');
  // The baseline stays: a relaunch finds the same wipe and pauses again, until the owner signs out (which
  // forgets the baseline) and signs in to upload this device's copy, as the message says.
  session = null;
  teardown(s);
  const sync = useSyncStore.getState();
  sync.setPending(false);
  sync.setError(CLOUD_CLEARED_MESSAGE);
}

function onListenError(s: Session, error: FirestoreError): void {
  if (session !== s) return;
  console.error('Momentum sync: the cloud listener stopped.', error);
  // No further snapshots will arrive on it; pushing into a collection we cannot read would only pile up
  // errors, and the two collections share one account, so the other listener goes too.
  session = null;
  teardown(s);
  useSyncStore.getState().setError(listenErrorMessage(error));
}

/** Replace the synced slice of the store (no-op when equal) without the store subscription pushing it back. */
function applyToStore<T, Op, Doc>(ch: Channel<T, Op, Doc>, data: T): void {
  const store = useStore.getState();
  if (ch.kind.same(ch.kind.current(store), data)) return;
  applyingRemote = true;
  try {
    ch.kind.apply(store, data);
  } finally {
    applyingRemote = false;
  }
}

/**
 * Save the baseline once both collections have been reconciled from a server view that carried no
 * pending write of this device (SPEC §14.8). A view with pending writes includes latency-compensated
 * local data the server has not acknowledged; recording that as the cloud's word would let a write
 * that never lands count as synced at the next launch.
 */
function saveBaseline(s: Session): void {
  const { habits, tasks } = s;
  if (habits.cloud === null || tasks.cloud === null || !habits.cloudAcked || !tasks.cloudAcked) return;
  writeBaseline(s.uid, {
    data: habits.cloud,
    acked: [...habits.acked],
    tasks: tasks.cloud,
    ackedTasks: [...tasks.acked],
  });
}

/* ---------- store → cloud ---------- */

function onLocalChange(s: Session, state: StoreState, prev: StoreState): void {
  if (session !== s || applyingRemote) return;
  if (!HABITS.changed(state, prev) && !TASKS.changed(state, prev)) return; // settings only: never synced
  // Both channels are diffed whichever slice changed: whatever a rejected batch left behind on either
  // side goes up with the owner's next change, as in phase 2.
  const habitOps = localOps(s.habits, state);
  const taskOps = localOps(s.tasks, state);
  if (habitOps === null && taskOps === null) return; // nothing the cloud lacks
  // This runs inside the owner's tap (zustand notifies subscribers synchronously): nothing may throw out.
  try {
    const before: Prev = { habits: s.habits.lastPushed, tasks: s.tasks.lastPushed };
    const skipped = push(s, { habits: habitOps ?? [], tasks: taskOps ?? [] }, before);
    // Firestore queues a batch durably the moment it is handed over (persistent cache), so the cloud
    // "knows" it from here on even while offline; a rejected commit rolls this back (onPushError). Should
    // a memory-cache queue be lost, the next launch's merge against the saved baseline re-sends what is
    // only on this device.
    if (habitOps !== null) advance(s.habits, state, skipped.habits);
    if (taskOps !== null) advance(s.tasks, state, skipped.tasks);
  } catch (error) {
    console.error('Momentum sync: could not push a local change.', error);
    useSyncStore.getState().setError(GENERIC_SYNC_MESSAGE);
  }
}

/**
 * The ops `state` needs on `ch`, or null when the channel has nothing to do: its slice equals the known
 * cloud state, or no snapshot has arrived yet (the first one reconciles the whole slice, so nothing is
 * lost by waiting).
 */
function localOps<T, Op, Doc>(ch: Channel<T, Op, Doc>, state: StoreState): Op[] | null {
  if (ch.lastPushed === null) return null;
  const current = ch.kind.current(state);
  if (ch.kind.same(ch.lastPushed, current)) return null;
  return ch.kind.diff(ch.lastPushed, current);
}

/** The cloud now knows `state`'s slice, except the documents whose writes could not be addressed. */
function advance<T, Op, Doc>(ch: Channel<T, Op, Doc>, state: StoreState, skipped: ReadonlySet<string>): void {
  const current = ch.kind.current(state);
  ch.lastPushed = skipped.size === 0 ? current : ch.kind.without(current, skipped);
}

/** A resolved write, ready to join a batch. */
interface Write {
  readonly collection: CollectionName;
  write(batch: WriteBatch): void;
}

/**
 * Hand `ops` to Firestore in batches of ≤ BATCH_LIMIT; a batch may carry ops of both collections.
 * `prev` is the cloud state the ops were diffed against; a rejected batch rolls back to it each side
 * of `lastPushed` it wrote (see rollBack). Returns, per collection, the ids whose writes could not be
 * addressed (never valid ids; see isValidId): those stay on this device and are reported, not claimed
 * as synced.
 */
function push(s: Session, ops: Ops, prev: Prev): Skipped {
  const skipped: Skipped = { habits: new Set(), tasks: new Set() };
  if ((ops.habits.length === 0 && ops.tasks.length === 0) || s.handles === null) return skipped;
  const fs = s.handles.sdk.firestore;
  const writes = [
    ...resolve(s, s.habits, ops.habits, skipped.habits),
    ...resolve(s, s.tasks, ops.tasks, skipped.tasks),
  ];
  for (let start = 0; start < writes.length; start += BATCH_LIMIT) {
    const batch = fs.writeBatch(s.handles.db);
    const touches = new Set<CollectionName>();
    for (const w of writes.slice(start, start + BATCH_LIMIT)) {
      w.write(batch);
      touches.add(w.collection);
    }
    const entry: Batch = { seq: s.seq, prev, touches };
    s.seq += 1;
    s.inFlight.push(entry);
    batch.commit().then(
      () => onPushSuccess(s, entry),
      (error: unknown) => onPushError(s, entry, error),
    );
  }
  if (skipped.habits.size > 0 || skipped.tasks.size > 0) {
    s.pushError = skipped.habits.size > 0 ? HABITS.unaddressableMessage : TASKS.unaddressableMessage;
    useSyncStore.getState().setError(s.pushError);
  }
  return skipped;
}

/** Resolve each op of `ch` to a document write; an id Firestore cannot address is skipped (and reported unless it is a tombstone). */
function resolve<T, Op, Doc>(s: Session, ch: Channel<T, Op, Doc>, ops: readonly Op[], skipped: Set<string>): Write[] {
  const writes: Write[] = [];
  if (ops.length === 0 || s.handles === null) return writes;
  const { db, sdk } = s.handles;
  const fs = sdk.firestore;
  const k = ch.kind;
  for (const op of ops) {
    const id = k.opId(op);
    let ref: DocumentReference;
    try {
      ref = fs.doc(db, 'users', s.uid, k.collection, id);
    } catch (error) {
      // An id Firestore cannot use as a document path (a backup edited by hand, imported before ids
      // were checked for that). A tombstone for such an id protects nothing: no copy can exist there.
      if (!k.isTombstone(op)) skipped.add(id);
      console.warn('Momentum sync: skipped a write it could not address.', error);
      continue;
    }
    writes.push({ collection: k.collection, write: (batch) => k.write(fs, batch, ref, op) });
  }
  return writes;
}

function writeHabitOp(fs: FirebaseSdk['firestore'], batch: WriteBatch, ref: DocumentReference, op: PushOp): void {
  switch (op.type) {
    case 'setHabit': {
      const h = op.habit;
      // Absent optional fields are written as deletes so clearing a note or restoring a tracker reaches
      // other devices. `completions` is left to the merge and `deleted` is never written here.
      const fields: DocumentData = {
        id: h.id,
        name: h.name,
        emoji: h.emoji,
        color: h.color,
        note: h.note ?? fs.deleteField(),
        days: [...h.days],
        createdAt: h.createdAt,
        archivedAt: h.archivedAt ?? fs.deleteField(),
        order: h.order,
        updatedAt: fs.serverTimestamp(),
      };
      batch.set(ref, fields, { merge: true });
      return;
    }
    case 'addCompletion':
      batch.set(ref, { completions: { [op.dateKey]: true } }, { merge: true });
      return;
    case 'removeCompletion':
      // A merge-set with a nested deleteField() removes just that key, like update() with a dotted path
      // would, but without update()'s "document must exist" precondition: a document another device has
      // since hard-deleted can no longer fail the whole batch and drop the writes beside it.
      batch.set(ref, { completions: { [op.dateKey]: fs.deleteField() } }, { merge: true });
      return;
    case 'tombstone':
      batch.set(ref, { deleted: true, updatedAt: fs.serverTimestamp() }, { merge: true });
      return;
  }
}

function writeTaskOp(fs: FirebaseSdk['firestore'], batch: WriteBatch, ref: DocumentReference, op: TaskPushOp): void {
  switch (op.type) {
    case 'setTask': {
      const t = op.task;
      // SPEC §14.8: absent note/time/doneAt are written as deletes so clearing them (or un-checking the
      // task) reaches other devices. `deleted` is never written here.
      const fields: DocumentData = {
        id: t.id,
        title: t.title,
        note: t.note ?? fs.deleteField(),
        date: t.date,
        time: t.time ?? fs.deleteField(),
        done: t.done,
        doneAt: t.doneAt ?? fs.deleteField(),
        createdAt: t.createdAt,
        updatedAt: fs.serverTimestamp(),
      };
      batch.set(ref, fields, { merge: true });
      return;
    }
    case 'tombstoneTask':
      batch.set(ref, { deleted: true, updatedAt: fs.serverTimestamp() }, { merge: true });
      return;
  }
}

function settle(s: Session, entry: Batch): void {
  const index = s.inFlight.indexOf(entry);
  if (index >= 0) s.inFlight.splice(index, 1);
}

function onPushSuccess(s: Session, entry: Batch): void {
  settle(s, entry);
  if (session !== s) return;
  s.pushError = null;
  s.retriesLeft = RETRY_LIMIT;
}

/**
 * The commit was rejected (permission, quota, …): the SDK drops the batch and rolls its local view back.
 * Each collection the batch wrote returns, in `lastPushed`, to the state the cloud is known to hold (see
 * rollBack), so the edit counts as unpushed: the next snapshot keeps it in the store (three-way merge)
 * and re-sends it while retries last, and the owner's next change always re-sends it. A collection the
 * batch did not write keeps its side as it is: its snapshots were not held back by this batch, so what
 * it has reconciled since is the cloud's word, and rewinding it would replay those cloud changes as
 * local edits over newer cloud values.
 */
function onPushError(s: Session, entry: Batch, error: unknown): void {
  console.error('Momentum sync: a write was rejected.', error);
  if (session === s) {
    // Before settling, so the rejected batch is among the unsettled ones rollBack starts from.
    if (entry.touches.has('habits')) rollBack(s, s.habits);
    if (entry.touches.has('tasks')) rollBack(s, s.tasks);
  }
  settle(s, entry);
  if (session !== s) return;
  s.pushError = pushErrorMessage(error);
  const code = errorCode(error);
  if (code !== null && FINAL_PUSH_CODES.has(code)) s.retriesLeft = 0;
  useSyncStore.getState().setError(s.pushError);
}

/**
 * A rejected batch wrote `ch`'s collection. Its side of `lastPushed` returns to the `prev` of the oldest
 * unsettled batch writing that collection (normally the rejected one itself: commits settle in order),
 * the last state the cloud is known to hold, since snapshots of the collection are held back while any
 * such batch is in flight. The later unsettled batches writing it were diffed against states that
 * counted the rejected one as landed; their `prev` is rebased onto the same state, so rejecting one of
 * them later can never return to a state that counts the rejected edits as synced (batches handed over
 * after the rollback are diffed against it anyway).
 */
function rollBack<T, Op, Doc>(s: Session, ch: Channel<T, Op, Doc>): void {
  const k = ch.kind;
  const writing = s.inFlight.filter((b) => b.touches.has(k.collection));
  const oldest = writing[0];
  const known = oldest ? k.prevOf(oldest.prev) : null;
  if (known === null) return; // unreachable: a batch writing a collection is diffed against a known state
  for (const b of writing) b.prev = k.prevWith(b.prev, known);
  ch.lastPushed = known;
}

/* ---------- helpers ---------- */

function teardown(s: Session): void {
  for (const ch of [s.habits, s.tasks]) {
    ch.unsubscribe?.();
    ch.unsubscribe = null;
    ch.lastPushed = null;
  }
  s.unsubscribeStore?.();
  s.unsubscribeStore = null;
  if (s.confirmTimer !== null) {
    clearTimeout(s.confirmTimer);
    s.confirmTimer = null;
  }
  s.handles = null;
  s.inFlight = [];
}

const bothConfirmed = (s: Session): boolean => s.habits.confirmed && s.tasks.confirmed;

/** A batch writing `ch`'s collection has been handed over and has not settled. */
function inFlightOn<T, Op, Doc>(s: Session, ch: Channel<T, Op, Doc>): boolean {
  return s.inFlight.some((b) => b.touches.has(ch.kind.collection));
}

function skippedOf<T, Op, Doc>(skipped: Skipped, kind: Kind<T, Op, Doc>): Set<string> {
  return kind.collection === 'habits' ? skipped.habits : skipped.tasks;
}

/** Every document goes through the kind's parser, tombstones and field-less ones included; unusable ones are dropped. */
function parseSnapshot<T, Op, Doc>(snapshot: QuerySnapshot, kind: Kind<T, Op, Doc>): Doc[] {
  const remote: Doc[] = [];
  for (const d of snapshot.docs) {
    const parsed = kind.parse(d.id, d.data());
    if (parsed) remote.push(parsed);
  }
  return remote;
}

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Momentum sync: ${what} timed out.`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

function listenErrorMessage(error: FirestoreError): string {
  switch (error.code) {
    case 'permission-denied':
    case 'unauthenticated':
      return 'This account cannot reach its cloud data. Sign out and back in to reconnect.';
    case 'resource-exhausted':
      return 'The free sync quota is used up for today. Your data is safe on this device.';
    default:
      return GENERIC_SYNC_MESSAGE;
  }
}

function pushErrorMessage(error: unknown): string {
  switch (errorCode(error)) {
    case 'permission-denied':
    case 'unauthenticated':
      return 'A change could not be saved to the cloud. Sign out and back in to reconnect.';
    case 'resource-exhausted':
      return 'The free sync quota is used up for today. Try again tomorrow.';
    default:
      return 'A change could not be saved to the cloud.';
  }
}
