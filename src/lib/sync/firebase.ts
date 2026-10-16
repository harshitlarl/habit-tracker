import type { FirebaseApp } from 'firebase/app';
import type { Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';

/**
 * Lazy Firebase loader (SPEC §13.5). Only `import type` from firebase/* may appear at the top of any
 * file under src/lib/sync/ — the SDK itself must reach the bundle solely through the dynamic imports
 * inside loadFirebase(), so the local-only app never downloads it.
 */

export interface FirebaseHandles {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

/** True when all four VITE_FIREBASE_* values are present. False hides the whole sync feature. */
export function isSyncConfigured(): boolean {
  const env = import.meta.env;
  return Boolean(
    env.VITE_FIREBASE_API_KEY &&
      env.VITE_FIREBASE_AUTH_DOMAIN &&
      env.VITE_FIREBASE_PROJECT_ID &&
      env.VITE_FIREBASE_APP_ID,
  );
}

/**
 * Dynamic-imports firebase/app, firebase/auth and firebase/firestore once (memoised promise),
 * initialises the app and Firestore with a persistent multi-tab cache (memory fallback), and returns
 * the handles. STUB: implemented by the sync-firebase owner.
 */
export function loadFirebase(): Promise<FirebaseHandles> {
  return Promise.reject(new Error('firebase.ts loadFirebase is a stub (sync-firebase implements it)'));
}
