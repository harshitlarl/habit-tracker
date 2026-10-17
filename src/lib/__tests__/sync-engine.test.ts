import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirebaseHandles } from '../sync/firebase';

/*
 * The sync engine against a small in-memory Firestore (SPEC §13.5 steps 1–5). The fake keeps a
 * collection of documents, applies write batches with Firestore's merge semantics (nested maps,
 * deleteField(), serverTimestamp()), records every committed op, and lets a test deliver snapshots
 * with chosen metadata — the way the real SDK would after a server round trip, from cache, or as the
 * latency-compensated echo of a local write.
 */

const fake = vi.hoisted(() => {
  type Data = Record<string, unknown>;
  interface Ref {
    path: string;
    id: string;
  }
  interface Listener {
    path: string;
    next: (snapshot: unknown) => void;
    error: (error: unknown) => void;
  }
  interface Op {
    kind: 'set' | 'update' | 'delete';
    path: string;
    data?: Data;
    merge?: boolean;
  }
  interface Meta {
    fromCache: boolean;
    hasPendingWrites: boolean;
  }

  const DELETE = Symbol('deleteField');
  const TIMESTAMP = Symbol('serverTimestamp');
  const SERVER_TIME = { seconds: 1_760_000_000, nanoseconds: 0 };

  const state = {
    docs: new Map<string, Data>(),
    listeners: new Set<Listener>(),
    /** Every committed batch, in commit order. */
    batches: [] as Op[][],
    /** When true, commits wait until settleCommits() — the time between hand-over and the server's ack. */
    manualCommits: false,
    pendingCommits: [] as Array<{ settle: () => void; reject: (error: unknown) => void }>,
    /** When set, loadFirebase() waits for openGate(). */
    gate: null as { promise: Promise<void>; open: () => void } | null,
    loadError: null as unknown,
    getDocsError: null as unknown,
    /** A step of "Delete cloud data" that never answers (a stalled connection). */
    hang: null as 'waitForPendingWrites' | 'getDocsFromServer' | null,
  };

  const isPlain = (v: unknown): v is Data => typeof v === 'object' && v !== null && !Array.isArray(v);

  function mergeInto(target: Data, patch: Data): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value === DELETE) {
        delete target[key];
      } else if (value === TIMESTAMP) {
        target[key] = { ...SERVER_TIME };
      } else if (isPlain(value)) {
        const nested: Data = isPlain(target[key]) ? { ...(target[key] as Data) } : {};
        mergeInto(nested, value);
        target[key] = nested;
      } else {
        target[key] = Array.isArray(value) ? [...value] : value;
      }
    }
  }

  function setDotted(target: Data, dotted: string, value: unknown): void {
    const segments = dotted.split('.');
    let cursor = target;
    for (const segment of segments.slice(0, -1)) {
      if (!isPlain(cursor[segment])) cursor[segment] = {};
      cursor = cursor[segment] as Data;
    }
    const last = segments[segments.length - 1] ?? '';
    if (value === DELETE) delete cursor[last];
    else if (value === TIMESTAMP) cursor[last] = { ...SERVER_TIME };
    else cursor[last] = value;
  }

  function apply(op: Op): void {
    const existing = state.docs.get(op.path);
    if (op.kind === 'delete') {
      state.docs.delete(op.path);
      return;
    }
    if (op.kind === 'update') {
      if (!existing) throw Object.assign(new Error('No document to update'), { code: 'not-found' });
      const next = structuredClone(existing);
      for (const [key, value] of Object.entries(op.data ?? {})) setDotted(next, key, value);
      state.docs.set(op.path, next);
      return;
    }
    const next: Data = op.merge && existing ? structuredClone(existing) : {};
    mergeInto(next, op.data ?? {});
    state.docs.set(op.path, next);
  }

  interface FakeDoc {
    id: string;
    ref: Ref;
    metadata: Meta;
    data: () => Data;
  }

  /**
   * The documents under `path` as the SDK would deliver them. Per-document metadata: a document named in
   * `pendingIds` has a write of this device awaiting the server; otherwise it follows the snapshot.
   */
  function docsUnder(path: string, metadata: Meta, pendingIds: readonly string[] = []): FakeDoc[] {
    const prefix = `${path}/`;
    return [...state.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, data]) => {
        const id = p.slice(prefix.length);
        const hasPendingWrites = pendingIds.length > 0 ? pendingIds.includes(id) : metadata.hasPendingWrites;
        return { id, ref: { path: p, id }, metadata: { fromCache: metadata.fromCache, hasPendingWrites }, data: () => structuredClone(data) };
      });
  }

  function snapshotFor(path: string, metadata: Meta, pendingIds: readonly string[] = []) {
    const docs = docsUnder(path, metadata, pendingIds);
    return { metadata, docs, size: docs.length, empty: docs.length === 0 };
  }

  const firestore = {
    collection: (_db: unknown, ...segments: string[]): Ref => ({ path: segments.join('/'), id: segments[segments.length - 1] ?? '' }),
    doc: (_db: unknown, ...segments: string[]): Ref => {
      if (segments.some((s) => s === '' || s.includes('/'))) throw new Error(`Invalid document path: ${segments.join('/')}`);
      return { path: segments.join('/'), id: segments[segments.length - 1] ?? '' };
    },
    onSnapshot: (ref: Ref, _options: unknown, next: Listener['next'], error: Listener['error']): (() => void) => {
      const listener: Listener = { path: ref.path, next, error };
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    writeBatch: () => {
      const ops: Op[] = [];
      return {
        set: (ref: Ref, data: Data, options?: { merge?: boolean }) => {
          ops.push({ kind: 'set', path: ref.path, data, merge: options?.merge === true });
        },
        update: (ref: Ref, data: Data) => {
          ops.push({ kind: 'update', path: ref.path, data });
        },
        delete: (ref: Ref) => {
          ops.push({ kind: 'delete', path: ref.path });
        },
        commit: () =>
          new Promise<void>((resolve, reject) => {
            state.batches.push(ops);
            const settle = (): void => {
              try {
                for (const op of ops) apply(op);
                resolve();
              } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            };
            if (state.manualCommits) state.pendingCommits.push({ settle, reject });
            else settle();
          }),
      };
    },
    deleteField: () => DELETE,
    serverTimestamp: () => TIMESTAMP,
    waitForPendingWrites: () => (state.hang === 'waitForPendingWrites' ? new Promise<void>(() => {}) : Promise.resolve()),
    getDocsFromServer: (ref: Ref) => {
      if (state.hang === 'getDocsFromServer') return new Promise<never>(() => {});
      return state.getDocsError
        ? Promise.reject(state.getDocsError instanceof Error ? state.getDocsError : new Error(String(state.getDocsError)))
        : Promise.resolve(snapshotFor(ref.path, { fromCache: false, hasPendingWrites: false }));
    },
  };

  const handles = { app: {}, auth: {}, db: {}, sdk: { app: {}, auth: {}, firestore } };

  return {
    DELETE,
    TIMESTAMP,
    SERVER_TIME,
    state,
    handles,
    load: (): Promise<typeof handles> => {
      if (state.loadError) return Promise.reject(state.loadError instanceof Error ? state.loadError : new Error('load'));
      if (state.gate) return state.gate.promise.then(() => handles);
      return Promise.resolve(handles);
    },
    /**
     * Deliver the current collection to every listener with the given metadata. `pendingIds` names the
     * documents that carry a write of this device the server has not acknowledged (the others are
     * acknowledged); without it every document follows the snapshot's hasPendingWrites.
     */
    emit: (metadata: Meta, pendingIds: readonly string[] = []): void => {
      for (const listener of [...state.listeners]) listener.next(snapshotFor(listener.path, metadata, pendingIds));
    },
    /** Deliver one collection only (its snapshot arriving before the other collection's). */
    emitTo: (path: string, metadata: Meta, pendingIds: readonly string[] = []): void => {
      for (const listener of [...state.listeners]) {
        if (listener.path === path) listener.next(snapshotFor(listener.path, metadata, pendingIds));
      }
    },
    /** Fail every listener the way Firestore does for a terminal error. */
    fail: (error: unknown): void => {
      for (const listener of [...state.listeners]) listener.error(error);
    },
    closeGate: (): void => {
      let open = (): void => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      state.gate = { promise, open };
    },
    openGate: (): void => {
      state.gate?.open();
      state.gate = null;
    },
    settleCommits: (): void => {
      const pending = state.pendingCommits.splice(0);
      for (const c of pending) c.settle();
    },
    rejectCommits: (error: unknown): void => {
      const pending = state.pendingCommits.splice(0);
      for (const c of pending) c.reject(error);
    },
    reset: (): void => {
      state.docs.clear();
      state.listeners.clear();
      state.batches = [];
      state.manualCommits = false;
      state.pendingCommits = [];
      state.gate = null;
      state.loadError = null;
      state.getDocsError = null;
      state.hang = null;
    },
  };
});

vi.mock('../sync/firebase', () => ({
  isSyncConfigured: () => true,
  loadFirebase: () => fake.load() as unknown as Promise<FirebaseHandles>,
}));

import useStore from '../store';
import { BASELINE_KEY_PREFIX, clearBaseline, hasSyncSession, readBaseline, setSyncSession } from '../sync/baseline';
import { CONFIRM_TIMEOUT_MS, DELETE_STEP_TIMEOUT_MS, deleteCloudData, startSync, stopSync } from '../sync/engine';
import { initialSyncState, useSyncStore } from '../sync/syncStore';
import type { Habit, Task, Weekday } from '../types';

const UID = 'owner-1';
const PATH = `users/${UID}/habits`;
const TASKS_PATH = `users/${UID}/tasks`;
const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const EMPTY_TASKS = { tasks: [], deletedTaskIds: [] };

const habit = (id: string, over: Partial<Habit> = {}): Habit => ({
  id,
  name: id.toUpperCase(),
  emoji: '✓',
  color: 'sage',
  days: [...EVERY_DAY],
  createdAt: '2026-10-01',
  order: 0,
  ...over,
});

/** A document as the engine writes it (note/archivedAt absent unless given). */
function seedDoc(h: Habit, extra: { completions?: Record<string, true>; deleted?: boolean } = {}): void {
  const { note, archivedAt, ...rest } = h;
  const data: Record<string, unknown> = {
    ...rest,
    days: [...h.days],
    completions: { ...(extra.completions ?? {}) },
    deleted: extra.deleted ?? false,
    updatedAt: { ...fake.SERVER_TIME },
  };
  if (note !== undefined) data.note = note;
  if (archivedAt !== undefined) data.archivedAt = archivedAt;
  fake.state.docs.set(`${PATH}/${h.id}`, data);
}

const cloudDoc = (id: string): Record<string, unknown> | undefined => fake.state.docs.get(`${PATH}/${id}`);

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  date: '2026-10-20',
  done: false,
  createdAt: '2026-10-17',
  ...over,
});

/** A task document as the engine writes it (note/time/doneAt absent unless given). */
function seedTaskDoc(t: Task, extra: { deleted?: boolean } = {}): void {
  const { note, time, doneAt, ...rest } = t;
  const data: Record<string, unknown> = { ...rest, deleted: extra.deleted ?? false, updatedAt: { ...fake.SERVER_TIME } };
  if (note !== undefined) data.note = note;
  if (time !== undefined) data.time = time;
  if (doneAt !== undefined) data.doneAt = doneAt;
  fake.state.docs.set(`${TASKS_PATH}/${t.id}`, data);
}

const cloudTask = (id: string): Record<string, unknown> | undefined => fake.state.docs.get(`${TASKS_PATH}/${id}`);
const store = () => useStore.getState();
const taskIds = (): string[] => store().tasks.map((t) => t.id);
const sync = () => useSyncStore.getState();
const ops = () => fake.state.batches.flat();
const serverSnapshot = (): void => fake.emit({ fromCache: false, hasPendingWrites: false });
const echoSnapshot = (): void => fake.emit({ fromCache: false, hasPendingWrites: true });
const cacheSnapshot = (): void => fake.emit({ fromCache: true, hasPendingWrites: false });
/** Lets promise chains (commit callbacks, the load await inside startSync) settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const setHabitOp = (h: Habit) => ({
  kind: 'set',
  path: `${PATH}/${h.id}`,
  merge: true,
  data: {
    id: h.id,
    name: h.name,
    emoji: h.emoji,
    color: h.color,
    note: h.note ?? fake.DELETE,
    days: [...h.days],
    createdAt: h.createdAt,
    archivedAt: h.archivedAt ?? fake.DELETE,
    order: h.order,
    updatedAt: fake.TIMESTAMP,
  },
});

/** SPEC §14.8: the setTask write, absent note/time/doneAt as deletes, never `deleted`. */
const setTaskOp = (t: Task) => ({
  kind: 'set',
  path: `${TASKS_PATH}/${t.id}`,
  merge: true,
  data: {
    id: t.id,
    title: t.title,
    note: t.note ?? fake.DELETE,
    date: t.date,
    time: t.time ?? fake.DELETE,
    done: t.done,
    doneAt: t.doneAt ?? fake.DELETE,
    createdAt: t.createdAt,
    updatedAt: fake.TIMESTAMP,
  },
});
const tombstoneOp = (path: string) => ({ kind: 'set', path, merge: true, data: { deleted: true, updatedAt: fake.TIMESTAMP } });

/** A stand-in for `globalThis.localStorage` (absent under node), for tests that plant a raw baseline record. */
function fakeLocalStorage(): Storage {
  const mem = new Map<string, string>();
  return {
    get length() {
      return mem.size;
    },
    key: (i: number) => [...mem.keys()][i] ?? null,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
  };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.reset();
  store().resetAll();
  useSyncStore.setState({ ...initialSyncState(), booting: false });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stopSync();
  warn.mockRestore();
  error.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A session that has heard from the server once on both collections, with the given cloud trackers and tasks. */
async function startConfirmed(cloud: Habit[] = [], cloudTasks: Task[] = []): Promise<void> {
  for (const h of cloud) seedDoc(h);
  for (const t of cloudTasks) seedTaskDoc(t);
  await startSync(UID);
  serverSnapshot();
  await flush();
  fake.state.batches = [];
}

describe('startSync / status', () => {
  it('is connecting until the server answers, synced after, offline for later cache snapshots', async () => {
    await startSync(UID);
    expect(sync().status).toBe('connecting');
    expect(fake.state.listeners.size).toBe(2);

    cacheSnapshot(); // the cache answers first even when online
    expect(sync().status).toBe('connecting');

    serverSnapshot();
    expect(sync().status).toBe('synced');
    expect(sync().lastSyncedAt).toBeTypeOf('number');
    expect(sync().pending).toBe(false);

    cacheSnapshot();
    expect(sync().status).toBe('offline');
    echoSnapshot();
    expect(sync().status).toBe('synced');
    expect(sync().pending).toBe(true);
    serverSnapshot();
    expect(sync().pending).toBe(false);
  });

  it('is idempotent per uid and replaces a session for another uid', async () => {
    await startSync(UID);
    const first = [...fake.state.listeners][0];
    await startSync(UID);
    expect(fake.state.listeners.size).toBe(2);
    expect([...fake.state.listeners][0]).toBe(first);
    await startSync('owner-2');
    expect(fake.state.listeners.size).toBe(2);
    expect([...fake.state.listeners].map((l) => l.path).sort()).toEqual(['users/owner-2/habits', 'users/owner-2/tasks']);
  });

  it('reports a friendly error when the SDK cannot be loaded, and attaches nothing', async () => {
    fake.state.loadError = new TypeError('Failed to fetch dynamically imported module');
    await startSync(UID);
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/could not start/i);
    expect(fake.state.listeners.size).toBe(0);
    expect(error).toHaveBeenCalled();
  });
});

describe('confirm timeout (no server snapshot yet)', () => {
  it('stays connecting until CONFIRM_TIMEOUT_MS, then reports offline; later cache snapshots keep it offline until the server answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    useStore.setState({ habits: [habit('a')] });
    await startSync(UID);
    cacheSnapshot(); // the cache answers, the server does not
    expect(sync().status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS - 1);
    expect(sync().status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(sync().status).toBe('offline');

    cacheSnapshot();
    expect(sync().status).toBe('offline');
    store().toggleCompletion('a', '2026-10-05'); // an edit meanwhile is handed to Firestore's queue…
    expect(ops()).toEqual([{ kind: 'set', path: `${PATH}/a`, merge: true, data: { completions: { '2026-10-05': true } } }]);
    await vi.advanceTimersByTimeAsync(0); // the hand-over settles
    fake.emit({ fromCache: true, hasPendingWrites: true }); // …and its latency-compensated echo is still offline
    expect(sync().status).toBe('offline');
    expect(sync().pending).toBe(true);
    expect(store().completions).toEqual({ a: { '2026-10-05': true } }); // local data intact

    serverSnapshot(); // the connection comes back
    expect(sync().status).toBe('synced');
    expect(sync().pending).toBe(false);
    expect(cloudDoc('a')).toMatchObject({ completions: { '2026-10-05': true } });
  });

  it('a lone server snapshot after the timeout reads connecting until the other collection answers too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startSync(UID);
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    expect(sync().status).toBe('offline');
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false });
    expect(sync().status).toBe('connecting');
    fake.emitTo(TASKS_PATH, { fromCache: true, hasPendingWrites: false });
    expect(sync().status).toBe('offline'); // the timer has spoken: a cache view of the other collection is offline
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(sync().status).toBe('synced');
  });

  it('does not fire once both collections have answered, nor after stopSync', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startSync(UID);
    serverSnapshot();
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    expect(sync().status).toBe('synced');

    stopSync();
    useSyncStore.setState({ status: 'connecting' });
    await startSync(UID);
    stopSync();
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    expect(sync().status).toBe('connecting'); // the stopped session's timer was cleared
  });
});

describe('first contact', () => {
  it('pushes local-only trackers and check-ins, adopts the cloud, remote fields win, completions union', async () => {
    const a = habit('a', { name: 'Local A' });
    const c = habit('c', { order: 1, note: 'local only' });
    useStore.setState({ habits: [a, c], completions: { a: { '2026-10-05': true }, c: { '2026-10-06': true } } });
    seedDoc(habit('a', { name: 'Cloud A' }), { completions: { '2026-10-02': true } });
    seedDoc(habit('b', { order: 2 }));

    await startSync(UID);
    serverSnapshot();

    expect(store().habits.map((h) => [h.id, h.name, h.order])).toEqual([
      ['a', 'Cloud A', 0],
      ['c', 'C', 1],
      ['b', 'B', 2],
    ]);
    expect(store().completions).toEqual({ a: { '2026-10-02': true, '2026-10-05': true }, c: { '2026-10-06': true } });

    expect(ops()).toEqual([
      { kind: 'set', path: `${PATH}/a`, merge: true, data: { completions: { '2026-10-05': true } } },
      setHabitOp(c),
      { kind: 'set', path: `${PATH}/c`, merge: true, data: { completions: { '2026-10-06': true } } },
    ]);
    // The fake cloud now holds what was pushed, with the server time filled in and no `deleted` written.
    expect(cloudDoc('c')).toEqual({ ...habit('c', { order: 1, note: 'local only' }), completions: { '2026-10-06': true }, updatedAt: fake.SERVER_TIME });
    expect(cloudDoc('c')).not.toHaveProperty('deleted');
    expect(cloudDoc('a')?.completions).toEqual({ '2026-10-02': true, '2026-10-05': true });
  });

  it('the echo of its own writes changes nothing and pushes nothing', async () => {
    useStore.setState({ habits: [habit('a')], completions: { a: { '2026-10-05': true } } });
    await startSync(UID);
    serverSnapshot();
    const batches = fake.state.batches.length;
    const habits = store().habits;

    echoSnapshot();
    serverSnapshot();
    expect(fake.state.batches.length).toBe(batches);
    expect(store().habits).toBe(habits); // applyRemote was a no-op: same reference
  });

  it('includes changes made while the SDK was still loading', async () => {
    fake.closeGate();
    const started = startSync(UID);
    const added = store().addHabit({ name: 'Early', emoji: 'e', color: 'plum', days: [0] });
    expect(fake.state.listeners.size).toBe(0);
    fake.openGate();
    await started;
    expect(fake.state.listeners.size).toBe(2);
    expect(fake.state.batches).toEqual([]); // nothing is pushed before the first snapshot

    serverSnapshot();
    expect(ops()).toEqual([setHabitOp(added)]);
  });

  it('merges every snapshot up to the first server-confirmed one, so cache snapshots never wipe local data, and pushes only against the server view', async () => {
    useStore.setState({ habits: [habit('a')] });
    seedDoc(habit('b', { order: 1 }));
    await startSync(UID);
    cacheSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(ops()).toEqual([]); // a cache view may be stale or empty: the diff waits for the server's view
    serverSnapshot();
    expect(ops()).toEqual([setHabitOp(habit('a'))]);
    serverSnapshot();
    expect(ops()).toHaveLength(1); // the cloud has it now (the fake applied the push): nothing more
  });

  it('an empty cache snapshot while offline (memory cache) does not push the whole store over the cloud', async () => {
    useStore.setState({ habits: [habit('a', { name: 'Stale local name' })] });
    seedDoc(habit('a', { name: 'Cloud name' }));
    await startSync(UID);
    fake.state.docs.clear(); // what an empty cache would show…
    cacheSnapshot();
    expect(ops()).toEqual([]); // …must not be mistaken for "the cloud lacks a"
    seedDoc(habit('a', { name: 'Cloud name' }));
    serverSnapshot();
    expect(store().habits[0]?.name).toBe('Cloud name'); // remote fields win on first contact
    expect(ops()).toEqual([]);
  });

  it('re-numbers colliding orders from the cloud and pushes the fix once', async () => {
    seedDoc(habit('a', { createdAt: '2026-10-01' }));
    seedDoc(habit('b', { createdAt: '2026-10-02' }));
    await startSync(UID);
    serverSnapshot();
    expect(store().habits.map((h) => [h.id, h.order])).toEqual([
      ['a', 0],
      ['b', 1],
    ]);
    expect(ops()).toEqual([setHabitOp(habit('b', { createdAt: '2026-10-02', order: 1 }))]);
    serverSnapshot();
    expect(ops()).toHaveLength(1);
  });

  it('a local tracker the cloud has tombstoned, which this device never deleted, is restored under a new id', async () => {
    // A backup restored on a fresh device after the tracker was deleted elsewhere (SPEC §13.4 re-key rule).
    useStore.setState({ habits: [habit('x', { name: 'Gym' })], completions: { x: { '2026-10-05': true } } });
    seedDoc(habit('x'), { deleted: true });
    await startSync(UID);
    serverSnapshot();

    const restored = store().habits[0] as Habit;
    expect(restored.name).toBe('Gym');
    expect(restored.id).not.toBe('x');
    expect(store().completions).toEqual({ [restored.id]: { '2026-10-05': true } });
    expect(store().deletedIds).toEqual(['x']); // the deletion of the old id stays final
    expect(ops()).toEqual([
      setHabitOp(restored),
      { kind: 'set', path: `${PATH}/${restored.id}`, merge: true, data: { completions: { '2026-10-05': true } } },
    ]);
    serverSnapshot();
    expect(ops()).toHaveLength(2);
    expect(store().habits).toHaveLength(1);
  });

  it('a tracker tombstoned on this device too is simply dropped, with its check-ins', async () => {
    useStore.setState({ habits: [habit('x')], completions: { x: { '2026-10-05': true } }, deletedIds: ['x'] });
    seedDoc(habit('x'), { deleted: true });
    await startSync(UID);
    serverSnapshot();
    expect(store().habits).toEqual([]);
    expect(store().completions).toEqual({});
    expect(ops()).toEqual([]);
  });
});

describe('relaunch with a saved baseline', () => {
  it('an un-check made elsewhere while this device was closed sticks, and nothing is pushed back', async () => {
    useStore.setState({ habits: [habit('a')], completions: { a: { '2026-10-05': true } } });
    seedDoc(habit('a'), { completions: { '2026-10-05': true } });
    await startSync(UID);
    serverSnapshot();
    expect(readBaseline(UID)?.data.completions).toEqual({ a: { '2026-10-05': true } });
    stopSync(); // the phone is closed

    // The phone relaunches. Its cache still shows the check-in…
    await startSync(UID);
    cacheSnapshot();
    expect(store().completions).toEqual({ a: { '2026-10-05': true } });
    // …but the laptop has un-checked it meanwhile.
    fake.state.docs.set(`${PATH}/a`, { ...cloudDoc('a'), completions: {} });
    serverSnapshot();
    expect(store().completions).toEqual({});
    expect(ops()).toEqual([]);

    // And again at the next relaunch: the un-check is not resurrected.
    stopSync();
    await startSync(UID);
    serverSnapshot();
    expect(store().completions).toEqual({});
    expect(ops()).toEqual([]);
    expect(cloudDoc('a')?.completions).toEqual({});
  });

  it('edits made here before the server answers survive and are pushed; edits made elsewhere while closed stick', async () => {
    await startConfirmed([habit('a'), habit('b', { order: 1 })]);
    stopSync();
    fake.state.docs.set(`${PATH}/b`, { ...cloudDoc('b'), name: 'Laptop name' });

    await startSync(UID);
    store().updateHabit('a', { name: 'Phone name' }); // before the first snapshot of the session
    store().toggleCompletion('b', '2026-10-05');
    expect(ops()).toEqual([]); // nothing goes up before the server's view
    serverSnapshot();
    expect(store().habits.map((h) => h.name)).toEqual(['Phone name', 'Laptop name']);
    expect(store().completions).toEqual({ b: { '2026-10-05': true } });
    expect(ops()).toEqual([
      setHabitOp(habit('a', { name: 'Phone name' })),
      { kind: 'set', path: `${PATH}/b`, merge: true, data: { completions: { '2026-10-05': true } } },
    ]);
    serverSnapshot();
    expect(ops()).toHaveLength(2);
  });

  it('edits to the same tracker on both sides merge field by field', async () => {
    await startConfirmed([habit('a')]);
    stopSync();
    fake.state.docs.set(`${PATH}/a`, { ...cloudDoc('a'), name: 'Renamed elsewhere' });
    store().updateHabit('a', { color: 'plum', note: 'by 8 AM' }); // made here while closed to the cloud

    await startSync(UID);
    serverSnapshot();
    const merged = habit('a', { name: 'Renamed elsewhere', color: 'plum', note: 'by 8 AM' });
    expect(store().habits).toEqual([merged]);
    expect(ops()).toEqual([setHabitOp(merged)]);
  });

  it('a tracker deleted elsewhere while closed goes, together with check-ins made here meanwhile', async () => {
    await startConfirmed([habit('a'), habit('b', { order: 1 })]);
    stopSync();
    store().toggleCompletion('b', '2026-10-05');
    fake.state.docs.set(`${PATH}/b`, { ...cloudDoc('b'), deleted: true });

    await startSync(UID);
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a']);
    expect(store().completions).toEqual({});
    expect(store().deletedIds).toEqual(['b']);
    expect(ops()).toEqual([]);
  });

  it('a tracker created here while closed is uploaded, one created elsewhere arrives, a deletion here is pushed', async () => {
    await startConfirmed([habit('a'), habit('d', { order: 3 })]);
    stopSync();
    const added = store().addHabit({ name: 'New here', emoji: 'n', color: 'moss', days: [0] });
    store().deleteHabit('d');
    seedDoc(habit('c', { order: 5 }));

    await startSync(UID);
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a', added.id, 'c']);
    expect(store().deletedIds).toEqual(['d']);
    expect(ops()).toEqual([
      setHabitOp(added),
      { kind: 'set', path: `${PATH}/d`, merge: true, data: { deleted: true, updatedAt: fake.TIMESTAMP } },
    ]);
    expect(cloudDoc('d')?.deleted).toBe(true);
  });

  it('a write that never reached the cloud (memory cache, app closed) is sent again at the next launch', async () => {
    await startConfirmed([habit('a')]);
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05');
    echoSnapshot(); // seen locally, never acknowledged: not part of the saved baseline
    expect(readBaseline(UID)?.data.completions).toEqual({});
    stopSync();
    fake.state.pendingCommits = []; // the queue died with the page
    fake.state.batches = [];
    fake.state.manualCommits = false;

    await startSync(UID);
    serverSnapshot();
    expect(store().completions).toEqual({ a: { '2026-10-05': true } });
    expect(ops()).toEqual([{ kind: 'set', path: `${PATH}/a`, merge: true, data: { completions: { '2026-10-05': true } } }]);
    expect(cloudDoc('a')?.completions).toEqual({ '2026-10-05': true });
  });

  it('the baseline follows acknowledged server views only and is forgotten by deleteCloudData', async () => {
    await startConfirmed([habit('a')]);
    expect(readBaseline(UID)).toEqual({
      data: { habits: [habit('a')], completions: {}, deletedIds: [] },
      acked: ['a'],
      tasks: EMPTY_TASKS,
      ackedTasks: [],
    });
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05');
    echoSnapshot();
    expect(readBaseline(UID)?.data.completions).toEqual({}); // pending writes are not the server's word
    fake.settleCommits();
    await flush();
    serverSnapshot();
    expect(readBaseline(UID)?.data.completions).toEqual({ a: { '2026-10-05': true } });

    fake.state.manualCommits = false;
    await deleteCloudData(UID);
    expect(readBaseline(UID)).toBeNull();
  });

  it('cache snapshots before the server answers change nothing when a baseline exists, even an empty one', async () => {
    await startConfirmed([habit('a', { name: 'Cloud name' })]);
    stopSync();
    store().updateHabit('a', { name: 'Edited while closed' });

    await startSync(UID);
    const before = store().habits;
    fake.state.docs.clear(); // a memory cache answers empty first
    cacheSnapshot();
    expect(store().habits).toBe(before); // not wiped, not touched
    expect(sync().status).toBe('connecting');
    expect(ops()).toEqual([]);

    seedDoc(habit('a', { name: 'Cloud name' }));
    serverSnapshot();
    expect(store().habits[0]?.name).toBe('Edited while closed'); // the local edit since the baseline wins
    expect(ops()).toEqual([setHabitOp(habit('a', { name: 'Edited while closed' }))]);
  });
});

describe('local changes → cloud', () => {
  it('pushes each change as a diff with the SPEC op shapes, and the echo does not re-push', async () => {
    const a = habit('a');
    await startConfirmed([a]);

    store().toggleCompletion('a', '2026-10-05');
    expect(ops()).toEqual([{ kind: 'set', path: `${PATH}/a`, merge: true, data: { completions: { '2026-10-05': true } } }]);
    echoSnapshot();
    serverSnapshot();
    expect(ops()).toHaveLength(1);

    store().setCompletion('a', '2026-10-05', false);
    // removeCompletion: a merge-set with a nested deleteField — no "must exist" precondition.
    expect(ops()[1]).toEqual({ kind: 'set', path: `${PATH}/a`, merge: true, data: { completions: { '2026-10-05': fake.DELETE } } });
    expect(cloudDoc('a')?.completions).toEqual({});

    store().updateHabit('a', { note: 'by 8 AM' });
    expect(ops()[2]).toEqual(setHabitOp({ ...a, note: 'by 8 AM' }));
    store().updateHabit('a', { note: '' });
    expect(ops()[3]).toEqual(setHabitOp(a)); // note cleared → deleteField, so the cloud forgets it too
    expect(cloudDoc('a')).not.toHaveProperty('note');

    store().archiveHabit('a');
    const archived = store().habits[0];
    expect(archived?.archivedAt).toBeDefined();
    expect(ops()[4]).toEqual(setHabitOp(archived as Habit));
    store().unarchiveHabit('a');
    expect(ops()[5]).toEqual(setHabitOp(a));
    expect(cloudDoc('a')).not.toHaveProperty('archivedAt');

    store().deleteHabit('a');
    expect(ops()[6]).toEqual({ kind: 'set', path: `${PATH}/a`, merge: true, data: { deleted: true, updatedAt: fake.TIMESTAMP } });
    expect(cloudDoc('a')?.deleted).toBe(true);
    expect(cloudDoc('a')?.name).toBe('A'); // a tombstone keeps its fields
    expect(ops()).toHaveLength(7);
  });

  it('never pushes settings, and pushes nothing for a change that equals the known cloud state', async () => {
    await startConfirmed([habit('a')]);
    store().setTheme('dark');
    store().dismissInstallHint();
    useStore.setState({ habits: [habit('a')] }); // a fresh but equal array
    expect(ops()).toEqual([]);
  });

  it('a new tracker goes up before its check-ins, in one batch', async () => {
    await startConfirmed();
    const added = store().addHabit({ name: 'Walk', emoji: 'w', color: 'moss', days: [0, 1] });
    store().setCompletion(added.id, '2026-10-05', true);
    expect(fake.state.batches).toHaveLength(2);
    expect(ops()).toEqual([
      setHabitOp(added),
      { kind: 'set', path: `${PATH}/${added.id}`, merge: true, data: { completions: { '2026-10-05': true } } },
    ]);
  });

  it('splits more than 400 ops into several batches', async () => {
    await startConfirmed([habit('a')]);
    const dates: Record<string, true> = {};
    for (let i = 0; i < 450; i += 1) {
      const d = new Date(2025, 0, 1 + i);
      dates[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = true;
    }
    useStore.setState({ completions: { a: dates } });
    expect(fake.state.batches.map((b) => b.length)).toEqual([400, 50]);
  });

  it('a write whose id cannot be a document path is reported, the rest is sent, and the tracker is never claimed as synced', async () => {
    await startConfirmed();
    // isValidId rejects such ids everywhere data comes in; this is the engine's own guard.
    useStore.setState({ habits: [habit('bad/id'), habit('ok', { order: 1 })] });
    expect(ops()).toEqual([setHabitOp(habit('ok', { order: 1 }))]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/could not be saved/);

    serverSnapshot(); // the cloud has only `ok`
    expect(store().habits.map((h) => h.id)).toEqual(['bad/id', 'ok']); // kept on the device, not wiped
    expect(sync().status).toBe('error'); // and never reported as synced
  });

  it('a rejected write shows a sticky friendly error until a later write lands', async () => {
    await startConfirmed([habit('a')]);
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05');
    fake.rejectCommits(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await flush();
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/could not be saved.*Sign out and back in/);
    serverSnapshot();
    expect(sync().status).toBe('error'); // sticky

    store().toggleCompletion('a', '2026-10-06');
    fake.settleCommits();
    await flush();
    serverSnapshot();
    expect(sync().status).toBe('synced');
    expect(sync().error).toBeNull();
  });

  it('a rejected write is kept on the device through the rollback snapshot and re-sent with the next change', async () => {
    await startConfirmed([habit('a')]);
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05');
    expect(fake.state.batches).toHaveLength(1);
    fake.rejectCommits(Object.assign(new Error('quota'), { code: 'resource-exhausted' }));
    await flush();
    expect(sync().error).toMatch(/quota/);

    // The SDK rolls its view back to the server's: the check-in must not vanish from the device.
    serverSnapshot();
    expect(store().completions.a).toEqual({ '2026-10-05': true });
    expect(fake.state.batches).toHaveLength(1); // a final code: no automatic re-send
    expect(sync().status).toBe('error');

    // The next change carries the lost one along; once it lands the cloud has both.
    store().toggleCompletion('a', '2026-10-06');
    expect(fake.state.batches).toHaveLength(2);
    expect(fake.state.batches[1]).toEqual([
      { kind: 'set', path: `${PATH}/a`, merge: true, data: { completions: { '2026-10-05': true } } },
      { kind: 'set', path: `${PATH}/a`, merge: true, data: { completions: { '2026-10-06': true } } },
    ]);
    fake.settleCommits();
    await flush();
    expect(cloudDoc('a')?.completions).toEqual({ '2026-10-05': true, '2026-10-06': true });
    serverSnapshot();
    expect(sync().status).toBe('synced');
    expect(store().completions.a).toEqual({ '2026-10-05': true, '2026-10-06': true });
  });

  it('after a transient rejection the next snapshots re-send a bounded number of times, then wait for the owner', async () => {
    await startConfirmed([habit('a')]);
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05');
    const reject = async (): Promise<void> => {
      fake.rejectCommits(Object.assign(new Error('aborted'), { code: 'aborted' }));
      await flush();
    };
    await reject();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      serverSnapshot(); // the rollback view: the check-in is kept and re-sent
      expect(store().completions.a).toEqual({ '2026-10-05': true });
      expect(fake.state.batches).toHaveLength(1 + attempt);
      await reject();
    }
    serverSnapshot();
    expect(fake.state.batches).toHaveLength(4); // retries used up
    expect(store().completions.a).toEqual({ '2026-10-05': true }); // still here
    expect(sync().status).toBe('error');

    store().toggleCompletion('a', '2026-10-06'); // the owner's change re-sends it
    expect(fake.state.batches).toHaveLength(5);
    fake.settleCommits();
    await flush();
    expect(cloudDoc('a')?.completions).toEqual({ '2026-10-05': true, '2026-10-06': true });
  });

  it('a rejected chunk of a multi-batch push is re-sent in full by the next change', async () => {
    await startConfirmed([habit('a')]);
    fake.state.manualCommits = true;
    const dates: Record<string, true> = {};
    for (let i = 0; i < 401; i += 1) {
      const d = new Date(2025, 0, 1 + i);
      dates[`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`] = true;
    }
    useStore.setState({ completions: { a: dates } });
    expect(fake.state.batches.map((b) => b.length)).toEqual([400, 1]);
    const [first, second] = fake.state.pendingCommits.splice(0);
    first?.settle();
    second?.reject(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await flush();

    store().toggleCompletion('a', '2026-10-05');
    // Everything after the state the cloud is known to hold goes again (idempotent merge-sets).
    expect(fake.state.batches).toHaveLength(4);
    expect(fake.state.batches.slice(2).flat()).toHaveLength(402);
  });
});

describe('cloud changes → store', () => {
  it('applies remote edits, tombstones and new trackers without pushing anything back', async () => {
    await startConfirmed([habit('a'), habit('b', { order: 1 })]);
    const before = store().habits;

    fake.state.docs.set(`${PATH}/a`, { ...cloudDoc('a'), name: 'Renamed', note: 'from the laptop' });
    serverSnapshot();
    expect(store().habits[0]).toMatchObject({ id: 'a', name: 'Renamed', note: 'from the laptop' });
    expect(store().habits).not.toBe(before);

    fake.state.docs.set(`${PATH}/b`, { ...cloudDoc('b'), deleted: true });
    seedDoc(habit('c', { order: 2 }), { completions: { '2026-10-05': true } });
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a', 'c']);
    expect(store().deletedIds).toEqual(['b']);
    expect(store().completions).toEqual({ c: { '2026-10-05': true } });
    expect(ops()).toEqual([]);
  });

  it('a snapshot that arrives while applying never loops: the store subscription ignores remote applies', async () => {
    await startConfirmed([habit('a')]);
    let changes = 0;
    const unsubscribe = useStore.subscribe(() => {
      changes += 1;
    });
    fake.state.docs.set(`${PATH}/a`, { ...cloudDoc('a'), name: 'Edited elsewhere' });
    serverSnapshot();
    serverSnapshot();
    unsubscribe();
    expect(changes).toBe(1); // applied once; the second, equal snapshot did not even set()
    expect(ops()).toEqual([]);
  });

  it('skips a snapshot computed before a batch in flight reached the local view', async () => {
    await startConfirmed([habit('a')]);
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05');
    expect(store().completions.a).toEqual({ '2026-10-05': true });

    serverSnapshot(); // the cloud has not applied the batch yet; this view predates the tap
    expect(store().completions.a).toEqual({ '2026-10-05': true }); // not undone

    fake.settleCommits();
    await flush();
    serverSnapshot();
    expect(store().completions.a).toEqual({ '2026-10-05': true });
    expect(cloudDoc('a')?.completions).toEqual({ '2026-10-05': true });
  });

  it('keeps the tombstones this device holds after first contact, and pushes one when the cloud shows the tracker live', async () => {
    useStore.setState({ deletedIds: ['x'] });
    await startConfirmed([habit('a')]);
    expect(store().deletedIds).toEqual(['x']);

    serverSnapshot();
    expect(store().deletedIds).toEqual(['x']); // not dropped by the authoritative phase
    expect(ops()).toEqual([]); // and not pushed for an id the cloud has never seen

    seedDoc(habit('x', { order: 1 })); // a device that was offline when x was deleted pushes it
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a']);
    expect(store().deletedIds).toEqual(['x']);
    expect(ops()).toEqual([{ kind: 'set', path: `${PATH}/x`, merge: true, data: { deleted: true, updatedAt: fake.TIMESTAMP } }]);
    expect(cloudDoc('x')?.deleted).toBe(true);

    serverSnapshot();
    expect(ops()).toHaveLength(1);
  });

  it('a collection emptied on another device pauses sync and keeps the local copy', async () => {
    await startConfirmed([habit('a'), habit('b', { order: 1 })]);
    expect(store().habits).toHaveLength(2);

    fake.state.docs.clear(); // "Delete cloud data" on the laptop
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/deleted from another device/);
    expect(fake.state.listeners.size).toBe(0);

    store().toggleCompletion('a', '2026-10-05'); // paused: nothing goes up
    expect(ops()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('a wipe is recognised even when a write of this device puts a document back onto the emptied collection', async () => {
    await startConfirmed([habit('a'), habit('b', { order: 1 }), habit('c', { order: 2 })]);
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05'); // flaky connection: the merge-set is queued

    // "Delete cloud data" on the phone. The laptop's view: b and c are gone; a survives only as the
    // latency-compensated overlay of its own pending write (a partial document). Nothing is applied
    // while that write is unsettled…
    fake.state.docs.clear();
    fake.state.docs.set(`${PATH}/a`, { completions: { '2026-10-05': true } });
    fake.emit({ fromCache: false, hasPendingWrites: true }, ['a']);
    expect(store().habits.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(fake.state.listeners.size).toBe(2);

    // …and once it lands, the view (a alone, as the merge-set wrote it) shows b and c vanished.
    fake.settleCommits();
    await flush();
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(store().completions.a).toEqual({ '2026-10-05': true });
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/deleted from another device/);
    expect(fake.state.listeners.size).toBe(0);
  });

  it('a wipe made while this device was closed is recognised at the next launch', async () => {
    await startConfirmed([habit('a'), habit('b', { order: 1 })]);
    stopSync(); // app closed; the baseline remembers what the server acknowledged
    fake.state.docs.clear(); // "Delete cloud data" elsewhere

    await startSync(UID);
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a', 'b']); // not wiped, not re-uploaded
    expect(ops()).toEqual([]);
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/deleted from another device/);
    expect(fake.state.listeners.size).toBe(0);

    // The pause holds across relaunches until the owner signs out (which forgets the baseline).
    await startSync(UID);
    serverSnapshot();
    expect(sync().error).toMatch(/deleted from another device/);
    expect(ops()).toEqual([]);

    clearBaseline(UID); // what sign-out does (bootstrap.ts)
    await startSync(UID);
    serverSnapshot();
    expect(sync().status).toBe('synced'); // first contact again: this device's copy goes up
    expect(ops().filter((op) => op.kind === 'set')).toHaveLength(2);
    expect(fake.state.docs.size).toBe(2);
  });

  it('a pending write on the only tracker is not mistaken for a wipe', async () => {
    await startConfirmed([habit('a')]);
    fake.state.manualCommits = true;
    store().toggleCompletion('a', '2026-10-05');
    fake.emit({ fromCache: false, hasPendingWrites: true }, ['a']); // the echo: every document pending
    expect(sync().status).toBe('synced');
    expect(fake.state.listeners.size).toBe(2);
  });

  it('an account whose cloud was always empty is not mistaken for a wipe', async () => {
    useStore.setState({ deletedIds: ['never-synced'] });
    await startSync(UID);
    serverSnapshot();
    serverSnapshot();
    expect(sync().status).toBe('synced');
    expect(store().deletedIds).toEqual(['never-synced']);
    expect(fake.state.listeners.size).toBe(2);
  });

  it('a terminal listener error tears everything down with a friendly message', async () => {
    await startConfirmed([habit('a')]);
    fake.fail(Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }));
    expect(fake.state.listeners.size).toBe(0);
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/Sign out and back in/);
    store().toggleCompletion('a', '2026-10-05');
    expect(ops()).toEqual([]);
    expect(store().habits).toHaveLength(1); // local data untouched
  });

  it('an unusable document is dropped rather than crashing the snapshot', async () => {
    await startConfirmed([habit('a')]);
    fake.state.docs.set(`${PATH}/junk`, { name: 42 });
    fake.state.docs.set(`${PATH}/t`, { deleted: true, updatedAt: null }); // a bare tombstone with a pending timestamp
    serverSnapshot();
    expect(store().habits.map((h) => h.id)).toEqual(['a']);
    expect(store().deletedIds).toEqual(['t']);
    expect(sync().status).toBe('synced');
  });
});

describe('stopSync', () => {
  it('detaches the listener and the store subscription; later events are ignored; safe twice', async () => {
    await startConfirmed([habit('a')]);
    stopSync();
    stopSync();
    expect(fake.state.listeners.size).toBe(0);
    store().toggleCompletion('a', '2026-10-05');
    expect(ops()).toEqual([]);
    expect(store().completions.a).toEqual({ '2026-10-05': true }); // local still works
  });

  it('stopping while the SDK is loading attaches nothing', async () => {
    fake.closeGate();
    const started = startSync(UID);
    stopSync();
    fake.openGate();
    await started;
    expect(fake.state.listeners.size).toBe(0);
    store().addHabit({ name: 'Quiet', emoji: 'q', color: 'rose', days: [0] });
    expect(ops()).toEqual([]);
  });

  it('a fresh session after sign-out → sign-in starts from scratch (no stale lastPushed)', async () => {
    await startConfirmed([habit('a')]);
    stopSync();
    store().deleteHabit('a'); // offline edit while signed out
    expect(ops()).toEqual([]);

    await startSync(UID);
    expect(sync().status).toBe('connecting');
    serverSnapshot();
    // First contact again: the local tombstone wins over the live cloud copy and is pushed.
    expect(store().habits).toEqual([]);
    expect(ops()).toEqual([{ kind: 'set', path: `${PATH}/a`, merge: true, data: { deleted: true, updatedAt: fake.TIMESTAMP } }]);
  });
});

describe('deleteCloudData', () => {
  it('stops the engine, deletes every document in chunked batches and leaves the store alone', async () => {
    const cloud = Array.from({ length: 401 }, (_, i) => habit(`h${i}`, { order: i }));
    await startConfirmed(cloud);
    expect(store().habits).toHaveLength(401);

    await deleteCloudData(UID);
    expect(fake.state.docs.size).toBe(0);
    expect(fake.state.batches.map((b) => b.length)).toEqual([400, 1]);
    expect(fake.state.batches.flat().every((op) => op.kind === 'delete')).toBe(true);
    expect(store().habits).toHaveLength(401);
    expect(fake.state.listeners.size).toBe(0); // the caller signs out next
  });

  it('rejects with a readable sentence when the cloud is unreachable, and carries on syncing', async () => {
    await startConfirmed([habit('a')]);
    fake.state.getDocsError = Object.assign(new Error('Failed to get documents from server.'), { code: 'unavailable' });
    await expect(deleteCloudData(UID)).rejects.toThrow(/Could not reach the cloud/);
    expect(fake.state.docs.size).toBe(1);
    expect(store().habits).toHaveLength(1);
    await flush();
    expect(fake.state.listeners.size).toBe(2); // restarted
    expect(sync().status).toBe('connecting');
    expect(warn).toHaveBeenCalled();
  });

  it('after a partial sweep the engine stays stopped with a sticky error', async () => {
    const cloud = Array.from({ length: 401 }, (_, i) => habit(`h${i}`, { order: i }));
    await startConfirmed(cloud);
    fake.state.manualCommits = true;
    const deleting = deleteCloudData(UID);
    await flush();
    fake.settleCommits(); // the first 400 land…
    await flush();
    fake.rejectCommits(Object.assign(new Error('offline'), { code: 'unavailable' })); // …the last batch does not
    await expect(deleting).rejects.toThrow(/Some of your cloud data could not be deleted/);
    expect(fake.state.docs.size).toBe(1);
    expect(store().habits).toHaveLength(401); // nothing mirrored
    expect(fake.state.listeners.size).toBe(0);
    expect(sync().status).toBe('error');
  });

  it('works when the engine is not running for that account', async () => {
    seedDoc(habit('a'));
    await deleteCloudData(UID);
    expect(fake.state.docs.size).toBe(0);
    expect(fake.state.listeners.size).toBe(0);
  });

  it.each(['waitForPendingWrites', 'getDocsFromServer'] as const)(
    'a step that never answers (%s) gives up after DELETE_STEP_TIMEOUT_MS with the friendly sentence, and syncing resumes',
    async (step) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      seedDoc(habit('a'));
      await startSync(UID);
      serverSnapshot();
      fake.state.batches = [];
      fake.state.hang = step;

      let outcome: unknown = null;
      const deleting = deleteCloudData(UID).then(
        () => 'resolved',
        (e: unknown) => {
          outcome = e;
          return 'rejected';
        },
      );
      await vi.advanceTimersByTimeAsync(DELETE_STEP_TIMEOUT_MS - 1);
      expect(outcome).toBeNull(); // still "Deleting…"
      expect(fake.state.listeners.size).toBe(0); // the mirror is detached meanwhile
      await vi.advanceTimersByTimeAsync(1);
      expect(await deleting).toBe('rejected');
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('Could not reach the cloud to delete your data. Check your connection and try again.');
      expect(fake.state.docs.size).toBe(1); // nothing was deleted
      expect(fake.state.batches).toEqual([]);

      await vi.advanceTimersByTimeAsync(0); // the restarted engine attaches its listeners
      expect(fake.state.listeners.size).toBe(2);
      expect(sync().status).toBe('connecting');
      serverSnapshot();
      expect(sync().status).toBe('synced');
    },
  );

  it('a complete sweep forgets the sync session; a failed one leaves it', async () => {
    setSyncSession(true);
    await startConfirmed([habit('a')]);
    fake.state.getDocsError = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    await expect(deleteCloudData(UID)).rejects.toThrow(/Could not reach the cloud/);
    expect(hasSyncSession()).toBe(true);
    fake.state.getDocsError = null;
    await deleteCloudData(UID);
    expect(hasSyncSession()).toBe(false);
  });
});

describe('tasks channel (SPEC §14.8)', () => {
  it('listens to users/{uid}/tasks beside habits and stays connecting until both collections are server-confirmed', async () => {
    await startSync(UID);
    expect([...fake.state.listeners].map((l) => l.path).sort()).toEqual([PATH, TASKS_PATH]);
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false });
    expect(sync().status).toBe('connecting');
    expect(sync().lastSyncedAt).toBeNull();
    fake.emitTo(TASKS_PATH, { fromCache: true, hasPendingWrites: false }); // the cache answers first
    expect(sync().status).toBe('connecting');
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(sync().status).toBe('synced');
    expect(sync().lastSyncedAt).toBeTypeOf('number');
  });

  it('pending is true while either collection has writes waiting', async () => {
    await startConfirmed();
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: true });
    expect(sync().pending).toBe(true);
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false }); // habits settled, tasks still waiting
    expect(sync().pending).toBe(true);
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(sync().pending).toBe(false);
  });

  it('first contact uploads local-only tasks (absent fields as deletes), adopts cloud tasks, remote fields win, a done side wins, tombstones win', async () => {
    const b = task('b', { time: '15:00', note: 'bring the form' });
    const c = task('c', { done: true, doneAt: '2026-10-18' });
    useStore.setState({ tasks: [task('a', { title: 'local title' }), b, c], deletedTaskIds: ['e'] });
    seedTaskDoc(task('a', { title: 'cloud title' }));
    seedTaskDoc(task('c'));
    seedTaskDoc(task('d'), { deleted: true }); // a tombstone this device learns about
    seedTaskDoc(task('e'));
    seedTaskDoc(task('f', { date: '2026-10-19' }));

    await startSync(UID);
    serverSnapshot();

    expect(taskIds()).toEqual(['f', 'b', 'a', 'c']); // compareTasks order: date, timed first, then createdAt, id
    const byId = new Map(store().tasks.map((t) => [t.id, t] as const));
    expect(byId.get('a')).toEqual(task('a', { title: 'cloud title' }));
    expect(byId.get('b')).toEqual(b);
    expect(byId.get('c')).toEqual(c);
    expect(new Set(store().deletedTaskIds)).toEqual(new Set(['d', 'e']));

    expect(ops()).toEqual([setTaskOp(b), setTaskOp(c), tombstoneOp(`${TASKS_PATH}/e`)]);
    expect(cloudTask('b')).toEqual({ ...b, updatedAt: fake.SERVER_TIME });
    expect(cloudTask('b')).not.toHaveProperty('deleted');
    expect(cloudTask('b')).not.toHaveProperty('doneAt');
    expect(cloudTask('c')).toMatchObject({ done: true, doneAt: '2026-10-18' });
    expect(cloudTask('e')).toMatchObject({ deleted: true, title: 'Task e' });
    serverSnapshot();
    expect(ops()).toHaveLength(3); // the echo pushes nothing
  });

  it('a cloud task arrives through applyRemoteTasks inside the loop guard: applied once, nothing pushed back', async () => {
    await startConfirmed();
    const apply = vi.spyOn(store(), 'applyRemoteTasks');
    let changes = 0;
    const unsubscribe = useStore.subscribe(() => {
      changes += 1;
    });
    try {
      seedTaskDoc(task('r', { time: '09:30' }));
      serverSnapshot();
      serverSnapshot();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith({ tasks: [task('r', { time: '09:30' })], deletedTaskIds: [] });
    } finally {
      unsubscribe();
      apply.mockRestore();
    }
    expect(store().tasks).toEqual([task('r', { time: '09:30' })]);
    expect(changes).toBe(1); // the second, equal snapshot did not even set()
    expect(ops()).toEqual([]);
  });

  it('a check-off goes up as setTask with doneAt; un-checking clears doneAt with deleteField; clearing note/time deletes them; deleting tombstones', async () => {
    const t = task('a', { note: 'n', time: '08:00' });
    await startConfirmed([], [t]);

    store().setTaskDone('a', true, '2026-10-21');
    expect(ops()).toEqual([setTaskOp({ ...t, done: true, doneAt: '2026-10-21' })]);
    expect(cloudTask('a')).toMatchObject({ done: true, doneAt: '2026-10-21' });
    echoSnapshot();
    serverSnapshot();
    expect(ops()).toHaveLength(1); // the echo does not re-push

    store().setTaskDone('a', false);
    expect(ops()[1]).toEqual(setTaskOp(t));
    expect(cloudTask('a')).not.toHaveProperty('doneAt');
    expect(cloudTask('a')?.done).toBe(false);

    store().updateTask('a', { note: '', time: '' });
    expect(ops()[2]).toEqual(setTaskOp(task('a')));
    expect(cloudTask('a')).not.toHaveProperty('note');
    expect(cloudTask('a')).not.toHaveProperty('time');

    store().deleteTask('a');
    expect(ops()[3]).toEqual(tombstoneOp(`${TASKS_PATH}/a`));
    expect(cloudTask('a')).toMatchObject({ deleted: true, title: 'Task a' }); // a tombstone keeps its fields
    expect(store().deletedTaskIds).toEqual(['a']);
    expect(ops()).toHaveLength(4);
    serverSnapshot();
    expect(store().tasks).toEqual([]);
    expect(ops()).toHaveLength(4);
  });

  it('habit and task ops of one store change share one batch', async () => {
    await startConfirmed([habit('h')]);
    // One set() touching both slices, as importData does.
    useStore.setState({ habits: [habit('h', { name: 'Renamed' })], tasks: [task('t')] });
    expect(fake.state.batches).toHaveLength(1);
    expect(fake.state.batches[0]).toEqual([setHabitOp(habit('h', { name: 'Renamed' })), setTaskOp(task('t'))]);
    serverSnapshot();
    expect(fake.state.batches).toHaveLength(1);
  });

  it('a rejected mixed batch rolls both sides back: both edits survive the rollback snapshot and go up again with the next change', async () => {
    await startConfirmed([habit('h')], [task('t')]);
    fake.state.manualCommits = true;
    useStore.setState({ completions: { h: { '2026-10-05': true } }, tasks: [task('t', { done: true, doneAt: '2026-10-20' })] });
    expect(fake.state.batches).toHaveLength(1);
    expect(fake.state.batches[0]).toHaveLength(2);
    fake.rejectCommits(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await flush();
    expect(sync().status).toBe('error');

    serverSnapshot(); // the SDK's rollback view: neither edit is in the cloud
    expect(store().completions.h).toEqual({ '2026-10-05': true });
    expect(store().tasks[0]).toMatchObject({ done: true, doneAt: '2026-10-20' });
    expect(fake.state.batches).toHaveLength(1); // a final code: no automatic re-send

    const later = store().addTask({ title: 'Later', date: '2026-10-22', createdAt: '2026-10-17' });
    expect(fake.state.batches).toHaveLength(2);
    expect(fake.state.batches[1]).toEqual([
      { kind: 'set', path: `${PATH}/h`, merge: true, data: { completions: { '2026-10-05': true } } },
      setTaskOp(task('t', { done: true, doneAt: '2026-10-20' })),
      setTaskOp(later),
    ]);
    fake.settleCommits();
    await flush();
    expect(cloudDoc('h')?.completions).toEqual({ '2026-10-05': true });
    expect(cloudTask('t')).toMatchObject({ done: true, doneAt: '2026-10-20' });
    expect(cloudTask(later.id)).toMatchObject({ title: 'Later' });
    serverSnapshot();
    expect(sync().status).toBe('synced');
    expect(fake.state.batches).toHaveLength(2);
  });

  it('a snapshot of one collection is not held back by a batch in flight on the other', async () => {
    await startConfirmed([habit('h')], [task('a')]);
    fake.state.manualCommits = true;
    store().toggleTask('a', '2026-10-20'); // a tasks batch in flight
    fake.state.docs.set(`${PATH}/h`, { ...cloudDoc('h'), name: 'Renamed elsewhere' });
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false });
    expect(store().habits[0]?.name).toBe('Renamed elsewhere'); // applied: that batch cannot date this view
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false }); // predates the tap: skipped
    expect(store().tasks[0]?.done).toBe(true);

    fake.settleCommits();
    await flush();
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(store().tasks[0]?.done).toBe(true);
    expect(cloudTask('a')?.done).toBe(true);
    expect(fake.state.batches).toHaveLength(1);
  });

  it('the saved baseline carries the tasks side; an un-check made elsewhere while closed sticks, an edit made here while closed is pushed', async () => {
    const done = task('a', { done: true, doneAt: '2026-10-18' });
    await startConfirmed([], [done, task('b')]);
    expect(readBaseline(UID)).toEqual({
      data: { habits: [], completions: {}, deletedIds: [] },
      acked: [],
      tasks: { tasks: [done, task('b')], deletedTaskIds: [] },
      ackedTasks: ['a', 'b'],
    });
    stopSync(); // the phone is closed

    const unchecked: Record<string, unknown> = { ...cloudTask('a'), done: false };
    delete unchecked.doneAt;
    fake.state.docs.set(`${TASKS_PATH}/a`, unchecked); // the laptop un-checks it…
    store().updateTask('b', { title: 'Edited while closed', time: '07:30' }); // …while this device edits another

    await startSync(UID);
    fake.state.docs.delete(`${TASKS_PATH}/b`); // a memory cache answers with a partial view first…
    cacheSnapshot();
    expect(taskIds()).toEqual(['a', 'b']); // …and is left alone (the store's own order, untouched)
    expect(store().tasks.find((t) => t.id === 'a')?.done).toBe(true);
    expect(ops()).toEqual([]);
    expect(sync().status).toBe('connecting');

    seedTaskDoc(task('b'));
    serverSnapshot();
    const edited = task('b', { title: 'Edited while closed', time: '07:30' });
    expect(store().tasks).toEqual([edited, task('a')]);
    expect(ops()).toEqual([setTaskOp(edited)]);
    expect(readBaseline(UID)?.tasks.tasks).toEqual([task('a'), task('b')]); // the server's view before the push
    await flush(); // the commit settles before the view that includes it arrives
    serverSnapshot();
    expect(ops()).toHaveLength(1);
    expect(readBaseline(UID)?.tasks.tasks).toEqual([edited, task('a')]);
  });

  it('a task created here while closed is uploaded, one created elsewhere arrives, a deletion here is pushed, a deletion elsewhere sticks', async () => {
    await startConfirmed([], [task('a'), task('d'), task('g')]);
    stopSync();
    const added = store().addTask({ title: 'New here', date: '2026-10-23', time: '18:00', createdAt: '2026-10-17' });
    store().deleteTask('d');
    store().setTaskDone('g', true, '2026-10-20'); // checked here…
    fake.state.docs.set(`${TASKS_PATH}/g`, { ...cloudTask('g'), deleted: true }); // …deleted elsewhere: the tombstone wins
    seedTaskDoc(task('c', { date: '2026-10-21' }));

    await startSync(UID);
    serverSnapshot();
    expect(taskIds()).toEqual(['a', 'c', added.id]);
    expect(new Set(store().deletedTaskIds)).toEqual(new Set(['d', 'g']));
    expect(ops()).toEqual([setTaskOp(added), tombstoneOp(`${TASKS_PATH}/d`)]);
    expect(cloudTask('d')?.deleted).toBe(true);
  });

  it('a v1 baseline (saved before tasks existed) reads with an empty tasks side: local tasks go up, cloud tasks come down', async () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    local.setItem(
      `${BASELINE_KEY_PREFIX}${UID}`,
      JSON.stringify({ v: 1, data: { habits: [habit('h')], completions: {}, deletedIds: [] }, acked: ['h'] }),
    );
    seedDoc(habit('h'));
    seedTaskDoc(task('cloud'));
    useStore.setState({ habits: [habit('h')], tasks: [task('mine')] });

    await startSync(UID);
    fake.state.docs.clear();
    cacheSnapshot(); // an empty cache view before the server: left alone on both collections
    expect(store().habits).toHaveLength(1);
    expect(taskIds()).toEqual(['mine']);
    expect(ops()).toEqual([]);

    seedDoc(habit('h'));
    seedTaskDoc(task('cloud'));
    serverSnapshot();
    expect(taskIds()).toEqual(['cloud', 'mine']);
    expect(ops()).toEqual([setTaskOp(task('mine'))]);
    expect(sync().status).toBe('synced');
    const saved = readBaseline(UID);
    expect(saved?.acked).toEqual(['h']);
    expect(saved?.ackedTasks).toEqual(['cloud']);
    expect(saved?.tasks.tasks).toEqual([task('cloud')]);
    expect(JSON.parse(local.getItem(`${BASELINE_KEY_PREFIX}${UID}`) ?? '{}')).toMatchObject({ v: 2 });
  });

  it('the baseline is saved only once both collections are acknowledged', async () => {
    await startConfirmed([habit('h')], [task('a')]);
    const before = readBaseline(UID);
    fake.state.docs.set(`${TASKS_PATH}/a`, { ...cloudTask('a'), done: true, doneAt: '2026-10-20' });
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: true }); // a view with writes the server has not acknowledged
    expect(store().tasks[0]?.done).toBe(true);
    seedDoc(habit('n', { order: 1 }));
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false });
    expect(store().habits.map((h) => h.id)).toEqual(['h', 'n']);
    expect(readBaseline(UID)).toEqual(before); // tasks not acknowledged yet: nothing saved

    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    const saved = readBaseline(UID);
    expect(saved?.data.habits.map((h) => h.id)).toEqual(['h', 'n']);
    expect(saved?.tasks.tasks[0]).toMatchObject({ id: 'a', done: true, doneAt: '2026-10-20' });
  });

  it('a local task the cloud tombstoned, which this device never deleted, is restored under a new id', async () => {
    useStore.setState({ tasks: [task('x', { title: 'Renew membership' })] });
    seedTaskDoc(task('x'), { deleted: true });
    await startSync(UID);
    serverSnapshot();
    const restored = store().tasks[0] as Task;
    expect(restored.title).toBe('Renew membership');
    expect(restored.id).not.toBe('x');
    expect(store().deletedTaskIds).toEqual(['x']);
    expect(ops()).toEqual([setTaskOp(restored)]);
    serverSnapshot();
    expect(ops()).toHaveLength(1);
    expect(store().tasks).toHaveLength(1);
  });

  it('keeps a task tombstone the cloud has never seen, and pushes it when the cloud shows the task live', async () => {
    useStore.setState({ deletedTaskIds: ['x'] });
    await startConfirmed([], [task('a')]);
    serverSnapshot();
    expect(store().deletedTaskIds).toEqual(['x']);
    expect(ops()).toEqual([]);
    seedTaskDoc(task('x')); // a device that was offline when x was deleted pushes it
    serverSnapshot();
    expect(taskIds()).toEqual(['a']);
    expect(ops()).toEqual([tombstoneOp(`${TASKS_PATH}/x`)]);
    expect(cloudTask('x')?.deleted).toBe(true);
  });

  it('a tasks collection emptied elsewhere pauses sync and keeps the local copy of both collections', async () => {
    await startConfirmed([habit('h')], [task('a'), task('b')]);
    fake.state.docs.delete(`${TASKS_PATH}/a`);
    fake.state.docs.delete(`${TASKS_PATH}/b`);
    serverSnapshot();
    expect(taskIds()).toEqual(['a', 'b']);
    expect(store().habits).toHaveLength(1);
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/deleted from another device/);
    expect(fake.state.listeners.size).toBe(0);
    store().toggleTask('a', '2026-10-20');
    expect(ops()).toEqual([]);
  });

  it('an unusable task document is dropped and a bare tombstone kept, without crashing the snapshot', async () => {
    await startConfirmed([], [task('a')]);
    fake.state.docs.set(`${TASKS_PATH}/junk`, { title: 42 });
    fake.state.docs.set(`${TASKS_PATH}/gone`, { deleted: true, updatedAt: null });
    serverSnapshot();
    expect(taskIds()).toEqual(['a']);
    expect(store().deletedTaskIds).toEqual(['gone']);
    expect(sync().status).toBe('synced');
  });

  it('a task write whose id cannot be a document path is reported, the rest is sent, and the task is never claimed as synced', async () => {
    await startConfirmed();
    useStore.setState({ tasks: [task('bad/id'), task('ok')] });
    expect(ops()).toEqual([setTaskOp(task('ok'))]);
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/One task could not be saved/);
    serverSnapshot();
    expect(taskIds()).toEqual(['bad/id', 'ok']); // kept on the device
    expect(sync().status).toBe('error');
  });

  it('deleteCloudData sweeps both collections, clears the baseline and leaves the store alone', async () => {
    await startConfirmed([habit('h')], [task('a'), task('b')]);
    await deleteCloudData(UID);
    expect(fake.state.docs.size).toBe(0);
    expect(fake.state.batches.flat().map((op) => [op.kind, op.path])).toEqual([
      ['delete', `${PATH}/h`],
      ['delete', `${TASKS_PATH}/a`],
      ['delete', `${TASKS_PATH}/b`],
    ]);
    expect(store().habits).toHaveLength(1);
    expect(store().tasks).toHaveLength(2);
    expect(readBaseline(UID)).toBeNull();
    expect(fake.state.listeners.size).toBe(0);
  });

  it('stopSync tears both listeners down', async () => {
    await startConfirmed([], [task('a')]);
    expect(fake.state.listeners.size).toBe(2);
    stopSync();
    expect(fake.state.listeners.size).toBe(0);
    store().toggleTask('a', '2026-10-20');
    expect(ops()).toEqual([]);
    expect(store().tasks[0]?.done).toBe(true); // local still works
  });
});

describe('a rejected batch and the other collection (SPEC §14.8)', () => {
  const denied = (): Error => Object.assign(new Error('denied'), { code: 'permission-denied' });
  const aborted = (): Error => Object.assign(new Error('aborted'), { code: 'aborted' });
  const liveTaskTitles = (): unknown[] =>
    [...fake.state.docs.entries()]
      .filter(([path, doc]) => path.startsWith(`${TASKS_PATH}/`) && doc.deleted !== true)
      .map(([, doc]) => doc.title);

  it('a rejected habits-only batch leaves the tasks side alone: a task renamed elsewhere meanwhile follows the cloud and is never pushed back', async () => {
    await startConfirmed([habit('h')], [task('x', { title: 'a' })]);
    fake.state.manualCommits = true;
    store().updateHabit('h', { name: 'Renamed' }); // a habits-only batch in flight
    expect(fake.state.batches).toHaveLength(1);

    // Renamed on another device: the batch writes no task, so this view is applied at once.
    fake.state.docs.set(`${TASKS_PATH}/x`, { ...cloudTask('x'), title: 'b' });
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(store().tasks[0]?.title).toBe('b');

    fake.rejectCommits(denied());
    await flush();

    // Renamed again elsewhere. No task was edited here, so this device simply follows the cloud.
    fake.state.docs.set(`${TASKS_PATH}/x`, { ...cloudTask('x'), title: 'c' });
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(store().tasks[0]?.title).toBe('c');
    expect(fake.state.batches).toHaveLength(1);

    // The owner's next change re-sends the rejected tracker edit, and nothing for the task.
    fake.state.manualCommits = false;
    store().toggleCompletion('h', '2026-10-05');
    await flush();
    expect(fake.state.batches).toHaveLength(2);
    expect(fake.state.batches[1]?.every((op) => op.path.startsWith(`${PATH}/`))).toBe(true);
    expect(cloudDoc('h')).toMatchObject({ name: 'Renamed', completions: { '2026-10-05': true } });
    expect(cloudTask('x')?.title).toBe('c');
  });

  it('a task created and then deleted elsewhere around a rejected habits-only batch stays deleted', async () => {
    await startConfirmed([habit('h')], [task('a')]);
    fake.state.manualCommits = true;
    store().updateHabit('h', { name: 'Renamed' }); // a habits-only batch in flight

    seedTaskDoc(task('y', { title: 'From the laptop' })); // the laptop adds a task…
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(taskIds().sort()).toEqual(['a', 'y']);

    fake.rejectCommits(denied());
    await flush();

    fake.state.docs.set(`${TASKS_PATH}/y`, { ...cloudTask('y'), deleted: true }); // …and deletes it
    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false });
    expect(taskIds()).toEqual(['a']); // known here, so not mistaken for a restored backup and re-keyed
    expect(store().deletedTaskIds).toEqual(['y']);

    fake.state.manualCommits = false;
    store().toggleCompletion('h', '2026-10-05');
    await flush();
    expect(taskIds()).toEqual(['a']);
    expect(liveTaskTitles()).toEqual(['Task a']); // no live copy under a fresh id
  });

  it('a rejected tasks-only batch leaves the habits side alone: a tracker renamed elsewhere meanwhile follows the cloud', async () => {
    await startConfirmed([habit('h', { name: 'A' })], [task('t')]);
    fake.state.manualCommits = true;
    store().toggleTask('t', '2026-10-20'); // a tasks-only batch in flight

    fake.state.docs.set(`${PATH}/h`, { ...cloudDoc('h'), name: 'B' });
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false });
    expect(store().habits[0]?.name).toBe('B');

    fake.rejectCommits(denied());
    await flush();

    fake.state.docs.set(`${PATH}/h`, { ...cloudDoc('h'), name: 'C' });
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false });
    expect(store().habits[0]?.name).toBe('C');

    // The owner's next change re-sends the rejected check-off, and nothing for the tracker.
    fake.state.manualCommits = false;
    const later = store().addTask({ title: 'Later', date: '2026-10-22', createdAt: '2026-10-17' });
    await flush();
    expect(fake.state.batches).toHaveLength(2);
    expect(fake.state.batches[1]).toEqual([setTaskOp(task('t', { done: true, doneAt: '2026-10-20' })), setTaskOp(later)]);
    expect(cloudDoc('h')?.name).toBe('C');
  });

  it('two rejected task batches with a habits snapshot in between: both edits survive the rollback view and go up again', async () => {
    await startConfirmed([habit('h')], [task('a')]);
    fake.state.manualCommits = true;
    store().toggleTask('a', '2026-10-20'); // B1: checked off
    store().updateTask('a', { title: 'Renamed' }); // B2: checked off and renamed
    expect(fake.state.batches).toHaveLength(2);
    const [b1, b2] = fake.state.pendingCommits.splice(0);
    b1?.reject(denied());
    await flush();

    // Any habits view while B2 is still in flight (a tracker edited elsewhere, a metadata flip).
    fake.emitTo(PATH, { fromCache: false, hasPendingWrites: false });

    b2?.reject(denied());
    await flush();

    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false }); // the rollback view: neither landed
    expect(store().tasks[0]).toMatchObject({ title: 'Renamed', done: true, doneAt: '2026-10-20' });

    fake.state.manualCommits = false;
    store().toggleCompletion('h', '2026-10-05');
    await flush();
    expect(cloudTask('a')).toMatchObject({ title: 'Renamed', done: true, doneAt: '2026-10-20' });
  });

  it('a batch handed over between two rejections and then rejected too never counts the first rejected edit as synced', async () => {
    await startConfirmed([], [task('a'), task('b')]);
    fake.state.manualCommits = true;
    store().toggleTask('a', '2026-10-20'); // B1
    store().updateTask('b', { title: 'B renamed' }); // B2, diffed against a state that counts B1 as landed
    const [b1, b2] = fake.state.pendingCommits.splice(0);
    b1?.reject(aborted());
    await flush();

    const third = store().addTask({ title: 'Third', date: '2026-10-22', createdAt: '2026-10-17' }); // B3
    const [b3] = fake.state.pendingCommits.splice(0);
    b2?.reject(aborted());
    await flush();
    b3?.reject(denied());
    await flush();

    fake.emitTo(TASKS_PATH, { fromCache: false, hasPendingWrites: false }); // none of the three landed
    expect(store().tasks.find((t) => t.id === 'a')).toMatchObject({ done: true, doneAt: '2026-10-20' });
    expect(store().tasks.find((t) => t.id === 'b')?.title).toBe('B renamed');

    fake.state.manualCommits = false;
    store().updateTask(third.id, { note: 'bring the form' }); // the owner's next change re-sends all of it
    await flush();
    expect(cloudTask('a')).toMatchObject({ done: true, doneAt: '2026-10-20' });
    expect(cloudTask('b')?.title).toBe('B renamed');
    expect(cloudTask(third.id)).toMatchObject({ title: 'Third', note: 'bring the form' });
  });
});
