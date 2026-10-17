import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASELINE_KEY_PREFIX,
  clearAllBaselines,
  clearBaseline,
  clearOtherBaselines,
  hasSyncSession,
  readBaseline,
  setSyncSession,
  SYNC_SESSION_KEY,
  writeBaseline,
  type SyncBaseline,
} from '../sync/baseline';
import type { Habit, Task } from '../types';

/*
 * The engine's memory between launches. Written from validated store state, read back defensively: a
 * damaged record reads as "no baseline", which sends the engine down the first-contact union — the one
 * path that can never drop local data. Since phase 3 the record carries the tasks collection too; a v1
 * record (phase 2) reads with an empty tasks side.
 */

const habit = (id: string, over: Partial<Habit> = {}): Habit => ({
  id,
  name: id.toUpperCase(),
  emoji: '✓',
  color: 'sage',
  days: [0, 1, 2, 3, 4, 5, 6],
  createdAt: '2026-10-01',
  order: 0,
  ...over,
});

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  date: '2026-10-20',
  done: false,
  createdAt: '2026-10-17',
  ...over,
});

const EMPTY_TASKS = { tasks: [], deletedTaskIds: [] };

const baseline = (over: Partial<SyncBaseline> = {}): SyncBaseline => ({
  data: {
    habits: [habit('a', { note: 'n' }), habit('b', { order: 1, archivedAt: '2026-10-10' })],
    completions: { a: { '2026-10-05': true } },
    deletedIds: ['x'],
  },
  acked: ['a', 'b', 'x'],
  tasks: {
    tasks: [task('t1', { note: 'gym', time: '15:00' }), task('t2', { done: true, doneAt: '2026-10-21' })],
    deletedTaskIds: ['t9'],
  },
  ackedTasks: ['t1', 't2', 't9'],
  ...over,
});

/** The record as phase 2 wrote it: trackers only. */
const v1Record = (b: SyncBaseline = baseline()): string => JSON.stringify({ v: 1, data: b.data, acked: b.acked });

/** A stand-in for `globalThis.localStorage` (absent under node). */
function fakeLocalStorage(): Storage & { failWrites: boolean } {
  const mem = new Map<string, string>();
  const fake = {
    failWrites: false,
    get length() {
      return mem.size;
    },
    key: (i: number) => [...mem.keys()][i] ?? null,
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (fake.failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      mem.set(k, v);
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
  };
  return fake as Storage & { failWrites: boolean };
}

beforeEach(() => {
  clearAllBaselines();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('baseline storage', () => {
  it('round-trips per account, tasks side included, and clears per account or altogether', () => {
    writeBaseline('u1', baseline());
    writeBaseline('u2', baseline({ acked: ['a'], ackedTasks: [] }));
    expect(readBaseline('u1')).toEqual(baseline());
    expect(readBaseline('u2')?.acked).toEqual(['a']);
    expect(readBaseline('u2')?.ackedTasks).toEqual([]);
    expect(readBaseline('u3')).toBeNull();
    clearBaseline('u1');
    expect(readBaseline('u1')).toBeNull();
    expect(readBaseline('u2')).not.toBeNull();
    clearAllBaselines();
    expect(readBaseline('u2')).toBeNull();
  });

  it('uses localStorage when there is one, under a key the store does not use, and writes a v2 record', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    writeBaseline('u1', baseline());
    const raw = local.getItem(`${BASELINE_KEY_PREFIX}u1`);
    expect(raw).toContain('"acked"');
    expect(JSON.parse(raw ?? '{}')).toMatchObject({ v: 2, ackedTasks: ['t1', 't2', 't9'] });
    expect(local.getItem('momentum-v1')).toBeNull();
    expect(readBaseline('u1')).toEqual(baseline());
    local.setItem('momentum-v1', '{}');
    clearAllBaselines();
    expect(local.getItem(`${BASELINE_KEY_PREFIX}u1`)).toBeNull();
    expect(local.getItem('momentum-v1')).toBe('{}'); // only its own keys
  });

  it('a record written without a tasks side (phase-2 callers) saves and reads an empty one', () => {
    const b = baseline();
    writeBaseline('u1', { data: b.data, acked: b.acked });
    expect(readBaseline('u1')).toEqual({ data: b.data, acked: b.acked, tasks: EMPTY_TASKS, ackedTasks: [] });
  });

  it('a refused browser write keeps the in-memory copy for the session and logs once', () => {
    const local = fakeLocalStorage();
    local.failWrites = true;
    vi.stubGlobal('localStorage', local);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeBaseline('u1', baseline());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(readBaseline('u1')).toEqual(baseline());
  });

  it('a v1 record (saved before tasks existed) reads as a valid baseline with an empty tasks side', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    const good = baseline();
    local.setItem(`${BASELINE_KEY_PREFIX}u1`, v1Record(good));
    expect(readBaseline('u1')).toEqual({ data: good.data, acked: good.acked, tasks: EMPTY_TASKS, ackedTasks: [] });
    // Stray task fields on a v1 record are ignored: phase 2 never wrote any, so they say nothing.
    local.setItem(`${BASELINE_KEY_PREFIX}u1`, JSON.stringify({ v: 1, data: good.data, acked: good.acked, tasks: 'junk' }));
    expect(readBaseline('u1')?.tasks).toEqual(EMPTY_TASKS);
    // Once re-saved it is a v2 record.
    const read = readBaseline('u1') as SyncBaseline;
    writeBaseline('u1', read);
    expect(JSON.parse(local.getItem(`${BASELINE_KEY_PREFIX}u1`) ?? '{}')).toMatchObject({ v: 2, tasks: EMPTY_TASKS });
  });

  it('a damaged record reads as no baseline', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    const key = `${BASELINE_KEY_PREFIX}u1`;
    const good = baseline();
    const { tasks, ackedTasks } = good;
    const v2 = (over: Record<string, unknown>): string =>
      JSON.stringify({ v: 2, data: good.data, acked: good.acked, tasks, ackedTasks, ...over });
    const cases: unknown[] = [
      'not json',
      '[]',
      JSON.stringify({ v: 3, data: good.data, acked: good.acked, tasks, ackedTasks }),
      JSON.stringify({ v: 1, data: good.data }),
      JSON.stringify({ v: 1, data: good.data, acked: [7] }),
      JSON.stringify({ v: 1, data: { ...good.data, habits: [{ ...habit('a'), color: 'purple' }] }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, habits: [habit('a'), habit('a')] }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, completions: { zzz: { '2026-10-05': true } } }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, completions: { a: { nope: true } } }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, deletedIds: ['bad/id'] }, acked: [] }),
      // v2: the tasks side is required and strict.
      JSON.stringify({ v: 2, data: good.data, acked: good.acked }),
      v2({ ackedTasks: undefined }),
      v2({ ackedTasks: ['ok', 5] }),
      v2({ tasks: { tasks: [] } }),
      v2({ tasks: { tasks: 'x', deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [task('t', { title: '  ' })], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [task('t', { date: '2026-02-30' })], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [task('t', { time: '24:00' })], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [{ ...task('t'), done: 'yes' }], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [task('t', { doneAt: '2026-10-21' })], deletedTaskIds: [] } }), // doneAt while undone
      v2({ tasks: { tasks: [task('t', { done: true, doneAt: 'later' })], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [{ ...task('t'), note: 5 }], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [{ ...task('t'), createdAt: undefined }], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [task('t'), task('t')], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [task('bad/id')], deletedTaskIds: [] } }),
      v2({ tasks: { tasks: [], deletedTaskIds: ['bad/id'] } }),
    ];
    for (const raw of cases) {
      local.setItem(key, String(raw));
      expect(readBaseline('u1'), String(raw)).toBeNull();
    }
    local.setItem(key, JSON.stringify({ v: 2, ...good }));
    expect(readBaseline('u1')).toEqual(good);
  });

  it('de-duplicates the acknowledged ids and tombstones it reads back', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    const good = baseline();
    local.setItem(
      `${BASELINE_KEY_PREFIX}u1`,
      JSON.stringify({
        v: 2,
        data: { ...good.data, deletedIds: ['x', 'x'] },
        acked: ['a', 'a'],
        tasks: { tasks: [], deletedTaskIds: ['t9', 't9'] },
        ackedTasks: ['t9', 't9'],
      }),
    );
    const read = readBaseline('u1');
    expect(read?.data.deletedIds).toEqual(['x']);
    expect(read?.acked).toEqual(['a']);
    expect(read?.tasks.deletedTaskIds).toEqual(['t9']);
    expect(read?.ackedTasks).toEqual(['t9']);
  });

  it('never throws when storage is hostile', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('nope');
      },
      key: () => {
        throw new Error('nope');
      },
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
      removeItem: () => {
        throw new Error('nope');
      },
      clear: () => {},
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => writeBaseline('u1', baseline())).not.toThrow();
    expect(readBaseline('u1')).toEqual(baseline()); // the in-memory copy
    expect(() => clearBaseline('u1')).not.toThrow();
    expect(() => clearAllBaselines()).not.toThrow();
    expect(readBaseline('u1')).toBeNull();
  });
});

describe('clearOtherBaselines', () => {
  it("keeps the signing-in account's baseline and forgets every other, in storage and in memory", () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    writeBaseline('u1', baseline());
    writeBaseline('u2', baseline());
    local.setItem('momentum-v1', '{}');
    clearOtherBaselines('u1');
    expect(readBaseline('u1')).toEqual(baseline());
    expect(readBaseline('u2')).toBeNull();
    expect(local.getItem(`${BASELINE_KEY_PREFIX}u2`)).toBeNull();
    expect(local.getItem('momentum-v1')).toBe('{}');

    vi.unstubAllGlobals(); // no browser storage: the in-memory copies follow the same rule
    writeBaseline('u3', baseline());
    clearOtherBaselines('u3');
    expect(readBaseline('u1')).toBeNull();
    expect(readBaseline('u3')).toEqual(baseline());
  });
});

describe('the sync-session flag', () => {
  it('is absent on a device that has never signed in, then follows sign-in and sign-out', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    expect(hasSyncSession()).toBe(false);
    setSyncSession(true);
    expect(hasSyncSession()).toBe(true);
    expect(local.getItem(SYNC_SESSION_KEY)).toBe('1');
    setSyncSession(false);
    expect(hasSyncSession()).toBe(false);
    expect(local.getItem(SYNC_SESSION_KEY)).toBe('0');
  });

  it('a device that synced before the flag existed counts as signed in while it holds a baseline; a recorded answer wins', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    local.setItem(`${BASELINE_KEY_PREFIX}u1`, v1Record());
    expect(hasSyncSession()).toBe(true);
    local.setItem(SYNC_SESSION_KEY, '0'); // signed out since: the baseline kept for its offline edits does not count
    expect(hasSyncSession()).toBe(false);
  });

  it('is forgotten by "Reset this device", baselines and all', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    setSyncSession(true);
    writeBaseline('u1', baseline());
    clearAllBaselines();
    expect(local.getItem(SYNC_SESSION_KEY)).toBeNull();
    expect(hasSyncSession()).toBe(false);
  });

  it('answers from memory for the session when storage refuses, and never throws', () => {
    vi.stubGlobal('localStorage', {
      get length(): number {
        throw new Error('nope');
      },
      key: () => {
        throw new Error('nope');
      },
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
      removeItem: () => {
        throw new Error('nope');
      },
      clear: () => {},
    });
    expect(() => hasSyncSession()).not.toThrow();
    expect(hasSyncSession()).toBe(false);
    expect(() => setSyncSession(true)).not.toThrow();
    expect(hasSyncSession()).toBe(true);
    expect(() => clearOtherBaselines('u1')).not.toThrow();
    clearAllBaselines();
    expect(hasSyncSession()).toBe(false);
  });
});
