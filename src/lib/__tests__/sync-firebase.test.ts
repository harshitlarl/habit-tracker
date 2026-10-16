import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * firebase.ts against stand-ins for the three SDK entry points: the memoised load, the forgotten
 * failure, onFirebaseLoaded, and clearLocalCache (terminate + clear the IndexedDB cache, then a fresh
 * instance on the next load). The env is stubbed per test; without it sync is not configured.
 */

const sdk = vi.hoisted(() => {
  const state = {
    apps: [] as object[],
    /** When set, the SDK "fails to load" (the first call into it throws, as a failed chunk download would reject). */
    importError: null as Error | null,
    initializeFirestore: 0,
    initializeAuth: 0,
    terminated: [] as object[],
    /** When set, terminate() stays pending until this promise resolves. */
    terminateHold: null as Promise<void> | null,
    cleared: [] as object[],
    clearError: null as Error | null,
  };
  return {
    state,
    app: {
      getApps: () => {
        if (state.importError) throw state.importError;
        return state.apps;
      },
      getApp: () => state.apps[0],
      initializeApp: (config: unknown) => {
        const app = { config };
        state.apps.push(app);
        return app;
      },
    },
    auth: {
      indexedDBLocalPersistence: 'idb',
      browserLocalPersistence: 'local',
      initializeAuth: (app: object) => {
        state.initializeAuth += 1;
        if (state.initializeAuth > 1) throw new Error('auth/already-initialized');
        return { app };
      },
      getAuth: (app: object) => ({ app, reused: true }),
    },
    firestore: {
      persistentLocalCache: (o: unknown) => ({ kind: 'persistent', o }),
      persistentMultipleTabManager: () => 'multi-tab',
      memoryLocalCache: () => ({ kind: 'memory' }),
      initializeFirestore: (app: object, settings: unknown) => {
        state.initializeFirestore += 1;
        return { app, settings, n: state.initializeFirestore };
      },
      getFirestore: (app: object) => ({ app, reused: true }),
      terminate: (db: object) => {
        state.terminated.push(db);
        return state.terminateHold ?? Promise.resolve();
      },
      clearIndexedDbPersistence: (db: object) => {
        if (state.clearError) return Promise.reject(state.clearError);
        state.cleared.push(db);
        return Promise.resolve();
      },
    },
    reset: (): void => {
      state.apps = [];
      state.importError = null;
      state.initializeFirestore = 0;
      state.initializeAuth = 0;
      state.terminated = [];
      state.terminateHold = null;
      state.cleared = [];
      state.clearError = null;
    },
  };
});

vi.mock('firebase/app', () => sdk.app);
vi.mock('firebase/auth', () => sdk.auth);
vi.mock('firebase/firestore', () => sdk.firestore);

import { clearLocalCache, isSyncConfigured, loadFirebase, onFirebaseLoaded } from '../sync/firebase';

const ENV = {
  VITE_FIREBASE_API_KEY: 'key',
  VITE_FIREBASE_AUTH_DOMAIN: 'momentum.example',
  VITE_FIREBASE_PROJECT_ID: 'momentum-test',
  VITE_FIREBASE_APP_ID: '1:2:web:3',
};

function stubEnv(over: Partial<Record<keyof typeof ENV, string | undefined>> = {}): void {
  for (const [key, value] of Object.entries({ ...ENV, ...over })) vi.stubEnv(key, value);
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sdk.reset();
  stubEnv();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await clearLocalCache(); // leaves the module with no memoised instance for the next test
  sdk.reset();
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe('isSyncConfigured', () => {
  it('needs all four VITE_FIREBASE_* values', () => {
    expect(isSyncConfigured()).toBe(true);
    for (const key of Object.keys(ENV) as Array<keyof typeof ENV>) {
      stubEnv({ [key]: undefined });
      expect(isSyncConfigured(), key).toBe(false);
      stubEnv({ [key]: '' });
      expect(isSyncConfigured(), key).toBe(false);
      stubEnv();
    }
  });
});

describe('loadFirebase', () => {
  it('initialises the app, auth and a persistent multi-tab Firestore once, and memoises the handles', async () => {
    const first = await loadFirebase();
    const second = await loadFirebase();
    expect(second).toBe(first);
    expect(sdk.state.apps).toHaveLength(1);
    expect(sdk.state.initializeFirestore).toBe(1);
    expect(first.db).toMatchObject({ settings: { localCache: { kind: 'persistent', o: { tabManager: 'multi-tab' } } } });
    expect(first.auth).toEqual({ app: first.app });
    expect(typeof first.sdk.firestore.terminate).toBe('function'); // the loaded namespaces travel with the handles
  });

  it('rejects when not configured, and forgets a failed load so the next call tries again', async () => {
    stubEnv({ VITE_FIREBASE_APP_ID: undefined });
    await expect(loadFirebase()).rejects.toThrow(/not configured/);
    stubEnv();

    sdk.state.importError = new TypeError('Failed to fetch dynamically imported module');
    await expect(loadFirebase()).rejects.toThrow(/dynamically imported/);
    sdk.state.importError = null;
    await expect(loadFirebase()).resolves.toBeDefined();
  });

  it('onFirebaseLoaded runs after every successful load, once now if already loaded, and can be removed', async () => {
    const calls: string[] = [];
    const offA = onFirebaseLoaded(() => calls.push('a'));
    expect(calls).toEqual([]);
    await loadFirebase();
    expect(calls).toEqual(['a']);

    onFirebaseLoaded(() => calls.push('b')); // already loaded: fires once, asynchronously
    expect(calls).toEqual(['a']);
    await flush();
    expect(calls).toEqual(['a', 'b']);

    offA();
    await clearLocalCache();
    await loadFirebase(); // a fresh instance: b is told, a was removed
    expect(calls).toEqual(['a', 'b', 'b']);
  });

  it('a failed load tells nobody', async () => {
    const cb = vi.fn();
    onFirebaseLoaded(cb);
    sdk.state.importError = new TypeError('Failed to fetch dynamically imported module');
    await expect(loadFirebase()).rejects.toThrow();
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('clearLocalCache', () => {
  it('terminates the instance, clears its IndexedDB persistence and lets the next load start a fresh instance', async () => {
    const first = await loadFirebase();
    await clearLocalCache();
    expect(sdk.state.terminated).toEqual([first.db]);
    expect(sdk.state.cleared).toEqual([first.db]);

    const second = await loadFirebase();
    expect(second).not.toBe(first);
    expect(second.db).not.toBe(first.db);
    expect(sdk.state.initializeFirestore).toBe(2);
    expect(sdk.state.apps).toHaveLength(1); // the app itself is reused…
    expect(second.auth).toEqual({ app: first.app, reused: true }); // …and so is its Auth instance
  });

  it('a load requested during the clear waits for it instead of reusing the terminating instance', async () => {
    const first = await loadFirebase();
    let release: () => void = () => {};
    sdk.state.terminateHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clearing = clearLocalCache();
    const next = loadFirebase();
    let settled = false;
    void next.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(sdk.state.initializeFirestore).toBe(1); // no second instance yet
    release();
    await clearing;
    const second = await next;
    expect(second.db).not.toBe(first.db);
    expect(sdk.state.cleared).toEqual([first.db]); // cleared before the fresh instance opened
    expect(sdk.state.initializeFirestore).toBe(2);
  });

  it('a refused clear (another tab holds the database) is logged, never thrown', async () => {
    await loadFirebase();
    sdk.state.clearError = Object.assign(new Error('Persistence is in use by another tab.'), { code: 'failed-precondition' });
    await expect(clearLocalCache()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(sdk.state.cleared).toEqual([]);
  });

  it('is a no-op when Firebase never loaded, or when the load had failed', async () => {
    await clearLocalCache();
    sdk.state.importError = new TypeError('Failed to fetch dynamically imported module');
    await expect(loadFirebase()).rejects.toThrow();
    await clearLocalCache();
    expect(sdk.state.terminated).toEqual([]);
  });
});
