import { onAuthChanged, signOutWasClean } from './auth';
import { clearBaseline, clearOtherBaselines, hasSyncSession, setSyncSession } from './baseline';
import { startSync, stopSync } from './engine';
import { clearLocalCache, isSyncConfigured, onFirebaseLoaded } from './firebase';
import { useSyncStore } from './syncStore';
import type { SyncUser } from './types';

/**
 * Wires auth state to the sync engine (SPEC §13.5). Called once from src/main.tsx AFTER the first
 * render. Never throws and never blocks rendering: when the env is not configured it only marks the
 * sync store 'off'; otherwise it defers (setTimeout 0), loads Firebase and reacts to auth changes.
 *
 * Deviation (review #26): the SDK is downloaded at launch only on a device with a sync session to
 * restore (baseline.ts hasSyncSession: an account signed in here and has not signed out). A device that
 * has never signed in shows the Sync card's form at once, fetches nothing and gets no Firebase IndexedDB
 * databases; the card's Sign in / Create account load the SDK on demand (auth.ts), and the
 * onFirebaseLoaded hook below attaches the auth listener then, without a reload.
 *
 * A launch whose SDK download fails is not a dead end: the auth listener is attached as soon as a later
 * load succeeds — a sign-in from the Sync card retries the download — or the browser reports being back
 * online, so that sign-in sets the user and starts syncing without a reload.
 */

const START_FAILED_MESSAGE = 'Sync could not start. Your data is safe on this device.';

let started = false;
/** onAuthStateChanged is attached; from here on nothing needs re-arming. */
let listening = false;
let arming: Promise<void> | null = null;

export function initSync(): void {
  if (started) return;
  started = true;
  if (!isSyncConfigured()) {
    useSyncStore.setState({ status: 'off', error: null, booting: false });
    return;
  }
  onFirebaseLoaded(() => {
    void boot();
  });
  if (!hasSyncSession()) {
    // Nothing to restore: the form shows at once (status stays 'signed-out') and the SDK waits for a sign-in.
    useSyncStore.setState({ booting: false });
    return;
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      void boot();
    });
  }
  // Off the critical path: the first paint never waits for the SDK download.
  setTimeout(() => {
    void boot();
  }, 0);
}

/** Attach the auth listener unless it is attached or being attached. Resolves once this attempt settles. */
function boot(): Promise<void> {
  if (listening) return Promise.resolve();
  arming ??= attach().finally(() => {
    arming = null;
  });
  return arming;
}

async function attach(): Promise<void> {
  try {
    await onAuthChanged(onAuthState);
    listening = true;
  } catch (error) {
    // Typically the SDK chunk failing to download on a first launch without network. The form stays
    // usable and shows this message meanwhile; a later successful load re-arms (see initSync).
    console.warn('Momentum sync: could not start.', error);
    useSyncStore.setState({ booting: false });
    useSyncStore.getState().setError(START_FAILED_MESSAGE);
  }
}

function onAuthState(user: SyncUser | null): void {
  if (user) {
    // The next launch restores this session (and downloads the SDK for it).
    setSyncSession(true);
    // A baseline kept by another account's offline sign-out no longer describes this store's cloud.
    clearOtherBaselines(user.uid);
    // One update: the card goes straight from "Checking your account…" to the account view.
    useSyncStore.setState({ user, booting: false });
    void startSync(user.uid);
    return;
  }
  // Read before the reset below: whether the engine last reported writes waiting for the server.
  const { user: previous, pending } = useSyncStore.getState();
  setSyncSession(false);
  stopSync();
  // A later sign-in (possibly as someone else) must not inherit this session's timestamps.
  useSyncStore.setState({
    user: null,
    booting: false,
    status: 'signed-out',
    pending: false,
    lastSyncedAt: null,
    error: null,
  });
  if (previous) {
    // Signing out leaves the account behind: Firestore's cached copy of the documents goes, queue
    // included, and so does the engine's memory of the cloud copy (the next sign-in is a first contact,
    // which uploads whatever is only on this device). Local trackers stay, as SPEC §13.6 promises.
    // Except when writes made here could not be confirmed (offline, so signOutUser skipped the flush, or
    // it timed out; a session ended elsewhere while writes were waiting): the baseline then stays, so the
    // next sign-in by this account reconciles three-way and replays those edits — an un-check or a
    // rename included — instead of uniting them away. Another account signing in drops it.
    const clean = signOutWasClean(previous.uid) ?? !pending;
    if (clean) clearBaseline(previous.uid);
    void clearLocalCache();
  }
}
