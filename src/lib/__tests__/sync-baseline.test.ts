import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASELINE_KEY_PREFIX,
  clearAllBaselines,
  clearBaseline,
  readBaseline,
  writeBaseline,
  type SyncBaseline,
} from '../sync/baseline';
import type { Habit } from '../types';

/*
 * The engine's memory between launches. Written from validated store state, read back defensively: a
 * damaged record reads as "no baseline", which sends the engine down the first-contact union — the one
 * path that can never drop local data.
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

const baseline = (over: Partial<SyncBaseline> = {}): SyncBaseline => ({
  data: {
    habits: [habit('a', { note: 'n' }), habit('b', { order: 1, archivedAt: '2026-10-10' })],
    completions: { a: { '2026-10-05': true } },
    deletedIds: ['x'],
  },
  acked: ['a', 'b', 'x'],
  ...over,
});

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
  it('round-trips per account and clears per account or altogether', () => {
    writeBaseline('u1', baseline());
    writeBaseline('u2', baseline({ acked: ['a'] }));
    expect(readBaseline('u1')).toEqual(baseline());
    expect(readBaseline('u2')?.acked).toEqual(['a']);
    expect(readBaseline('u3')).toBeNull();
    clearBaseline('u1');
    expect(readBaseline('u1')).toBeNull();
    expect(readBaseline('u2')).not.toBeNull();
    clearAllBaselines();
    expect(readBaseline('u2')).toBeNull();
  });

  it('uses localStorage when there is one, under a key the store does not use', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    writeBaseline('u1', baseline());
    expect(local.getItem(`${BASELINE_KEY_PREFIX}u1`)).toContain('"acked"');
    expect(local.getItem('momentum-v1')).toBeNull();
    expect(readBaseline('u1')).toEqual(baseline());
    local.setItem('momentum-v1', '{}');
    clearAllBaselines();
    expect(local.getItem(`${BASELINE_KEY_PREFIX}u1`)).toBeNull();
    expect(local.getItem('momentum-v1')).toBe('{}'); // only its own keys
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

  it('a damaged record reads as no baseline', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    const key = `${BASELINE_KEY_PREFIX}u1`;
    const good = baseline();
    const cases: unknown[] = [
      'not json',
      '[]',
      JSON.stringify({ v: 2, data: good.data, acked: good.acked }),
      JSON.stringify({ v: 1, data: good.data }),
      JSON.stringify({ v: 1, data: good.data, acked: [7] }),
      JSON.stringify({ v: 1, data: { ...good.data, habits: [{ ...habit('a'), color: 'purple' }] }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, habits: [habit('a'), habit('a')] }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, completions: { zzz: { '2026-10-05': true } } }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, completions: { a: { nope: true } } }, acked: [] }),
      JSON.stringify({ v: 1, data: { ...good.data, deletedIds: ['bad/id'] }, acked: [] }),
    ];
    for (const raw of cases) {
      local.setItem(key, String(raw));
      expect(readBaseline('u1'), String(raw)).toBeNull();
    }
    local.setItem(key, JSON.stringify({ v: 1, ...good }));
    expect(readBaseline('u1')).toEqual(good);
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
