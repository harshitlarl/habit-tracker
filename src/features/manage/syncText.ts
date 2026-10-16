import type { SyncState } from '../../lib/sync/types';

/**
 * Copy for the "Sync across devices" card (SPEC §13.6). Pure, so it is unit-tested in Node:
 * the relative time on the status line, the status line itself, and how thrown errors become text.
 */

/** Which colour the status dot takes; doubles as the key for the status copy. */
export type SyncTone = 'synced' | 'pending' | 'connecting' | 'offline' | 'error';

export interface SyncLine {
  tone: SyncTone;
  text: string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const OFFLINE_TEXT = "Offline — changes will sync when you're back online";
const ERROR_FALLBACK = 'Sync hit a problem. It will keep trying.';

/**
 * "just now" / "5 min ago" / "3 hr ago" / "2 days ago". A `then` later than `now` (two clocks
 * that disagree) reads as "just now" rather than something negative.
 */
export function relativeTime(then: number, now: number): string {
  const diff = now - then;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hr ago`;
  const days = Math.floor(diff / DAY);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The one-line status shown under the account email. Priority: a sync error; offline (even with
 * changes waiting, since they go on their own once the connection is back); writes still pending;
 * the last server-confirmed time. Anything else is still connecting.
 */
export function describeSync(
  state: Pick<SyncState, 'status' | 'pending' | 'lastSyncedAt' | 'error'>,
  now: number,
): SyncLine {
  if (state.status === 'error') return { tone: 'error', text: state.error ?? ERROR_FALLBACK };
  if (state.status === 'offline') return { tone: 'offline', text: OFFLINE_TEXT };
  if (state.pending) return { tone: 'pending', text: 'Syncing…' };
  if (state.status === 'synced') {
    return {
      tone: 'synced',
      text: state.lastSyncedAt === null ? 'Synced' : `Synced · ${relativeTime(state.lastSyncedAt, now)}`,
    };
  }
  return { tone: 'connecting', text: 'Connecting…' };
}

/**
 * The auth wrappers (src/lib/sync/auth.ts) rethrow one calm, user-facing sentence as the Error
 * message; use it when there is one, the fallback otherwise.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const text = error.message.trim();
    if (text !== '') return text;
  }
  return fallback;
}
