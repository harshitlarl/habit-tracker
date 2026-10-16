import type { DocumentData, DocumentReference, FirestoreError, QuerySnapshot, WriteBatch } from 'firebase/firestore';
import useStore, { type StoreState } from '../store';
import { clearBaseline, readBaseline, writeBaseline } from './baseline';
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
import type { LocalData, PushOp, RemoteHabit } from './types';

/**
 * Sync engine (SPEC §13.5 steps 1–5): Firestore onSnapshot listener + store subscription that pushes
 * diffs in chunked write batches, with an echo-loop guard.
 *
 * Model: the engine keeps "the cloud state as this device last knew it" — `lastPushed` within a session,
 * and a per-account baseline saved in localStorage across launches (baseline.ts). Every snapshot is
 * reconciled three-way against it (mergeWithBase): the local edits made since are replayed over the
 * cloud's view and sent, everything else follows the cloud. With no local edits that is exactly
 * "remote is authoritative"; with some, an edit that has not reached the cloud yet survives the snapshot
 * instead of being undone by it. Only a device that has never synced the account (no baseline) starts
 * with the first-contact union of mergeSnapshots, which uploads whatever is only on this device.
 * Tombstones are the exception in every phase: one this device holds is never dropped, and when the
 * cloud still shows that tracker live (a device that was offline when it was deleted) the tombstone is
 * pushed, so a deletion stays final (SPEC §13.4). Firestore's latency compensation echoes local writes
 * back in the next snapshot, where sameData() finds nothing to apply.
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
 */

/** Firestore accepts 500 writes per batch; 400 leaves headroom. */
const BATCH_LIMIT = 400;
/** A start that has not heard from the server after this long is reported as offline. */
const CONFIRM_TIMEOUT_MS = 10_000;
/** Each step of "Delete cloud data" gives up after this long, so the button never hangs on "Deleting…". */
const DELETE_STEP_TIMEOUT_MS = 20_000;
/** Snapshot-driven re-sends after a rejected batch, before the engine waits for the owner's next change. */
const RETRY_LIMIT = 3;

const LOAD_FAILED_MESSAGE = 'Sync could not start. Your data is safe on this device.';
const GENERIC_SYNC_MESSAGE = 'Sync hit a problem. Your data is safe on this device.';
const CLOUD_CLEARED_MESSAGE =
  'Your cloud data was deleted from another device, so sync is paused. Your trackers are still on this device. Sign out, then sign in again to upload them.';
const UNADDRESSABLE_MESSAGE = 'One tracker could not be saved to the cloud. Close and reopen the app to repair it.';

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

/** A write batch handed to Firestore. */
interface Batch {
  readonly seq: number;
  /** The cloud state as known before this batch; `lastPushed` returns here if the commit is rejected. */
  readonly prev: LocalData;
}

interface Session {
  readonly uid: string;
  handles: FirebaseHandles | null;
  unsubscribeSnapshot: (() => void) | null;
  unsubscribeStore: (() => void) | null;
  confirmTimer: ReturnType<typeof setTimeout> | null;
  /** Set once a server-confirmed snapshot has been reconciled. */
  confirmed: boolean;
  /** The confirm timer fired before the server answered. */
  timedOut: boolean;
  /** From an earlier launch: the server-confirmed cloud state this device last saw for this account. Null on first contact. */
  readonly baseline: LocalData | null;
  /** Ids of documents (trackers and tombstones) the server has acknowledged holding; saved with the baseline. */
  readonly acked: Set<string>;
  /** The cloud state as this device last knew it: the `prev` side of diffForPush. Null until the first snapshot. */
  lastPushed: LocalData | null;
  /** Batches handed to Firestore whose commit has not settled yet, oldest first (see the guard in onRemoteSnapshot). */
  inFlight: Batch[];
  /** The rejected batch `lastPushed` is pinned to, until a later hand-over or snapshot moves it on. */
  pinned: Batch | null;
  seq: number;
  /** The last rejected push, shown until a later push succeeds. */
  pushError: string | null;
  /** Snapshot-driven re-sends left while `pushError` stands; the owner's next change always re-sends. */
  retriesLeft: number;
}

let session: Session | null = null;
/** Loop guard: true while the store applies a snapshot, so the store subscription ignores that change. */
let applyingRemote = false;

/** Start listening to users/{uid}/habits and mirroring the local store. Idempotent per uid. */
export async function startSync(uid: string): Promise<void> {
  if (session?.uid === uid) return;
  if (session) stopSync();

  const saved = readBaseline(uid);
  const s: Session = {
    uid,
    handles: null,
    unsubscribeSnapshot: null,
    unsubscribeStore: null,
    confirmTimer: null,
    confirmed: false,
    timedOut: false,
    baseline: saved?.data ?? null,
    acked: new Set(saved?.acked ?? []),
    lastPushed: null,
    inFlight: [],
    pinned: null,
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
  const { db, sdk } = handles;
  const { collection, onSnapshot } = sdk.firestore;
  try {
    s.unsubscribeSnapshot = onSnapshot(
      collection(db, 'users', uid, 'habits'),
      { includeMetadataChanges: true },
      (snapshot) => onRemoteSnapshot(s, snapshot),
      (error) => onListenError(s, error),
    );
  } catch (error) {
    console.error('Momentum sync: could not listen to the cloud.', error);
    session = null;
    sync.setError(GENERIC_SYNC_MESSAGE);
    return;
  }
  // Changes made before this point (while the SDK was loading) are not lost: the first snapshot
  // reconciles the whole store, not a diff.
  s.unsubscribeStore = useStore.subscribe((state, prev) => onLocalChange(s, state, prev));
  s.confirmTimer = setTimeout(() => {
    s.confirmTimer = null;
    if (session !== s || s.confirmed) return;
    s.timedOut = true;
    const current = useSyncStore.getState();
    if (current.status === 'connecting') current.setStatus('offline');
  }, CONFIRM_TIMEOUT_MS);
}

/** Unsubscribe the snapshot listener and the store subscription; reset module state. Safe to call twice. */
export function stopSync(): void {
  const s = session;
  session = null;
  applyingRemote = false;
  if (s) teardown(s);
}

/**
 * Hard-delete every document under users/{uid}/habits in chunked batches (used by "Delete cloud data").
 * Stops the engine first: a running listener would mirror the vanishing documents into the local store,
 * and local data must survive this. Rejects with a friendly Error on failure; when nothing was deleted
 * and the engine was running it resumes syncing, when the sweep was partial the engine stays stopped
 * (with a sticky error) so the gaps are not mirrored locally. After a complete sweep this device's
 * memory of the account's cloud copy is cleared too, so the next sign-in is a first contact. The caller
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
    const snapshot = await withTimeout(
      fs.getDocsFromServer(fs.collection(db, 'users', uid, 'habits')),
      DELETE_STEP_TIMEOUT_MS,
      'listing the cloud documents',
    );
    const docs = snapshot.docs;
    for (let start = 0; start < docs.length; start += BATCH_LIMIT) {
      const batch = fs.writeBatch(db);
      for (const d of docs.slice(start, start + BATCH_LIMIT)) batch.delete(d.ref);
      await withTimeout(batch.commit(), DELETE_STEP_TIMEOUT_MS, 'deleting a batch');
      deletedAny = true;
    }
    clearBaseline(uid);
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

function onRemoteSnapshot(s: Session, snapshot: QuerySnapshot): void {
  if (session !== s) return;
  const { fromCache, hasPendingWrites } = snapshot.metadata;
  const sync = useSyncStore.getState();

  try {
    if (s.lastPushed !== null && s.inFlight.length > 0) {
      // A batch this device handed to Firestore has not settled: this view may predate it (the commit
      // promise settles before the view that includes it is delivered), or include an earlier batch but
      // not the latest. Applying it would briefly undo the owner's last tap. The view that follows the
      // acknowledgement (or the rollback) carries everything, remote changes included, and is applied.
    } else if (!fromCache && isCloudCleared(s, snapshot)) {
      // Sync only ever tombstones, so a document the server once acknowledged can vanish from the
      // server's view only through "Delete cloud data" on another device. Mirroring that would wipe
      // this device too; keep the local copy, pause, and say so.
      onCloudCleared(s);
      return;
    } else if (!s.confirmed && fromCache && s.baseline !== null) {
      // A device that has synced this account before already holds everything it knew in its store. A
      // cache view cannot be ahead of that, and may be behind it or empty (memory cache, cleared site
      // data): wait for the server's view, which follows as soon as the device is online.
    } else {
      // On first contact a cache snapshot may be stale or empty: the union is applied locally so nothing
      // is wiped, but the diff is only pushed once it has been computed against the server's view.
      const cloud = reconcile(s, parseSnapshot(snapshot), fromCache);
      if (!fromCache) {
        s.confirmed = true;
        for (const d of snapshot.docs) if (!d.metadata.hasPendingWrites) s.acked.add(d.id);
        // A fully acknowledged server view is what the next launch reconciles against.
        if (!hasPendingWrites) writeBaseline(s.uid, { data: cloud, acked: [...s.acked] });
      }
    }
  } catch (error) {
    console.error('Momentum sync: could not apply a snapshot.', error);
    sync.setError(GENERIC_SYNC_MESSAGE);
    return;
  }

  sync.setPending(hasPendingWrites);
  if (!fromCache) {
    sync.markSynced(Date.now());
  } else if (s.confirmed || s.timedOut || isBrowserOffline()) {
    sync.setStatus('offline');
  } else {
    // The cache answers first even when online; keep "connecting" until the server has been heard from.
    sync.setStatus('connecting');
  }
  if (s.pushError !== null) sync.setError(s.pushError);
}

/**
 * Reconcile one snapshot with the store and send the cloud what it lacks. First contact (no baseline
 * from an earlier launch, nothing reconciled yet this session): the whole local store takes part through
 * the union of mergeSnapshots, so a device signing in for the first time uploads what is only on it.
 * Afterwards: three-way, with the local edits since the cloud state this device last knew (the saved
 * baseline at launch, `lastPushed` within the session) replayed over the cloud's view, so a change made
 * on another device sticks here and an unpushed change made here survives the snapshot and is sent.
 * Returns the cloud's own view (see knownCloud), which is what the saved baseline records.
 */
function reconcile(s: Session, remote: readonly RemoteHabit[], fromCache: boolean): LocalData {
  const base = s.confirmed ? s.lastPushed : s.baseline;
  const local = restoreTombstoned(currentLocal(useStore.getState()), remote, base);
  const { merged, toPush } = base === null ? mergeSnapshots(local, remote) : mergeWithBase(base, local, remote);
  applyToStore(merged);
  const cloud = knownCloud(remote, merged);
  s.pinned = null;

  // First contact from the cache: the diff waits for the server's view.
  const deferred = !s.confirmed && fromCache;
  if (toPush.length === 0 || deferred) {
    s.lastPushed = merged;
    return cloud;
  }
  if (s.pushError !== null) {
    // A rejected batch triggers a rollback snapshot, which would re-send and be rejected again: retries
    // from here are bounded. The edit stays in the store either way, and the owner's next change
    // re-sends everything the cloud lacks.
    if (s.retriesLeft <= 0) {
      s.lastPushed = cloud;
      return cloud;
    }
    s.retriesLeft -= 1;
  }
  const skipped = push(s, toPush, cloud);
  s.lastPushed = skipped.size === 0 ? merged : withoutHabits(merged, skipped);
  return cloud;
}

/**
 * True when a document the server once acknowledged is missing from the server's view entirely. A
 * document this device is still writing shows up regardless (latency compensation), so a pending write
 * can neither hide a wipe nor fake one.
 */
function isCloudCleared(s: Session, snapshot: QuerySnapshot): boolean {
  if (s.acked.size === 0) return false;
  const present = new Set(snapshot.docs.map((d) => d.id));
  for (const id of s.acked) if (!present.has(id)) return true;
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
  // No further snapshots will arrive; pushing into a collection we cannot read would only pile up errors.
  session = null;
  teardown(s);
  useSyncStore.getState().setError(listenErrorMessage(error));
}

/** Replace the synced slice of the store (no-op when equal) without the store subscription pushing it back. */
function applyToStore(data: LocalData): void {
  const store = useStore.getState();
  if (sameData(currentLocal(store), data)) return;
  applyingRemote = true;
  try {
    store.applyRemote(data);
  } finally {
    applyingRemote = false;
  }
}

/**
 * What the cloud holds as this view shows it, plus every tombstone `merged` knows: a tombstone for an id
 * the cloud has never held is not pushed (nothing there to protect) and must not be re-diffed on every
 * local change either; the snapshot path pushes it the moment the cloud shows the tracker live.
 */
function knownCloud(remote: readonly RemoteHabit[], merged: LocalData): LocalData {
  const cloud = remoteToLocal(remote);
  return { habits: cloud.habits, completions: cloud.completions, deletedIds: merged.deletedIds };
}

/* ---------- store → cloud ---------- */

function onLocalChange(s: Session, state: StoreState, prev: StoreState): void {
  if (session !== s || applyingRemote || s.lastPushed === null) return;
  if (state.habits === prev.habits && state.completions === prev.completions && state.deletedIds === prev.deletedIds) {
    return; // settings only: never synced
  }
  const current = currentLocal(state);
  if (sameData(s.lastPushed, current)) return;
  // This runs inside the owner's tap (zustand notifies subscribers synchronously): nothing may throw out.
  try {
    const skipped = push(s, diffForPush(s.lastPushed, current), s.lastPushed);
    // Firestore queues a batch durably the moment it is handed over (persistent cache), so the cloud
    // "knows" it from here on even while offline; a rejected commit rolls this back (onPushError). Should
    // a memory-cache queue be lost, the next launch's merge against the saved baseline re-sends what is
    // only on this device.
    s.pinned = null;
    s.lastPushed = skipped.size === 0 ? current : withoutHabits(current, skipped);
  } catch (error) {
    console.error('Momentum sync: could not push a local change.', error);
    useSyncStore.getState().setError(GENERIC_SYNC_MESSAGE);
  }
}

/**
 * Hand `ops` to Firestore in batches of ≤ BATCH_LIMIT. `prev` is the cloud state the ops were diffed
 * against; a rejected batch rolls `lastPushed` back to it. Returns the ids of trackers whose writes could
 * not be addressed (never valid ids; see isValidId): those stay on this device and are reported, not
 * claimed as synced.
 */
function push(s: Session, ops: readonly PushOp[], prev: LocalData): Set<string> {
  const skipped = new Set<string>();
  if (ops.length === 0 || s.handles === null) return skipped;
  const { db, sdk } = s.handles;
  const fs = sdk.firestore;
  for (let start = 0; start < ops.length; start += BATCH_LIMIT) {
    const batch = fs.writeBatch(db);
    let count = 0;
    for (const op of ops.slice(start, start + BATCH_LIMIT)) {
      const id = op.type === 'setHabit' ? op.habit.id : op.habitId;
      let ref: DocumentReference;
      try {
        ref = fs.doc(db, 'users', s.uid, 'habits', id);
      } catch (error) {
        // An id Firestore cannot use as a document path (a backup edited by hand, imported before ids
        // were checked for that). A tombstone for such an id protects nothing: no copy can exist there.
        if (op.type !== 'tombstone') skipped.add(id);
        console.warn('Momentum sync: skipped a write it could not address.', error);
        continue;
      }
      addToBatch(fs, batch, ref, op);
      count += 1;
    }
    if (count === 0) continue;
    const entry: Batch = { seq: s.seq, prev };
    s.seq += 1;
    s.inFlight.push(entry);
    batch.commit().then(
      () => onPushSuccess(s, entry),
      (error: unknown) => onPushError(s, entry, error),
    );
  }
  if (skipped.size > 0) {
    s.pushError = UNADDRESSABLE_MESSAGE;
    useSyncStore.getState().setError(s.pushError);
  }
  return skipped;
}

function addToBatch(fs: FirebaseSdk['firestore'], batch: WriteBatch, ref: DocumentReference, op: PushOp): void {
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
 * `lastPushed` returns to the state the cloud is known to hold — the `prev` of the oldest batch that
 * had not settled — so the edit counts as unpushed: the next snapshot keeps it in the store (three-way
 * merge) and re-sends it while retries last, and the owner's next change always re-sends it.
 */
function onPushError(s: Session, entry: Batch, error: unknown): void {
  console.error('Momentum sync: a write was rejected.', error);
  const oldest = s.pinned ?? s.inFlight[0] ?? entry;
  settle(s, entry);
  if (session !== s) return;
  s.pinned = oldest;
  s.lastPushed = oldest.prev;
  s.pushError = pushErrorMessage(error);
  const code = errorCode(error);
  if (code !== null && FINAL_PUSH_CODES.has(code)) s.retriesLeft = 0;
  useSyncStore.getState().setError(s.pushError);
}

/* ---------- helpers ---------- */

function teardown(s: Session): void {
  s.unsubscribeSnapshot?.();
  s.unsubscribeSnapshot = null;
  s.unsubscribeStore?.();
  s.unsubscribeStore = null;
  if (s.confirmTimer !== null) {
    clearTimeout(s.confirmTimer);
    s.confirmTimer = null;
  }
  s.handles = null;
  s.lastPushed = null;
  s.inFlight = [];
  s.pinned = null;
}

function currentLocal(state: StoreState): LocalData {
  return { habits: state.habits, completions: state.completions, deletedIds: state.deletedIds };
}

/** `data` without the given trackers and their check-ins (tombstones untouched). */
function withoutHabits(data: LocalData, ids: ReadonlySet<string>): LocalData {
  const completions = { ...data.completions };
  for (const id of ids) delete completions[id];
  return { habits: data.habits.filter((h) => !ids.has(h.id)), completions, deletedIds: data.deletedIds };
}

/** Every document goes through parseRemoteDoc, tombstones and field-less ones included; unusable ones are dropped. */
function parseSnapshot(snapshot: QuerySnapshot): RemoteHabit[] {
  const remote: RemoteHabit[] = [];
  for (const d of snapshot.docs) {
    const parsed = parseRemoteDoc(d.id, d.data());
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
