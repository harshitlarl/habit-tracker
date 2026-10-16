import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import useStore, {
  DEFAULT_SETTINGS,
  HABIT_EMOJI_MAX,
  HABIT_NAME_MAX,
  HABIT_NOTE_MAX,
  STORAGE_KEY,
  lastStorageError,
  normalizeDays,
  validateAppData,
  type HabitInput,
  type StoreState,
} from '../store';
import { addDays, isScheduled, todayKey, weekdayOf } from '../dates';
import { activeHabits, archivedHabits, dueHabits, isDone } from '../selectors';
import { bestStreak, completionStats, currentStreak } from '../streaks';
import type { AppData, Habit, Weekday } from '../types';

const store = () => useStore.getState();
const TODAY = todayKey();

type Persisted = Pick<StoreState, 'habits' | 'completions' | 'settings'>;

const add = (name: string, over: Partial<HabitInput> = {}): Habit =>
  store().addHabit({ name, emoji: name.slice(0, 1).toLowerCase(), color: 'sage', days: [0], ...over });

const validBackup = (): AppData => ({
  version: 1,
  habits: [
    { id: 'a', name: 'Gym', emoji: '🏋️', color: 'terracotta', days: [0, 2, 4], createdAt: '2026-10-01', order: 0 },
    {
      id: 'b',
      name: 'Read',
      emoji: '📚',
      color: 'sage',
      note: '20 pages',
      days: [0, 1, 2, 3, 4, 5, 6],
      createdAt: '2026-09-15',
      archivedAt: '2026-10-10',
      order: 1,
    },
  ],
  completions: { a: { '2026-10-05': true, '2026-10-07': true }, b: { '2026-09-20': true } },
  settings: { theme: 'dark', installHintDismissed: true },
  exportedAt: '2026-10-16T12:00:00.000Z',
});

const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

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

beforeEach(() => {
  store().resetAll();
});

describe('persistence wiring', () => {
  it('uses the momentum-v1 key at version 2 and has hydrated', () => {
    expect(STORAGE_KEY).toBe('momentum-v1');
    expect(useStore.persist.getOptions().name).toBe('momentum-v1');
    expect(useStore.persist.getOptions().version).toBe(2);
    expect(useStore.persist.hasHydrated()).toBe(true);
  });

  it('starts with defaults', () => {
    expect(store().habits).toEqual([]);
    expect(store().completions).toEqual({});
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
    expect(store().settings).not.toBe(DEFAULT_SETTINGS); // a copy, never the shared constant
  });

  it('rehydrates a stored record and deep-merges settings with the defaults', async () => {
    const original = useStore.persist.getOptions().storage;
    expect(original).toBeDefined();
    if (!original) return;
    const habit: Habit = { id: 'a', name: 'Gym', emoji: 'g', color: 'plum', days: [1, 3], createdAt: '2026-10-01', order: 0 };
    const mem = new Map<string, string>([
      [
        STORAGE_KEY,
        JSON.stringify({
          state: { habits: [habit], completions: { a: { '2026-10-06': true } }, settings: { theme: 'dark' } },
          version: 1,
        }),
      ],
    ]);
    try {
      useStore.persist.setOptions({ storage: memoryStorage(mem) });
      await useStore.persist.rehydrate();
      expect(store().habits).toEqual([habit]);
      expect(store().completions).toEqual({ a: { '2026-10-06': true } });
      expect(store().settings).toEqual({ theme: 'dark', installHintDismissed: false });
      expect(typeof store().addHabit).toBe('function'); // actions survive hydration
      // Subsequent writes land in storage, partialized to data only.
      store().setTheme('light');
      const written = JSON.parse(mem.get(STORAGE_KEY) ?? 'null') as StorageValue<Persisted>;
      expect(written.version).toBe(2);
      expect(Object.keys(written.state).sort()).toEqual(['completions', 'deletedIds', 'habits', 'settings']);
      expect(written.state.settings.theme).toBe('light');
    } finally {
      useStore.persist.setOptions({ storage: original });
    }
  });

  it('migrate passes an older record through and rewrites it at the current version', async () => {
    const original = useStore.persist.getOptions().storage;
    if (!original) return;
    const mem = new Map<string, string>([
      [STORAGE_KEY, JSON.stringify({ state: { habits: [], completions: {}, settings: { theme: 'light', installHintDismissed: true } }, version: 0 })],
    ]);
    try {
      useStore.persist.setOptions({ storage: memoryStorage(mem) });
      await useStore.persist.rehydrate();
      expect(store().settings).toEqual({ theme: 'light', installHintDismissed: true });
      const written = JSON.parse(mem.get(STORAGE_KEY) ?? 'null') as StorageValue<Persisted>;
      expect(written.version).toBe(2);
    } finally {
      useStore.persist.setOptions({ storage: original });
    }
  });

  it('ignores an absent or malformed record and keeps the defaults', async () => {
    const original = useStore.persist.getOptions().storage;
    if (!original) return;
    try {
      useStore.persist.setOptions({ storage: memoryStorage(new Map()) });
      await useStore.persist.rehydrate();
      expect(store().habits).toEqual([]);
      expect(store().settings).toEqual(DEFAULT_SETTINGS);

      const broken = new Map<string, string>([
        [STORAGE_KEY, JSON.stringify({ state: { habits: 'nope', completions: [], settings: null }, version: 1 })],
      ]);
      useStore.persist.setOptions({ storage: memoryStorage(broken) });
      await useStore.persist.rehydrate();
      expect(store().habits).toEqual([]);
      expect(store().completions).toEqual({});
      expect(store().settings).toEqual(DEFAULT_SETTINGS);
    } finally {
      useStore.persist.setOptions({ storage: original });
    }
  });
});

describe('addHabit', () => {
  it('fills id, order, createdAt and normalises input', () => {
    const h = store().addHabit({ name: '  Gym ', emoji: ' 🏋️ ', color: 'terracotta', days: [4, 0, 0, 2], note: '  ' });
    expect(h.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.name).toBe('Gym');
    expect(h.emoji).toBe('🏋️');
    expect(h.days).toEqual([0, 2, 4]);
    expect(h.createdAt).toBe(TODAY);
    expect(h.order).toBe(0);
    expect(h.note).toBeUndefined();
    expect(h).not.toHaveProperty('note');
    expect(h).not.toHaveProperty('archivedAt');
    expect(store().habits).toEqual([h]);
  });

  it('increments order and keeps a trimmed note and explicit createdAt', () => {
    store().addHabit({ name: 'A', emoji: 'a', color: 'sage', days: [0] });
    const second = store().addHabit({ name: 'B', emoji: 'b', color: 'plum', days: [1], note: ' 2 hours ', createdAt: '2026-01-01' });
    expect(second.order).toBe(1);
    expect(second.note).toBe('2 hours');
    expect(second.createdAt).toBe('2026-01-01');
  });

  it('order is max + 1, not the count (gaps after a delete are not reused)', () => {
    const a = add('A');
    add('B');
    store().deleteHabit(a.id);
    expect(add('C').order).toBe(2);
    expect(store().habits.map((h) => h.order)).toEqual([1, 2]);
  });

  it('an empty day selection falls back to every day (the data model requires ≥ 1 day)', () => {
    const h = add('A', { days: [] });
    expect(h.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(dueHabits(store().habits, TODAY)).toEqual([h]);
  });

  it('ids are unique and the returned habit is the stored one', () => {
    const ids = new Set(Array.from({ length: 25 }, (_, i) => add(`H${i}`).id));
    expect(ids.size).toBe(25);
    expect(store().habits).toHaveLength(25);
    expect(store().habits.map((h) => h.order)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('a new tracker is due today when today is in its days', () => {
    const h = add('A', { days: [0, 1, 2, 3, 4, 5, 6] });
    expect(dueHabits(store().habits, TODAY).map((x) => x.id)).toEqual([h.id]);
    expect(dueHabits(store().habits, addDays(TODAY, -1))).toEqual([]); // not before createdAt
  });
});

describe('updateHabit', () => {
  it('patches fields and normalises days, removes an emptied note', () => {
    const h = store().addHabit({ name: 'A', emoji: 'a', color: 'sage', days: [0], note: 'x' });
    store().updateHabit(h.id, { name: ' Renamed ', days: [6, 6, 1], note: '' });
    const updated = store().habits[0];
    expect(updated?.name).toBe('Renamed');
    expect(updated?.days).toEqual([1, 6]);
    expect(updated?.note).toBeUndefined();
    expect(updated).not.toHaveProperty('note');
    expect(updated?.id).toBe(h.id);
    expect(updated?.createdAt).toBe(h.createdAt);
    expect(updated?.order).toBe(h.order);
  });

  it('changes colour, emoji and note independently', () => {
    const h = add('A');
    store().updateHabit(h.id, { color: 'rose' });
    expect(store().habits[0]?.color).toBe('rose');
    store().updateHabit(h.id, { emoji: ' 📚 ' });
    expect(store().habits[0]?.emoji).toBe('📚');
    store().updateHabit(h.id, { note: ' by 8 AM ' });
    expect(store().habits[0]?.note).toBe('by 8 AM');
    expect(store().habits[0]?.name).toBe('A');
    store().updateHabit(h.id, { note: undefined });
    expect(store().habits[0]).not.toHaveProperty('note');
  });

  it('ignores explicit undefined for required fields (a sparse patch cannot blank a tracker)', () => {
    const h = add('A', { note: 'keep' });
    store().updateHabit(h.id, { name: undefined, emoji: undefined, color: undefined, days: undefined });
    expect(store().habits[0]).toEqual(h);
    expect(validateAppData(store().exportData()).ok).toBe(true);
  });

  it('an empty days patch falls back to every day', () => {
    const h = add('A');
    store().updateHabit(h.id, { days: [] });
    expect(store().habits[0]?.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('sets and clears archivedAt through the patch', () => {
    const h = add('A');
    store().updateHabit(h.id, { archivedAt: '2026-10-10' });
    expect(store().habits[0]?.archivedAt).toBe('2026-10-10');
    expect(archivedHabits(store().habits)).toHaveLength(1);
    store().updateHabit(h.id, { archivedAt: undefined });
    expect(store().habits[0]).not.toHaveProperty('archivedAt');
    expect(activeHabits(store().habits)).toHaveLength(1);
  });

  it('leaves other trackers and unknown ids alone', () => {
    const a = add('A');
    const b = add('B');
    store().updateHabit(b.id, { name: 'Bee' });
    store().updateHabit('missing', { name: 'Ghost' });
    expect(store().habits[0]).toEqual(a);
    expect(store().habits[1]?.name).toBe('Bee');
    expect(store().habits).toHaveLength(2);
  });

  it('never changes id, createdAt or order', () => {
    const h = add('A', { createdAt: '2026-01-01' });
    store().updateHabit(h.id, { name: 'B', days: [3] });
    const u = store().habits[0];
    expect([u?.id, u?.createdAt, u?.order]).toEqual([h.id, '2026-01-01', 0]);
  });
});

describe('archiveHabit / unarchiveHabit', () => {
  it('archives with today and unarchives by clearing the field', () => {
    const h = add('A');
    store().archiveHabit(h.id);
    expect(store().habits[0]?.archivedAt).toBe(TODAY);
    expect(activeHabits(store().habits)).toEqual([]);
    expect(archivedHabits(store().habits).map((x) => x.id)).toEqual([h.id]);
    store().unarchiveHabit(h.id);
    expect(store().habits[0]).not.toHaveProperty('archivedAt');
    expect(activeHabits(store().habits).map((x) => x.id)).toEqual([h.id]);
  });

  it('an archived tracker drops out of dueHabits from today on and keeps its history', () => {
    const h = add('A', { days: [0, 1, 2, 3, 4, 5, 6], createdAt: addDays(TODAY, -3) });
    for (let i = 1; i <= 3; i += 1) store().setCompletion(h.id, addDays(TODAY, -i), true);
    store().archiveHabit(h.id);
    expect(dueHabits(store().habits, TODAY)).toEqual([]);
    expect(dueHabits(store().habits, addDays(TODAY, -1)).map((x) => x.id)).toEqual([h.id]);
    expect(currentStreak(store().habits[0] as Habit, store().completions, TODAY)).toBe(3);
    expect(store().completions[h.id]).toBeDefined();
  });

  it("archiving after today's check-in keeps that day scheduled: archivedAt moves to tomorrow", () => {
    const h = add('Study', { days: EVERY_DAY, createdAt: addDays(TODAY, -7) }); // 8 days including today
    store().setCompletion(h.id, addDays(TODAY, -1), true);
    store().setCompletion(h.id, TODAY, true);
    expect(currentStreak(h, store().completions, TODAY)).toBe(2);

    store().archiveHabit(h.id);
    const archived = store().habits[0] as Habit;
    expect(archived.archivedAt).toBe(addDays(TODAY, 1));
    expect(activeHabits(store().habits)).toEqual([]);
    expect(archivedHabits(store().habits).map((x) => x.id)).toEqual([h.id]);
    expect(isScheduled(archived, TODAY)).toBe(true);
    expect(isScheduled(archived, addDays(TODAY, 1))).toBe(false);
    // The history reads as it did a moment earlier: a 2-day streak, 2 of 8 due, no bonus.
    expect(currentStreak(archived, store().completions, TODAY)).toBe(2);
    expect(bestStreak(archived, store().completions, TODAY)).toBe(2);
    expect(completionStats(archived, store().completions, archived.createdAt, TODAY)).toEqual({
      due: 8,
      done: 2,
      bonus: 0,
      rate: 0.25,
    });
    expect(validateAppData(store().exportData()).ok).toBe(true);

    store().unarchiveHabit(h.id);
    expect(currentStreak(store().habits[0] as Habit, store().completions, TODAY)).toBe(2);
  });

  it('archiving on a pending day, or after a bonus, uses today: that day is neither due nor a miss', () => {
    const pending = add('Pending', { days: EVERY_DAY, createdAt: addDays(TODAY, -2) });
    store().setCompletion(pending.id, addDays(TODAY, -1), true);
    store().archiveHabit(pending.id);
    expect(store().habits[0]?.archivedAt).toBe(TODAY);
    expect(dueHabits(store().habits, TODAY)).toEqual([]);
    expect(currentStreak(store().habits[0] as Habit, store().completions, TODAY)).toBe(1);

    const bonus = add('Bonus', { days: EVERY_DAY.filter((d) => d !== weekdayOf(TODAY)), createdAt: addDays(TODAY, -7) });
    store().setCompletion(bonus.id, TODAY, true); // not scheduled today, so a bonus
    store().archiveHabit(bonus.id);
    const archived = store().habits[1] as Habit;
    expect(archived.archivedAt).toBe(TODAY);
    expect(isScheduled(archived, TODAY)).toBe(false);
    expect(completionStats(archived, store().completions, archived.createdAt, TODAY)).toMatchObject({ bonus: 1, done: 0 });
  });

  it('archiving twice keeps the original archivedAt', () => {
    const h = add('A');
    store().updateHabit(h.id, { archivedAt: '2026-10-01' });
    store().archiveHabit(h.id);
    expect(store().habits[0]?.archivedAt).toBe('2026-10-01');
  });

  it('unarchiving an active tracker and unknown ids are no-ops', () => {
    const h = add('A');
    store().unarchiveHabit(h.id);
    store().unarchiveHabit('missing');
    store().archiveHabit('missing');
    expect(store().habits).toEqual([h]);
  });
});

describe('deleteHabit', () => {
  it('removes the habit and its completions', () => {
    const a = add('A');
    const b = add('B');
    store().setCompletion(a.id, '2026-10-05', true);
    store().setCompletion(b.id, '2026-10-05', true);
    store().deleteHabit(a.id);
    expect(store().habits.map((h) => h.id)).toEqual([b.id]);
    expect(store().completions).toEqual({ [b.id]: { '2026-10-05': true } });
  });

  it('removes an archived habit too, and ignores unknown ids', () => {
    const a = add('A');
    store().archiveHabit(a.id);
    store().deleteHabit('missing');
    expect(store().habits).toHaveLength(1);
    store().deleteHabit(a.id);
    expect(store().habits).toEqual([]);
    expect(store().completions).toEqual({});
  });

  it('leaves no orphan completions, so the export always re-imports', () => {
    const a = add('A');
    store().setCompletion(a.id, '2026-10-05', true);
    store().deleteHabit(a.id);
    expect(validateAppData(store().exportData())).toEqual({ ok: true, data: expect.anything() as unknown });
  });
});

describe('reorderHabits', () => {
  it('assigns 0..n-1 in the given sequence; unlisted ids keep their relative order after', () => {
    const a = add('A');
    const b = add('B');
    const c = add('C');
    const d = add('D');
    store().reorderHabits([c.id, a.id, 'missing', c.id]);
    const orders = Object.fromEntries(store().habits.map((h) => [h.name, h.order]));
    expect(orders).toEqual({ C: 0, A: 1, B: 2, D: 3 });
    expect(store().habits.map((h) => h.id)).toEqual([c.id, a.id, b.id, d.id]);
  });

  it('a full sequence reverses the list', () => {
    const ids = [add('A'), add('B'), add('C')].map((h) => h.id);
    store().reorderHabits([...ids].reverse());
    expect(activeHabits(store().habits).map((h) => h.id)).toEqual([...ids].reverse());
    expect(activeHabits(store().habits).map((h) => h.order)).toEqual([0, 1, 2]);
  });

  it('an empty list compacts order gaps left by a delete', () => {
    const a = add('A');
    const b = add('B');
    const c = add('C');
    store().deleteHabit(b.id);
    expect(store().habits.map((h) => h.order)).toEqual([0, 2]);
    store().reorderHabits([]);
    expect(store().habits.map((h) => [h.id, h.order])).toEqual([
      [a.id, 0],
      [c.id, 1],
    ]);
  });

  it('the ▲▼ flow: swapping two active ids leaves archived trackers after them', () => {
    const a = add('A');
    const b = add('B');
    const c = add('C');
    store().archiveHabit(a.id);
    const ids = activeHabits(store().habits).map((h) => h.id);
    expect(ids).toEqual([b.id, c.id]);
    [ids[0], ids[1]] = [ids[1] ?? '', ids[0] ?? ''];
    store().reorderHabits(ids);
    expect(activeHabits(store().habits).map((h) => h.id)).toEqual([c.id, b.id]);
    expect(store().habits.find((h) => h.id === a.id)?.order).toBe(2);
    expect(store().habits.map((h) => h.order).sort()).toEqual([0, 1, 2]);
  });

  it('does not alter anything but order', () => {
    const a = add('A', { note: 'n', days: [2, 4] });
    const b = add('B');
    store().setCompletion(a.id, '2026-10-05', true);
    store().reorderHabits([b.id, a.id]);
    const moved = store().habits.find((h) => h.id === a.id);
    expect(moved).toEqual({ ...a, order: 1 });
    expect(store().completions).toEqual({ [a.id]: { '2026-10-05': true } });
  });
});

describe('completions', () => {
  it('toggles on and off, cleaning up empty records', () => {
    const h = add('A');
    store().toggleCompletion(h.id, '2026-10-05');
    expect(store().completions).toEqual({ [h.id]: { '2026-10-05': true } });
    store().toggleCompletion(h.id, '2026-10-06');
    store().toggleCompletion(h.id, '2026-10-05');
    expect(store().completions).toEqual({ [h.id]: { '2026-10-06': true } });
    store().toggleCompletion(h.id, '2026-10-06');
    expect(store().completions).toEqual({});
  });

  it('setCompletion is idempotent and ignores unknown habits', () => {
    const h = add('A');
    store().setCompletion(h.id, '2026-10-05', true);
    const before = store().completions;
    store().setCompletion(h.id, '2026-10-05', true);
    expect(store().completions).toBe(before);
    store().setCompletion('nope', '2026-10-05', true);
    store().toggleCompletion('nope', '2026-10-05');
    expect(store().completions).toBe(before);
    store().setCompletion(h.id, '2026-10-09', false);
    expect(store().completions).toBe(before);
  });

  it('ignores malformed date keys so the data always passes the importer', () => {
    const h = add('A');
    store().setCompletion(h.id, '2026-10-05', true);
    const before = store().completions;
    for (const bad of ['2026-13-01', '2026-10-1', '2026-02-30', 'today', '', '2026-10-05T00:00']) {
      store().setCompletion(h.id, bad, true);
      store().toggleCompletion(h.id, bad);
    }
    expect(store().completions).toBe(before);
    expect(validateAppData(store().exportData()).ok).toBe(true);
  });

  it('keeps records per habit and does not mutate previous state objects', () => {
    const a = add('A');
    const b = add('B');
    store().setCompletion(a.id, '2026-10-05', true);
    const snapshot = store().completions;
    store().setCompletion(b.id, '2026-10-05', true);
    expect(snapshot).toEqual({ [a.id]: { '2026-10-05': true } });
    expect(store().completions).toEqual({ [a.id]: { '2026-10-05': true }, [b.id]: { '2026-10-05': true } });
    expect(isDone(store().completions, a.id, '2026-10-05')).toBe(true);
    expect(isDone(store().completions, b.id, '2026-10-06')).toBe(false);
  });

  it('allows bonus completions on unscheduled days and on archived trackers', () => {
    const h = add('A', { days: [0] }); // Mondays only
    store().toggleCompletion(h.id, '2026-10-15'); // a Thursday
    expect(isDone(store().completions, h.id, '2026-10-15')).toBe(true);
    store().archiveHabit(h.id);
    store().toggleCompletion(h.id, TODAY);
    expect(isDone(store().completions, h.id, TODAY)).toBe(true);
  });
});

describe('settings', () => {
  it('setTheme and dismissInstallHint', () => {
    store().setTheme('dark');
    expect(store().settings.theme).toBe('dark');
    store().dismissInstallHint();
    expect(store().settings).toEqual({ theme: 'dark', installHintDismissed: true });
    store().setTheme('system');
    expect(store().settings).toEqual({ theme: 'system', installHintDismissed: true });
    store().dismissInstallHint();
    expect(store().settings.installHintDismissed).toBe(true);
  });

  it('settings changes do not touch habits or completions', () => {
    const h = add('A');
    store().setCompletion(h.id, '2026-10-05', true);
    const habits = store().habits;
    const completions = store().completions;
    store().setTheme('light');
    store().dismissInstallHint();
    expect(store().habits).toBe(habits);
    expect(store().completions).toBe(completions);
  });
});

describe('export / import', () => {
  it('exportData has exactly the AppData shape with an ISO timestamp', () => {
    const h = add('A');
    store().setCompletion(h.id, '2026-10-05', true);
    const data = store().exportData();
    expect(Object.keys(data).sort()).toEqual(['completions', 'deletedIds', 'exportedAt', 'habits', 'settings', 'version']);
    expect(data.version).toBe(1);
    expect(data.habits).toEqual([h]);
    expect(data.completions).toEqual({ [h.id]: { '2026-10-05': true } });
    expect(data.settings).toEqual(DEFAULT_SETTINGS);
    expect(data.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(() => new Date(data.exportedAt ?? '').toISOString()).not.toThrow();
  });

  it('round-trips through JSON', () => {
    const h = store().addHabit({ name: 'A', emoji: 'a', color: 'sage', days: [0, 3] });
    store().setCompletion(h.id, '2026-10-05', true);
    const json = JSON.stringify(store().exportData());
    store().resetAll();
    expect(store().importData(JSON.parse(json))).toEqual({ ok: true });
    expect(store().habits).toEqual([h]);
    expect(store().completions).toEqual({ [h.id]: { '2026-10-05': true } });
  });

  it('round-trips archived trackers, notes, bonus completions and settings', () => {
    const a = add('A', { note: '2 hours', days: [0, 2, 4], createdAt: '2026-09-01' });
    const b = add('B', { color: 'graphite' });
    store().setCompletion(a.id, '2026-10-06', true); // Tuesday bonus
    store().setCompletion(a.id, '2026-10-05', true);
    store().archiveHabit(b.id);
    store().setTheme('dark');
    store().dismissInstallHint();
    const exported = store().exportData();
    const json = JSON.stringify(exported);
    store().resetAll();
    expect(store().importData(JSON.parse(json))).toEqual({ ok: true });
    expect(store().habits).toEqual(exported.habits);
    expect(store().completions).toEqual(exported.completions);
    expect(store().settings).toEqual({ theme: 'dark', installHintDismissed: true });
    expect(store().habits[1]?.archivedAt).toBe(TODAY);
  });

  it('a valid backup replaces everything, including settings and old completions', () => {
    const old = add('Old', { color: 'rose' });
    store().setCompletion(old.id, '2026-10-05', true);
    expect(store().importData(validBackup())).toEqual({ ok: true });
    expect(store().habits.map((h) => h.name)).toEqual(['Gym', 'Read']);
    expect(store().habits[1]?.archivedAt).toBe('2026-10-10');
    expect(store().completions).toEqual({ a: { '2026-10-05': true, '2026-10-07': true }, b: { '2026-09-20': true } });
    expect(store().completions).not.toHaveProperty(old.id);
    expect(store().settings).toEqual({ theme: 'dark', installHintDismissed: true });
  });

  it('accepts a backup without exportedAt and ignores unknown top-level keys', () => {
    const data: Record<string, unknown> = { ...validBackup(), extra: 'ignored' };
    delete data.exportedAt;
    expect(store().importData(data)).toEqual({ ok: true });
    expect(store().habits).toHaveLength(2);
  });

  it('drops empty completion records on import', () => {
    const data = validBackup();
    data.completions.b = {};
    expect(store().importData(data)).toEqual({ ok: true });
    expect(store().completions).not.toHaveProperty('b');
    expect(store().completions.a).toEqual({ '2026-10-05': true, '2026-10-07': true });
  });

  it('keeps a tracker whose note or archivedAt is absent, and drops an empty note', () => {
    const data = validBackup();
    data.habits[0]!.note = '';
    expect(store().importData(data)).toEqual({ ok: true });
    expect(store().habits[0]).not.toHaveProperty('note');
    expect(store().habits[0]).not.toHaveProperty('archivedAt');
  });

  it('accepts name, note and emoji at the editor limits and trims them on import, like addHabit', () => {
    expect([HABIT_NAME_MAX, HABIT_NOTE_MAX, HABIT_EMOJI_MAX]).toEqual([40, 40, 16]);
    const data = validBackup();
    data.habits[0]!.name = `  ${'n'.repeat(HABIT_NAME_MAX)}  `; // over 40 only because of the padding
    data.habits[0]!.note = `  ${'m'.repeat(HABIT_NOTE_MAX)}  `;
    data.habits[0]!.emoji = ' 👨‍👩‍👧‍👦 '; // 11 UTF-16 units once trimmed
    data.habits[1]!.note = '   ';
    expect(store().importData(data)).toEqual({ ok: true });
    expect(store().habits[0]?.name).toBe('n'.repeat(HABIT_NAME_MAX));
    expect(store().habits[0]?.note).toBe('m'.repeat(HABIT_NOTE_MAX));
    expect(store().habits[0]?.emoji).toBe('👨‍👩‍👧‍👦');
    expect(store().habits[1]).not.toHaveProperty('note');
    expect(validateAppData(store().exportData()).ok).toBe(true);
  });

  it.each<[string, (d: AppData) => unknown, RegExp]>([
    ['not an object', () => null, /JSON object/],
    ['undefined', () => undefined, /JSON object/],
    ['an array', () => [], /JSON object/],
    ['a string', () => '{}', /JSON object/],
    ['a number', () => 1, /JSON object/],
    ['wrong version', (d) => ({ ...d, version: 2 }), /version/],
    ['string version', (d) => ({ ...d, version: '1' }), /version/],
    ['missing version', (d) => ({ ...d, version: undefined }), /version/],
    ['habits not an array', (d) => ({ ...d, habits: {} }), /habits/],
    ['habits missing', (d) => ({ ...d, habits: undefined }), /habits/],
    ['habit not an object', (d) => ({ ...d, habits: [1] }), /Tracker #1/],
    ['habit null', (d) => ({ ...d, habits: [null] }), /Tracker #1/],
    ['habit without id', (d) => ({ ...d, habits: [{ ...d.habits[0], id: '' }] }), /id/],
    ['habit id not a string', (d) => ({ ...d, habits: [{ ...d.habits[0], id: 7 }] }), /id/],
    ['habit id __proto__', (d) => ({ ...d, habits: [{ ...d.habits[0], id: '__proto__' }], completions: {} }), /id/],
    ['habit id constructor', (d) => ({ ...d, habits: [{ ...d.habits[0], id: 'constructor' }], completions: {} }), /id/],
    ['duplicate ids', (d) => ({ ...d, habits: [d.habits[0], { ...d.habits[1], id: 'a' }] }), /duplicates/],
    ['empty name', (d) => ({ ...d, habits: [{ ...d.habits[0], name: '  ' }] }), /name/],
    ['missing name', (d) => ({ ...d, habits: [{ ...d.habits[0], name: undefined }] }), /name/],
    ['non-string emoji', (d) => ({ ...d, habits: [{ ...d.habits[0], emoji: 1 }] }), /emoji/],
    ['unknown colour', (d) => ({ ...d, habits: [{ ...d.habits[0], color: 'purple' }] }), /colour/],
    ['missing colour', (d) => ({ ...d, habits: [{ ...d.habits[0], color: undefined }] }), /colour/],
    ['empty days', (d) => ({ ...d, habits: [{ ...d.habits[0], days: [] }] }), /days/],
    ['days not an array', (d) => ({ ...d, habits: [{ ...d.habits[0], days: 0 }] }), /days/],
    ['day out of range', (d) => ({ ...d, habits: [{ ...d.habits[0], days: [0, 7] }] }), /days/],
    ['negative day', (d) => ({ ...d, habits: [{ ...d.habits[0], days: [-1] }] }), /days/],
    ['non-integer day', (d) => ({ ...d, habits: [{ ...d.habits[0], days: [1.5] }] }), /days/],
    ['string day', (d) => ({ ...d, habits: [{ ...d.habits[0], days: ['1'] }] }), /days/],
    ['duplicate days', (d) => ({ ...d, habits: [{ ...d.habits[0], days: [0, 0, 2] }] }), /repeated/],
    ['unsorted days', (d) => ({ ...d, habits: [{ ...d.habits[0], days: [4, 0, 2] }] }), /out of order/],
    ['bad createdAt', (d) => ({ ...d, habits: [{ ...d.habits[0], createdAt: 'yesterday' }] }), /createdAt/],
    ['missing createdAt', (d) => ({ ...d, habits: [{ ...d.habits[0], createdAt: undefined }] }), /createdAt/],
    ['impossible createdAt', (d) => ({ ...d, habits: [{ ...d.habits[0], createdAt: '2026-02-30' }] }), /createdAt/],
    ['ISO createdAt', (d) => ({ ...d, habits: [{ ...d.habits[0], createdAt: '2026-10-01T00:00:00.000Z' }] }), /createdAt/],
    ['bad archivedAt', (d) => ({ ...d, habits: [{ ...d.habits[0], archivedAt: '2026/10/10' }] }), /archivedAt/],
    ['null archivedAt', (d) => ({ ...d, habits: [{ ...d.habits[0], archivedAt: null }] }), /archivedAt/],
    ['non-numeric order', (d) => ({ ...d, habits: [{ ...d.habits[0], order: '0' }] }), /order/],
    ['NaN order', (d) => ({ ...d, habits: [{ ...d.habits[0], order: Number.NaN }] }), /order/],
    ['missing order', (d) => ({ ...d, habits: [{ ...d.habits[0], order: undefined }] }), /order/],
    ['non-string note', (d) => ({ ...d, habits: [{ ...d.habits[0], note: 5 }] }), /note/],
    ['a 41-character name', (d) => ({ ...d, habits: [{ ...d.habits[0], name: 'x'.repeat(41) }] }), /name longer than 40/],
    ['a 100k-character name', (d) => ({ ...d, habits: [{ ...d.habits[0], name: 'x'.repeat(100_000) }] }), /name longer than 40/],
    ['a 41-character note', (d) => ({ ...d, habits: [{ ...d.habits[0], note: 'y'.repeat(41) }] }), /note longer than 40/],
    ['a 100k-character note', (d) => ({ ...d, habits: [{ ...d.habits[0], note: 'y'.repeat(100_000) }] }), /note longer than 40/],
    ['an emoji over 16 UTF-16 units', (d) => ({ ...d, habits: [{ ...d.habits[0], emoji: '🏋️'.repeat(6) }] }), /emoji longer than 16/],
    ['a 100k-character emoji', (d) => ({ ...d, habits: [{ ...d.habits[0], emoji: '🏋️'.repeat(100_000) }] }), /emoji longer than 16/],
    ['completions not an object', (d) => ({ ...d, completions: [] }), /completions/],
    ['completions missing', (d) => ({ ...d, completions: undefined }), /completions/],
    ['orphan completions', (d) => ({ ...d, completions: { ...d.completions, zzz: { '2026-10-01': true } } }), /unknown tracker/],
    ['completion record not an object', (d) => ({ ...d, completions: { a: ['2026-10-01'] } }), /must be an object/],
    ['completion record null', (d) => ({ ...d, completions: { a: null } }), /must be an object/],
    ['invalid completion date', (d) => ({ ...d, completions: { a: { '2026-10-1': true } } }), /date/],
    ['impossible completion date', (d) => ({ ...d, completions: { a: { '2026-02-30': true } } }), /date/],
    ['completion value not true', (d) => ({ ...d, completions: { a: { '2026-10-01': false } } }), /true/],
    ['completion value 1', (d) => ({ ...d, completions: { a: { '2026-10-01': 1 } } }), /true/],
    ['settings missing', (d) => ({ ...d, settings: undefined }), /settings/],
    ['settings an array', (d) => ({ ...d, settings: [] }), /settings/],
    ['unknown theme', (d) => ({ ...d, settings: { ...d.settings, theme: 'blue' } }), /theme/],
    ['missing theme', (d) => ({ ...d, settings: { installHintDismissed: true } }), /theme/],
    ['installHintDismissed not boolean', (d) => ({ ...d, settings: { ...d.settings, installHintDismissed: 'yes' } }), /installHintDismissed/],
    ['exportedAt not a string', (d) => ({ ...d, exportedAt: 123 }), /exportedAt/],
  ])('rejects %s and leaves the store untouched', (_label, mutate, message) => {
    const existing = add('Keep', { color: 'moss', days: [2] });
    store().setCompletion(existing.id, '2026-10-14', true);
    store().setTheme('light');
    const habitsBefore = store().habits;
    const completionsBefore = store().completions;
    const settingsBefore = store().settings;

    const result = store().importData(mutate(validBackup()));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
      expect(result.error).toMatch(message);
    }
    expect(store().habits).toBe(habitsBefore);
    expect(store().completions).toBe(completionsBefore);
    expect(store().settings).toBe(settingsBefore);
    expect(store().habits).toEqual([existing]);
  });

  it('importing a malformed backup never mutates the raw input', () => {
    const raw = validBackup();
    (raw.habits[0] as unknown as Record<string, unknown>).color = 'purple';
    const snapshot = JSON.stringify(raw);
    expect(store().importData(raw).ok).toBe(false);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it('import does not share object identity with the raw input', () => {
    const raw = validBackup();
    expect(store().importData(raw)).toEqual({ ok: true });
    raw.habits[0]!.name = 'Mutated';
    (raw.completions.a as Record<string, true>)['2026-10-09'] = true;
    expect(store().habits[0]?.name).toBe('Gym');
    expect(store().completions.a).toEqual({ '2026-10-05': true, '2026-10-07': true });
  });

  it('validateAppData returns normalised data for a good backup', () => {
    const result = validateAppData(validBackup());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe(1);
      expect(result.data.habits).toHaveLength(2);
      expect(result.data.habits[1]?.note).toBe('20 pages');
      expect(result.data.habits[1]?.archivedAt).toBe('2026-10-10');
      expect(result.data.exportedAt).toBe('2026-10-16T12:00:00.000Z');
      expect(result.data.settings).toEqual({ theme: 'dark', installHintDismissed: true });
    }
  });

  it('validateAppData is a preview: it does not change the store', () => {
    const h = add('A');
    validateAppData(validBackup());
    expect(store().habits).toEqual([h]);
  });

  it('every store-produced export passes validateAppData', () => {
    const a = add('A', { days: [6, 0, 6], note: ' x ' });
    const b = add('B', { days: [] });
    store().setCompletion(a.id, '2026-10-05', true);
    store().toggleCompletion(b.id, TODAY);
    store().archiveHabit(a.id);
    store().reorderHabits([b.id]);
    store().updateHabit(b.id, { name: ' Renamed ', days: [3, 3] });
    const result = validateAppData(JSON.parse(JSON.stringify(store().exportData())));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.habits).toEqual(store().habits);
      expect(result.data.completions).toEqual(store().completions);
    }
  });

  it('normalizeDays dedupes and sorts', () => {
    expect(normalizeDays([6, 0, 3, 0, 6])).toEqual([0, 3, 6]);
    expect(normalizeDays([])).toEqual([]);
    expect(normalizeDays([0, 1, 2, 3, 4, 5, 6])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const input: (0 | 1 | 2 | 3 | 4 | 5 | 6)[] = [2, 1];
    normalizeDays(input);
    expect(input).toEqual([2, 1]); // does not mutate
  });
});

describe('when localStorage rejects a write', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('importData reports the failure and keeps the previous data instead of claiming success', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    const keep = add('Keep', { color: 'moss', days: [2] });
    store().setCompletion(keep.id, '2026-10-14', true);
    const savedRecord = local.getItem(STORAGE_KEY);
    expect(savedRecord).toContain('Keep');
    expect(lastStorageError()).toBeNull();
    const habitsBefore = store().habits;
    const completionsBefore = store().completions;
    const settingsBefore = store().settings;

    local.failure = quotaError();
    expect(store().importData(validBackup())).toEqual({
      ok: false,
      error: 'This backup is too large to store on this device.',
    });
    expect(store().habits).toBe(habitsBefore);
    expect(store().completions).toBe(completionsBefore);
    expect(store().settings).toBe(settingsBefore);
    expect(local.getItem(STORAGE_KEY)).toBe(savedRecord); // the device still holds the previous record
    expect(lastStorageError()?.name).toBe('QuotaExceededError');

    // Once writes work again the next change lands and the flag clears.
    local.failure = null;
    store().setTheme('dark');
    expect(lastStorageError()).toBeNull();
    const written = JSON.parse(local.getItem(STORAGE_KEY) ?? 'null') as StorageValue<Persisted>;
    expect(written.state.settings.theme).toBe('dark');
    expect(written.state.habits).toEqual([keep]);
  });

  it('importData succeeds and the record reaches localStorage when the write lands', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    expect(store().importData(validBackup())).toEqual({ ok: true });
    const written = JSON.parse(local.getItem(STORAGE_KEY) ?? 'null') as StorageValue<Persisted>;
    expect(written.state.habits.map((h) => h.name)).toEqual(['Gym', 'Read']);
    expect(written.state.settings).toEqual({ theme: 'dark', installHintDismissed: true });
    expect(lastStorageError()).toBeNull();
  });

  it('a write failure that is not about quota gets its own message', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    local.failure = new Error('The operation is insecure.');
    const result = store().importData(validBackup());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not saving changes/);
    expect(store().habits).toEqual([]);
    expect(lastStorageError()?.message).toBe('The operation is insecure.');
  });

  it('other actions keep working in memory and record the failure instead of throwing', () => {
    const local = fakeLocalStorage();
    vi.stubGlobal('localStorage', local);
    local.failure = quotaError();
    expect(() => add('A')).not.toThrow();
    expect(() => store().toggleCompletion(store().habits[0]?.id ?? '', TODAY)).not.toThrow();
    expect(store().habits).toHaveLength(1);
    expect(isDone(store().completions, store().habits[0]?.id ?? '', TODAY)).toBe(true);
    expect(lastStorageError()?.name).toBe('QuotaExceededError');
  });
});

describe('resetAll', () => {
  it('restores the defaults', () => {
    const h = add('A');
    store().setCompletion(h.id, '2026-10-05', true);
    store().setTheme('light');
    store().dismissInstallHint();
    store().resetAll();
    expect(store().habits).toEqual([]);
    expect(store().completions).toEqual({});
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
    expect(typeof store().addHabit).toBe('function');
  });

  it('is idempotent and produces fresh settings each time', () => {
    store().resetAll();
    const first = store().settings;
    store().resetAll();
    expect(store().settings).toEqual(first);
    expect(store().settings).not.toBe(DEFAULT_SETTINGS);
  });
});
