import type { User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { loadFirebase, type FirebaseHandles, type FirebaseSdk } from './firebase';
import type { SyncUser } from './types';

/**
 * Email/password auth wrappers (SPEC §13.5). Each loads Firebase lazily via loadFirebase(), trims the
 * email, and rethrows an Error whose message is friendlyAuthError(originalError).
 */

const OFFLINE_MESSAGE = 'You seem to be offline. Check your connection and try again.';
const GENERIC_MESSAGE = 'Something went wrong. Try again in a moment.';
/** How long sign-out waits for queued writes to reach the server before going ahead anyway. */
const FLUSH_TIMEOUT_MS = 4_000;

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

/**
 * Signs out of Firebase. Local data is untouched. Writes still queued for the server get a bounded
 * moment to land first, so a check-in made seconds before signing out is not left behind.
 */
export async function signOutUser(): Promise<void> {
  await withAuth(async ({ auth, db, sdk }) => {
    await flushPendingWrites(db, sdk.firestore);
    await sdk.auth.signOut(auth);
  });
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
 * moment. Skipped offline, where waiting would only delay the sign-out: trackers and check-ins made
 * offline are re-sent by the first-contact merge of the next sign-in. Never throws.
 */
async function flushPendingWrites(db: Firestore, fs: FirebaseSdk['firestore']): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fs.waitForPendingWrites(db),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Rejected on a user change or shutdown: nothing left to wait for.
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
