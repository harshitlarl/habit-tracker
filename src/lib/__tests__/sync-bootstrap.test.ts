import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirebaseHandles } from '../sync/firebase';

/*
 * bootstrap.ts: the auth listener must end up attached even when the first SDK download fails — a
 * sign-in from the Sync card (auth.ts → loadFirebase) or the browser coming back online re-arms it, so
 * that sign-in sets the user and starts syncing without a reload. The Firebase module is replaced by a
 * small fake whose load can be made to fail, with a faithful copy of onFirebaseLoaded.
 */

const fake = vi.hoisted(() => {
  type Observer = (user: { uid: string; email: string | null } | null) => void;
  const state = {
    loadError: null as Error | null,
    loads: 0,
    currentUser: null as { uid: string; email: string | null } | null,
    observers: new Set<Observer>(),
    loadedCallbacks: new Set<() => void>(),
    loading: null as Promise<unknown> | null,
    cleared: 0,
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
      for (const cb of [...state.observers]) cb(state.currentUser);
      return Promise.resolve();
    },
    signOut: (): Promise<void> => {
      state.currentUser = null;
      for (const cb of [...state.observers]) cb(null);
      return Promise.resolve();
    },
  };
  const handles = { app: {}, auth: {}, db: {}, sdk: { app: {}, auth, firestore: { waitForPendingWrites: () => Promise.resolve() } } };
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
    handles,
    load,
    onFirebaseLoaded: (cb: () => void): (() => void) => {
      state.loadedCallbacks.add(cb);
      return () => {
        state.loadedCallbacks.delete(cb);
      };
    },
    /** Per-test counters only: bootstrap.ts keeps its listener across tests, so observers and callbacks stay. */
    reset: (): void => {
      state.loadError = null;
      state.loads = 0;
      state.cleared = 0;
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

import { signIn, signOutUser } from '../sync/auth';
import { readBaseline, writeBaseline } from '../sync/baseline';
import { initSync } from '../sync/bootstrap';
import { startSync, stopSync } from '../sync/engine';
import { initialSyncState, useSyncStore } from '../sync/syncStore';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sync = () => useSyncStore.getState();

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fake.reset();
  vi.mocked(startSync).mockClear();
  vi.mocked(stopSync).mockClear();
  useSyncStore.setState({ ...initialSyncState(), booting: true });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe('initSync', () => {
  // initSync runs once per module instance; the module is loaded fresh for the first test only, so the
  // scenario that needs the failed boot comes first and the later tests build on the same listener.
  it('a failed boot is re-armed by the sign-in that manages the download: the user is set and sync starts', async () => {
    fake.state.loadError = new TypeError('Failed to fetch dynamically imported module');
    initSync();
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
    await signIn(' me@example.com ', 'secret');
    await flush();
    expect(fake.state.observers.size).toBe(1); // the auth listener is attached now…
    expect(sync().user).toEqual({ uid: 'uid-of-me@example.com', email: 'me@example.com' });
    expect(startSync).toHaveBeenCalledWith('uid-of-me@example.com'); // …and sync started, no reload needed
    expect(sync().booting).toBe(false);
  });

  it('signing out stops the engine, resets the store, forgets the baseline and clears the local cache', async () => {
    writeBaseline('uid-of-me@example.com', { data: { habits: [], completions: {}, deletedIds: [] }, acked: [] });
    useSyncStore.setState({ user: { uid: 'uid-of-me@example.com', email: 'me@example.com' }, status: 'synced', lastSyncedAt: 5 });
    await signOutUser();
    await flush();
    expect(stopSync).toHaveBeenCalled();
    expect(sync()).toMatchObject({ user: null, status: 'signed-out', pending: false, lastSyncedAt: null, error: null, booting: false });
    expect(readBaseline('uid-of-me@example.com')).toBeNull();
    expect(fake.state.cleared).toBe(1);
  });

  it('the initial signed-out state at launch clears nothing (there was no account on this device)', async () => {
    fake.state.cleared = 0;
    for (const cb of [...fake.state.observers]) cb(null);
    await flush();
    expect(fake.state.cleared).toBe(0);
    expect(sync().status).toBe('signed-out');
  });

  it('is idempotent: a second initSync attaches nothing more, and a later load re-arms nothing while listening', async () => {
    initSync();
    await flush();
    for (const cb of [...fake.state.loadedCallbacks]) cb(); // what a later successful loadFirebase() does
    await flush();
    expect(fake.state.observers.size).toBe(1);
  });
});
