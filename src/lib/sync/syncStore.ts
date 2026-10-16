import { create } from 'zustand';
import { isSyncConfigured } from './firebase';
import type { SyncState, SyncStatus, SyncUser } from './types';

/** UI-facing sync state (SPEC §13.5). NOT persisted — it is rebuilt on every launch by bootstrap.ts. */
export interface SyncStore extends SyncState {
  /** Set the status; clears the error unless one is given. */
  setStatus: (status: SyncStatus, error?: string | null) => void;
  setUser: (user: SyncUser | null) => void;
  setPending: (pending: boolean) => void;
  /** Server-confirmed snapshot arrived at `at` (epoch ms): status 'synced', error cleared. */
  markSynced: (at: number) => void;
  /** Status 'error' with a friendly, user-facing sentence. */
  setError: (error: string) => void;
}

export function initialSyncState(): SyncState {
  return {
    status: isSyncConfigured() ? 'signed-out' : 'off',
    user: null,
    pending: false,
    lastSyncedAt: null,
    error: null,
  };
}

export const useSyncStore = create<SyncStore>()((set) => ({
  ...initialSyncState(),
  setStatus: (status, error = null) => set({ status, error }),
  setUser: (user) => set({ user }),
  setPending: (pending) => set({ pending }),
  markSynced: (at) => set({ status: 'synced', lastSyncedAt: at, error: null }),
  setError: (error) => set({ status: 'error', error }),
}));

export default useSyncStore;
