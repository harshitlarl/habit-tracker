import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import useStore, { DEFAULT_SETTINGS, STORAGE_KEY, lastStorageError, validateAppData, type StoreState } from '../store';
import { todayKey } from '../dates';
import type { LocalTasks } from '../sync/types';
import type { AppData, Habit, Task } from '../types';

const store = () => useStore.getState();
const TODAY = todayKey();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Persisted = Pick<StoreState, 'habits' | 'completions' | 'settings' | 'deletedIds' | 'tasks' | 'deletedTaskIds'>;

const backup = (over: Partial<AppData> = {}): AppData => ({
  version: 1,
  habits: [],
  completions: {},
  settings: { theme: 'system', installHintDismissed: false },
  ...over,
});

const storedHabit = (over: Partial<Habit> = {}): Habit => ({
  id: 'h1',
  name: 'Gym',
  emoji: 'g',
  color: 'plum',
  days: [1, 3],
  createdAt: '2026-10-01',
  order: 0,
  ...over,
});

const storedTask = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  title: 'Renew membership',
  date: '2026-10-20',
  done: false,
  createdAt: '2026-10-17',
  ...over,
});

/* ---------- storage harness (mirrors store.test.ts) ---------- */

interface FakeLocalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** When set, every write throws it — the way a full or disabled localStorage behaves. */
  failure: Error | null;
}

/** A stand-in for `globalThis.localStorage` (absent under node) with switchable write failures. */
function fakeLocalStorage(): FakeLocalStorage {
  const mem = new Map<string, string>();
  const fake: FakeLocalStorage = {
    failure: null,
    getItem: (key) => mem.get(key) ?? null,
    setItem: (key, value) => {
      if (fake.failure) throw fake.failure;
      mem.set(key, value);
    },
    removeItem: (key) => {
      mem.delete(key);
    },
  };
  return fake;
}

const quotaError = (): Error => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

/** A PersistStorage backed by a Map, so the persist wiring can be exercised without localStorage. */
function memoryStorage(mem: Map<string, string>): PersistStorage<unknown> {
  return {
    getItem: (name) => {
      const raw = mem.get(name);
      return raw === undefined ? null : (JSON.parse(raw) as StorageValue<unknown>);
    },
    setItem: (name, value) => {
      mem.set(name, JSON.stringify(value));
    },
    removeItem: (name) => {
      mem.delete(name);
    },
  };
}

/** Runs `fn` with persist writing to `mem`, restoring the real storage afterwards. */
async function withStorage(mem: Map<string, string>, fn: () => Promise<unknown> | void): Promise<void> {
  const original = useStore.persist.getOptions().storage;
  expect(original).toBeDefined();
  if (!original) return;
  try {
    useStore.persist.setOptions({ storage: memoryStorage(mem) });
    await fn();
  } finally {
    useStore.persist.setOptions({ storage: original });
  }
}

/** Rehydrates the store from a stored record, as a reload would, and returns what persist wrote back. */
async function rehydrateFrom(record: unknown): Promise<StorageValue<Persisted> | null> {
  const mem = new Map<string, string>([[STORAGE_KEY, JSON.stringify(record)]]);
  await withStorage(mem, () => useStore.persist.rehydrate());
  const raw = mem.get(STORAGE_KEY);
  return raw === undefined ? null : (JSON.parse(raw) as StorageValue<Persisted>);
}

const readRecord = (mem: Map<string, string>): StorageValue<Persisted> =>
  JSON.parse(mem.get(STORAGE_KEY) ?? 'null') as StorageValue<Persisted>;

beforeEach(() => {
  useStore.setState({
    habits: [],
    completions: {},
    settings: { ...DEFAULT_SETTINGS },
    deletedIds: [],
    tasks: [],
    deletedTaskIds: [],
  });
});

describe('task actions', () => {
  it('addTask trims, caps, drops an invalid time and a blank note, and defaults createdAt to today', () => {
    const t = store().addTask({ title: '  Call the bank  ', date: '2026-10-20', time: '9:00', note: '   ' });
    expect(t).toEqual({ id: t.id, title: 'Call the bank', date: '2026-10-20', done: false, createdAt: TODAY });
    expect(store().tasks).toEqual([t]);
    const timed = store().addTask({ title: 'x'.repeat(70), date: 'nope', time: '15:00', note: ' n ', createdAt: '2026-10-01' });
    expect(timed.title).toHaveLength(60);
    expect(timed.date).toBe('2026-10-01'); // an invalid date falls back to createdAt
    expect(timed.time).toBe('15:00');
    expect(timed.note).toBe('n');
    expect(store().addTask({ title: '   ', date: TODAY }).title).toBe('Untitled');
  });

  it('addTask ids are unique uuids, an invalid createdAt becomes today, and the returned task is the stored one', () => {
    const a = store().addTask({ title: 'A', date: TODAY, createdAt: 'yesterday' });
    const b = store().addTask({ title: 'B', date: TODAY });
    expect(a.id).toMatch(UUID);
    expect(b.id).toMatch(UUID);
    expect(a.id).not.toBe(b.id);
    expect(a.createdAt).toBe(TODAY);
    expect(store().tasks[0]).toBe(a);
    expect(store().tasks[1]).toBe(b);
    expect(store().addTask({ title: 'C', date: 'nope', createdAt: 'nope' }).date).toBe(TODAY);
  });

  it('updateTask patches field by field, clears note and time, ignores blank titles, bad dates and unknown ids', () => {
    const t = store().addTask({ title: 'A', date: TODAY, time: '08:00', note: 'n' });
    const before = store().tasks;
    store().updateTask('missing', { title: 'B' });
    expect(store().tasks).toBe(before);
    store().updateTask(t.id, { title: '  ', note: '', time: undefined, date: '2026-13-40' });
    expect(store().tasks[0]).toEqual({ id: t.id, title: 'A', date: TODAY, done: false, createdAt: TODAY });
    store().updateTask(t.id, { title: ' B ', date: '2026-11-02', time: '23:59', note: 'later' });
    expect(store().tasks[0]).toEqual({
      id: t.id,
      title: 'B',
      date: '2026-11-02',
      time: '23:59',
      note: 'later',
      done: false,
      createdAt: TODAY,
    });
  });

  it("updateTask clears time only with undefined or ''; an invalid non-empty time is ignored like an invalid date", () => {
    const t = store().addTask({ title: 'A', date: TODAY, time: '08:00' });
    const before = store().tasks;
    store().updateTask(t.id, { time: '25:00' });
    store().updateTask(t.id, { time: '8:00' });
    store().updateTask(t.id, { time: ' 08:00' });
    expect(store().tasks[0]?.time).toBe('08:00');
    expect(store().tasks[0]).toEqual(before[0]);
    store().updateTask(t.id, { time: '' });
    expect(store().tasks[0]).not.toHaveProperty('time');
    store().updateTask(t.id, { time: '09:30' });
    store().updateTask(t.id, { time: undefined });
    expect(store().tasks[0]).not.toHaveProperty('time');
  });

  it("updateTask caps title and note, clears with '', never touches id, done, doneAt or createdAt, and leaves other tasks alone", () => {
    const other = store().addTask({ title: 'Other', date: TODAY });
    const t = store().addTask({ title: 'A', date: '2026-10-20', time: '08:00', note: 'n', createdAt: '2026-10-01' });
    store().setTaskDone(t.id, true, '2026-10-21');
    store().updateTask(t.id, { title: ` ${'x'.repeat(70)} `, note: `${'n'.repeat(90)} `, time: '' });
    expect(store().tasks[1]).toEqual({
      id: t.id,
      title: 'x'.repeat(60),
      note: 'n'.repeat(80),
      date: '2026-10-20',
      done: true,
      doneAt: '2026-10-21',
      createdAt: '2026-10-01',
    });
    store().updateTask(t.id, { note: '   ' });
    expect(store().tasks[1]).not.toHaveProperty('note');
    expect(store().tasks[0]).toBe(other);
  });

  it('a cap that lands on a space or inside a surrogate pair still stores the value trimmed, so a backup re-imports unchanged', () => {
    const t = store().addTask({ title: `${'a'.repeat(59)} b`, date: '2026-10-20', note: `${'n'.repeat(79)} z` });
    expect(t).toMatchObject({ title: 'a'.repeat(59), note: 'n'.repeat(79) });
    const u = store().addTask({ title: 'Other', date: '2026-10-21' });
    store().updateTask(u.id, { title: `${'b'.repeat(59)}😀`, note: `${'m'.repeat(78)} 😀` });
    expect(store().tasks[1]).toMatchObject({ title: 'b'.repeat(59), note: 'm'.repeat(78) });

    const before = store().tasks;
    const file = JSON.parse(JSON.stringify(store().exportData())) as unknown;
    expect(store().importData(file)).toEqual({ ok: true });
    expect(store().tasks).toEqual(before);
  });

  it('setTaskDone and toggleTask record and clear doneAt; a no-op does not notify', () => {
    const t = store().addTask({ title: 'A', date: '2026-10-01' });
    const listener = vi.fn();
    const unsubscribe = useStore.subscribe(listener);
    store().setTaskDone(t.id, false);
    store().setTaskDone('missing', true);
    expect(listener).not.toHaveBeenCalled();
    store().setTaskDone(t.id, true, '2026-10-05');
    expect(store().tasks[0]).toMatchObject({ done: true, doneAt: '2026-10-05' });
    store().toggleTask(t.id);
    expect(store().tasks[0]).toEqual({ id: t.id, title: 'A', date: '2026-10-01', done: false, createdAt: TODAY });
    store().toggleTask(t.id);
    expect(store().tasks[0]?.doneAt).toBe(TODAY);
    unsubscribe();
  });

  it('setTaskDone falls back to today for a malformed doneAt, and checking twice keeps the first doneAt', () => {
    const t = store().addTask({ title: 'A', date: '2026-10-01' });
    store().setTaskDone(t.id, true, 'not-a-date');
    expect(store().tasks[0]?.doneAt).toBe(TODAY);
    const after = store().tasks;
    store().setTaskDone(t.id, true, '2026-10-02');
    expect(store().tasks).toBe(after);
    store().toggleTask('missing');
    expect(store().tasks).toBe(after);
  });

  it('deleteTask removes and tombstones, ignores unknown ids; resetAll clears both', () => {
    const t = store().addTask({ title: 'A', date: TODAY });
    const before = store().tasks;
    store().deleteTask('nope');
    expect(store().tasks).toBe(before);
    store().deleteTask(t.id);
    store().deleteTask(t.id);
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([t.id]);
    store().resetAll();
    expect(store().deletedTaskIds).toEqual([]);
  });

  it('deleteTask keeps the other tasks and records tombstones in deletion order, each once', () => {
    const a = store().addTask({ title: 'A', date: TODAY });
    const b = store().addTask({ title: 'B', date: TODAY });
    const c = store().addTask({ title: 'C', date: TODAY });
    store().deleteTask(b.id);
    store().deleteTask(a.id);
    expect(store().tasks).toEqual([c]);
    expect(store().deletedTaskIds).toEqual([b.id, a.id]);
    expect(store().habits).toEqual([]);
    expect(store().deletedIds).toEqual([]); // tracker tombstones are a separate list
  });

  it('applyRemoteTasks replaces, dedupes tombstones and is a no-op when nothing changed', () => {
    const t = store().addTask({ title: 'A', date: TODAY });
    const listener = vi.fn();
    const unsubscribe = useStore.subscribe(listener);
    store().applyRemoteTasks({ tasks: [{ ...t }], deletedTaskIds: [] });
    expect(listener).not.toHaveBeenCalled();
    const other: Task = { id: 'r', title: 'R', date: '2026-10-25', done: false, createdAt: '2026-10-17' };
    store().applyRemoteTasks({ tasks: [other], deletedTaskIds: ['x', 'x'] });
    expect(store().tasks).toEqual([other]);
    expect(store().deletedTaskIds).toEqual(['x']);
    unsubscribe();
  });
});

describe('tasks in backups', () => {
  it('exportData includes tasks and their tombstones; a file without them is still valid', () => {
    const t = store().addTask({ title: 'A', date: TODAY });
    store().deleteTask(store().addTask({ title: 'B', date: TODAY }).id);
    const data = store().exportData();
    expect(data.tasks).toEqual([t]);
    expect(data.deletedTaskIds).toHaveLength(1);
    const result = validateAppData(backup());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toHaveProperty('tasks');
      expect(result.data).not.toHaveProperty('deletedTaskIds');
    }
  });

  const good = { id: 't', title: 'A', date: '2026-10-20', done: false, createdAt: '2026-10-17' };
  it.each<[string, unknown, RegExp]>([
    ['not an array', 'x', /tasks/],
    ['not objects', [5], /Task #1/],
    ['missing a title', [{ ...good, title: undefined }], /title/],
    ['a blank title', [{ ...good, title: '   ' }], /title/],
    ['a long title', [{ ...good, title: 't'.repeat(61) }], /title/],
    ['a bad date', [{ ...good, date: '2026-1-1' }], /date/],
    ['an impossible date', [{ ...good, date: '2026-02-30' }], /date/],
    ['a bad time', [{ ...good, time: '24:00' }], /time/],
    ['an empty time', [{ ...good, time: '' }], /time/],
    ['a bad done flag', [{ ...good, done: 'yes' }], /done/],
    ['a bad doneAt', [{ ...good, done: true, doneAt: 'later' }], /doneAt/],
    ['a missing createdAt', [{ ...good, createdAt: undefined }], /createdAt/],
    ['a duplicate id', [good, { ...good, title: 'B' }], /duplicates/],
    ['a long note', [{ ...good, note: 'n'.repeat(81) }], /note/],
    ['a non-string note', [{ ...good, note: 5 }], /note/],
    ['an invalid id', [{ ...good, id: 'a/b' }], /id/],
    ['a prototype id', [{ ...good, id: '__proto__' }], /id/],
  ])('rejects a backup whose tasks are %s', (_label, tasks, re) => {
    const result = validateAppData({ ...backup(), tasks });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(re);
  });

  it('accepts tasks at the limits, an empty list, a done task without doneAt and a timed task', () => {
    const result = validateAppData(
      backup({
        tasks: [
          { ...good, title: 't'.repeat(60), note: 'n'.repeat(80), time: '00:00' },
          { ...good, id: 'u', done: true },
          { ...good, id: 'v', time: '23:59', done: true, doneAt: '2026-10-25' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.tasks).toHaveLength(3);
      expect(result.data.tasks?.[1]).toEqual({ ...good, id: 'u', done: true });
      expect(result.data.tasks?.[2]).toMatchObject({ time: '23:59', doneAt: '2026-10-25' });
    }
    const empty = validateAppData(backup({ tasks: [] }));
    expect(empty.ok && empty.data.tasks).toEqual([]);
  });

  it('rejects deletedTaskIds that are not ids', () => {
    expect(validateAppData({ ...backup(), deletedTaskIds: 'x' }).ok).toBe(false);
    expect(validateAppData({ ...backup(), deletedTaskIds: ['ok', 5] }).ok).toBe(false);
  });

  it('normalises tasks on import: trims, drops doneAt on undone tasks, strips tombstones naming present tasks', () => {
    const result = validateAppData(
      backup({
        tasks: [{ ...good, title: ' A ', note: ' ', doneAt: '2026-10-21' }],
        deletedTaskIds: ['t', 'g', 'g'],
      }),
    );
    expect(result.ok && result.data.tasks).toEqual([good]);
    expect(result.ok && result.data.deletedTaskIds).toEqual(['g']);
  });

  it('validateAppData is a preview: it does not change the store', () => {
    const mine = store().addTask({ title: 'Mine', date: TODAY });
    validateAppData(backup({ tasks: [good], deletedTaskIds: [mine.id] }));
    expect(store().tasks).toEqual([mine]);
    expect(store().deletedTaskIds).toEqual([]);
  });

  it('importData replaces tasks, tombstones the replaced ones, re-keys tasks tombstoned here and unions tombstones', () => {
    const mine = store().addTask({ title: 'Mine', date: TODAY });
    store().deleteTask(store().addTask({ title: 'Gone', date: TODAY }).id);
    const gone = store().deletedTaskIds[0] as string;
    const file = backup({
      tasks: [
        { id: gone, title: 'Restored', date: '2026-10-20', done: true, doneAt: '2026-10-20', createdAt: '2026-10-17' },
        { id: 'new', title: 'New', date: '2026-10-21', done: false, createdAt: '2026-10-17' },
      ],
      deletedTaskIds: ['far'],
    });
    expect(store().importData(file)).toEqual({ ok: true });
    expect(store().tasks.map((t) => t.title).sort()).toEqual(['New', 'Restored']);
    const restored = store().tasks.find((t) => t.title === 'Restored');
    expect(restored?.id).not.toBe(gone);
    expect(restored?.id).toMatch(UUID);
    expect(restored).toMatchObject({ done: true, doneAt: '2026-10-20' });
    expect(new Set(store().deletedTaskIds)).toEqual(new Set([gone, 'far', mine.id]));
  });

  it('a task kept by the import (same id) is not tombstoned; a backup from this device re-imports byte for byte', () => {
    const keep = store().addTask({ title: 'Keep', date: TODAY, time: '15:00', note: 'n' });
    store().setTaskDone(keep.id, true, TODAY);
    store().deleteTask(store().addTask({ title: 'Gone', date: TODAY }).id);
    const file = JSON.parse(JSON.stringify(store().exportData())) as AppData;
    expect(store().importData(file)).toEqual({ ok: true });
    expect(store().tasks).toEqual(file.tasks);
    expect(store().deletedTaskIds).toEqual(file.deletedTaskIds);
    expect(validateAppData(store().exportData()).ok).toBe(true);
  });

  it('a backup without tasks replaces them with none and tombstones the old ones', () => {
    const mine = store().addTask({ title: 'Mine', date: TODAY });
    expect(store().importData(backup())).toEqual({ ok: true });
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([mine.id]);
  });

  it('a malformed backup leaves tasks and their tombstones untouched', () => {
    const mine = store().addTask({ title: 'Mine', date: TODAY });
    const before = store().tasks;
    const result = store().importData(backup({ tasks: [{ ...good, date: 'soon' }] }));
    expect(result.ok).toBe(false);
    expect(store().tasks).toBe(before);
    expect(store().tasks).toEqual([mine]);
    expect(store().deletedTaskIds).toEqual([]);
  });
});

/* ---------- persist version 3 (SPEC §14.3): migration, hydration repair, the record ---------- */

describe('persist version 3: migration', () => {
  it('migrates a v1 record: tasks and deletedTaskIds start empty and the record is rewritten at version 3', async () => {
    const written = await rehydrateFrom({
      state: {
        habits: [storedHabit()],
        completions: { h1: { '2026-10-06': true } },
        settings: { theme: 'dark', installHintDismissed: true },
      },
      version: 1,
    });
    expect(store().habits).toEqual([storedHabit()]);
    expect(store().completions).toEqual({ h1: { '2026-10-06': true } });
    expect(store().settings).toEqual({ theme: 'dark', installHintDismissed: true });
    expect(store().deletedIds).toEqual([]);
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([]);
    expect(written?.version).toBe(3);
    expect(written?.state.tasks).toEqual([]);
    expect(written?.state.deletedTaskIds).toEqual([]);
    expect(Object.keys(written?.state ?? {}).sort()).toEqual([
      'completions',
      'deletedIds',
      'deletedTaskIds',
      'habits',
      'settings',
      'tasks',
    ]);
  });

  it('migrates a v2 record: tombstones kept, tasks and deletedTaskIds start empty, rewritten at version 3', async () => {
    const written = await rehydrateFrom({
      state: {
        habits: [storedHabit()],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: ['old', 'older'],
      },
      version: 2,
    });
    expect(store().habits).toEqual([storedHabit()]);
    expect(store().deletedIds).toEqual(['old', 'older']);
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([]);
    expect(written?.version).toBe(3);
    expect(written?.state.deletedIds).toEqual(['old', 'older']);
    expect(written?.state.tasks).toEqual([]);
    expect(written?.state.deletedTaskIds).toEqual([]);
  });

  it('migrates a partial or empty older record, filling the task lists with defaults', async () => {
    await rehydrateFrom({ state: { habits: [storedHabit()] }, version: 1 });
    expect(store().habits).toEqual([storedHabit()]);
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([]);
    const written = await rehydrateFrom({ state: {}, version: 2 });
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([]);
    expect(written?.version).toBe(3);
  });

  it('a v3 record hydrates its tasks and task tombstones unchanged', async () => {
    const tasks = [
      storedTask({ time: '15:00', note: 'bring the card', done: true, doneAt: '2026-10-21' }),
      storedTask({ id: 't2', title: 't'.repeat(60), date: '2026-10-25', note: 'n'.repeat(80) }),
    ];
    await rehydrateFrom({
      state: {
        habits: [],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: [],
        tasks,
        deletedTaskIds: ['old-task'],
      },
      version: 3,
    });
    expect(store().tasks).toEqual(tasks);
    expect(store().deletedTaskIds).toEqual(['old-task']);
    expect(typeof store().addTask).toBe('function'); // actions survive hydration
  });

  it.each<unknown>([
    null,
    'garbage',
    5,
    [],
    { tasks: 'nope', deletedTaskIds: 7 },
    { tasks: [null, 5, 'x'], deletedTaskIds: [5, null] },
    { habits: 'nope', completions: [], settings: null, deletedIds: 'x', tasks: {}, deletedTaskIds: {} },
  ])('survives a damaged v3 record (%j) with the defaults', async (state) => {
    await rehydrateFrom({ state, version: 3 });
    expect(store().habits).toEqual([]);
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([]);
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
    expect(typeof store().addTask).toBe('function');
  });
});

describe('persist version 3: hydration repair of tasks', () => {
  it('repairs damaged task records field by field and drops only what cannot be addressed', async () => {
    const valid = storedTask({ time: '15:00', note: 'gym', done: true, doneAt: '2026-10-21' });
    await rehydrateFrom({
      state: {
        habits: [],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: [],
        tasks: [
          null,
          5,
          'x',
          { title: 'No id', date: '2026-10-20', createdAt: '2026-10-17' },
          { id: '', title: 'Blank id', date: '2026-10-20' },
          { id: '   ', title: 'Whitespace id', date: '2026-10-20' },
          { id: '__proto__', title: 'Proto', date: '2026-10-20' },
          valid,
          { ...valid, title: 'Duplicate id' },
          { id: 'b', title: '   ', date: 'nope', createdAt: '2026-10-01', time: '25:00', note: 7, done: true, doneAt: 'bad' },
          { id: 'c', title: `  ${'x'.repeat(70)}`, date: '2026-02-30', createdAt: 'yesterday' },
          {
            id: 'd',
            title: '  Pad  ',
            date: '2026-10-20',
            done: 'yes',
            doneAt: '2026-10-20',
            note: `  ${'n'.repeat(90)}`,
            time: '09:00',
            createdAt: '2026-10-17',
          },
          { id: 'e', title: 'Minimal' },
          { id: 'a/b', title: 'Cloud-unsafe id', date: '2026-10-20', createdAt: '2026-10-17' },
        ],
        deletedTaskIds: ['gone', 't1', 'gone', 5, null, '', '   ', 'x/y', '__proto__', 'e'],
      },
      version: 3,
    });
    expect(store().tasks).toEqual([
      valid,
      { id: 'b', title: 'Untitled', date: '2026-10-01', done: true, createdAt: '2026-10-01' },
      { id: 'c', title: 'x'.repeat(60), date: TODAY, done: false, createdAt: TODAY },
      { id: 'd', title: 'Pad', date: '2026-10-20', done: false, createdAt: '2026-10-17', note: 'n'.repeat(80), time: '09:00' },
      { id: 'e', title: 'Minimal', date: TODAY, done: false, createdAt: TODAY },
      { id: expect.stringMatching(UUID) as string, title: 'Cloud-unsafe id', date: '2026-10-20', done: false, createdAt: '2026-10-17' },
    ]);
    expect(store().tasks[1]).not.toHaveProperty('time');
    expect(store().tasks[1]).not.toHaveProperty('note');
    expect(store().tasks[1]).not.toHaveProperty('doneAt');
    expect(store().tasks[3]).not.toHaveProperty('doneAt'); // doneAt only means something while done
    expect(store().deletedTaskIds).toEqual(['gone']);
    // Whatever hydration repairs, the device can still back itself up.
    expect(validateAppData(JSON.parse(JSON.stringify(store().exportData()))).ok).toBe(true);
  });

  it('a repaired over-long title or note never ends in a space or half a character', async () => {
    await rehydrateFrom({
      state: {
        habits: [],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: [],
        tasks: [
          storedTask({ id: 'a', title: `${'a'.repeat(59)} b`, note: `${'n'.repeat(79)} z` }),
          storedTask({ id: 'b', title: `${'b'.repeat(59)}😀`, note: `${'m'.repeat(79)}😀` }),
        ],
        deletedTaskIds: [],
      },
      version: 3,
    });
    expect(store().tasks).toEqual([
      storedTask({ id: 'a', title: 'a'.repeat(59), note: 'n'.repeat(79) }),
      storedTask({ id: 'b', title: 'b'.repeat(59), note: 'm'.repeat(79) }),
    ]);
  });

  it('a blank or non-string title becomes "Untitled" so the task can be renamed instead of lost', async () => {
    await rehydrateFrom({
      state: {
        habits: [],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: [],
        tasks: [storedTask({ title: '   ' }), storedTask({ id: 't2', title: 3 as unknown as string })],
        deletedTaskIds: [],
      },
      version: 3,
    });
    expect(store().tasks.map((t) => t.title)).toEqual(['Untitled', 'Untitled']);
    expect(validateAppData(store().exportData()).ok).toBe(true);
  });

  it('a bad date falls back to createdAt, and to today when createdAt is bad too', async () => {
    await rehydrateFrom({
      state: {
        habits: [],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: [],
        tasks: [
          storedTask({ id: 'a', date: '2026-13-01', createdAt: '2026-10-02' }),
          storedTask({ id: 'b', date: '20261001', createdAt: 'nope' }),
          storedTask({ id: 'c', date: '2026-10-20', createdAt: 'nope' }),
        ],
        deletedTaskIds: [],
      },
      version: 3,
    });
    expect(store().tasks.map((t) => [t.date, t.createdAt])).toEqual([
      ['2026-10-02', '2026-10-02'],
      [TODAY, TODAY],
      ['2026-10-20', TODAY],
    ]);
  });

  it('duplicate ids keep their first record; a tombstone naming a present task is stripped, the rest deduplicated', async () => {
    await rehydrateFrom({
      state: {
        habits: [],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: [],
        tasks: [storedTask({ title: 'First' }), storedTask({ title: 'Second' }), storedTask({ id: 't2' })],
        deletedTaskIds: ['t1', 'z', 't2', 'y', 'z'],
      },
      version: 3,
    });
    expect(store().tasks.map((t) => [t.id, t.title])).toEqual([
      ['t1', 'First'],
      ['t2', 'Renew membership'],
    ]);
    expect(store().deletedTaskIds).toEqual(['z', 'y']);
  });

  it('two records under the same cloud-unsafe id are one duplicate: the first is re-keyed, the second dropped (as for trackers)', async () => {
    await rehydrateFrom({
      state: {
        habits: [],
        completions: {},
        settings: DEFAULT_SETTINGS,
        deletedIds: [],
        tasks: [
          storedTask({ id: 'a/b', title: 'First' }),
          storedTask({ id: 'a/b', title: 'Second' }),
          storedTask({ id: 'c/d', title: 'Other' }),
        ],
        deletedTaskIds: [],
      },
      version: 3,
    });
    expect(store().tasks.map((t) => t.title)).toEqual(['First', 'Other']);
    for (const t of store().tasks) expect(t.id).toMatch(UUID);
    expect(new Set(store().tasks.map((t) => t.id)).size).toBe(2);
  });

  it('a damaged task record never leaks into the tracker side, and vice versa', async () => {
    await rehydrateFrom({
      state: {
        habits: [storedHabit(), { id: 'broken' }],
        completions: { h1: { '2026-10-06': true } },
        settings: DEFAULT_SETTINGS,
        deletedIds: ['t1'],
        tasks: [storedTask(), { id: 'h1', title: 'Same id as a tracker', date: '2026-10-20', createdAt: '2026-10-17' }],
        deletedTaskIds: ['h1', 'broken'],
      },
      version: 3,
    });
    expect(store().habits.map((h) => h.id)).toEqual(['h1', 'broken']);
    expect(store().tasks.map((t) => t.id)).toEqual(['t1', 'h1']); // ids are per collection
    expect(store().deletedIds).toEqual(['t1']); // a tracker tombstone may name a task id: separate lists
    expect(store().deletedTaskIds).toEqual(['broken']);
  });
});

describe('persist version 3: the record', () => {
  it('the persisted record contains tasks and deletedTaskIds at version 3', async () => {
    const mem = new Map<string, string>();
    await withStorage(mem, () => {
      const t = store().addTask({ title: 'A', date: '2026-10-20', time: '15:00', note: 'n' });
      const gone = store().addTask({ title: 'B', date: '2026-10-21' });
      store().deleteTask(gone.id);
      const written = readRecord(mem);
      expect(written.version).toBe(3);
      expect(written.state.tasks).toEqual([t]);
      expect(written.state.deletedTaskIds).toEqual([gone.id]);
      expect(Object.keys(written.state).sort()).toEqual([
        'completions',
        'deletedIds',
        'deletedTaskIds',
        'habits',
        'settings',
        'tasks',
      ]);
    });
  });

  it('every task action writes the record: done state and edits are persisted', async () => {
    const mem = new Map<string, string>();
    await withStorage(mem, () => {
      const t = store().addTask({ title: 'A', date: '2026-10-20' });
      store().setTaskDone(t.id, true, '2026-10-21');
      expect(readRecord(mem).state.tasks[0]).toMatchObject({ done: true, doneAt: '2026-10-21' });
      store().updateTask(t.id, { title: 'B', time: '08:00' });
      expect(readRecord(mem).state.tasks[0]).toMatchObject({ title: 'B', time: '08:00' });
      store().toggleTask(t.id);
      expect(readRecord(mem).state.tasks[0]).not.toHaveProperty('doneAt');
    });
  });

  it('tasks and their tombstones survive a reload', async () => {
    const mem = new Map<string, string>();
    await withStorage(mem, async () => {
      const t = store().addTask({ title: 'A', date: '2026-10-20', time: '15:00' });
      store().deleteTask(store().addTask({ title: 'B', date: '2026-10-20' }).id);
      const tombstones = store().deletedTaskIds;
      const snapshot = mem.get(STORAGE_KEY) ?? '';
      useStore.setState({ tasks: [], deletedTaskIds: [] }); // persist writes this too, so put the snapshot back
      expect(store().tasks).toEqual([]);
      mem.set(STORAGE_KEY, snapshot);
      await useStore.persist.rehydrate();
      expect(store().tasks).toEqual([t]);
      expect(store().deletedTaskIds).toEqual(tombstones);
    });
  });

  it('resetAll writes a record with empty task lists', async () => {
    const mem = new Map<string, string>();
    await withStorage(mem, () => {
      store().addTask({ title: 'A', date: '2026-10-20' });
      store().resetAll();
      expect(readRecord(mem).state.tasks).toEqual([]);
      expect(readRecord(mem).state.deletedTaskIds).toEqual([]);
    });
  });
});

describe('applyRemoteTasks', () => {
  it('replaces tasks and tombstones wholesale, writes the record once and leaves everything else alone', async () => {
    const mine = store().addTask({ title: 'Mine', date: TODAY });
    store().setTheme('dark');
    store().deleteHabit(store().addHabit({ name: 'Gym', emoji: 'g', color: 'sage', days: [0] }).id);
    const trackerTombstones = store().deletedIds;
    const data: LocalTasks = {
      tasks: [
        { id: 'r1', title: 'Remote', date: '2026-10-25', time: '09:00', done: false, createdAt: '2026-10-17' },
        { id: 'r2', title: 'Done remotely', date: '2026-10-18', done: true, doneAt: '2026-10-19', createdAt: '2026-10-17' },
      ],
      deletedTaskIds: ['x', 'x', 'y'],
    };
    const listener = vi.fn();
    const unsubscribe = useStore.subscribe(listener);
    const mem = new Map<string, string>();
    try {
      await withStorage(mem, () => {
        store().applyRemoteTasks(data);
      });
    } finally {
      unsubscribe();
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store().tasks).toBe(data.tasks);
    expect(store().deletedTaskIds).toEqual(['x', 'y']);
    expect(store().tasks.find((t) => t.id === mine.id)).toBeUndefined();
    expect(store().settings.theme).toBe('dark');
    expect(store().deletedIds).toBe(trackerTombstones);
    const written = readRecord(mem);
    expect(written.version).toBe(3);
    expect(written.state.tasks.map((t) => t.id)).toEqual(['r1', 'r2']);
    expect(written.state.deletedTaskIds).toEqual(['x', 'y']);
    expect(validateAppData(store().exportData()).ok).toBe(true);
  });

  it('is a no-op when nothing changed: same references, no subscriber call, no persist write', async () => {
    const a = store().addTask({ title: 'A', date: '2026-10-20', time: '09:00', note: 'n' });
    const b = store().addTask({ title: 'B', date: '2026-10-21' });
    store().setTaskDone(a.id, true, '2026-10-20');
    store().deleteTask(store().addTask({ title: 'C', date: TODAY }).id);
    store().deleteTask(store().addTask({ title: 'D', date: TODAY }).id);
    const { tasks, deletedTaskIds } = store();
    const same = JSON.parse(JSON.stringify({ tasks, deletedTaskIds })) as LocalTasks;
    same.tasks.reverse(); // task order never matters: views sort for themselves
    same.deletedTaskIds.reverse(); // tombstone order never matters
    expect(same.tasks.map((t) => t.id)).toEqual([b.id, a.id]);
    const listener = vi.fn();
    const unsubscribe = useStore.subscribe(listener);
    const mem = new Map<string, string>();
    try {
      await withStorage(mem, () => {
        store().applyRemoteTasks(same);
        store().applyRemoteTasks({ tasks, deletedTaskIds });
        store().applyRemoteTasks({ tasks: [...tasks], deletedTaskIds: [...deletedTaskIds] });
      });
    } finally {
      unsubscribe();
    }
    expect(store().tasks).toBe(tasks);
    expect(store().deletedTaskIds).toBe(deletedTaskIds);
    expect(listener).not.toHaveBeenCalled();
    expect(mem.size).toBe(0);
  });

  it('applies a change in either part, including a field-only change and an emptied cloud', () => {
    const a = store().addTask({ title: 'A', date: '2026-10-20' });
    store().applyRemoteTasks({ tasks: [{ ...a, done: true, doneAt: '2026-10-20' }], deletedTaskIds: [] });
    expect(store().tasks[0]).toMatchObject({ id: a.id, done: true, doneAt: '2026-10-20' });
    store().applyRemoteTasks({ tasks: [{ ...a, done: true, doneAt: '2026-10-20' }], deletedTaskIds: ['gone'] });
    expect(store().deletedTaskIds).toEqual(['gone']);
    store().applyRemoteTasks({ tasks: [{ ...a, title: 'Renamed', done: true, doneAt: '2026-10-20' }], deletedTaskIds: ['gone'] });
    expect(store().tasks[0]?.title).toBe('Renamed');
    store().applyRemoteTasks({ tasks: [], deletedTaskIds: [] });
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([]);
  });

  it('does not touch trackers, completions or tracker tombstones', () => {
    const habit = store().addHabit({ name: 'Gym', emoji: 'g', color: 'sage', days: [0] });
    store().setCompletion(habit.id, '2026-10-19', true);
    const { habits, completions, deletedIds } = store();
    store().applyRemoteTasks({ tasks: [storedTask()], deletedTaskIds: ['z'] });
    expect(store().habits).toBe(habits);
    expect(store().completions).toBe(completions);
    expect(store().deletedIds).toBe(deletedIds);
  });
});

describe('a failed import leaves tasks untouched', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const imported: Task = { id: 'imp', title: 'Imported', date: '2026-10-22', time: '10:00', done: false, createdAt: '2026-10-17' };

  it('refuses when the browser write fails: same references, no new tombstones, no notification, record kept', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    const mine = store().addTask({ title: 'Mine', date: TODAY, time: '09:00' });
    store().deleteTask(store().addTask({ title: 'Gone', date: TODAY }).id);
    const gone = store().deletedTaskIds[0] as string;
    const tasksBefore = store().tasks;
    const tombstonesBefore = store().deletedTaskIds;
    const savedRecord = local.getItem(STORAGE_KEY);
    expect(savedRecord).toContain('Mine');
    expect(lastStorageError()).toBeNull();
    const listener = vi.fn();
    const unsubscribe = useStore.subscribe(listener);
    const file = backup({ tasks: [imported], deletedTaskIds: ['far'] });

    local.failure = quotaError();
    try {
      expect(store().importData(file)).toEqual({ ok: false, error: 'This backup is too large to store on this device.' });
    } finally {
      unsubscribe();
    }
    expect(listener).not.toHaveBeenCalled();
    expect(store().tasks).toBe(tasksBefore);
    expect(store().tasks).toEqual([mine]);
    expect(store().deletedTaskIds).toBe(tombstonesBefore);
    expect(store().deletedTaskIds).toEqual([gone]); // no tombstone for the task the import would have replaced
    expect(local.getItem(STORAGE_KEY)).toBe(savedRecord); // the device still holds the previous record
    expect(lastStorageError()?.name).toBe('QuotaExceededError');

    // Once the write lands the same file imports, tasks included.
    local.failure = null;
    expect(store().importData(file)).toEqual({ ok: true });
    expect(store().tasks).toEqual([imported]);
    expect(new Set(store().deletedTaskIds)).toEqual(new Set([gone, 'far', mine.id]));
    const written = JSON.parse(local.getItem(STORAGE_KEY) ?? 'null') as StorageValue<Persisted>;
    expect(written.version).toBe(3);
    expect(written.state.tasks).toEqual([imported]);
    expect(lastStorageError()).toBeNull();
  });

  it('a non-quota write failure is reported too, and the tasks stay', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    const mine = store().addTask({ title: 'Mine', date: TODAY });
    local.failure = new Error('The operation is insecure.');
    const result = store().importData(backup({ tasks: [imported] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not saving changes/);
    expect(store().tasks).toEqual([mine]);
    expect(store().deletedTaskIds).toEqual([]);
  });

  it('task actions keep working in memory while the browser refuses writes', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    local.failure = quotaError();
    expect(() => store().addTask({ title: 'A', date: TODAY })).not.toThrow();
    expect(() => store().toggleTask(store().tasks[0]?.id ?? '')).not.toThrow();
    expect(store().tasks[0]).toMatchObject({ title: 'A', done: true, doneAt: TODAY });
    expect(lastStorageError()?.name).toBe('QuotaExceededError');
  });
});
