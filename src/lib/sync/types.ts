import type { Completions, DateKey, Habit } from '../types';

/**
 * Phase 2 — cloud sync contract (SPEC §13). Every module under src/lib/sync/ builds on these types.
 * Settings never sync; only the three parts below do.
 */

/** The synced slice of the local store. */
export interface LocalData {
  habits: Habit[];
  completions: Completions;
  /** Tombstones: ids of habits deleted on this device (or learned from the cloud). Sync never hard-deletes. */
  deletedIds: string[];
}

/** One Firestore document at users/{uid}/habits/{habitId}, after parsing (see merge.ts parseRemoteDoc). */
export interface RemoteHabit extends Habit {
  /** Set of completed LOCAL calendar dates ('YYYY-MM-DD' → true). */
  completions: Record<DateKey, true>;
  /** Tombstone flag. A deleted doc keeps its fields so a late device can learn about the deletion. */
  deleted: boolean;
  /** Firestore serverTimestamp(); null while a local write awaits the server. Opaque to merge.ts. */
  updatedAt?: unknown;
}

/** A single write the engine must perform against users/{uid}/habits. */
export type PushOp =
  | { type: 'setHabit'; habit: Habit }
  | { type: 'addCompletion'; habitId: string; dateKey: DateKey }
  | { type: 'removeCompletion'; habitId: string; dateKey: DateKey }
  | { type: 'tombstone'; habitId: string };

export interface MergeResult {
  /** What the local store should hold after reconciling with the cloud. */
  merged: LocalData;
  /** What the cloud is missing. Empty when the cloud already has everything. */
  toPush: PushOp[];
}

export type SyncStatus =
  | 'off' // env not configured → the whole feature is hidden
  | 'signed-out'
  | 'connecting' // signed in, waiting for the first snapshot
  | 'synced' // last snapshot came from the server
  | 'offline' // last snapshot came from the local cache
  | 'error';

export interface SyncUser {
  uid: string;
  email: string | null;
}

export interface SyncState {
  status: SyncStatus;
  user: SyncUser | null;
  /** True while local writes are waiting to reach the server. */
  pending: boolean;
  /** Epoch ms of the last server-confirmed snapshot. */
  lastSyncedAt: number | null;
  /** Friendly, user-facing sentence; set whenever status === 'error'. */
  error: string | null;
}
