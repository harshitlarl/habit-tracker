/**
 * Sync engine (SPEC §13.5 steps 1–5): Firestore onSnapshot listener + store subscription that pushes
 * diffs in chunked write batches, with an echo-loop guard.
 * STUB: bodies are implemented by the sync-firebase owner; keep every exported name and signature.
 */

const STUB = 'engine.ts is a stub (sync-firebase implements it)';

/** Start listening to users/{uid}/habits and mirroring the local store. Idempotent per uid. */
export async function startSync(_uid: string): Promise<void> {
  throw new Error(STUB);
}

/** Unsubscribe the snapshot listener and the store subscription; reset module state. Safe to call twice. */
export function stopSync(): void {
  throw new Error(STUB);
}

/** Hard-delete every document under users/{uid}/habits in chunked batches (used by "Delete cloud data"). */
export async function deleteCloudData(_uid: string): Promise<void> {
  throw new Error(STUB);
}
