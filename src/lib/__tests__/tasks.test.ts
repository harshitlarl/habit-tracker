import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_NOTE_MAX,
  TASK_TITLE_MAX,
  TIME_RE,
  carriedOver,
  carriedOverDone,
  compareTasks,
  formatTime,
  isTimeString,
  nextWeekdayKey,
  quickDates,
  relativeDayLabel,
  sortTasks,
  taskStatus,
  tasksForToday,
  tasksInWeek,
  tasksOn,
} from '../tasks';
import { addDays, diffDays, weekKeys, weekdayOf } from '../dates';
import type { DateKey, Task, Weekday } from '../types';

/*
 * Calendar facts for 2026 used below (tests run with TZ=America/New_York, see vitest.config.ts):
 * 2026-10-17 is a Saturday; 2026-10-19 … 2026-10-25 is a Mon–Sun week; 2026-09-28 … 2026-10-04 is the
 * week that crosses the September/October boundary; DST starts Sunday 2026-03-08 (week 03-02 … 03-08)
 * and ends Sunday 2026-11-01 (week 10-26 … 11-01).
 */

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  date: '2026-10-20',
  done: false,
  createdAt: '2026-10-17',
  ...over,
});

const ids = (list: readonly Task[]): string[] => list.map((t) => t.id);

/** Every task on its own tie level: earlier date, '00:00', '09:00', '15:00' × two createdAt, untimed × createdAt/id, later date. */
const ORDERED: Task[] = [
  task('e', { date: '2026-10-19' }),
  task('i', { time: '00:00' }),
  task('b', { time: '09:00' }),
  task('a', { time: '15:00', createdAt: '2026-10-16' }),
  task('c', { time: '15:00', createdAt: '2026-10-17' }),
  task('f', { createdAt: '2026-10-10' }),
  task('d', { createdAt: '2026-10-17' }),
  task('g', { createdAt: '2026-10-17' }),
  task('h', { date: '2026-10-21', time: '00:00' }),
];

/** A few deterministic shuffles of ORDERED. */
const PERMUTATIONS: Task[][] = [
  [...ORDERED].reverse(),
  [...ORDERED.slice(4), ...ORDERED.slice(0, 4)],
  ORDERED.filter((_, i) => i % 2 === 1).concat(ORDERED.filter((_, i) => i % 2 === 0)),
  [...ORDERED].sort((x, y) => (x.id > y.id ? -1 : 1)),
];

describe('re-exports', () => {
  it('exposes the task limits and the time check from types.ts', () => {
    expect(TASK_TITLE_MAX).toBe(60);
    expect(TASK_NOTE_MAX).toBe(80);
    expect(TIME_RE.test('07:05')).toBe(true);
    expect(isTimeString('23:59')).toBe(true);
    expect(isTimeString('24:00')).toBe(false);
    expect(isTimeString('9:00')).toBe(false);
    expect(isTimeString(900)).toBe(false);
  });
});

describe('compareTasks / sortTasks', () => {
  it('orders by date, then timed before untimed, then time, then createdAt, then id', () => {
    for (const permutation of PERMUTATIONS) {
      expect(ids(sortTasks(permutation))).toEqual(ids(ORDERED));
    }
  });

  it('puts an earlier date first even when the later one is timed', () => {
    const untimedEarlier = task('u', { date: '2026-10-19' });
    const timedLater = task('t', { date: '2026-10-20', time: '08:00' });
    expect(compareTasks(untimedEarlier, timedLater)).toBeLessThan(0);
    expect(compareTasks(timedLater, untimedEarlier)).toBeGreaterThan(0);
  });

  it('on the same day a timed task precedes an untimed one, including midnight', () => {
    expect(compareTasks(task('m', { time: '00:00' }), task('u'))).toBeLessThan(0);
    expect(compareTasks(task('u'), task('l', { time: '23:59' }))).toBeGreaterThan(0);
    expect(compareTasks(task('x', { time: '09:00' }), task('y', { time: '15:00' }))).toBeLessThan(0);
  });

  it('breaks ties on createdAt, then id, so the order is total', () => {
    expect(compareTasks(task('z', { createdAt: '2026-10-01' }), task('a', { createdAt: '2026-10-02' }))).toBeLessThan(0);
    expect(compareTasks(task('a'), task('b'))).toBeLessThan(0);
    expect(compareTasks(task('b'), task('a'))).toBeGreaterThan(0);
    expect(compareTasks(task('a'), task('a'))).toBe(0);
    for (const x of ORDERED) {
      for (const y of ORDERED) {
        expect(Math.sign(compareTasks(x, y)) + Math.sign(compareTasks(y, x))).toBe(0); // antisymmetric
        if (x !== y) expect(compareTasks(x, y)).not.toBe(0);
        for (const z of ORDERED) {
          if (compareTasks(x, y) < 0 && compareTasks(y, z) < 0) expect(compareTasks(x, z)).toBeLessThan(0);
        }
      }
    }
  });

  it('ignores done, title and note; sorting is stable for equal-by-key copies', () => {
    const a = task('a', { title: 'Zed', done: true, doneAt: '2026-10-21' });
    const b = task('b', { title: 'Alpha', note: 'n' });
    expect(compareTasks(a, b)).toBeLessThan(0);
    const twin = { ...a };
    expect(sortTasks([twin, a])).toEqual([twin, a]);
    expect(sortTasks([twin, a])[0]).toBe(twin);
  });

  it('returns a sorted copy and leaves the input untouched', () => {
    const input = [...ORDERED].reverse();
    const snapshot = [...input];
    const sorted = sortTasks(input);
    expect(sorted).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(ids(sorted)).toEqual(ids(ORDERED));
    expect(sortTasks([])).toEqual([]);
  });
});

describe('tasksOn', () => {
  const list = [
    task('later', { date: '2026-10-21' }),
    task('u2'),
    task('done', { time: '12:00', done: true, doneAt: '2026-10-20' }),
    task('u1', { createdAt: '2026-10-01' }),
    task('earlier', { date: '2026-10-19' }),
    task('t', { time: '08:30' }),
  ];

  it('returns every task planned for that day, done ones included, sorted', () => {
    expect(ids(tasksOn(list, '2026-10-20'))).toEqual(['t', 'done', 'u1', 'u2']);
    expect(ids(tasksOn(list, '2026-10-19'))).toEqual(['earlier']);
  });

  it('is empty for a day without tasks and never mutates the input', () => {
    const snapshot = [...list];
    expect(tasksOn(list, '2026-10-18')).toEqual([]);
    expect(tasksOn([], '2026-10-20')).toEqual([]);
    expect(list).toEqual(snapshot);
  });
});

describe('carriedOver', () => {
  const today: DateKey = '2026-10-20';
  const list = [
    task('today'),
    task('future', { date: '2026-10-22' }),
    task('old-done', { date: '2026-10-10', done: true, doneAt: '2026-10-19' }),
    task('yesterday-untimed', { date: '2026-10-19' }),
    task('oldest', { date: '2026-10-15' }),
    task('yesterday-timed', { date: '2026-10-19', time: '08:00' }),
  ];

  it('keeps only undone tasks dated before today, oldest first and sorted within a day', () => {
    expect(ids(carriedOver(list, today))).toEqual(['oldest', 'yesterday-timed', 'yesterday-untimed']);
  });

  it("excludes today's tasks, future tasks and anything already done", () => {
    expect(carriedOver([task('today'), task('future', { date: '2026-10-22' })], today)).toEqual([]);
    expect(carriedOver([task('late-done', { date: '2026-10-01', done: true })], today)).toEqual([]);
    expect(carriedOver([], today)).toEqual([]);
  });

  it('a task from the previous year still carries over', () => {
    expect(ids(carriedOver([task('old', { date: '2025-12-31' })], '2026-01-01'))).toEqual(['old']);
  });
});

describe('carriedOverDone', () => {
  const today: DateKey = '2026-10-20';

  it('lists only earlier-dated tasks checked off today, oldest first and sorted within a day', () => {
    const list = [
      task('today-done', { done: true, doneAt: today }),
      task('yesterday-open', { date: '2026-10-19' }),
      task('yesterday-done-today', { date: '2026-10-19', done: true, doneAt: today }),
      task('old-done-today', { date: '2026-10-12', time: '09:00', done: true, doneAt: today }),
      task('old-done-yesterday', { date: '2026-10-12', done: true, doneAt: '2026-10-19' }),
      task('old-done-on-time', { date: '2026-10-12', done: true, doneAt: '2026-10-12' }),
      task('future-done-early', { date: '2026-10-25', done: true, doneAt: today }),
    ];
    expect(ids(carriedOverDone(list, today))).toEqual(['old-done-today', 'yesterday-done-today']);
  });

  it('is disjoint from carriedOver and empty for no tasks', () => {
    const list = [task('open', { date: '2026-10-19' }), task('late', { date: '2026-10-19', done: true, doneAt: today })];
    const open = new Set(ids(carriedOver(list, today)));
    for (const id of ids(carriedOverDone(list, today))) expect(open.has(id)).toBe(false);
    expect(carriedOverDone([], today)).toEqual([]);
    // A done task without doneAt (repaired data) is not claimed for today.
    expect(carriedOverDone([task('no-stamp', { date: '2026-10-19', done: true })], today)).toEqual([]);
  });
});

describe('tasksForToday', () => {
  const today: DateKey = '2026-10-20';

  it('splits carried-over from scheduled and counts the undone items in both', () => {
    const list = [
      task('s-untimed'),
      task('s-done', { time: '15:00', done: true, doneAt: today }),
      task('s-timed', { time: '09:00' }),
      task('c-old', { date: '2026-10-15' }),
      task('c-yesterday', { date: '2026-10-19' }),
      task('future', { date: '2026-10-21' }),
      task('past-done', { date: '2026-10-18', done: true, doneAt: '2026-10-18' }),
    ];
    const result = tasksForToday(list, today);
    expect(ids(result.carried)).toEqual(['c-old', 'c-yesterday']);
    expect(ids(result.scheduled)).toEqual(['s-timed', 's-done', 's-untimed']);
    expect(result.openCount).toBe(4);
  });

  it('counts zero when everything today is done and nothing is carried', () => {
    const list = [task('a', { done: true, doneAt: today }), task('b', { time: '10:00', done: true, doneAt: today })];
    expect(tasksForToday(list, today)).toEqual({ carried: [], scheduled: sortTasks(list), openCount: 0 });
  });

  it('is empty for no tasks or only future tasks', () => {
    expect(tasksForToday([], today)).toEqual({ carried: [], scheduled: [], openCount: 0 });
    expect(tasksForToday([task('f', { date: '2026-10-25' })], today)).toEqual({ carried: [], scheduled: [], openCount: 0 });
  });

  it('carried-over tasks are all open, so they count even when timed', () => {
    const result = tasksForToday([task('c', { date: '2026-10-19', time: '07:00' })], today);
    expect(result.openCount).toBe(1);
    expect(result.carried).toHaveLength(1);
  });
});

describe('tasksInWeek', () => {
  it('groups by day in Monday → Sunday order, only for days that have tasks, each list sorted', () => {
    const list = [
      task('sun', { date: '2026-10-25' }),
      task('mon-untimed', { date: '2026-10-19' }),
      task('wed', { date: '2026-10-21', done: true, doneAt: '2026-10-21' }),
      task('mon-timed', { date: '2026-10-19', time: '18:00' }),
      task('before', { date: '2026-10-18' }),
      task('after', { date: '2026-10-26' }),
    ];
    const byDay = tasksInWeek(list, '2026-10-19');
    expect([...byDay.keys()]).toEqual(['2026-10-19', '2026-10-21', '2026-10-25']);
    expect(ids(byDay.get('2026-10-19') ?? [])).toEqual(['mon-timed', 'mon-untimed']);
    expect(ids(byDay.get('2026-10-21') ?? [])).toEqual(['wed']);
    expect(ids(byDay.get('2026-10-25') ?? [])).toEqual(['sun']);
    expect(byDay.has('2026-10-20')).toBe(false);
    expect(byDay.has('2026-10-18')).toBe(false);
    expect(byDay.has('2026-10-26')).toBe(false);
  });

  it('keeps Monday → Sunday order regardless of insertion order', () => {
    const days = weekKeys('2026-10-19');
    const list = [...days].reverse().map((date, i) => task(`d${i}`, { date }));
    expect([...tasksInWeek(list, '2026-10-19').keys()]).toEqual(days);
  });

  it('spans a month boundary (Mon 28 Sep → Sun 4 Oct)', () => {
    const list = [
      task('oct-4', { date: '2026-10-04' }),
      task('sep-30', { date: '2026-09-30' }),
      task('oct-1', { date: '2026-10-01', time: '15:00' }),
      task('oct-5', { date: '2026-10-05' }),
      task('sep-27', { date: '2026-09-27' }),
    ];
    const byDay = tasksInWeek(list, '2026-09-28');
    expect([...byDay.keys()]).toEqual(['2026-09-30', '2026-10-01', '2026-10-04']);
    expect(ids(byDay.get('2026-10-04') ?? [])).toEqual(['oct-4']);
  });

  it('includes the DST transition Sunday in its week and nothing from the next (spring forward)', () => {
    const list = [
      task('mon', { date: '2026-03-02' }),
      task('dst-sun', { date: '2026-03-08' }),
      task('next-mon', { date: '2026-03-09' }),
      task('prev-sun', { date: '2026-03-01' }),
    ];
    const byDay = tasksInWeek(list, '2026-03-02');
    expect([...byDay.keys()]).toEqual(['2026-03-02', '2026-03-08']);
    expect(ids(byDay.get('2026-03-08') ?? [])).toEqual(['dst-sun']);
  });

  it('includes the DST transition Sunday in its week and nothing from the next (fall back)', () => {
    const list = [
      task('sat', { date: '2026-10-31', time: '23:00' }),
      task('dst-sun', { date: '2026-11-01', time: '01:30' }),
      task('next-mon', { date: '2026-11-02' }),
    ];
    const byDay = tasksInWeek(list, '2026-10-26');
    expect([...byDay.keys()]).toEqual(['2026-10-31', '2026-11-01']);
    expect(byDay.has('2026-11-02')).toBe(false);
  });

  it('accepts any day of the week as the anchor and resolves it to that week', () => {
    const list = [task('a', { date: '2026-10-19' }), task('b', { date: '2026-10-25' })];
    expect([...tasksInWeek(list, '2026-10-21').entries()]).toEqual([...tasksInWeek(list, '2026-10-19').entries()]);
    expect([...tasksInWeek(list, '2026-10-25').keys()]).toEqual(['2026-10-19', '2026-10-25']);
  });

  it('is an empty map when the week has no tasks', () => {
    expect(tasksInWeek([], '2026-10-19').size).toBe(0);
    expect(tasksInWeek([task('x', { date: '2026-11-11' })], '2026-10-19').size).toBe(0);
  });
});

describe('taskStatus', () => {
  const today: DateKey = '2026-10-20';

  it('done wins whatever the date', () => {
    expect(taskStatus(task('a', { done: true, doneAt: today }), today)).toBe('done');
    expect(taskStatus(task('b', { date: '2026-10-01', done: true, doneAt: '2026-10-19' }), today)).toBe('done');
    expect(taskStatus(task('c', { date: '2026-12-01', done: true }), today)).toBe('done');
  });

  it("an undone task is open on its day, overdue before it, upcoming after it", () => {
    expect(taskStatus(task('a'), today)).toBe('open');
    expect(taskStatus(task('b', { date: '2026-10-19' }), today)).toBe('overdue');
    expect(taskStatus(task('c', { date: '2025-01-01' }), today)).toBe('overdue');
    expect(taskStatus(task('d', { date: '2026-10-21' }), today)).toBe('upcoming');
    expect(taskStatus(task('e', { date: '2027-01-01' }), today)).toBe('upcoming');
  });

  it('a time does not change the status', () => {
    expect(taskStatus(task('a', { time: '00:00' }), today)).toBe('open');
    expect(taskStatus(task('b', { date: '2026-10-19', time: '23:59' }), today)).toBe('overdue');
  });
});

describe('nextWeekdayKey', () => {
  it('finds the next occurrence after a Saturday for every weekday (same weekday → 7 days ahead)', () => {
    const saturday: DateKey = '2026-10-17';
    expect(weekdayOf(saturday)).toBe(5);
    const expected: Record<Weekday, DateKey> = {
      0: '2026-10-19',
      1: '2026-10-20',
      2: '2026-10-21',
      3: '2026-10-22',
      4: '2026-10-23',
      5: '2026-10-24',
      6: '2026-10-18',
    };
    for (const weekday of [0, 1, 2, 3, 4, 5, 6] as const) {
      expect(nextWeekdayKey(saturday, weekday)).toBe(expected[weekday]);
    }
  });

  it('is always 1–7 days ahead and lands on the requested weekday, from any day of a week', () => {
    for (const today of weekKeys('2026-10-19')) {
      for (const weekday of [0, 1, 2, 3, 4, 5, 6] as const) {
        const key = nextWeekdayKey(today, weekday);
        const ahead = diffDays(today, key);
        expect(ahead).toBeGreaterThanOrEqual(1);
        expect(ahead).toBeLessThanOrEqual(7);
        expect(weekdayOf(key)).toBe(weekday);
        if (weekday === weekdayOf(today)) expect(ahead).toBe(7);
      }
    }
  });

  it('crosses the DST start (Sunday 2026-03-08) and the month/DST end (Sunday 2026-11-01)', () => {
    expect(nextWeekdayKey('2026-03-07', 6)).toBe('2026-03-08');
    expect(nextWeekdayKey('2026-03-07', 0)).toBe('2026-03-09');
    expect(nextWeekdayKey('2026-03-07', 5)).toBe('2026-03-14');
    expect(nextWeekdayKey('2026-03-08', 6)).toBe('2026-03-15');
    expect(nextWeekdayKey('2026-10-30', 6)).toBe('2026-11-01');
    expect(nextWeekdayKey('2026-10-30', 0)).toBe('2026-11-02');
    expect(nextWeekdayKey('2026-10-30', 4)).toBe('2026-11-06');
    expect(nextWeekdayKey('2026-11-01', 6)).toBe('2026-11-08');
  });

  it('crosses a year boundary', () => {
    expect(weekdayOf('2026-12-31')).toBe(3); // a Thursday
    expect(nextWeekdayKey('2026-12-31', 3)).toBe('2027-01-07'); // Thursday → next Thursday
    expect(nextWeekdayKey('2026-12-31', 4)).toBe('2027-01-01'); // Friday
    expect(nextWeekdayKey('2026-12-31', 5)).toBe('2027-01-02');
  });
});

describe('quickDates', () => {
  it('lists today, tomorrow and the five days after that with short labels', () => {
    expect(quickDates('2026-10-17')).toEqual([
      { key: '2026-10-17', label: 'Today' },
      { key: '2026-10-18', label: 'Tomorrow' },
      { key: '2026-10-19', label: 'Mon 19' },
      { key: '2026-10-20', label: 'Tue 20' },
      { key: '2026-10-21', label: 'Wed 21' },
      { key: '2026-10-22', label: 'Thu 22' },
      { key: '2026-10-23', label: 'Fri 23' },
    ]);
  });

  it('crosses a month boundary with single-digit day numbers', () => {
    expect(quickDates('2026-10-29').map((q) => q.label)).toEqual([
      'Today',
      'Tomorrow',
      'Sat 31',
      'Sun 1',
      'Mon 2',
      'Tue 3',
      'Wed 4',
    ]);
    expect(quickDates('2026-10-29').map((q) => q.key)).toEqual([
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
  });

  it('neither skips nor repeats a day across the DST transitions', () => {
    const spring = quickDates('2026-03-06');
    expect(spring.map((q) => q.key)).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ]);
    expect(spring.map((q) => q.label)).toEqual(['Today', 'Tomorrow', 'Sun 8', 'Mon 9', 'Tue 10', 'Wed 11', 'Thu 12']);
    const autumn = quickDates('2026-10-30');
    expect(autumn.map((q) => q.key)).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
    expect(autumn[2]?.label).toBe('Sun 1');
  });

  it('crosses a year boundary', () => {
    expect(quickDates('2026-12-30').map((q) => `${q.key} ${q.label}`)).toEqual([
      '2026-12-30 Today',
      '2026-12-31 Tomorrow',
      '2027-01-01 Fri 1',
      '2027-01-02 Sat 2',
      '2027-01-03 Sun 3',
      '2027-01-04 Mon 4',
      '2027-01-05 Tue 5',
    ]);
  });

  it('keys are consecutive and the first is today, for any starting day', () => {
    for (const today of weekKeys('2026-10-26')) {
      const list = quickDates(today);
      expect(list).toHaveLength(7);
      list.forEach((q, i) => expect(q.key).toBe(addDays(today, i)));
    }
  });
});

describe('relativeDayLabel', () => {
  const today: DateKey = '2026-10-17'; // Saturday

  it('names today, tomorrow and yesterday', () => {
    expect(relativeDayLabel('2026-10-17', today)).toBe('Today');
    expect(relativeDayLabel('2026-10-18', today)).toBe('Tomorrow');
    expect(relativeDayLabel('2026-10-16', today)).toBe('Yesterday');
  });

  it('uses the weekday name from 2 to 6 days away, either way', () => {
    expect(relativeDayLabel('2026-10-19', today)).toBe('Monday'); // +2
    expect(relativeDayLabel('2026-10-23', today)).toBe('Friday'); // +6
    expect(relativeDayLabel('2026-10-15', today)).toBe('Thursday'); // -2
    expect(relativeDayLabel('2026-10-11', today)).toBe('Sunday'); // -6
  });

  it('switches to the dated form at exactly 7 days, either way', () => {
    expect(relativeDayLabel('2026-10-24', today)).toBe('Sat 24 Oct'); // +7
    expect(relativeDayLabel('2026-10-10', today)).toBe('Sat 10 Oct'); // -7
    expect(relativeDayLabel('2026-12-01', today)).toBe('Tue 1 Dec');
    expect(relativeDayLabel('2025-12-31', today)).toBe('Wed 31 Dec');
    expect(relativeDayLabel('2027-01-01', today)).toBe('Fri 1 Jan');
  });

  it('counts calendar days across the DST transitions, not 24-hour blocks', () => {
    expect(relativeDayLabel('2026-03-08', '2026-03-07')).toBe('Tomorrow');
    expect(relativeDayLabel('2026-03-13', '2026-03-07')).toBe('Friday'); // +6 across spring forward
    expect(relativeDayLabel('2026-03-14', '2026-03-07')).toBe('Sat 14 Mar'); // +7
    expect(relativeDayLabel('2026-03-03', '2026-03-09')).toBe('Tuesday'); // -6
    expect(relativeDayLabel('2026-03-02', '2026-03-09')).toBe('Mon 2 Mar'); // -7
    expect(relativeDayLabel('2026-11-06', '2026-10-31')).toBe('Friday'); // +6 across fall back
    expect(relativeDayLabel('2026-11-07', '2026-10-31')).toBe('Sat 7 Nov'); // +7
    expect(relativeDayLabel('2026-10-27', '2026-11-02')).toBe('Tuesday'); // -6
    expect(relativeDayLabel('2026-10-26', '2026-11-02')).toBe('Mon 26 Oct'); // -7
    expect(relativeDayLabel('2026-10-31', '2026-11-01')).toBe('Yesterday');
  });

  it('returns a damaged key unchanged instead of throwing', () => {
    expect(relativeDayLabel('nope', today)).toBe('nope');
    expect(relativeDayLabel('2026-02-30', today)).toBe('2026-02-30');
    expect(relativeDayLabel('2026-10-20', 'garbage')).toBe('2026-10-20');
  });
});

describe('formatTime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** What the device clock shows for a LOCAL wall time, computed the way the spec prescribes. */
  const clock = (hours: number, minutes: number): string =>
    new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2001, 0, 15, hours, minutes));

  it('formats valid times through the device-locale clock', () => {
    expect(formatTime('00:05')).toBe(clock(0, 5));
    expect(formatTime('15:00')).toBe(clock(15, 0));
    expect(formatTime('23:59')).toBe(clock(23, 59));
    expect(formatTime('09:30')).toBe(clock(9, 30));
  });

  it('reads as a clock in either a 12-hour or a 24-hour locale', () => {
    expect(formatTime('00:05')).toMatch(/(^|\D)(12|0|00):05(\D|$)/);
    expect(formatTime('15:00')).toMatch(/(^|\D)(3|15):00(\D|$)/);
    expect(formatTime('23:59')).toMatch(/(^|\D)(11|23):59(\D|$)/);
  });

  it('keeps the wall-clock time for an hour that the spring-forward day skips', () => {
    expect(formatTime('02:30')).toMatch(/(^|\D)(2|02):30(\D|$)/);
    expect(formatTime('02:30')).toBe(clock(2, 30));
  });

  it.each(['', '9:00', '24:00', '15:60', '15:00 ', ' 15:00', '1500', '15:00:00', 'abc', '15-00'])(
    'returns %j unchanged when it is not HH:mm',
    (raw) => {
      expect(formatTime(raw)).toBe(raw);
    },
  );

  it('falls back to the raw string when the device cannot format the time', () => {
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no clock');
    });
    expect(formatTime('15:00')).toBe('15:00');
    expect(formatTime('00:05')).toBe('00:05');
  });
});
