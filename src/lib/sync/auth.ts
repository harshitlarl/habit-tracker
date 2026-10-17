import type { User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { loadFirebase, type FirebaseHandles, type FirebaseSdk } from './firebase';
import { useSyncStore } from './syncStore';
import type { SyncUser } from './types';

/**
 * Email/password auth wrappers (SPEC §13.5). Each loads Firebase lazily via loadFirebase(), trims the
 * email, and rethrows an Error whose message is friendlyAuthError(originalError).
 */

const OFFLINE_MESSAGE = 'You seem to be offline. Check your connection and try again.';
const GENERIC_MESSAGE = 'Something went wrong. Try again in a moment.';
/** How long sign-out waits for queued writes to reach the server before going ahead anyway. */
export const FLUSH_TIMEOUT_MS = 4_000;

/** Calm, user-facing sentences for the codes the sign-in form can run into. */
const AUTH_MESSAGES: Readonly<Record<string, string>> = {
  'auth/invalid-email': 'That email address does not look right.',
  'auth/missing-email': 'Enter your email address.',
  'auth/missing-password': 'Enter your password.',
  'auth/user-not-found': 'No account uses that email yet. Create one instead.',
  'auth/wrong-password': 'That password is not right. Try again, or reset it.',
  'auth/invalid-credential': 'That email and password do not match. Try again, or reset your password.',
  'auth/invalid-login-credentials': 'That email and password do not match. Try again, or reset your password.',
  'auth/email-already-in-use': 'An account with that email already exists. Sign in instead.',
  'auth/weak-password': 'Choose a longer password: at least 6 characters.',
  'auth/too-many-requests': 'Too many attempts for now. Wait a few minutes, then try again.',
  'auth/network-request-failed': OFFLINE_MESSAGE,
  'auth/user-disabled': 'This account has been disabled.',
  // Sign-ups switched off in the Firebase console (README: the recommended setting once the owner's account exists).
  'auth/admin-restricted-operation': 'New accounts are closed on this project.',
  // The Email/Password provider itself switched off.
  'auth/operation-not-allowed': 'Email sign-in is turned off for this project.',
};

export async function signIn(email: string, password: string): Promise<void> {
  await withAuth(({ auth, sdk }) => sdk.auth.signInWithEmailAndPassword(auth, email.trim(), password));
}

export async function signUp(email: string, password: string): Promise<void> {
  await withAuth(({ auth, sdk }) => sdk.auth.createUserWithEmailAndPassword(auth, email.trim(), password));
}

export async function resetPassword(email: string): Promise<void> {
  await withAuth(({ auth, sdk }) => sdk.auth.sendPasswordResetEmail(auth, email.trim()));
}

/** What signOutUser found out about the account it signed out; read once by bootstrap.ts. */
let lastSignOut: { uid: string; clean: boolean } | null = null;

/**
 * Signs out of Firebase. Local data is untouched. Writes still queued for the server get a bounded
 * moment to land first, so a check-in made seconds before signing out is not left behind.
 *
 * Signing out clears Firestore's local cache, queue included (bootstrap.ts). When the engine reported
 * writes waiting and they could not be confirmed — offline, so the flush was skipped, or it timed out or
 * failed — the sign-out is recorded as unclean (signOutWasClean) and bootstrap.ts keeps the account's
 * sync baseline: the next sign-in by the same account then reconciles three-way and replays those edits
 * (an un-check or a rename included) instead of uniting them away with the cloud's copy.
 */
export async function signOutUser(): Promise<void> {
  await withAuth(async ({ auth, db, sdk }) => {
    // Read before signing out: the auth callback resets the sync store.
    const { user, pending } = useSyncStore.getState();
    const flushed = await flushPendingWrites(db, sdk.firestore);
    lastSignOut = user ? { uid: user.uid, clean: !pending || flushed } : null;
    try {
      await sdk.auth.signOut(auth);
    } catch (error) {
      lastSignOut = null;
      throw error;
    }
  });
}

/**
 * Whether `uid`'s sign-out through signOutUser was clean: true when nothing was waiting or every write
 * reached the server first, false when writes made offline could not be confirmed. Null when `uid` was
 * not signed out by signOutUser (a session ended elsewhere). Answers once per sign-out.
 */
export function signOutWasClean(uid: string): boolean | null {
  const verdict = lastSignOut;
  lastSignOut = null;
  return verdict?.uid === uid ? verdict.clean : null;
}

/** Subscribe to auth changes (loads Firebase first). Resolves to the unsubscribe function. */
export async function onAuthChanged(cb: (user: SyncUser | null) => void): Promise<() => void> {
  const { auth, sdk } = await loadFirebase();
  return sdk.auth.onAuthStateChanged(auth, (user) => cb(user ? toSyncUser(user) : null));
}

/**
 * Map a FirebaseError / Error / string code to one calm, user-facing sentence
 * (auth/invalid-email, auth/user-not-found, auth/wrong-password, auth/invalid-credential,
 * auth/email-already-in-use, auth/weak-password, auth/too-many-requests,
 * auth/network-request-failed, anything else → a generic sentence). Never throws.
 */
export function friendlyAuthError(error: unknown): string {
  const code = errorCode(error);
  if (code !== null) {
    const message = AUTH_MESSAGES[code];
    if (message !== undefined) return message;
  }
  if (isModuleLoadFailure(error)) return OFFLINE_MESSAGE;
  return GENERIC_MESSAGE;
}

/** Runs one auth call against the lazily loaded SDK; any failure surfaces as a friendly Error. */
async function withAuth<T>(run: (handles: FirebaseHandles) => Promise<T>): Promise<T> {
  try {
    const handles = await loadFirebase();
    return await run(handles);
  } catch (error) {
    throw new Error(friendlyAuthError(error));
  }
}

/**
 * Best effort: writes that have not reached the server when the user signs out would otherwise be
 * left behind (sign-out clears Firestore's local cache, queue included), so give them a bounded
 * moment. Skipped offline, where waiting would only delay the sign-out: the saved baseline is kept
 * then (see signOutUser), and the next sign-in replays what was made offline. Resolves true when the
 * server confirmed every queued write, false when skipped, timed out or failed. Never throws.
 */
async function flushPendingWrites(db: Firestore, fs: FirebaseSdk['firestore']): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fs.waitForPendingWrites(db).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Rejected on a user change or shutdown: the queue's fate is unknown.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function toSyncUser(user: User): SyncUser {
  return { uid: user.uid, email: user.email };
}

/** The `code` of a FirebaseError-like object, or the string itself when given a bare code. */
function errorCode(error: unknown): string | null {
  if (typeof error === 'string') return error.trim();
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

/** The SDK chunk itself failed to download: every browser reports that as a TypeError. */
function isModuleLoadFailure(error: unknown): boolean {
  return error instanceof TypeError && /import|module|fetch/i.test(error.message);
}
