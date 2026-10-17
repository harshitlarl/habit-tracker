import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STALE_AFTER_MS,
  THROWAWAY_EMAIL,
  entryPath,
  forgetEntry,
  isProcessAlive,
  parseEntry,
  recordAccount,
  scanLedger,
  throwawayEmail,
  type PendingAccount,
} from './ledger';

/*
 * The sync spec's pending-cleanup ledger (SPEC §13.8): what a killed run leaves is found by the next
 * one, a run still in progress is never swept, and nothing but a throwaway address is ever held.
 */

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const LIVE_PID = 4242;
const DEAD_PID = 4343;
const alive = (pid: number): boolean => pid === LIVE_PID;

const account = (run: number, pid: number, minutesAgo: number): PendingAccount => ({
  email: throwawayEmail(run),
  password: `secret-${run}`,
  pid,
  recordedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

let root = '';
let dir = '';
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'momentum-ledger-'));
  dir = path.join(root, '.pending-cleanup');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('throwaway addresses', () => {
  it('names one per run and holds nothing else', () => {
    expect(throwawayEmail(1792235458109)).toBe('momentum-qa-2-1792235458109@example.com');
    expect(THROWAWAY_EMAIL.test(throwawayEmail(Date.now()))).toBe(true);
    expect(THROWAWAY_EMAIL.test('owner@example.org')).toBe(false);
    expect(THROWAWAY_EMAIL.test('momentum-qa-2-1@example.com.evil.test')).toBe(false);
    expect(THROWAWAY_EMAIL.test('x-momentum-qa-2-1@example.com')).toBe(false);
  });
});

describe('recordAccount / forgetEntry', () => {
  it('writes one owner-only file per account that reads back as the same entry', () => {
    const entry = account(1, LIVE_PID, 0);
    const file = recordAccount(dir, entry);
    expect(file).toBe(entryPath(dir, entry.email));
    expect(readdirSync(dir)).toEqual([path.basename(file)]); // the temporary file was renamed into place
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(scanLedger(dir, { now: NOW, isAlive: () => false }).stale).toEqual([{ file, account: entry }]);

    forgetEntry(file);
    expect(readdirSync(dir)).toEqual([]);
    expect(() => forgetEntry(file)).not.toThrow(); // already gone
  });

  it('refuses an address that is not a throwaway one, before writing anything', () => {
    expect(() => recordAccount(dir, { ...account(1, LIVE_PID, 0), email: 'owner@example.org' })).toThrow(/throwaway/);
    expect(scanLedger(dir)).toEqual({ stale: [], unreadable: [] });
  });
});

describe('scanLedger', () => {
  it('finds nothing in a folder that does not exist yet', () => {
    expect(scanLedger(path.join(root, 'missing'))).toEqual({ stale: [], unreadable: [] });
  });

  it('returns the entries of runs that are over, oldest first, and never a run still in progress', () => {
    const killed = account(1, DEAD_PID, 5); // its worker died five minutes ago
    const older = account(2, DEAD_PID, 30);
    const running = account(3, LIVE_PID, 2); // a concurrent run, still going
    const reused = account(4, LIVE_PID, STALE_AFTER_MS / 60_000 + 1); // old: the pid belongs to someone else by now
    for (const entry of [killed, older, running, reused]) recordAccount(dir, entry);

    const { stale, unreadable } = scanLedger(dir, { now: NOW, isAlive: alive });
    expect(stale.map((s) => s.account.email)).toEqual([reused.email, older.email, killed.email]);
    expect(stale.map((s) => s.file)).toEqual([reused, older, killed].map((e) => entryPath(dir, e.email)));
    expect(unreadable).toEqual([]);
  });

  it("leaves out this run's own entry, whatever its age", () => {
    const own = account(5, DEAD_PID, 120);
    recordAccount(dir, own);
    expect(scanLedger(dir, { now: NOW, isAlive: alive, except: own.email }).stale).toEqual([]);
  });

  it('lists files that are not a throwaway entry without touching them, and ignores stray temporary files', () => {
    mkdirSync(dir, { recursive: true });
    const bad = {
      'torn.json': '{"email":"momentum-qa-2-6@example.com","pass',
      'real-account.json': JSON.stringify({ ...account(7, DEAD_PID, 90), email: 'owner@example.org' }),
      'no-password.json': JSON.stringify({ ...account(8, DEAD_PID, 90), password: '' }),
      'bad-pid.json': JSON.stringify({ ...account(9, DEAD_PID, 90), pid: 0 }),
    };
    for (const [name, text] of Object.entries(bad)) writeFileSync(path.join(dir, name), text);
    mkdirSync(path.join(dir, 'folder.json'));
    // A worker killed between the write and the rename: never read (its account was not created yet).
    writeFileSync(path.join(dir, `${path.basename(entryPath(dir, throwawayEmail(10)))}.${DEAD_PID}.tmp`), '{}');

    const { stale, unreadable } = scanLedger(dir, { now: NOW, isAlive: alive });
    expect(stale).toEqual([]);
    expect(unreadable.map((f) => path.basename(f)).sort()).toEqual([
      'bad-pid.json',
      'folder.json',
      'no-password.json',
      'real-account.json',
      'torn.json',
    ]);
    expect(readdirSync(dir)).toHaveLength(6); // nothing deleted
  });
});

describe('parseEntry', () => {
  it('accepts exactly what recordAccount writes', () => {
    const entry = account(11, LIVE_PID, 0);
    expect(parseEntry(`${JSON.stringify(entry)}\n`)).toEqual(entry);
    expect(parseEntry(JSON.stringify({ ...entry, extra: true }))).toEqual(entry);
    expect(parseEntry('null')).toBeNull();
    expect(parseEntry('[]')).toBeNull();
    expect(parseEntry(JSON.stringify({ ...entry, recordedAt: 'yesterday' }))).toBeNull();
    expect(parseEntry(JSON.stringify({ ...entry, pid: 1.5 }))).toBeNull();
  });
});

describe('isProcessAlive', () => {
  it('sees this process, and not one that has exited', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    expect(child.pid).toBeGreaterThan(0);
    expect(isProcessAlive(child.pid)).toBe(false);
  });
});
