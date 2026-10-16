import { onAuthChanged } from './auth';
import { clearBaseline } from './baseline';
import { startSync, stopSync } from './engine';
import { clearLocalCache, isSyncConfigured, onFirebaseLoaded } from './firebase';
import { useSyncStore } from './syncStore';
import type { SyncUser } from './types';

/**
 * Wires auth state to the sync engine (SPEC §13.5). Called once from src/main.tsx AFTER the first
 * render. Never throws and never blocks rendering: when the env is not configured it only marks the
 * sync store 'off'; otherwise it defers (setTimeout 0), loads Firebase and reacts to auth changes.
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
    // One update: the card goes straight from "Checking your account…" to the account view.
    useSyncStore.setState({ user, booting: false });
    void startSync(user.uid);
    return;
  }
  const previous = useSyncStore.getState().user;
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
    // Signing out leaves nothing of the account behind: the engine's memory of its cloud copy goes
    // (the next sign-in is a first contact, which uploads whatever is only on this device) and so does
    // Firestore's cached copy of the documents. Local trackers stay, as SPEC §13.6 promises.
    clearBaseline(previous.uid);
    void clearLocalCache();
  }
}
