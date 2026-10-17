import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/*
 * The sync spec's pending-cleanup ledger (SPEC §13.8: the throwaway account is always removed).
 *
 * The account's random password exists only in the worker that made it up, so a worker that died mid-run
 * (Ctrl-C, a crash, a hook that timed out, a laptop put to sleep) used to leave the account and its
 * users/{uid} documents behind for good: nothing else could ever sign in to remove them. The spec therefore
 * records the credentials here before the account can exist, forgets them once its cleanup has seen the
 * sign-in refused, and every later run's beforeAll sweeps what an earlier run left: entries whose process
 * has exited, or that are older than STALE_AFTER_MS. An entry of a run that is still going is never
 * touched, so two runs on one machine stay out of each other's way.
 *
 * The price is a throwaway password on disk: one JSON file per account, mode 0600 in a 0700 folder that
 * git ignores (e2e/.pending-cleanup/), deleted as soon as the account is verified gone. That account holds
 * nothing but the run's test data and can reach only its own users/{uid} subtree (firestore.rules). The
 * ledger accepts throwaway addresses only (THROWAWAY_EMAIL), so no sweep can ever delete a real account.
 * Nothing here imports Playwright, so vitest can load this file (ledger.test.ts).
 */

/** The only accounts the ledger holds: the sync spec's throwaway sign-ups, one per run. */
export const THROWAWAY_EMAIL = /^momentum-qa-2-\d+@example\.com$/;

/** The throwaway address of the run started at `run` (ms since the epoch). */
export const throwawayEmail = (run: number): string => `momentum-qa-2-${run}@example.com`;

export interface PendingAccount {
  email: string;
  password: string;
  /** The process that recorded the entry: while it runs, the entry is its own. */
  pid: number;
  /** When the entry was recorded (ISO 8601). */
  recordedAt: string;
}

/** An entry this old is swept even when its pid is alive: by then the pid belongs to another process. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

const ENTRY_SUFFIX = '.json';

/** One file per account, named after its address. */
export function entryPath(dir: string, email: string): string {
  return path.join(dir, `${email.replace(/[^A-Za-z0-9@._-]/g, '_')}${ENTRY_SUFFIX}`);
}

/**
 * Records `account`, readable by its owner only, and returns the file. Written to a temporary file and
 * renamed into place, so a process killed mid-write leaves the whole entry or none: a stray *.tmp is
 * never read, and belongs to an account that does not exist yet (the entry is recorded before sign-up).
 */
export function recordAccount(dir: string, account: PendingAccount): string {
  if (!THROWAWAY_EMAIL.test(account.email)) {
    throw new Error(`The cleanup ledger holds throwaway accounts only, not ${account.email}.`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = entryPath(dir, account.email);
  const temp = `${file}.${account.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(account)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return file;
}

/** Deletes one entry file; nothing happens when it is not there. */
export function forgetEntry(file: string): void {
  rmSync(file, { force: true });
}

/** A process with this pid exists (signal 0 delivers nothing). EPERM: it exists and belongs to someone else. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The entry `text` holds, or null when it is not one the spec could have written. */
export function parseEntry(text: string): PendingAccount | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { email, password, pid, recordedAt } = raw as Record<string, unknown>;
  if (typeof email !== 'string' || !THROWAWAY_EMAIL.test(email)) return null;
  if (typeof password !== 'string' || password === '') return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) return null;
  return { email, password, pid, recordedAt };
}

export interface StaleEntry {
  file: string;
  account: PendingAccount;
}

export interface LedgerScan {
  /** Left behind by runs that are over, oldest first: the sweep's work. */
  stale: StaleEntry[];
  /** Entry files that are not a readable throwaway entry; named for a person to check, never deleted here. */
  unreadable: string[];
}

export interface ScanOptions {
  now?: number;
  /** Injected by the unit tests. */
  isAlive?: (pid: number) => boolean;
  /** This run's own address: never returned as stale. */
  except?: string;
}

/** What an earlier run left in `dir` (an absent folder holds nothing). */
export function scanLedger(dir: string, { now = Date.now(), isAlive = isProcessAlive, except }: ScanOptions = {}): LedgerScan {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { stale: [], unreadable: [] };
    throw error;
  }
  const stale: StaleEntry[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter((n) => n.endsWith(ENTRY_SUFFIX)).sort()) {
    const file = path.join(dir, name);
    let account: PendingAccount | null;
    try {
      account = parseEntry(readFileSync(file, 'utf8'));
    } catch {
      account = null; // not a readable file (a folder named *.json, no permission)
    }
    if (account === null) {
      unreadable.push(file);
      continue;
    }
    if (account.email === except) continue;
    if (!isAlive(account.pid) || now - Date.parse(account.recordedAt) > STALE_AFTER_MS) stale.push({ file, account });
  }
  stale.sort((a, b) => Date.parse(a.account.recordedAt) - Date.parse(b.account.recordedAt));
  return { stale, unreadable };
}
