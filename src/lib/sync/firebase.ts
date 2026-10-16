import type { FirebaseApp, FirebaseOptions } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

/**
 * Lazy Firebase loader (SPEC §13.5). Only `import type` from firebase/* may appear at the top of any
 * file under src/lib/sync/ — the SDK itself must reach the bundle solely through the dynamic imports
 * inside loadFirebase(), so the local-only app never downloads it.
 */

/** The three SDK entry points, loaded once. Other sync modules take them from here rather than importing firebase/* themselves. */
export interface FirebaseSdk {
  app: typeof import('firebase/app');
  auth: typeof import('firebase/auth');
  firestore: typeof import('firebase/firestore');
}

export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  /** The loaded SDK namespaces: onSnapshot, writeBatch, signInWithEmailAndPassword and friends. */
  sdk: FirebaseSdk;
}

/** The public web config from .env, or null when any value is missing. */
function readConfig(): FirebaseOptions | null {
  const env = import.meta.env;
  const apiKey = env.VITE_FIREBASE_API_KEY;
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  const appId = env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return { apiKey, authDomain, projectId, appId };
}

/** True when all four VITE_FIREBASE_* values are present. False hides the whole sync feature. */
export function isSyncConfigured(): boolean {
  return readConfig() !== null;
}

let loading: Promise<FirebaseHandles> | null = null;
/** A clearLocalCache() still running; the next load waits for it so the fresh instance opens a clean cache. */
let clearing: Promise<void> | null = null;
const loadedCallbacks = new Set<() => void>();

/**
 * Dynamic-imports firebase/app, firebase/auth and firebase/firestore once (memoised promise),
 * initialises the app and Firestore with a persistent multi-tab cache (memory fallback), and returns
 * the handles. A failed download (offline on first use) is forgotten so the next call tries again.
 */
export function loadFirebase(): Promise<FirebaseHandles> {
  loading ??= (clearing ?? Promise.resolve()).then(load).then(
    (handles) => {
      for (const cb of [...loadedCallbacks]) cb();
      return handles;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/**
 * Run `cb` after every successful loadFirebase() (and once now, if it already succeeded). bootstrap.ts
 * uses it to attach the auth listener when a sign-in from the Sync card manages the download a failed
 * launch could not; auth.ts does not import bootstrap.ts, so this is how the two meet.
 */
export function onFirebaseLoaded(cb: () => void): () => void {
  loadedCallbacks.add(cb);
  if (loading !== null) {
    void loading.then(
      () => {
        if (loadedCallbacks.has(cb)) cb();
      },
      () => {},
    );
  }
  return () => {
    loadedCallbacks.delete(cb);
  };
}

/**
 * Remove the account's documents from Firestore's persistent cache on this device (sign-out, "Reset
 * this device"): terminates the instance and clears its IndexedDB database, which only a terminated
 * instance allows. Another tab holding the database makes the clear fail; that is logged, not thrown.
 * The next loadFirebase() builds a fresh instance. Never throws; a no-op when Firebase never loaded.
 */
export async function clearLocalCache(): Promise<void> {
  const current = loading;
  if (current === null) return;
  loading = null;
  const job = (async () => {
    let handles: FirebaseHandles;
    try {
      handles = await current;
    } catch {
      return; // a failed load has no cache
    }
    try {
      await handles.sdk.firestore.terminate(handles.db);
      await handles.sdk.firestore.clearIndexedDbPersistence(handles.db);
    } catch (error) {
      console.warn('Momentum sync: could not clear the local cache.', error);
    }
  })();
  clearing = job;
  try {
    await job;
  } finally {
    if (clearing === job) clearing = null;
  }
}

async function load(): Promise<FirebaseHandles> {
  const config = readConfig();
  if (!config) throw new Error('Cloud sync is not configured in this build.');
  const [app, auth, firestore] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ]);
  const sdk: FirebaseSdk = { app, auth, firestore };
  // Dev HMR can re-evaluate this module while the SDK still holds the app from the previous evaluation.
  const firebaseApp = app.getApps().length > 0 ? app.getApp() : app.initializeApp(config);
  return { app: firebaseApp, auth: createAuth(sdk, firebaseApp), db: createFirestore(sdk, firebaseApp), sdk };
}

function createAuth(sdk: FirebaseSdk, app: FirebaseApp): Auth {
  const { initializeAuth, getAuth, indexedDBLocalPersistence, browserLocalPersistence } = sdk.auth;
  try {
    // Email/password only, so no popup/redirect resolver is loaded. The SDK uses the first persistence
    // the browser supports and keeps the session in memory when neither is available.
    return initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  } catch {
    // Already initialised for this app (dev HMR): reuse it.
    return getAuth(app);
  }
}

function createFirestore(sdk: FirebaseSdk, app: FirebaseApp): Firestore {
  const { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache } =
    sdk.firestore;
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (error) {
    try {
      // Private mode / unsupported browser: offline changes queue in memory for this session only.
      const db = initializeFirestore(app, { localCache: memoryLocalCache() });
      console.warn('Momentum sync: persistent cache unavailable, using the memory cache.', error);
      return db;
    } catch {
      // Already initialised for this app (dev HMR): reuse it.
      return getFirestore(app);
    }
  }
}
