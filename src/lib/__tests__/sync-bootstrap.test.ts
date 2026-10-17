import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirebaseHandles } from '../sync/firebase';

/*
 * bootstrap.ts: auth state → the sync engine.
 *
 * - The SDK is downloaded at launch only on a device with a sync session to restore (review #26). A
 *   device that has never signed in shows the form at once and fetches nothing; a sign-in from the Sync
 *   card loads the SDK on demand and the listener attaches then, without a reload. A device that synced
 *   before the session flag existed (it holds a saved baseline) restores its session once.
 * - The auth listener ends up attached even when the first SDK download fails: a sign-in from the Sync
 *   card (auth.ts → loadFirebase) or the browser coming back online re-arms it.
 * - Signing out forgets the account's baseline only when it was clean (review #47): when writes made
 *   offline could not be confirmed, the baseline stays for the next sign-in by the same account, and
 *   another account signing in drops it.
 *
 * Every test is a fresh launch: vi.resetModules() re-evaluates the modules (initSync runs once per module
 * instance) while the fake localStorage below survives, like the browser's. The Firebase module is a small
 * fake whose load can fail, with a faithful copy of onFirebaseLoaded; the engine is a pair of spies.
 */

const fake = vi.hoisted(() => {
  type User = { uid: string; email: string | null };
  type Observer = (user: User | null) => void;
  const state = {
    loadError: null as Error | null,
    loads: 0,
    currentUser: null as User | null,
    observers: new Set<Observer>(),
    loadedCallbacks: new Set<() => void>(),
    loading: null as Promise<unknown> | null,
    cleared: 0,
    /** How waitForPendingWrites answers: confirms, never answers, or fails. */
    flush: 'confirm' as 'confirm' | 'hang' | 'fail',
    flushCalls: 0,
  };
  const notify = (): void => {
    for (const cb of [...state.observers]) cb(state.currentUser);
  };
  const auth = {
    onAuthStateChanged: (_auth: unknown, cb: Observer): (() => void) => {
      state.observers.add(cb);
      queueMicrotask(() => cb(state.currentUser));
      return () => {
        state.observers.delete(cb);
      };
    },
    signInWithEmailAndPassword: (_auth: unknown, email: string): Promise<void> => {
      state.currentUser = { uid: `uid-of-${email}`, email };
      notify();
      return Promise.resolve();
    },
    signOut: (): Promise<void> => {
      state.currentUser = null;
      notify();
      return Promise.resolve();
    },
  };
  const firestore = {
    waitForPendingWrites: (): Promise<void> => {
      state.flushCalls += 1;
      if (state.flush === 'hang') return new Promise<void>(() => {});
      if (state.flush === 'fail') return Promise.reject(new Error('shutdown'));
      return Promise.resolve();
    },
  };
  const handles = { app: {}, auth: {}, db: {}, sdk: { app: {}, auth, firestore } };
  const load = (): Promise<typeof handles> => {
    state.loads += 1;
    state.loading ??= (state.loadError ? Promise.reject(state.loadError) : Promise.resolve(handles)).then(
      (h) => {
        for (const cb of [...state.loadedCallbacks]) cb();
        return h;
      },
      (error: unknown) => {
        state.loading = null;
        throw error;
      },
    );
    return state.loading as Promise<typeof handles>;
  };
  return {
    state,
    load,
    onFirebaseLoaded: (cb: () => void): (() => void) => {
      state.loadedCallbacks.add(cb);
      return () => {
        state.loadedCallbacks.delete(cb);
      };
    },
    /** A new page: nothing loaded or listening yet. The account Firebase remembers (currentUser) survives. */
    relaunch: (): void => {
      state.loadError = null;
      state.loads = 0;
      state.observers.clear();
      state.loadedCallbacks.clear();
      state.loading = null;
      state.cleared = 0;
      state.flush = 'confirm';
      state.flushCalls = 0;
    },
    /** What the auth server does when a session ends elsewhere (password changed, account removed). */
    endSessionElsewhere: (): void => {
      state.currentUser = null;
      notify();
    },
  };
});

vi.mock('../sync/firebase', () => ({
  isSyncConfigured: () => true,
  loadFirebase: () => fake.load() as unknown as Promise<FirebaseHandles>,
  onFirebaseLoaded: fake.onFirebaseLoaded,
  clearLocalCache: () => {
    fake.state.cleared += 1;
    return Promise.resolve();
  },
}));

vi.mock('../sync/engine', () => ({
  startSync: vi.fn(() => Promise.resolve()),
  stopSync: vi.fn(),
}));

interface App {
  bootstrap: typeof import('../sync/bootstrap');
  auth: typeof import('../sync/auth');
  baseline: typeof import('../sync/baseline');
  syncStore: typeof import('../sync/syncStore');
  engine: typeof import('../sync/engine');
}

/** A fresh page load: every module re-evaluated, storage and Firebase's remembered account kept. */
async function launch(): Promise<App> {
  vi.resetModules();
  fake.relaunch();
  // The engine first, so the copy bootstrap.ts links against is this launch's mock.
  const engine = await import('../sync/engine');
  const syncStore = await import('../sync/syncStore');
  const baseline = await import('../sync/baseline');
  const auth = await import('../sync/auth');
  const bootstrap = await import('../sync/bootstrap');
  return { bootstrap, auth, baseline, syncStore, engine };
}

/** A launch with initSync() called, the way main.tsx does after the first render. */
async function start(): Promise<App> {
  const app = await launch();
  app.bootstrap.initSync();
  return app;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const EMPTY_BASE = { data: { habits: [], completions: {}, deletedIds: [] }, acked: [] };
const ME = { uid: 'uid-of-me@example.com', email: 'me@example.com' };

/** A stand-in for `globalThis.localStorage` (absent under node) that outlives every launch of one test. */
function fakeLocalStorage(): Storage {
  const mem = new Map<string, string>();
  return {
    get length() {
      return mem.size;
    },
    key: (i: number) => [...mem.keys()][i] ?? null,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
  };
}

let storage: Storage;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.state.currentUser = null;
  storage = fakeLocalStorage();
  vi.stubGlobal('localStorage', storage);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A device on which `ME` is signed in and syncing, with a saved baseline. */
async function signedInDevice(): Promise<App> {
  fake.state.currentUser = ME;
  storage.setItem('momentum-sync-session', '1');
  const app = await start();
  await flush();
  expect(app.syncStore.useSyncStore.getState().user).toEqual(ME);
  app.baseline.writeBaseline(ME.uid, EMPTY_BASE);
  return app;
}

describe('launch', () => {
  it('a device that has never signed in shows the form at once and downloads nothing', async () => {
    const app = await start();
    const sync = app.syncStore.useSyncStore.getState();
    expect(sync.booting).toBe(false);
    expect(sync.status).toBe('signed-out');
    await flush();
    await flush();
    expect(fake.state.loads).toBe(0);
    expect(fake.state.observers.size).toBe(0);
    expect(app.engine.startSync).not.toHaveBeenCalled();
    expect(storage.getItem('momentum-sync-session')).toBeNull();
  });

  it('there, a sign-in from the Sync card loads the SDK, attaches the listener without a reload and remembers the session', async () => {
    const app = await start();
    await app.auth.signIn(' me@example.com ', 'secret');
    await flush();
    expect(fake.state.observers.size).toBe(1);
    expect(app.syncStore.useSyncStore.getState().user).toEqual(ME);
    expect(app.engine.startSync).toHaveBeenCalledWith(ME.uid);
    expect(storage.getItem('momentum-sync-session')).toBe('1');

    // The next launch restores that session: "Checking your account…" until Firebase answers.
    const next = await start();
    expect(next.syncStore.useSyncStore.getState().booting).toBe(true);
    await flush();
    expect(fake.state.loads).toBe(1);
    expect(next.syncStore.useSyncStore.getState()).toMatchObject({ user: ME, booting: false });
    expect(next.engine.startSync).toHaveBeenCalledWith(ME.uid);
  });

  it('a device that synced before the session flag existed (a saved baseline) restores its session once, and the answer is remembered', async () => {
    storage.setItem(`momentum-sync-base:${ME.uid}`, JSON.stringify({ v: 1, ...EMPTY_BASE }));
    fake.state.currentUser = ME;
    const app = await start();
    expect(app.syncStore.useSyncStore.getState().booting).toBe(true);
    await flush();
    expect(app.syncStore.useSyncStore.getState().user).toEqual(ME);
    expect(storage.getItem('momentum-sync-session')).toBe('1');

    // Firebase no longer holds that session (it ended elsewhere): one launch finds out, later ones skip the SDK.
    fake.state.currentUser = null;
    const second = await start();
    await flush();
    expect(fake.state.loads).toBe(1);
    expect(second.syncStore.useSyncStore.getState()).toMatchObject({ user: null, status: 'signed-out', booting: false });
    expect(storage.getItem('momentum-sync-session')).toBe('0');
    const third = await start();
    expect(third.syncStore.useSyncStore.getState().booting).toBe(false);
    await flush();
    expect(fake.state.loads).toBe(0);
  });

  it('a failed boot is re-armed by the sign-in that manages the download: the user is set and sync starts', async () => {
    storage.setItem('momentum-sync-session', '1');
    const app = await launch();
    fake.state.loadError = new TypeError('Failed to fetch dynamically imported module');
    app.bootstrap.initSync();
    const sync = () => app.syncStore.useSyncStore.getState();
    expect(sync().booting).toBe(true); // nothing happens before the deferred boot
    await flush();
    await flush();
    expect(sync().status).toBe('error');
    expect(sync().error).toMatch(/could not start/i);
    expect(sync().booting).toBe(false);
    expect(fake.state.observers.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    // The network is back; the owner signs in from the Sync card.
    fake.state.loadError = null;
    await app.auth.signIn(' me@example.com ', 'secret');
    await flush();
    expect(fake.state.observers.size).toBe(1); // the auth listener is attached now…
    expect(sync().user).toEqual(ME);
    expect(app.engine.startSync).toHaveBeenCalledWith(ME.uid); // …and sync started, no reload needed
    expect(sync().booting).toBe(false);
  });

  it('is idempotent: a second initSync attaches nothing more, and a later load re-arms nothing while listening', async () => {
    const app = await signedInDevice();
    app.bootstrap.initSync();
    await flush();
    for (const cb of [...fake.state.loadedCallbacks]) cb(); // what a later successful loadFirebase() does
    await flush();
    expect(fake.state.observers.size).toBe(1);
  });

  it('the initial signed-out state at launch clears nothing (there was no account on this device)', async () => {
    storage.setItem('momentum-sync-session', '1');
    storage.setItem(`momentum-sync-base:${ME.uid}`, JSON.stringify({ v: 2, ...EMPTY_BASE, tasks: { tasks: [], deletedTaskIds: [] }, ackedTasks: [] }));
    const app = await start();
    await flush();
    expect(fake.state.cleared).toBe(0);
    expect(app.syncStore.useSyncStore.getState().status).toBe('signed-out');
    expect(app.baseline.readBaseline(ME.uid)).not.toBeNull();
  });
});

describe('signing out', () => {
  it('a clean sign-out stops the engine, resets the store, forgets the baseline and the session, and clears the local cache', async () => {
    const app = await signedInDevice();
    app.syncStore.useSyncStore.setState({ status: 'synced', lastSyncedAt: 5 });
    await app.auth.signOutUser();
    await flush();
    expect(app.engine.stopSync).toHaveBeenCalled();
    expect(app.syncStore.useSyncStore.getState()).toMatchObject({
      user: null,
      status: 'signed-out',
      pending: false,
      lastSyncedAt: null,
      error: null,
      booting: false,
    });
    expect(app.baseline.readBaseline(ME.uid)).toBeNull();
    expect(fake.state.cleared).toBe(1);
    expect(storage.getItem('momentum-sync-session')).toBe('0');

    const next = await start(); // nothing to restore: the SDK is not downloaded again
    expect(next.syncStore.useSyncStore.getState().booting).toBe(false);
    await flush();
    expect(fake.state.loads).toBe(0);
  });

  it('offline with writes waiting, the baseline stays (the flush is skipped) and the same account finds it at its next sign-in', async () => {
    const app = await signedInDevice();
    app.syncStore.useSyncStore.setState({ status: 'offline', pending: true });
    vi.stubGlobal('navigator', { onLine: false });
    await app.auth.signOutUser();
    await flush();
    expect(fake.state.flushCalls).toBe(0);
    expect(app.baseline.readBaseline(ME.uid)).toEqual({ ...EMPTY_BASE, tasks: { tasks: [], deletedTaskIds: [] }, ackedTasks: [] });
    expect(fake.state.cleared).toBe(1); // Firestore's cached copy still goes
    expect(app.syncStore.useSyncStore.getState()).toMatchObject({ user: null, pending: false, status: 'signed-out' });
    expect(storage.getItem('momentum-sync-session')).toBe('0');

    // Back online, a relaunch and the same account signs in: the engine starts against the kept baseline.
    vi.stubGlobal('navigator', { onLine: true });
    const next = await start();
    await next.auth.signIn('me@example.com', 'secret');
    await flush();
    expect(next.engine.startSync).toHaveBeenCalledWith(ME.uid);
    expect(next.baseline.readBaseline(ME.uid)).not.toBeNull();
  });

  it('online, a flush that does not finish in time keeps the baseline too', async () => {
    const app = await signedInDevice();
    app.syncStore.useSyncStore.setState({ pending: true });
    fake.state.flush = 'hang';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const signingOut = app.auth.signOutUser();
    await vi.advanceTimersByTimeAsync(app.auth.FLUSH_TIMEOUT_MS);
    await signingOut;
    expect(fake.state.flushCalls).toBe(1);
    expect(app.syncStore.useSyncStore.getState().user).toBeNull();
    expect(app.baseline.readBaseline(ME.uid)).not.toBeNull();
  });

  it('online, writes the server confirmed in time make it clean even though the engine had reported them waiting', async () => {
    const app = await signedInDevice();
    app.syncStore.useSyncStore.setState({ pending: true });
    await app.auth.signOutUser();
    await flush();
    expect(fake.state.flushCalls).toBe(1);
    expect(app.baseline.readBaseline(ME.uid)).toBeNull();
  });

  it('another account signing in drops the kept baseline; its own baseline is left alone', async () => {
    const app = await signedInDevice();
    app.syncStore.useSyncStore.setState({ pending: true });
    vi.stubGlobal('navigator', { onLine: false });
    await app.auth.signOutUser();
    await flush();
    expect(app.baseline.readBaseline(ME.uid)).not.toBeNull();

    vi.stubGlobal('navigator', { onLine: true });
    app.baseline.writeBaseline('uid-of-other@example.com', EMPTY_BASE);
    await app.auth.signIn('other@example.com', 'secret');
    await flush();
    expect(app.engine.startSync).toHaveBeenLastCalledWith('uid-of-other@example.com');
    expect(app.baseline.readBaseline(ME.uid)).toBeNull();
    expect(app.baseline.readBaseline('uid-of-other@example.com')).not.toBeNull();
  });

  it('a session that ends elsewhere keeps the baseline while writes were waiting, and forgets it otherwise', async () => {
    const app = await signedInDevice();
    app.syncStore.useSyncStore.setState({ pending: true });
    fake.endSessionElsewhere();
    await flush();
    expect(app.syncStore.useSyncStore.getState().user).toBeNull();
    expect(app.baseline.readBaseline(ME.uid)).not.toBeNull();

    const next = await signedInDevice();
    next.syncStore.useSyncStore.setState({ pending: false });
    fake.endSessionElsewhere();
    await flush();
    expect(next.baseline.readBaseline(ME.uid)).toBeNull();
    expect(storage.getItem('momentum-sync-session')).toBe('0');
  });
});
