import { describe, expect, it } from 'vitest';
import {
  diffTasksForPush,
  mergeTasks,
  mergeTasksWithBase,
  parseRemoteTask,
  remoteTasksToLocal,
  restoreTombstonedTasks,
  sameTask,
  sameTasks,
} from '../sync/tasksMerge';
import type { LocalTasks, RemoteTask } from '../sync/types';
import type { Task } from '../types';

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  date: '2026-10-20',
  done: false,
  createdAt: '2026-10-17',
  ...over,
});
const remote = (id: string, over: Partial<RemoteTask> = {}): RemoteTask => ({ ...task(id), deleted: false, ...over });
const local = (tasks: Task[] = [], deletedTaskIds: string[] = []): LocalTasks => ({ tasks, deletedTaskIds });

describe('parseRemoteTask', () => {
  it('parses a full document, trims and drops unknown keys', () => {
    const doc = parseRemoteTask('a', {
      id: 'a',
      title: '  Renew membership ',
      note: ' gym ',
      date: '2026-10-21',
      time: '15:00',
      done: true,
      doneAt: '2026-10-22',
      createdAt: '2026-10-17',
      deleted: false,
      updatedAt: { seconds: 1 },
      extra: 1,
    });
    expect(doc).toEqual({
      id: 'a',
      title: 'Renew membership',
      note: 'gym',
      date: '2026-10-21',
      time: '15:00',
      done: true,
      doneAt: '2026-10-22',
      createdAt: '2026-10-17',
      deleted: false,
      updatedAt: { seconds: 1 },
    });
  });

  it('rejects unusable documents', () => {
    expect(parseRemoteTask('a', null)).toBeNull();
    expect(parseRemoteTask('a', { title: '   ', date: '2026-10-21' })).toBeNull();
    expect(parseRemoteTask('a', { title: 'x', date: '2026-13-01' })).toBeNull();
    expect(parseRemoteTask('a', { id: 'b', title: 'x', date: '2026-10-21' })).toBeNull();
    expect(parseRemoteTask('__x__', { title: 'x', date: '2026-10-21' })).toBeNull();
  });

  it('drops damaged optional fields instead of the task; createdAt falls back to date; doneAt only while done', () => {
    expect(
      parseRemoteTask('a', { title: 'x', date: '2026-10-21', time: '25:00', note: 5, doneAt: '2026-10-21', done: false }),
    ).toEqual({ id: 'a', title: 'x', date: '2026-10-21', done: false, createdAt: '2026-10-21', deleted: false });
  });

  it('parses a bare tombstone', () => {
    const doc = parseRemoteTask('gone', { deleted: true, updatedAt: null });
    expect(doc).toMatchObject({ id: 'gone', deleted: true });
    expect(doc).not.toHaveProperty('updatedAt');
  });
});

describe('remoteTasksToLocal', () => {
  it('sorts live tasks and collects tombstones; a tombstone beats a live doc with the same id', () => {
    const out = remoteTasksToLocal([
      remote('b', { date: '2026-10-22' }),
      remote('a', { time: '09:00' }),
      remote('c', { deleted: true }),
      remote('c'),
    ]);
    expect(out.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(out.tasks[0]).not.toHaveProperty('deleted');
    expect(out.deletedTaskIds).toEqual(['c']);
  });
});

describe('mergeTasks (first contact)', () => {
  it('unions both sides, remote fields win, a done side wins, tombstones win, and pushes what the cloud lacks', () => {
    const l = local([task('a', { title: 'local' }), task('b'), task('c', { done: true, doneAt: '2026-10-18' }), task('d')], ['e']);
    const r = [remote('a', { title: 'remote' }), remote('c'), remote('d', { deleted: true }), remote('e'), remote('f')];
    const { merged, toPush } = mergeTasks(l, r);
    expect(merged.tasks.map((t) => [t.id, t.title, t.done, t.doneAt])).toEqual([
      ['a', 'remote', false, undefined],
      ['b', 'Task b', false, undefined],
      ['c', 'Task c', true, '2026-10-18'],
      ['f', 'Task f', false, undefined],
    ]);
    expect(new Set(merged.deletedTaskIds)).toEqual(new Set(['d', 'e']));
    expect(toPush).toEqual([
      { type: 'setTask', task: task('b') },
      { type: 'setTask', task: task('c', { done: true, doneAt: '2026-10-18' }) },
      { type: 'tombstoneTask', taskId: 'e' },
    ]);
  });

  it('is a no-op when the cloud already has everything', () => {
    const r = [remote('a'), remote('b', { deleted: true })];
    const l = remoteTasksToLocal(r);
    const { merged, toPush } = mergeTasks(l, r);
    expect(toPush).toEqual([]);
    expect(sameTasks(merged, l)).toBe(true);
  });
});

describe('mergeTasksWithBase (three-way)', () => {
  const base = local([task('a'), task('b', { done: true, doneAt: '2026-10-18' })]);

  it('replays local edits over the cloud, follows the cloud elsewhere, and keeps an un-check made here', () => {
    const l = local([task('a', { title: 'renamed here' }), task('b')]); // b un-checked on this device
    const r = [remote('a', { time: '08:00' }), remote('b', { done: true, doneAt: '2026-10-18', note: 'remote note' })];
    const { merged, toPush } = mergeTasksWithBase(base, l, r);
    expect(merged.tasks).toEqual([task('a', { title: 'renamed here', time: '08:00' }), task('b', { note: 'remote note' })]);
    expect(toPush).toEqual([
      { type: 'setTask', task: task('a', { title: 'renamed here', time: '08:00' }) },
      { type: 'setTask', task: task('b', { note: 'remote note' }) },
    ]);
  });

  it('keeps and re-pushes a task the cloud dropped without a tombstone; drops one the cloud tombstoned', () => {
    const l = local([task('a'), task('b', { done: true, doneAt: '2026-10-18' })]);
    const { merged, toPush } = mergeTasksWithBase(base, l, [remote('b', { deleted: true })]);
    expect(merged.tasks).toEqual([task('a')]);
    expect(merged.deletedTaskIds).toEqual(['b']);
    expect(toPush).toEqual([{ type: 'setTask', task: task('a') }]);
  });

  it('applies the first-contact rule to a task both sides hold but the base never saw', () => {
    const l = local([task('z', { done: true, doneAt: '2026-10-19', title: 'mine' })]);
    const { merged, toPush } = mergeTasksWithBase(base, l, [remote('z', { title: 'theirs' })]);
    expect(merged.tasks).toEqual([task('z', { title: 'theirs', done: true, doneAt: '2026-10-19' })]);
    expect(toPush).toEqual([{ type: 'setTask', task: task('z', { title: 'theirs', done: true, doneAt: '2026-10-19' }) }]);
  });

  it('never tombstones an id the cloud has never seen', () => {
    const { toPush } = mergeTasksWithBase(base, local([], ['ghost']), [remote('a')]);
    expect(toPush).toEqual([]);
  });
});

describe('restoreTombstonedTasks', () => {
  it('re-keys a local task the cloud tombstoned that this device never knew; leaves everything else alone', () => {
    const l = local([task('a'), task('b')]);
    const out = restoreTombstonedTasks(l, [remote('a', { deleted: true })], local([]), () => 'fresh');
    expect(out.tasks.map((t) => t.id)).toEqual(['fresh', 'b']);
    expect(restoreTombstonedTasks(l, [remote('a', { deleted: true })], local([task('a')]))).toBe(l);
    expect(restoreTombstonedTasks(local([task('a')], ['a']), [remote('a', { deleted: true })], null)).toEqual(
      local([task('a')], ['a']),
    );
    expect(restoreTombstonedTasks(l, [remote('c', { deleted: true })], null)).toBe(l);
  });
});

describe('diffTasksForPush', () => {
  it('emits setTask for added or changed tasks and tombstoneTask for new tombstones; nothing for a reorder', () => {
    const prev = local([task('a'), task('b')], ['x']);
    const next = local([task('b'), task('a', { done: true, doneAt: '2026-10-20' }), task('c')], ['x', 'y']);
    expect(diffTasksForPush(prev, next)).toEqual([
      { type: 'setTask', task: task('a', { done: true, doneAt: '2026-10-20' }) },
      { type: 'setTask', task: task('c') },
      { type: 'tombstoneTask', taskId: 'y' },
    ]);
    expect(diffTasksForPush(prev, local([task('b'), task('a')], ['x']))).toEqual([]);
  });

  it('a task both present and tombstoned only gets the tombstone', () => {
    expect(diffTasksForPush(local(), local([task('a')], ['a']))).toEqual([{ type: 'tombstoneTask', taskId: 'a' }]);
  });
});

describe('sameTask / sameTasks', () => {
  it('compares fields and ignores order and identity', () => {
    expect(sameTask(task('a', { note: undefined }), task('a'))).toBe(true);
    expect(sameTask(task('a', { time: '09:00' }), task('a'))).toBe(false);
    expect(sameTasks(local([task('a'), task('b')], ['x', 'y']), local([task('b'), task('a')], ['y', 'x']))).toBe(true);
    expect(sameTasks(local([task('a')]), local([task('a', { done: true })]))).toBe(false);
    expect(sameTasks(local([task('a')]), local([task('a')], ['z']))).toBe(false);
  });
});

describe('parseRemoteTask — the lenient edges', () => {
  it('treats null optional fields as absent, coerces a non-boolean done to false and caps a long title', () => {
    const doc = parseRemoteTask('a', {
      title: `${'x'.repeat(70)}`,
      note: null,
      date: '2026-10-21',
      time: null,
      done: 'yes',
      doneAt: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(doc).toEqual({ id: 'a', title: 'x'.repeat(60), date: '2026-10-21', done: false, createdAt: '2026-10-21', deleted: false });
    expect(parseRemoteTask('a', { title: 'x', date: '2026-10-21', note: 'n'.repeat(90) })?.note).toHaveLength(80);
  });

  it('caps the way the store does: never a trailing space or half a surrogate pair at the cut', () => {
    const doc = parseRemoteTask('a', { title: `${'a'.repeat(59)} b`, date: '2026-10-21', note: `${'n'.repeat(79)} z` });
    expect(doc).toMatchObject({ title: 'a'.repeat(59), note: 'n'.repeat(79) });
    const emoji = parseRemoteTask('a', { title: `${'a'.repeat(59)}😀`, date: '2026-10-21', note: `${'n'.repeat(78)} 😀` });
    expect(emoji).toMatchObject({ title: 'a'.repeat(59), note: 'n'.repeat(78) });
  });

  it('a tombstone keeps its fields when they are usable, and a non-true deleted flag is not a tombstone', () => {
    expect(parseRemoteTask('a', { title: 'x', date: '2026-10-21', deleted: true })).toMatchObject({ title: 'x', deleted: true });
    expect(parseRemoteTask('a', { title: 'x', date: '2026-10-21', deleted: 'true' })?.deleted).toBe(false);
    expect(parseRemoteTask('a', { deleted: false })).toBeNull(); // neither a task nor a tombstone
    expect(parseRemoteTask('a', [])).toBeNull();
    expect(parseRemoteTask('a/b', { title: 'x', date: '2026-10-21' })).toBeNull();
  });
});

describe('mergeTasks — more first-contact cases', () => {
  it('a task done on both sides keeps the remote doneAt; a task done only in the cloud stays done; duplicate local tombstones push once', () => {
    const l = local([task('a', { done: true, doneAt: '2026-10-21' }), task('b')], ['c', 'c']);
    const r = [remote('a', { done: true, doneAt: '2026-10-20' }), remote('b', { done: true, doneAt: '2026-10-19' }), remote('c')];
    const { merged, toPush } = mergeTasks(l, r);
    expect(merged.tasks).toEqual([task('a', { done: true, doneAt: '2026-10-20' }), task('b', { done: true, doneAt: '2026-10-19' })]);
    expect(merged.deletedTaskIds).toEqual(['c']);
    expect(toPush).toEqual([{ type: 'tombstoneTask', taskId: 'c' }]);
  });

  it('a task tombstoned in the cloud is dropped locally without a push; a cloud tombstone beats a local live copy', () => {
    const l = local([task('a', { done: true, doneAt: '2026-10-21' })]);
    const { merged, toPush } = mergeTasks(l, [remote('a', { deleted: true })]);
    expect(merged).toEqual(local([], ['a']));
    expect(toPush).toEqual([]);
  });

  it('a local task listed in its own tombstones is dropped (the tombstone wins) and nothing is pushed for it', () => {
    const { merged, toPush } = mergeTasks(local([task('a')], ['a']), []);
    expect(merged).toEqual(local([], ['a']));
    expect(toPush).toEqual([]);
  });

  it('an empty cloud and an empty device merge to nothing', () => {
    expect(mergeTasks(local(), [])).toEqual({ merged: local(), toPush: [] });
  });
});

describe('mergeTasksWithBase — more three-way cases', () => {
  const base = local([task('a'), task('b'), task('c', { note: 'keep' })]);

  it('a deletion here beats the live cloud copy and is pushed; a check-off elsewhere sticks on an untouched task', () => {
    const l = local([task('a'), task('c', { note: 'keep' })], ['b']);
    const r = [remote('a', { done: true, doneAt: '2026-10-20' }), remote('b'), remote('c', { note: 'keep' })];
    const { merged, toPush } = mergeTasksWithBase(base, l, r);
    expect(merged.tasks).toEqual([task('a', { done: true, doneAt: '2026-10-20' }), task('c', { note: 'keep' })]);
    expect(merged.deletedTaskIds).toEqual(['b']);
    expect(toPush).toEqual([{ type: 'tombstoneTask', taskId: 'b' }]);
  });

  it('edits to different fields of the same task on both sides both survive; the same field edited on both sides takes this device', () => {
    const l = local([task('a', { time: '09:00', title: 'mine' }), task('b', { date: '2026-10-25' }), task('c', { note: 'keep' })]);
    const r = [remote('a', { note: 'theirs', title: 'theirs' }), remote('b', { date: '2026-10-26' }), remote('c', { note: 'keep' })];
    const { merged, toPush } = mergeTasksWithBase(base, l, r);
    expect(merged.tasks).toEqual([
      task('a', { time: '09:00', title: 'mine', note: 'theirs' }),
      task('c', { note: 'keep' }),
      task('b', { date: '2026-10-25' }),
    ]);
    expect(toPush).toEqual([
      { type: 'setTask', task: task('a', { time: '09:00', title: 'mine', note: 'theirs' }) },
      { type: 'setTask', task: task('b', { date: '2026-10-25' }) },
    ]);
  });

  it('a note cleared here reaches the merged copy even when the cloud edited another field', () => {
    const l = local([task('a'), task('b'), task('c')]); // c's note cleared here
    const r = [remote('a'), remote('b'), remote('c', { note: 'keep', time: '10:00' })];
    const { merged, toPush } = mergeTasksWithBase(base, l, r);
    expect(merged.tasks.find((t) => t.id === 'c')).toEqual(task('c', { time: '10:00' }));
    expect(toPush).toEqual([{ type: 'setTask', task: task('c', { time: '10:00' }) }]);
  });

  it('a task tombstoned by the cloud while edited here is dropped: the tombstone wins and nothing is pushed', () => {
    const l = local([task('a', { title: 'edited here' }), task('b'), task('c', { note: 'keep' })]);
    const r = [remote('a', { deleted: true }), remote('b'), remote('c', { note: 'keep' })];
    const { merged, toPush } = mergeTasksWithBase(base, l, r);
    expect(merged.tasks.map((t) => t.id)).toEqual(['b', 'c']);
    expect(merged.deletedTaskIds).toEqual(['a']);
    expect(toPush).toEqual([]);
  });

  it('is a no-op when nothing changed anywhere', () => {
    const r = [remote('a'), remote('b'), remote('c', { note: 'keep' })];
    const { merged, toPush } = mergeTasksWithBase(base, base, r);
    expect(sameTasks(merged, base)).toBe(true);
    expect(toPush).toEqual([]);
  });

  it('with an empty base (a phase-2 baseline) behaves like first contact: locals go up, cloud comes down, both-sided ids follow the cloud except done', () => {
    const l = local([task('mine'), task('both', { done: true, doneAt: '2026-10-20', title: 'local' })]);
    const r = [remote('cloud'), remote('both', { title: 'remote' })];
    const { merged, toPush } = mergeTasksWithBase(local(), l, r);
    expect(merged.tasks).toEqual([task('both', { title: 'remote', done: true, doneAt: '2026-10-20' }), task('cloud'), task('mine')]);
    expect(toPush).toEqual([
      { type: 'setTask', task: task('both', { title: 'remote', done: true, doneAt: '2026-10-20' }) },
      { type: 'setTask', task: task('mine') },
    ]);
  });
});

describe('diffTasksForPush — more cases', () => {
  it('a task removed without a tombstone yields nothing; an existing tombstone is not re-sent', () => {
    expect(diffTasksForPush(local([task('a')], ['x']), local([], ['x']))).toEqual([]);
  });

  it('is empty exactly when sameTasks', () => {
    const a = local([task('a', { note: 'n' })], ['x']);
    const b = local([task('a', { note: 'n' })], ['x']);
    expect(sameTasks(a, b)).toBe(true);
    expect(diffTasksForPush(a, b)).toEqual([]);
    const c = local([task('a', { note: 'm' })], ['x']);
    expect(sameTasks(a, c)).toBe(false);
    expect(diffTasksForPush(a, c)).toEqual([{ type: 'setTask', task: task('a', { note: 'm' }) }]);
  });
});

describe('sameTasks — duplicates', () => {
  it('a duplicate id on either side never stands in for a task the other side lacks', () => {
    expect(sameTasks(local([task('a'), task('a')]), local([task('a'), task('b')]))).toBe(false);
    expect(sameTasks(local([task('a'), task('b')]), local([task('a'), task('a')]))).toBe(false);
    expect(sameTasks(local([task('a'), task('a')]), local([task('a'), task('a')]))).toBe(false);
  });
});
