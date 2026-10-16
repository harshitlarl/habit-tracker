import { describe, expect, it } from 'vitest';
import {
  diffForPush,
  mergeSnapshots,
  mergeWithBase,
  parseRemoteDoc,
  remoteToLocal,
  restoreTombstoned,
  sameCompletions,
  sameData,
  sameHabit,
} from '../sync/merge';
import type { LocalData, PushOp, RemoteHabit } from '../sync/types';
import { HABIT_COLORS, type Completions, type Habit, type Weekday } from '../types';

const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

const habit = (id: string, over: Partial<Habit> = {}): Habit => ({
  id,
  name: id.toUpperCase(),
  emoji: '✓',
  color: 'sage',
  days: [...EVERY_DAY],
  createdAt: '2026-10-01',
  order: 0,
  ...over,
});

const doc = (id: string, over: Partial<RemoteHabit> = {}): RemoteHabit => ({
  ...habit(id),
  completions: {},
  deleted: false,
  ...over,
});

const local = (habits: Habit[] = [], completions: Completions = {}, deletedIds: string[] = []): LocalData => ({
  habits,
  completions,
  deletedIds,
});

const dates = (...keys: string[]): Record<string, true> => Object.fromEntries(keys.map((k) => [k, true as const]));

/** A raw Firestore document as the engine writes it. */
const rawDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a',
  name: 'Gym',
  emoji: '🏋️',
  color: 'terracotta',
  days: [0, 2, 4],
  createdAt: '2026-10-01',
  order: 0,
  completions: { '2026-10-05': true, '2026-10-07': true },
  deleted: false,
  updatedAt: { seconds: 1_760_000_000, nanoseconds: 0 },
  ...over,
});

/** rawDoc() with one key removed — "missing" rather than "undefined". */
const without = (key: string, over: Record<string, unknown> = {}): Record<string, unknown> => {
  const d = rawDoc(over);
  delete d[key];
  return d;
};

/** The parsed form of rawDoc(). */
const parsedDoc = (over: Partial<RemoteHabit> = {}): RemoteHabit => ({
  id: 'a',
  name: 'Gym',
  emoji: '🏋️',
  color: 'terracotta',
  days: [0, 2, 4],
  createdAt: '2026-10-01',
  order: 0,
  completions: dates('2026-10-05', '2026-10-07'),
  deleted: false,
  updatedAt: { seconds: 1_760_000_000, nanoseconds: 0 },
  ...over,
});

/**
 * A tiny model of the engine's writes (SPEC §13.5 step 4) against a collection, used to check that
 * toPush really makes the cloud converge to `merged`. It insists on the op order the engine relies on:
 * a completion write before the tracker exists would leave a field-less document behind.
 */
function applyOps(remote: readonly RemoteHabit[], ops: readonly PushOp[]): RemoteHabit[] {
  const docs = new Map<string, RemoteHabit>(remote.map((d) => [d.id, { ...d, completions: { ...d.completions } }]));
  for (const op of ops) {
    switch (op.type) {
      case 'setHabit': {
        const existing = docs.get(op.habit.id);
        docs.set(op.habit.id, { ...op.habit, completions: existing?.completions ?? {}, deleted: existing?.deleted ?? false });
        break;
      }
      case 'addCompletion': {
        const existing = docs.get(op.habitId);
        if (!existing) throw new Error(`addCompletion for ${op.habitId} before its setHabit`);
        existing.completions[op.dateKey] = true;
        break;
      }
      case 'removeCompletion': {
        const existing = docs.get(op.habitId);
        if (existing) delete existing.completions[op.dateKey];
        break;
      }
      case 'tombstone': {
        const existing = docs.get(op.habitId);
        const bare = parseRemoteDoc(op.habitId, { deleted: true });
        if (!bare) throw new Error('a bare tombstone must parse');
        docs.set(op.habitId, existing ? { ...existing, deleted: true } : bare);
        break;
      }
    }
  }
  return [...docs.values()];
}

/** Runs the first-contact merge, pushes, and checks both sides agree and a second round is a no-op. */
function mergeAndConverge(before: LocalData, remote: readonly RemoteHabit[]) {
  const localSnapshot = JSON.stringify(before);
  const remoteSnapshot = JSON.stringify(remote);
  const result = mergeSnapshots(before, remote);
  expect(JSON.stringify(before)).toBe(localSnapshot); // inputs are never mutated
  expect(JSON.stringify(remote)).toBe(remoteSnapshot);

  const cloud = applyOps(remote, result.toPush);
  const after = remoteToLocal(cloud);
  expect(after.habits).toEqual(result.merged.habits);
  expect(after.completions).toEqual(result.merged.completions);
  // The cloud never learns tombstones for ids it has not seen, so it may know fewer, never more.
  expect(result.merged.deletedIds).toEqual(expect.arrayContaining(after.deletedIds));

  const again = mergeSnapshots(result.merged, cloud);
  expect(again.toPush).toEqual([]);
  expect(sameData(again.merged, result.merged)).toBe(true);
  return { ...result, cloud };
}

const ofType = (ops: readonly PushOp[], type: PushOp['type']): PushOp[] => ops.filter((op) => op.type === type);

describe('parseRemoteDoc', () => {
  it('accepts a well-formed document and drops unknown keys', () => {
    const parsed = parseRemoteDoc('a', rawDoc({ extra: 'ignored', nested: { deep: true } }));
    expect(parsed).toEqual(parsedDoc());
    expect(Object.keys(parsed ?? {}).sort()).toEqual(
      ['color', 'completions', 'createdAt', 'days', 'deleted', 'emoji', 'id', 'name', 'order', 'updatedAt'].sort(),
    );
    expect(parsed).not.toHaveProperty('extra');
    expect(parsed).not.toHaveProperty('note');
    expect(parsed).not.toHaveProperty('archivedAt');
  });

  it('keeps note and archivedAt when present and valid', () => {
    const parsed = parseRemoteDoc('a', rawDoc({ note: '  2 hours ', archivedAt: '2026-10-10' }));
    expect(parsed?.note).toBe('2 hours');
    expect(parsed?.archivedAt).toBe('2026-10-10');
  });

  it('uses the document id when the id field is absent or null, and rejects a disagreeing one', () => {
    expect(parseRemoteDoc('a', without('id'))?.id).toBe('a');
    expect(parseRemoteDoc('a', rawDoc({ id: null }))?.id).toBe('a');
    expect(parseRemoteDoc('a', rawDoc({ id: 'b' }))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ id: 1 }))).toBeNull();
  });

  it('rejects unusable ids and non-object data', () => {
    for (const id of ['', '   ', '__proto__', 'constructor', 'prototype']) {
      expect(parseRemoteDoc(id, without('id'))).toBeNull();
    }
    for (const data of [null, undefined, [], 'gym', 5, true, () => rawDoc()]) {
      expect(parseRemoteDoc('a', data)).toBeNull();
    }
  });

  it('name must be a non-blank string; it is trimmed and capped at 40 characters', () => {
    expect(parseRemoteDoc('a', without('name'))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ name: '   ' }))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ name: 7 }))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ name: null }))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ name: '  Morning run  ' }))?.name).toBe('Morning run');
    expect(parseRemoteDoc('a', rawDoc({ name: 'n'.repeat(41) }))?.name).toBe('n'.repeat(40));
    expect(parseRemoteDoc('a', rawDoc({ name: `  ${'n'.repeat(45)}` }))?.name).toBe('n'.repeat(40));
  });

  it('emoji must be a string; it is trimmed and capped at 16 UTF-16 units', () => {
    expect(parseRemoteDoc('a', without('emoji'))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ emoji: 1 }))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ emoji: '' }))?.emoji).toBe('');
    expect(parseRemoteDoc('a', rawDoc({ emoji: ' 📚 ' }))?.emoji).toBe('📚');
    expect(parseRemoteDoc('a', rawDoc({ emoji: '🏋️'.repeat(6) }))?.emoji).toHaveLength(16);
  });

  it('colour must be one of HABIT_COLORS', () => {
    for (const color of HABIT_COLORS) expect(parseRemoteDoc('a', rawDoc({ color }))?.color).toBe(color);
    expect(parseRemoteDoc('a', rawDoc({ color: 'purple' }))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ color: 1 }))).toBeNull();
    expect(parseRemoteDoc('a', without('color'))).toBeNull();
  });

  it('note is optional: absent, null or blank means none; wrong types make the doc unusable', () => {
    expect(parseRemoteDoc('a', without('note'))).not.toHaveProperty('note');
    expect(parseRemoteDoc('a', rawDoc({ note: null }))).not.toHaveProperty('note');
    expect(parseRemoteDoc('a', rawDoc({ note: '   ' }))).not.toHaveProperty('note');
    expect(parseRemoteDoc('a', rawDoc({ note: 'y'.repeat(41) }))?.note).toBe('y'.repeat(40));
    expect(parseRemoteDoc('a', rawDoc({ note: 5 }))).toBeNull();
    expect(parseRemoteDoc('a', rawDoc({ note: ['x'] }))).toBeNull();
  });

  it('days must be a non-empty list of integers 0–6, returned unique and ascending', () => {
    expect(parseRemoteDoc('a', rawDoc({ days: [4, 0, 4, 2] }))?.days).toEqual([0, 2, 4]);
    expect(parseRemoteDoc('a', rawDoc({ days: [6] }))?.days).toEqual([6]);
    for (const days of [undefined, null, [], [7], [-1], [1.5], ['1'], 'mon', { 0: true }, [0, null]]) {
      expect(parseRemoteDoc('a', rawDoc({ days }))).toBeNull();
    }
  });

  it('createdAt must be a real calendar date; archivedAt too when present (null counts as absent)', () => {
    for (const createdAt of [undefined, null, 'yesterday', '2026-02-30', '2026-10-1', '2026-10-01T00:00:00.000Z', 20261001]) {
      expect(parseRemoteDoc('a', rawDoc({ createdAt }))).toBeNull();
    }
    expect(parseRemoteDoc('a', rawDoc({ archivedAt: null }))).not.toHaveProperty('archivedAt');
    expect(parseRemoteDoc('a', rawDoc({ archivedAt: '2026-10-10' }))?.archivedAt).toBe('2026-10-10');
    for (const archivedAt of ['2026/10/10', '2026-02-30', '', 1]) {
      expect(parseRemoteDoc('a', rawDoc({ archivedAt }))).toBeNull();
    }
  });

  it('order defaults to 0 when missing or null, keeps any finite number and rejects the rest', () => {
    expect(parseRemoteDoc('a', without('order'))?.order).toBe(0);
    expect(parseRemoteDoc('a', rawDoc({ order: null }))?.order).toBe(0);
    expect(parseRemoteDoc('a', rawDoc({ order: 7 }))?.order).toBe(7);
    expect(parseRemoteDoc('a', rawDoc({ order: 2.5 }))?.order).toBe(2.5);
    expect(parseRemoteDoc('a', rawDoc({ order: -1 }))?.order).toBe(-1);
    for (const order of ['1', Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
      expect(parseRemoteDoc('a', rawDoc({ order }))).toBeNull();
    }
  });

  it('completions keep only true-valued real dates; anything else is dropped, never fatal', () => {
    const parsed = parseRemoteDoc(
      'a',
      rawDoc({
        completions: {
          '2026-10-05': true,
          '2026-10-06': false,
          '2026-10-07': 1,
          '2026-10-08': 'true',
          '2026-02-30': true,
          '2026-10-9': true,
          today: true,
          __proto__: true,
          '2026-10-10': true,
        },
      }),
    );
    expect(parsed?.completions).toEqual(dates('2026-10-05', '2026-10-10'));
    for (const completions of [undefined, null, [], 'done', 3]) {
      expect(parseRemoteDoc('a', rawDoc({ completions }))?.completions).toEqual({});
    }
  });

  it('deleted defaults to false and is only true for boolean true', () => {
    expect(parseRemoteDoc('a', without('deleted'))?.deleted).toBe(false);
    expect(parseRemoteDoc('a', rawDoc({ deleted: null }))?.deleted).toBe(false);
    expect(parseRemoteDoc('a', rawDoc({ deleted: 'yes' }))?.deleted).toBe(false);
    expect(parseRemoteDoc('a', rawDoc({ deleted: 1 }))?.deleted).toBe(false);
    expect(parseRemoteDoc('a', rawDoc({ deleted: true }))?.deleted).toBe(true);
  });

  it('updatedAt passes through opaquely and stays absent when missing or null', () => {
    const stamp = { toMillis: () => 1 };
    expect(parseRemoteDoc('a', rawDoc({ updatedAt: stamp }))?.updatedAt).toBe(stamp);
    expect(parseRemoteDoc('a', without('updatedAt'))).not.toHaveProperty('updatedAt');
    expect(parseRemoteDoc('a', rawDoc({ updatedAt: null }))).not.toHaveProperty('updatedAt');
  });

  it('a deleted document keeps its fields, and a bare tombstone still parses as a tombstone', () => {
    const full = parseRemoteDoc('a', rawDoc({ deleted: true }));
    expect(full).toEqual(parsedDoc({ deleted: true }));

    const bare = parseRemoteDoc('gone', { deleted: true, updatedAt: 'ts' });
    expect(bare).toMatchObject({ id: 'gone', deleted: true, completions: {}, updatedAt: 'ts' });
    expect(typeof bare?.name).toBe('string');
    expect(bare?.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(remoteToLocal(bare ? [bare] : [])).toEqual({ habits: [], completions: {}, deletedIds: ['gone'] });

    // Without the tombstone flag the same field-less document is simply unusable.
    expect(parseRemoteDoc('gone', { deleted: false, updatedAt: 'ts' })).toBeNull();
    expect(parseRemoteDoc('gone', { updatedAt: 'ts' })).toBeNull();
    // A tombstone whose remaining fields are damaged is still a tombstone — the id is all that matters.
    expect(parseRemoteDoc('a', rawDoc({ deleted: true, color: 'purple', days: [] }))?.deleted).toBe(true);
  });

  it('never throws on arbitrary input', () => {
    // An exotic object in place of the completions map is just an empty map, not a broken document.
    expect(parseRemoteDoc('a', { ...rawDoc(), completions: new Map([['2026-10-05', true]]) })?.completions).toEqual({});
    const weird: unknown[] = [
      Object.create(null) as unknown,
      { ...rawDoc(), days: 'everyday' },
      { ...rawDoc(), name: Symbol('x') },
      { ...rawDoc(), createdAt: new Date() },
      { ...rawDoc(), days: [0, [1], { 2: 3 }] },
      JSON.parse('{"__proto__": {"polluted": true}, "name": "x"}') as unknown,
      new Date(),
      Symbol('doc'),
      123n,
    ];
    for (const data of weird) {
      expect(() => parseRemoteDoc('a', data)).not.toThrow();
      expect(parseRemoteDoc('a', data)).toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('remoteToLocal', () => {
  it('maps an empty collection to empty data', () => {
    expect(remoteToLocal([])).toEqual({ habits: [], completions: {}, deletedIds: [] });
  });

  it('strips completions/deleted/updatedAt, keeps true-valued dates, omits empty sets, lists tombstones', () => {
    const remote: RemoteHabit[] = [
      doc('b', { order: 1, completions: dates('2026-10-05', '2026-10-06'), updatedAt: 'ts' }),
      doc('a', { order: 0, note: '2 hours', archivedAt: '2026-10-10', completions: {} }),
      doc('gone', { order: 2, deleted: true, completions: dates('2026-10-01') }),
      doc('c', { order: 2, completions: { '2026-10-07': true, '2026-10-08': false as unknown as true } }),
    ];
    const result = remoteToLocal(remote);
    expect(result.habits.map((h) => h.id)).toEqual(['a', 'b', 'c']);
    expect(result.habits[0]).toEqual(habit('a', { order: 0, note: '2 hours', archivedAt: '2026-10-10' }));
    expect(result.habits[1]).toEqual(habit('b', { order: 1 }));
    for (const h of result.habits) {
      expect(h).not.toHaveProperty('completions');
      expect(h).not.toHaveProperty('deleted');
      expect(h).not.toHaveProperty('updatedAt');
    }
    expect(result.completions).toEqual({ b: dates('2026-10-05', '2026-10-06'), c: dates('2026-10-07') });
    expect(result.deletedIds).toEqual(['gone']);
  });

  it('sorts by order, then createdAt, then id, without re-numbering', () => {
    const remote = [
      doc('z', { order: 5, createdAt: '2026-10-01' }),
      doc('y', { order: 5, createdAt: '2026-09-01' }),
      doc('b', { order: 5, createdAt: '2026-10-01' }),
      doc('a', { order: 9 }),
      doc('m', { order: -1 }),
    ];
    expect(remoteToLocal(remote).habits.map((h) => [h.id, h.order])).toEqual([
      ['m', -1],
      ['y', 5],
      ['b', 5],
      ['z', 5],
      ['a', 9],
    ]);
  });

  it('a tombstone wins over a live document with the same id', () => {
    const result = remoteToLocal([doc('a', { completions: dates('2026-10-05') }), doc('a', { deleted: true })]);
    expect(result).toEqual({ habits: [], completions: {}, deletedIds: ['a'] });
  });

  it('returns fresh objects: editing the result does not touch the documents', () => {
    const remote = [doc('a', { completions: dates('2026-10-05') })];
    const result = remoteToLocal(remote);
    result.habits[0]!.days.push(0);
    result.completions.a!['2026-10-09'] = true;
    expect(remote[0]!.days).toEqual(EVERY_DAY);
    expect(remote[0]!.completions).toEqual(dates('2026-10-05'));
  });

  it('agrees with the store after a round trip, so an echoed snapshot compares equal', () => {
    const data = local(
      [habit('a', { order: 0 }), habit('b', { order: 1, note: 'x' })],
      { a: dates('2026-10-05') },
      ['old'],
    );
    const cloud = applyOps([], diffForPush(local(), data));
    expect(sameData(remoteToLocal(cloud), data)).toBe(true);
  });
});

describe('mergeSnapshots', () => {
  it('two empty sides produce nothing', () => {
    expect(mergeSnapshots(local(), [])).toEqual({ merged: { habits: [], completions: {}, deletedIds: [] }, toPush: [] });
  });

  it('local only: everything is pushed, the tracker before its completions', () => {
    const a = habit('a', { order: 0 });
    const b = habit('b', { order: 1, note: 'n', archivedAt: '2026-10-10' });
    const { merged, toPush } = mergeAndConverge(local([b, a], { a: dates('2026-10-05', '2026-10-06') }), []);
    expect(merged).toEqual({ habits: [a, b], completions: { a: dates('2026-10-05', '2026-10-06') }, deletedIds: [] });
    expect(toPush).toEqual([
      { type: 'setHabit', habit: a },
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-05' },
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-06' },
      { type: 'setHabit', habit: b },
    ]);
  });

  it('remote only: the cloud is adopted as is, nothing is pushed', () => {
    const remote = [
      doc('b', { order: 4, completions: dates('2026-10-05') }),
      doc('a', { order: 1 }),
      doc('gone', { deleted: true }),
    ];
    const { merged, toPush } = mergeAndConverge(local(), remote);
    expect(toPush).toEqual([]);
    expect(merged).toEqual(remoteToLocal(remote));
    expect(merged.habits.map((h) => h.order)).toEqual([1, 4]); // gaps are not re-numbered
    expect(merged.deletedIds).toEqual(['gone']);
  });

  it('both sides: remote fields win, completions are unioned, only the missing dates are pushed', () => {
    const mine = habit('a', { name: 'Gym (local)', color: 'rose', order: 0, note: 'mine' });
    const theirs = doc('a', {
      name: 'Gym',
      color: 'terracotta',
      order: 0,
      archivedAt: '2026-10-12',
      completions: dates('2026-10-05', '2026-10-06'),
      updatedAt: 'ts',
    });
    const { merged, toPush } = mergeAndConverge(local([mine], { a: dates('2026-10-06', '2026-10-07') }), [theirs]);
    expect(merged.habits).toEqual([habit('a', { name: 'Gym', color: 'terracotta', order: 0, archivedAt: '2026-10-12' })]);
    expect(merged.habits[0]).not.toHaveProperty('note');
    expect(merged.completions).toEqual({ a: dates('2026-10-05', '2026-10-06', '2026-10-07') });
    expect(toPush).toEqual([{ type: 'addCompletion', habitId: 'a', dateKey: '2026-10-07' }]);
  });

  it('identical sides push nothing', () => {
    const a = habit('a', { order: 0, note: 'n' });
    const b = habit('b', { order: 1 });
    const data = local([a, b], { a: dates('2026-10-05') }, ['gone']);
    const remote = [doc('a', { ...a, completions: dates('2026-10-05') }), doc('b', b), doc('gone', { deleted: true })];
    const { merged, toPush } = mergeAndConverge(data, remote);
    expect(toPush).toEqual([]);
    expect(sameData(merged, data)).toBe(true);
  });

  it('a local tombstone removes a live cloud tracker and is pushed', () => {
    const keep = habit('k', { order: 1 });
    const remote = [doc('a', { completions: dates('2026-10-05') }), doc('k', { ...keep })];
    const { merged, toPush } = mergeAndConverge(local([keep], { a: dates('2026-10-06') }, ['a']), remote);
    expect(merged.habits).toEqual([keep]);
    expect(merged.completions).toEqual({});
    expect(merged.deletedIds).toEqual(['a']);
    expect(toPush).toEqual([{ type: 'tombstone', habitId: 'a' }]);
  });

  it('a local tombstone for an id the cloud has never seen is kept locally but not pushed', () => {
    const { merged, toPush } = mergeAndConverge(local([habit('a')], {}, ['never-synced']), [doc('a')]);
    expect(toPush).toEqual([]);
    expect(merged.deletedIds).toEqual(['never-synced']);
  });

  it('a local tombstone for a cloud tombstone is a no-op', () => {
    const { merged, toPush } = mergeAndConverge(local([], {}, ['a']), [doc('a', { deleted: true })]);
    expect(toPush).toEqual([]);
    expect(merged).toEqual({ habits: [], completions: {}, deletedIds: ['a'] });
  });

  it('a cloud tombstone wins over a live local tracker and nothing of it is pushed', () => {
    const a = habit('a', { order: 0 });
    const b = habit('b', { order: 1 });
    const { merged, toPush } = mergeAndConverge(
      local([a, b], { a: dates('2026-10-05'), b: dates('2026-10-05') }),
      [doc('a', { deleted: true, completions: dates('2026-10-01') })],
    );
    expect(merged.habits).toEqual([b]);
    expect(merged.completions).toEqual({ b: dates('2026-10-05') });
    expect(merged.deletedIds).toEqual(['a']);
    expect(toPush).toEqual([
      { type: 'setHabit', habit: b },
      { type: 'addCompletion', habitId: 'b', dateKey: '2026-10-05' },
    ]);
  });

  it('a tracker that is both live and tombstoned locally is treated as deleted', () => {
    const { merged, toPush } = mergeAndConverge(local([habit('a')], { a: dates('2026-10-05') }, ['a']), [doc('a')]);
    expect(merged).toEqual({ habits: [], completions: {}, deletedIds: ['a'] });
    expect(toPush).toEqual([{ type: 'tombstone', habitId: 'a' }]);
  });

  it('tombstones from both sides are unioned, deduplicated, and still win', () => {
    const { merged } = mergeAndConverge(
      local([habit('x'), habit('y')], {}, ['x', 'q', 'q']),
      [doc('y', { deleted: true }), doc('z', { deleted: true }), doc('w')],
    );
    expect([...merged.deletedIds].sort()).toEqual(['q', 'x', 'y', 'z']);
    expect(merged.habits.map((h) => h.id)).toEqual(['w']);
  });

  it('colliding orders are re-numbered 0..n-1 by order, createdAt, id — and the fix is pushed', () => {
    const a = habit('a', { order: 0, createdAt: '2026-09-01' });
    const b = habit('b', { order: 1, createdAt: '2026-10-02' }); // local-only, collides with c
    const c = doc('c', { order: 1, createdAt: '2026-10-01' }); // remote, created earlier → wins the tie
    const d = doc('d', { order: 1, createdAt: '2026-10-02' }); // same createdAt as b → id decides
    const { merged, toPush } = mergeAndConverge(local([a, b]), [doc('a', { ...a }), c, d]);
    expect(merged.habits.map((h) => [h.id, h.order])).toEqual([
      ['a', 0],
      ['c', 1],
      ['b', 2],
      ['d', 3],
    ]);
    expect(toPush).toEqual([
      { type: 'setHabit', habit: { ...b, order: 2 } },
      { type: 'setHabit', habit: habit('d', { order: 3, createdAt: '2026-10-02' }) },
    ]);
  });

  it('keeps orders untouched when they are distinct, however sparse', () => {
    const { merged, toPush } = mergeAndConverge(local([habit('b', { order: 10 })]), [doc('a', { order: 3 }), doc('c', { order: 7 })]);
    expect(merged.habits.map((h) => [h.id, h.order])).toEqual([
      ['a', 3],
      ['c', 7],
      ['b', 10],
    ]);
    expect(toPush).toEqual([{ type: 'setHabit', habit: habit('b', { order: 10 }) }]);
  });

  it('a renumbered remote tracker keeps its other fields, including completions', () => {
    const remote = [doc('a', { order: 0, note: 'keep', completions: dates('2026-10-05') }), doc('b', { order: 0 })];
    const { merged, toPush } = mergeAndConverge(local(), remote);
    expect(merged.habits).toEqual([habit('a', { order: 0, note: 'keep' }), habit('b', { order: 1 })]);
    expect(merged.completions).toEqual({ a: dates('2026-10-05') });
    expect(toPush).toEqual([{ type: 'setHabit', habit: habit('b', { order: 1 }) }]);
  });

  it('completions of a surviving tracker are unioned even when the cloud copy has none', () => {
    const { merged, toPush } = mergeAndConverge(local([habit('a')], { a: dates('2026-10-05') }), [doc('a')]);
    expect(merged.completions).toEqual({ a: dates('2026-10-05') });
    expect(toPush).toEqual([{ type: 'addCompletion', habitId: 'a', dateKey: '2026-10-05' }]);
  });

  it('a larger, mixed scenario converges', () => {
    const before = local(
      [
        habit('shared', { order: 0, name: 'Old name' }),
        habit('mine', { order: 1 }),
        habit('deleted-there', { order: 2 }),
        habit('zombie', { order: 3 }),
      ],
      {
        shared: dates('2026-10-01', '2026-10-02'),
        mine: dates('2026-10-03'),
        'deleted-there': dates('2026-10-04'),
        zombie: dates('2026-10-05'),
      },
      ['zombie', 'deleted-here', 'unknown'],
    );
    const remote = [
      doc('shared', { order: 0, name: 'New name', completions: dates('2026-10-02', '2026-10-06') }),
      doc('theirs', { order: 1, completions: dates('2026-10-07') }),
      doc('deleted-there', { order: 2, deleted: true }),
      doc('deleted-here', { order: 5, completions: dates('2026-10-08') }),
    ];
    const { merged, toPush } = mergeAndConverge(before, remote);
    expect(merged.habits.map((h) => [h.id, h.order, h.name])).toEqual([
      ['shared', 0, 'New name'],
      ['mine', 1, 'MINE'],
      ['theirs', 2, 'THEIRS'],
    ]);
    expect(merged.completions).toEqual({
      shared: dates('2026-10-01', '2026-10-02', '2026-10-06'),
      mine: dates('2026-10-03'),
      theirs: dates('2026-10-07'),
    });
    expect([...merged.deletedIds].sort()).toEqual(['deleted-here', 'deleted-there', 'unknown', 'zombie']);
    expect(ofType(toPush, 'tombstone')).toEqual([{ type: 'tombstone', habitId: 'deleted-here' }]);
    expect(ofType(toPush, 'setHabit').map((op) => (op.type === 'setHabit' ? op.habit.id : ''))).toEqual(['mine', 'theirs']);
    expect(ofType(toPush, 'addCompletion')).toEqual([
      { type: 'addCompletion', habitId: 'shared', dateKey: '2026-10-01' },
      { type: 'addCompletion', habitId: 'mine', dateKey: '2026-10-03' },
    ]);
    expect(ofType(toPush, 'removeCompletion')).toEqual([]);
  });
});

describe('diffForPush', () => {
  const a = habit('a', { order: 0, note: 'n' });
  const b = habit('b', { order: 1 });
  const base = local([a, b], { a: dates('2026-10-05', '2026-10-06') }, ['gone']);

  it('is empty for identical data, for equal copies, and for a mere reordering of the array', () => {
    expect(diffForPush(base, base)).toEqual([]);
    const copy = JSON.parse(JSON.stringify(base)) as LocalData;
    expect(diffForPush(base, copy)).toEqual([]);
    const reordered = local([b, { ...a }], { a: { ...base.completions.a } }, ['gone']);
    expect(diffForPush(base, reordered)).toEqual([]);
    expect(sameData(base, reordered)).toBe(false); // sameData is stricter than the diff needs to be
  });

  it('pushes an added tracker and its completions, the tracker first', () => {
    const c = habit('c', { order: 2 });
    const next = local([a, b, c], { ...base.completions, c: dates('2026-10-07', '2026-10-08') }, ['gone']);
    expect(diffForPush(base, next)).toEqual([
      { type: 'setHabit', habit: c },
      { type: 'addCompletion', habitId: 'c', dateKey: '2026-10-07' },
      { type: 'addCompletion', habitId: 'c', dateKey: '2026-10-08' },
    ]);
  });

  it('pushes one setHabit per edited tracker, by field comparison, never identity', () => {
    const renamed = { ...a, name: 'Renamed', emoji: '🏃' };
    const archived = { ...b, archivedAt: '2026-10-16' };
    const next = local([renamed, archived], base.completions, base.deletedIds);
    expect(diffForPush(base, next)).toEqual([
      { type: 'setHabit', habit: renamed },
      { type: 'setHabit', habit: archived },
    ]);
    const clone = local([{ ...a, days: [...a.days] }, { ...b }], base.completions, base.deletedIds);
    expect(diffForPush(base, clone)).toEqual([]);
  });

  it('a cleared note, a restored tracker and a changed order are field changes too', () => {
    const { note: _note, ...noNote } = a;
    void _note;
    const next = local([noNote, { ...b, order: 5 }], base.completions, base.deletedIds);
    expect(diffForPush(base, next)).toEqual([
      { type: 'setHabit', habit: noNote },
      { type: 'setHabit', habit: { ...b, order: 5 } },
    ]);
    const archivedBase = local([{ ...a, archivedAt: '2026-10-10' }], {}, []);
    expect(diffForPush(archivedBase, local([a], {}, []))).toEqual([{ type: 'setHabit', habit: a }]);
  });

  it('pushes completion adds and removes per date key', () => {
    const next = local([a, b], { a: dates('2026-10-06', '2026-10-09'), b: dates('2026-10-01') }, ['gone']);
    expect(diffForPush(base, next)).toEqual([
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-09' },
      { type: 'removeCompletion', habitId: 'a', dateKey: '2026-10-05' },
      { type: 'addCompletion', habitId: 'b', dateKey: '2026-10-01' },
    ]);
    const emptied = local([a, b], {}, ['gone']);
    expect(diffForPush(base, emptied)).toEqual([
      { type: 'removeCompletion', habitId: 'a', dateKey: '2026-10-05' },
      { type: 'removeCompletion', habitId: 'a', dateKey: '2026-10-06' },
    ]);
  });

  it('pushes a tombstone for a newly deleted tracker and nothing else about it', () => {
    const next = local([b], {}, ['gone', 'a']);
    expect(diffForPush(base, next)).toEqual([{ type: 'tombstone', habitId: 'a' }]);
    expect(diffForPush(next, next)).toEqual([]);
    // Tombstones only learned about (never-seen ids) are pushed too, once, deduplicated.
    expect(diffForPush(base, local([a, b], base.completions, ['gone', 'x', 'x']))).toEqual([{ type: 'tombstone', habitId: 'x' }]);
  });

  it('a tracker removed without a tombstone produces no op, and its completions are left alone', () => {
    const next = local([b], {}, ['gone']);
    expect(diffForPush(base, next)).toEqual([]);
  });

  it('ignores completions of trackers that are not present in next', () => {
    const next = local([b], { a: dates('2026-10-05', '2026-10-06', '2026-10-07'), b: {} }, ['gone']);
    expect(diffForPush(base, next)).toEqual([]);
  });

  it('a tracker that is present but tombstoned in next only gets the tombstone', () => {
    const next = local([a, b], base.completions, ['gone', 'a']);
    expect(diffForPush(base, next)).toEqual([{ type: 'tombstone', habitId: 'a' }]);
  });

  it('a tombstone that disappears from next produces no op (tombstones are never retracted)', () => {
    expect(diffForPush(base, local([a, b], base.completions, []))).toEqual([]);
  });

  it('starting from nothing pushes everything, and the model cloud then reads back equal', () => {
    const ops = diffForPush(local(), base);
    expect(ops).toEqual([
      { type: 'setHabit', habit: a },
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-05' },
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-06' },
      { type: 'setHabit', habit: b },
      { type: 'tombstone', habitId: 'gone' },
    ]);
    expect(sameData(remoteToLocal(applyOps([], ops)), base)).toBe(true);
  });

  it('does not mutate its inputs', () => {
    const prev = JSON.stringify(base);
    const next = local([{ ...a, name: 'x' }], { a: dates('2026-10-01') }, ['gone', 'b']);
    const snapshot = JSON.stringify(next);
    diffForPush(base, next);
    expect(JSON.stringify(base)).toBe(prev);
    expect(JSON.stringify(next)).toBe(snapshot);
  });
});

describe('sameHabit / sameCompletions / sameData', () => {
  it('sameHabit compares fields, treats an undefined note/archivedAt as absent, and is order-sensitive for days', () => {
    const a = habit('a');
    expect(sameHabit(a, { ...a })).toBe(true);
    expect(sameHabit(a, { ...a, note: undefined, archivedAt: undefined })).toBe(true);
    expect(sameHabit(a, { ...a, note: '' })).toBe(false);
    expect(sameHabit(a, { ...a, days: [...EVERY_DAY].reverse() })).toBe(false);
    expect(sameHabit(a, { ...a, days: [0] })).toBe(false);
    for (const patch of [{ id: 'b' }, { name: 'B' }, { emoji: 'x' }, { color: 'rose' as const }, { createdAt: '2026-10-02' }, { order: 1 }, { archivedAt: '2026-10-10' }]) {
      expect(sameHabit(a, { ...a, ...patch })).toBe(false);
    }
  });

  it('sameCompletions ignores key order, treats an empty set as missing, and compares every habit', () => {
    expect(sameCompletions({ a: dates('2026-10-05', '2026-10-06') }, { a: dates('2026-10-06', '2026-10-05') })).toBe(true);
    expect(sameCompletions({ a: {} }, {})).toBe(true);
    expect(sameCompletions({}, { a: {} })).toBe(true);
    expect(sameCompletions({ a: dates('2026-10-05') }, {})).toBe(false);
    expect(sameCompletions({ a: dates('2026-10-05') }, { a: dates('2026-10-06') })).toBe(false);
    expect(sameCompletions({ a: dates('2026-10-05') }, { b: dates('2026-10-05') })).toBe(false);
  });

  it('sameData is order-sensitive for habits, order-insensitive for tombstones, and ignores identity', () => {
    const a = habit('a');
    const b = habit('b', { order: 1 });
    const x = local([a, b], { a: dates('2026-10-05') }, ['p', 'q']);
    expect(sameData(x, JSON.parse(JSON.stringify(x)) as LocalData)).toBe(true);
    expect(sameData(x, local([a, b], { a: dates('2026-10-05') }, ['q', 'p', 'p']))).toBe(true);
    expect(sameData(x, local([b, a], x.completions, x.deletedIds))).toBe(false);
    expect(sameData(x, local([a], x.completions, x.deletedIds))).toBe(false);
    expect(sameData(x, local([a, b], {}, x.deletedIds))).toBe(false);
    expect(sameData(x, local([a, b], x.completions, ['p']))).toBe(false);
    expect(sameData(x, local([a, b], x.completions, ['p', 'q', 'r']))).toBe(false);
    expect(sameData(local(), local())).toBe(true);
  });
});

describe('mergeWithBase (three-way, for a device that has synced before)', () => {
  const base = (): LocalData =>
    local([habit('a'), habit('b', { order: 1 })], { a: dates('2026-10-05', '2026-10-06') });
  const cloud = (over: { a?: Partial<RemoteHabit>; b?: Partial<RemoteHabit> } = {}): RemoteHabit[] => [
    doc('a', { completions: dates('2026-10-05', '2026-10-06'), ...over.a }),
    doc('b', { order: 1, ...over.b }),
  ];

  it('with nothing changed on either side it is a no-op that equals the cloud', () => {
    const { merged, toPush } = mergeWithBase(base(), base(), cloud());
    expect(sameData(merged, remoteToLocal(cloud()))).toBe(true);
    expect(toPush).toEqual([]);
  });

  it('an un-check made elsewhere sticks: the local copy follows the cloud and nothing is pushed', () => {
    const { merged, toPush } = mergeWithBase(base(), base(), cloud({ a: { completions: dates('2026-10-06') } }));
    expect(merged.completions).toEqual({ a: dates('2026-10-06') });
    expect(toPush).toEqual([]);
  });

  it('a check-in added here is kept and pushed; one removed here is removed and pushed', () => {
    const now = local(base().habits, { a: dates('2026-10-05', '2026-10-07') }); // 06 removed, 07 added
    const { merged, toPush } = mergeWithBase(base(), now, cloud());
    expect(merged.completions).toEqual({ a: dates('2026-10-05', '2026-10-07') });
    expect(toPush).toEqual([
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-07' },
      { type: 'removeCompletion', habitId: 'a', dateKey: '2026-10-06' },
    ]);
  });

  it('edits to the same tracker on both sides merge field by field; the cloud wins untouched fields', () => {
    const now = local([habit('a', { color: 'plum', note: 'by 8 AM' }), habit('b', { order: 1 })], base().completions);
    const remote = cloud({ a: { name: 'Renamed elsewhere', emoji: '🏋️' } });
    const { merged, toPush } = mergeWithBase(base(), now, remote);
    const expected = habit('a', { name: 'Renamed elsewhere', emoji: '🏋️', color: 'plum', note: 'by 8 AM' });
    expect(merged.habits[0]).toEqual(expected);
    expect(toPush).toEqual([{ type: 'setHabit', habit: expected }]);
  });

  it('a field changed on both sides takes the local value; clearing a field here clears it', () => {
    const b = base();
    b.habits[0] = habit('a', { note: 'old', archivedAt: '2026-10-10' });
    const now = local([habit('a', { name: 'Local name' }), habit('b', { order: 1 })], b.completions); // note + archivedAt cleared here
    const remote = cloud({ a: { name: 'Cloud name', note: 'old', archivedAt: '2026-10-10', days: [0, 2] } });
    const { merged } = mergeWithBase(b, now, remote);
    expect(merged.habits[0]).toEqual(habit('a', { name: 'Local name', days: [0, 2] }));
    expect(merged.habits[0]).not.toHaveProperty('note');
    expect(merged.habits[0]).not.toHaveProperty('archivedAt');
  });

  it('a tracker added here is kept with its check-ins and pushed; one added elsewhere arrives', () => {
    const c = habit('c', { order: 2 });
    const now = local([...base().habits, c], { ...base().completions, c: dates('2026-10-01') });
    const remote = [...cloud(), doc('d', { order: 3, completions: dates('2026-10-02') })];
    const { merged, toPush } = mergeWithBase(base(), now, remote);
    expect(merged.habits.map((h) => h.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.completions).toEqual({ a: dates('2026-10-05', '2026-10-06'), c: dates('2026-10-01'), d: dates('2026-10-02') });
    expect(toPush).toEqual([
      { type: 'setHabit', habit: c },
      { type: 'addCompletion', habitId: 'c', dateKey: '2026-10-01' },
    ]);
  });

  it('a tracker tombstoned elsewhere goes, with check-ins made here meanwhile; the tombstone is kept', () => {
    const now = local(base().habits, { ...base().completions, b: dates('2026-10-05') });
    const { merged, toPush } = mergeWithBase(base(), now, cloud({ b: { deleted: true } }));
    expect(merged.habits.map((h) => h.id)).toEqual(['a']);
    expect(merged.completions).toEqual({ a: dates('2026-10-05', '2026-10-06') });
    expect(merged.deletedIds).toEqual(['b']);
    expect(toPush).toEqual([]);
  });

  it('a tracker deleted here is tombstoned in the cloud when the cloud still holds it live, never when it does not', () => {
    const now = local([habit('a')], { a: dates('2026-10-05', '2026-10-06') }, ['b', 'never-seen']);
    const { merged, toPush } = mergeWithBase(base(), now, cloud());
    expect(merged.habits.map((h) => h.id)).toEqual(['a']);
    expect(new Set(merged.deletedIds)).toEqual(new Set(['b', 'never-seen']));
    expect(toPush).toEqual([{ type: 'tombstone', habitId: 'b' }]);
  });

  it('a tracker the cloud no longer holds live, without a tombstone, is kept and pushed again', () => {
    // A write that never landed (lost memory-cache queue); a wiped collection is caught by the engine first.
    const { merged, toPush } = mergeWithBase(base(), base(), [doc('b', { order: 1 })]);
    expect(merged.habits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(merged.completions).toEqual({ a: dates('2026-10-05', '2026-10-06') });
    expect(toPush).toEqual([
      { type: 'setHabit', habit: habit('a') },
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-05' },
      { type: 'addCompletion', habitId: 'a', dateKey: '2026-10-06' },
    ]);
  });

  it('the same tracker on both sides without a common past: the cloud fields win, check-ins union', () => {
    const now = local([habit('x', { name: 'From the backup' })], { x: dates('2026-10-01') });
    const remote = [doc('x', { name: 'From the other device', completions: dates('2026-10-02') })];
    const { merged, toPush } = mergeWithBase(local(), now, remote);
    expect(merged.habits).toEqual([habit('x', { name: 'From the other device' })]);
    expect(merged.completions).toEqual({ x: dates('2026-10-01', '2026-10-02') });
    expect(toPush).toEqual([{ type: 'addCompletion', habitId: 'x', dateKey: '2026-10-01' }]);
  });

  it('re-numbers colliding orders and pushes the fix, like mergeSnapshots', () => {
    const now = local([...base().habits, habit('c', { order: 1, createdAt: '2026-10-03' })], base().completions);
    const { merged, toPush } = mergeWithBase(base(), now, cloud());
    expect(merged.habits.map((h) => [h.id, h.order])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(toPush).toEqual([{ type: 'setHabit', habit: habit('c', { order: 2, createdAt: '2026-10-03' }) }]);
  });

  it('a tracker removed here without a tombstone comes back from the cloud (only a tombstone deletes)', () => {
    const now = local([habit('a')], base().completions);
    const { merged, toPush } = mergeWithBase(base(), now, cloud());
    expect(merged.habits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(toPush).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const b = base();
    const now = local([habit('a', { name: 'Edited' }), habit('b', { order: 1 })], { a: dates('2026-10-05') });
    const remote = cloud({ b: { deleted: true } });
    const snapshotBefore = JSON.stringify([b, now, remote]);
    mergeWithBase(b, now, remote);
    expect(JSON.stringify([b, now, remote])).toBe(snapshotBefore);
  });
});

describe('restoreTombstoned (the importData re-key rule at reconciliation)', () => {
  const makeId = (): (() => string) => {
    let n = 0;
    return () => `fresh-${(n += 1)}`;
  };

  it('re-keys a local tracker the cloud has tombstoned when this device holds no tombstone for it', () => {
    const now = local([habit('x', { name: 'Gym' }), habit('y', { order: 1 })], { x: dates('2026-10-05'), y: dates('2026-10-06') });
    const out = restoreTombstoned(now, [doc('x', { deleted: true })], null, makeId());
    expect(out.habits).toEqual([habit('fresh-1', { name: 'Gym' }), habit('y', { order: 1 })]);
    expect(out.completions).toEqual({ 'fresh-1': dates('2026-10-05'), y: dates('2026-10-06') });
    expect(out.deletedIds).toBe(now.deletedIds);
    expect(now.habits[0]?.id).toBe('x'); // input untouched
  });

  it('leaves a tracker alone when this device tombstoned it too, or when the cloud holds it live', () => {
    const now = local([habit('x'), habit('y', { order: 1 })], {}, ['x']);
    expect(restoreTombstoned(now, [doc('x', { deleted: true }), doc('y')], null, makeId())).toBe(now);
  });

  it('a tracker this device had synced (present in base) is not restored: it was deleted elsewhere since', () => {
    const now = local([habit('x'), habit('n')]);
    const out = restoreTombstoned(now, [doc('x', { deleted: true }), doc('n', { deleted: true })], local([habit('x')]), makeId());
    expect(out.habits.map((h) => h.id)).toEqual(['x', 'fresh-1']); // x is left for the merge to drop; n is restored
  });

  it('returns the same object when there is nothing to do', () => {
    const now = local([habit('a')]);
    expect(restoreTombstoned(now, [doc('a')], null, makeId())).toBe(now);
    expect(restoreTombstoned(now, [], null, makeId())).toBe(now);
  });

  it('the merge then keeps the restored tracker and pushes it, while the old id stays deleted', () => {
    const now = local([habit('x', { name: 'Gym' })], { x: dates('2026-10-05') });
    const remote = [doc('x', { deleted: true })];
    const restored = restoreTombstoned(now, remote, null, makeId());
    const { merged, toPush } = mergeSnapshots(restored, remote);
    expect(merged.habits).toEqual([habit('fresh-1', { name: 'Gym' })]);
    expect(merged.completions).toEqual({ 'fresh-1': dates('2026-10-05') });
    expect(merged.deletedIds).toEqual(['x']);
    expect(toPush).toEqual([
      { type: 'setHabit', habit: habit('fresh-1', { name: 'Gym' }) },
      { type: 'addCompletion', habitId: 'fresh-1', dateKey: '2026-10-05' },
    ]);
  });
});
