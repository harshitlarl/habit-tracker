import type { SyncUser } from './types';

/**
 * Email/password auth wrappers (SPEC §13.5). Each loads Firebase lazily via loadFirebase(), trims the
 * email, and rethrows an Error whose message is friendlyAuthError(originalError).
 * STUB: bodies are implemented by the sync-firebase owner; keep every exported name and signature.
 */

const STUB = 'auth.ts is a stub (sync-firebase implements it)';

export async function signIn(_email: string, _password: string): Promise<void> {
  throw new Error(STUB);
}

export async function signUp(_email: string, _password: string): Promise<void> {
  throw new Error(STUB);
}

export async function resetPassword(_email: string): Promise<void> {
  throw new Error(STUB);
}

/** Signs out of Firebase. Local data is untouched. */
export async function signOutUser(): Promise<void> {
  throw new Error(STUB);
}

/** Subscribe to auth changes (loads Firebase first). Resolves to the unsubscribe function. */
export function onAuthChanged(_cb: (user: SyncUser | null) => void): Promise<() => void> {
  return Promise.reject(new Error(STUB));
}

/**
 * Map a FirebaseError / Error / string code to one calm, user-facing sentence
 * (auth/invalid-email, auth/user-not-found, auth/wrong-password, auth/invalid-credential,
 * auth/email-already-in-use, auth/weak-password, auth/too-many-requests,
 * auth/network-request-failed, anything else → a generic sentence). Never throws.
 */
export function friendlyAuthError(_error: unknown): string {
  throw new Error(STUB);
}
