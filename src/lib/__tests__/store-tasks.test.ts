import { beforeEach, describe, expect, it, vi } from 'vitest';
import useStore, { DEFAULT_SETTINGS, validateAppData } from '../store';
import { todayKey } from '../dates';
import type { AppData, Task } from '../types';

const store = () => useStore.getState();
const TODAY = todayKey();

const backup = (over: Partial<AppData> = {}): AppData => ({
  version: 1,
  habits: [],
  completions: {},
  settings: { theme: 'system', installHintDismissed: false },
  ...over,
});

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
    ['missing a title', [{ ...good, title: undefined }], /title/],
    ['a bad date', [{ ...good, date: '2026-1-1' }], /date/],
    ['a bad time', [{ ...good, time: '24:00' }], /time/],
    ['a bad done flag', [{ ...good, done: 'yes' }], /done/],
    ['a duplicate id', [good, { ...good, title: 'B' }], /duplicates/],
    ['a long note', [{ ...good, note: 'n'.repeat(81) }], /note/],
    ['an invalid id', [{ ...good, id: 'a/b' }], /id/],
  ])('rejects a backup whose tasks are %s', (_label, tasks, re) => {
    const result = validateAppData({ ...backup(), tasks });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(re);
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
    expect(restored).toMatchObject({ done: true, doneAt: '2026-10-20' });
    expect(new Set(store().deletedTaskIds)).toEqual(new Set([gone, 'far', mine.id]));
  });

  it('a backup without tasks replaces them with none and tombstones the old ones', () => {
    const mine = store().addTask({ title: 'Mine', date: TODAY });
    expect(store().importData(backup())).toEqual({ ok: true });
    expect(store().tasks).toEqual([]);
    expect(store().deletedTaskIds).toEqual([mine.id]);
  });
});
