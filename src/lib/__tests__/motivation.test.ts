import { describe, expect, it } from 'vitest';
import {
  MOTIVATION_POOLS,
  getMotivation,
  getWeekSummaryMessage,
  hashString,
  motivationState,
  type Motivation,
  type MotivationContext,
  type MotivationState,
} from '../motivation';
import { STREAK_MILESTONES, currentStreak } from '../streaks';
import { addDays } from '../dates';
import type { Completions, Habit } from '../types';

const base: MotivationContext = {
  dateKey: '2026-10-16',
  hour: 9,
  habitsCount: 3,
  dueCount: 3,
  doneCount: 0,
  bestCurrentStreak: null,
  perfectDayStreak: 0,
  missedYesterday: false,
};

const ctx = (over: Partial<MotivationContext> = {}): MotivationContext => ({ ...base, ...over });

const days = (n: number): string[] => Array.from({ length: n }, (_, i) => addDays('2026-01-01', i));

const STATES = Object.keys(MOTIVATION_POOLS) as MotivationState[];

/** A context that resolves to each state. */
const CONTEXTS: Record<MotivationState, Partial<MotivationContext>> = {
  noHabits: { habitsCount: 0 },
  allDone: { doneCount: 3 },
  milestone: { doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: 7 } },
  restDay: { dueCount: 0, doneCount: 0 },
  comeback: { missedYesterday: true, doneCount: 1 },
  'nothingYet.morning': { hour: 8 },
  'nothingYet.afternoon': { hour: 14 },
  'nothingYet.evening': { hour: 20 },
  'partial.low': { dueCount: 4, doneCount: 1 },
  'partial.high': { dueCount: 4, doneCount: 3 },
};

const TONES: Motivation['tone'][] = ['calm', 'warm', 'celebrate', 'nudge'];

describe('hashString', () => {
  it('is stable, integer and non-negative', () => {
    expect(hashString('2026-10-16:allDone')).toBe(hashString('2026-10-16:allDone'));
    for (const s of ['', 'a', 'b', 'Gym', '2026-10-16:partial.low', 'ünïcödé 🏋️']) {
      const h = hashString(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
    expect(hashString('a')).not.toBe(hashString('b'));
  });

  it('is FNV-1a 32-bit (anchors keep the pick stable across releases)', () => {
    expect(hashString('')).toBe(2166136261);
    expect(hashString('a')).toBe(3826002220);
  });

  it('spreads consecutive days across a small pool', () => {
    const buckets = new Set(days(30).map((d) => hashString(`${d}:allDone`) % 6));
    expect(buckets.size).toBeGreaterThan(2);
  });
});

describe('getMotivation determinism', () => {
  it('returns the same message for the same context, every time', () => {
    const first = getMotivation(ctx({ doneCount: 1 }));
    for (let i = 0; i < 50; i += 1) expect(getMotivation(ctx({ doneCount: 1 }))).toEqual(first);
  });

  it('picks exactly hashString(dateKey + ":" + state) % pool.length', () => {
    for (const dateKey of days(60)) {
      for (const state of STATES) {
        const c = ctx({ dateKey, ...CONTEXTS[state] });
        const pool = MOTIVATION_POOLS[state];
        const expected = pool[hashString(`${dateKey}:${state}`) % pool.length];
        const m = getMotivation(c);
        if (state === 'milestone') {
          expect(m.title).toBe(expected?.title.replaceAll('{n}', '7').replaceAll('{name}', 'Gym'));
        } else {
          expect(m.title).toBe(expected?.title);
          expect(m.body).toBe(expected?.body);
        }
      }
    }
  });

  it('varies across days within a state', () => {
    const titles = new Set(days(40).map((dateKey) => getMotivation(ctx({ dateKey })).title));
    expect(titles.size).toBeGreaterThan(1);
  });

  it('does not depend on fields outside the state (hour, perfectDayStreak, missedYesterday, counts)', () => {
    expect(getMotivation(ctx({ perfectDayStreak: 9 }))).toEqual(getMotivation(ctx({ perfectDayStreak: 0 })));
    // Same partial.low state regardless of the hour or the exact counts.
    expect(getMotivation(ctx({ doneCount: 1, hour: 6 }))).toEqual(getMotivation(ctx({ doneCount: 1, hour: 23 })));
    expect(getMotivation(ctx({ dueCount: 10, doneCount: 1 }))).toEqual(getMotivation(ctx({ dueCount: 3, doneCount: 1 })));
    // allDone does not care how many were due.
    expect(getMotivation(ctx({ dueCount: 1, doneCount: 1 }))).toEqual(getMotivation(ctx({ dueCount: 5, doneCount: 5 })));
    // noHabits ignores everything else, including a bogus streak.
    expect(getMotivation(ctx({ habitsCount: 0, missedYesterday: true, hour: 22 }))).toEqual(
      getMotivation(ctx({ habitsCount: 0, bestCurrentStreak: { habitName: 'Gym', days: 7 } })),
    );
  });

  it('changes only when the state changes within a day', () => {
    const before = getMotivation(ctx({ doneCount: 0, hour: 9 }));
    const after = getMotivation(ctx({ doneCount: 1, hour: 9 }));
    expect(motivationState(ctx({ doneCount: 0, hour: 9 }))).toBe('nothingYet.morning');
    expect(motivationState(ctx({ doneCount: 1, hour: 9 }))).toBe('partial.low');
    expect(before.tone).toBe('calm');
    expect(after.tone).toBe('warm');
  });
});

describe('state priority', () => {
  it('noHabits wins over everything', () => {
    expect(motivationState(ctx({ habitsCount: 0, dueCount: 0, doneCount: 0 }))).toBe('noHabits');
    expect(motivationState(ctx({ habitsCount: 0, dueCount: 2, doneCount: 2 }))).toBe('noHabits');
    expect(
      motivationState(ctx({ habitsCount: 0, missedYesterday: true, bestCurrentStreak: { habitName: 'Gym', days: 7 } })),
    ).toBe('noHabits');
    expect(getMotivation(ctx({ habitsCount: 0 })).tone).toBe('calm');
  });

  it('allDone when every due habit is done', () => {
    const m = getMotivation(ctx({ doneCount: 3 }));
    expect(motivationState(ctx({ doneCount: 3 }))).toBe('allDone');
    expect(motivationState(ctx({ dueCount: 1, doneCount: 1 }))).toBe('allDone');
    expect(m.tone).toBe('celebrate');
    expect(MOTIVATION_POOLS.allDone.map((v) => v.title)).toContain(m.title);
  });

  it('allDone beats a milestone and a comeback', () => {
    expect(
      motivationState(ctx({ doneCount: 3, bestCurrentStreak: { habitName: 'Gym', days: 7 } })),
    ).toBe('allDone');
    expect(motivationState(ctx({ doneCount: 3, missedYesterday: true }))).toBe('allDone');
  });

  it('allDone never fires with nothing due', () => {
    expect(motivationState(ctx({ dueCount: 0, doneCount: 0 }))).not.toBe('allDone');
  });

  it('milestone beats comeback, nothingYet, partial and restDay', () => {
    const streak = { habitName: 'Gym', days: 7 };
    expect(motivationState(ctx({ doneCount: 1, missedYesterday: true, bestCurrentStreak: streak }))).toBe('milestone');
    expect(motivationState(ctx({ doneCount: 0, hour: 8, bestCurrentStreak: streak }))).toBe('milestone');
    expect(motivationState(ctx({ dueCount: 4, doneCount: 3, bestCurrentStreak: streak }))).toBe('milestone');
    expect(motivationState(ctx({ dueCount: 0, doneCount: 0, bestCurrentStreak: streak }))).toBe('milestone');
  });

  it('milestone copy includes the habit name and the number', () => {
    for (const dateKey of days(12)) {
      const m = getMotivation(ctx({ dateKey, doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: 7 } }));
      expect(m.tone).toBe('celebrate');
      expect(m.title).toContain('Gym');
      expect(m.title).toContain('7');
      expect(m.title).not.toMatch(/\{(n|name)\}/);
      if (m.body) expect(m.body).not.toMatch(/\{(n|name)\}/);
    }
  });

  it('milestone copy works for every milestone and for realistic tracker names', () => {
    const names = ['Gym', 'Study 2 hours', 'Wake up by 8 AM', 'Read 📚', 'Save $$'];
    for (const n of STREAK_MILESTONES) {
      for (const habitName of names) {
        for (const dateKey of days(MOTIVATION_POOLS.milestone.length * 3)) {
          const m = getMotivation(ctx({ dateKey, doneCount: 1, bestCurrentStreak: { habitName, days: n } }));
          expect(motivationState(ctx({ dateKey, doneCount: 1, bestCurrentStreak: { habitName, days: n } }))).toBe('milestone');
          expect(m.title).toContain(habitName);
          expect(m.title).toContain(String(n));
          expect(m.title).not.toMatch(/\{(n|name)\}/);
          expect(m.title).not.toContain('$$$');
        }
      }
    }
  });

  it('a habit name with dollar signs is inserted literally (no $$ / $& replacement patterns)', () => {
    for (const dateKey of days(MOTIVATION_POOLS.milestone.length * 2)) {
      const m = getMotivation(ctx({ dateKey, doneCount: 1, bestCurrentStreak: { habitName: 'Save $$ & $& more', days: 3 } }));
      expect(m.title).toContain('Save $$ & $& more');
      expect(m.title).not.toContain('{name}');
    }
  });

  it('every milestone template mentions both the number and the name', () => {
    for (const v of MOTIVATION_POOLS.milestone) {
      expect(v.title).toContain('{n}');
      expect(v.title).toContain('{name}');
    }
  });

  it('only milestone days trigger the milestone state', () => {
    expect(motivationState(ctx({ doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: 8 } }))).toBe('partial.low');
    expect(motivationState(ctx({ doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: 365 } }))).toBe('milestone');
    expect(motivationState(ctx({ doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: 3 } }))).toBe('milestone');
    expect(motivationState(ctx({ doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: 2 } }))).toBe('partial.low');
    expect(motivationState(ctx({ doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: 0 } }))).toBe('partial.low');
    for (const n of STREAK_MILESTONES) {
      expect(motivationState(ctx({ doneCount: 1, bestCurrentStreak: { habitName: 'Gym', days: n } }))).toBe('milestone');
    }
  });

  it('a real 7-day streak flows into a milestone message', () => {
    const gym: Habit = { id: 'g', name: 'Gym', emoji: '🏋️', color: 'terracotta', days: [0, 1, 2, 3, 4, 5, 6], createdAt: '2026-09-01', order: 0 };
    const completions: Completions = { g: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [addDays('2026-10-16', -i), true as const])) };
    const streak = currentStreak(gym, completions, '2026-10-16');
    expect(streak).toBe(7);
    expect(STREAK_MILESTONES.includes(streak)).toBe(true);
    const m = getMotivation(ctx({ dueCount: 2, doneCount: 1, bestCurrentStreak: { habitName: gym.name, days: streak } }));
    expect(m.tone).toBe('celebrate');
    expect(m.title).toContain('Gym');
    expect(m.title).toContain('7');
  });

  it('restDay when trackers exist but nothing is due', () => {
    expect(motivationState(ctx({ dueCount: 0, doneCount: 0 }))).toBe('restDay');
    expect(motivationState(ctx({ dueCount: 0, doneCount: 0, missedYesterday: true }))).toBe('restDay');
    expect(motivationState(ctx({ dueCount: 0, doneCount: 0, hour: 22 }))).toBe('restDay');
    expect(getMotivation(ctx({ dueCount: 0, doneCount: 0 })).tone).toBe('calm');
  });

  it('comeback needs a miss yesterday AND progress today', () => {
    expect(motivationState(ctx({ missedYesterday: true, doneCount: 1 }))).toBe('comeback');
    expect(motivationState(ctx({ missedYesterday: true, doneCount: 2 }))).toBe('comeback');
    expect(getMotivation(ctx({ missedYesterday: true, doneCount: 1 })).tone).toBe('warm');
    expect(motivationState(ctx({ missedYesterday: true, doneCount: 0, hour: 9 }))).toBe('nothingYet.morning');
    expect(motivationState(ctx({ missedYesterday: true, doneCount: 0, hour: 20 }))).toBe('nothingYet.evening');
    expect(motivationState(ctx({ missedYesterday: false, doneCount: 1 }))).toBe('partial.low');
  });

  it('nothingYet splits by hour', () => {
    expect(motivationState(ctx({ hour: 0 }))).toBe('nothingYet.morning');
    expect(motivationState(ctx({ hour: 11 }))).toBe('nothingYet.morning');
    expect(motivationState(ctx({ hour: 12 }))).toBe('nothingYet.afternoon');
    expect(motivationState(ctx({ hour: 17 }))).toBe('nothingYet.afternoon');
    expect(motivationState(ctx({ hour: 18 }))).toBe('nothingYet.evening');
    expect(motivationState(ctx({ hour: 23 }))).toBe('nothingYet.evening');
    expect(getMotivation(ctx({ hour: 8 })).tone).toBe('calm');
    expect(getMotivation(ctx({ hour: 14 })).tone).toBe('warm');
    expect(getMotivation(ctx({ hour: 20 })).tone).toBe('nudge');
  });

  it('partial splits at 50%', () => {
    expect(motivationState(ctx({ dueCount: 4, doneCount: 1 }))).toBe('partial.low');
    expect(motivationState(ctx({ dueCount: 4, doneCount: 2 }))).toBe('partial.high');
    expect(motivationState(ctx({ dueCount: 3, doneCount: 2 }))).toBe('partial.high');
    expect(motivationState(ctx({ dueCount: 3, doneCount: 1 }))).toBe('partial.low');
    expect(motivationState(ctx({ dueCount: 100, doneCount: 49 }))).toBe('partial.low');
    expect(motivationState(ctx({ dueCount: 100, doneCount: 50 }))).toBe('partial.high');
    expect(getMotivation(ctx({ dueCount: 4, doneCount: 1 })).tone).toBe('warm');
    expect(getMotivation(ctx({ dueCount: 4, doneCount: 3 })).tone).toBe('nudge');
  });

  it('never throws on out-of-range counts', () => {
    expect(() => getMotivation(ctx({ dueCount: 2, doneCount: 3 }))).not.toThrow();
    expect(() => getMotivation(ctx({ hour: -1 }))).not.toThrow();
    expect(() => getMotivation(ctx({ hour: 24 }))).not.toThrow();
  });
});

describe('copy quality', () => {
  it('covers the ten states', () => {
    expect(STATES.sort()).toEqual(
      [
        'noHabits',
        'allDone',
        'milestone',
        'restDay',
        'comeback',
        'nothingYet.morning',
        'nothingYet.afternoon',
        'nothingYet.evening',
        'partial.low',
        'partial.high',
      ].sort(),
    );
  });

  it('has at least 4 variants per state', () => {
    for (const state of STATES) expect(MOTIVATION_POOLS[state].length).toBeGreaterThanOrEqual(4);
  });

  it('keeps titles ≤ 60 chars, with no emoji and no exclamation spam', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const state of STATES) {
      for (const v of MOTIVATION_POOLS[state]) {
        expect(v.title.length).toBeGreaterThan(0);
        expect(v.title.length).toBeLessThanOrEqual(60);
        expect(v.title).not.toMatch(emoji);
        expect((v.title.match(/!/g) ?? []).length).toBeLessThanOrEqual(1);
        expect(v.title.trim()).toBe(v.title);
        if (v.body !== undefined) {
          expect(v.body.length).toBeGreaterThan(0);
          expect(v.body).not.toMatch(emoji);
          expect((v.body.match(/!/g) ?? []).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('has no duplicate titles within a state', () => {
    for (const state of STATES) {
      const titles = MOTIVATION_POOLS[state].map((v) => v.title);
      expect(new Set(titles).size).toBe(titles.length);
    }
  });

  it('only milestone copy uses placeholders', () => {
    for (const state of STATES) {
      if (state === 'milestone') continue;
      for (const v of MOTIVATION_POOLS[state]) {
        expect(v.title).not.toMatch(/\{(n|name)\}/);
        if (v.body) expect(v.body).not.toMatch(/\{(n|name)\}/);
      }
    }
  });

  it('every variant of every state is reachable by some day, with a valid tone', () => {
    const reached: Record<MotivationState, Set<string>> = Object.fromEntries(
      STATES.map((s) => [s, new Set<string>()]),
    ) as Record<MotivationState, Set<string>>;
    for (const dateKey of days(120)) {
      for (const state of STATES) {
        const c = ctx({ dateKey, ...CONTEXTS[state] });
        expect(motivationState(c)).toBe(state);
        const m = getMotivation(c);
        expect(TONES).toContain(m.tone);
        expect(m.title.length).toBeGreaterThan(0);
        if (m.body !== undefined) expect(typeof m.body).toBe('string');
        reached[state].add(m.title);
      }
    }
    for (const state of STATES) expect(reached[state].size).toBe(MOTIVATION_POOLS[state].length);
  });

  it('body is omitted (not undefined-valued) when the variant has none', () => {
    for (const dateKey of days(30)) {
      const m = getMotivation(ctx({ dateKey, doneCount: 3 }));
      if (m.body === undefined) expect(Object.keys(m)).toEqual(['title', 'tone']);
    }
  });
});

describe('getWeekSummaryMessage', () => {
  it('formats done of due with a rounded percentage', () => {
    expect(getWeekSummaryMessage(18, 21)).toBe('18 of 21 done · 86%');
    expect(getWeekSummaryMessage(21, 21)).toBe('21 of 21 done · 100%');
    expect(getWeekSummaryMessage(1, 3)).toBe('1 of 3 done · 33%');
    expect(getWeekSummaryMessage(2, 3)).toBe('2 of 3 done · 67%');
    expect(getWeekSummaryMessage(1, 8)).toBe('1 of 8 done · 13%');
    expect(getWeekSummaryMessage(0, 5)).toBe('0 of 5 done · 0%');
    expect(getWeekSummaryMessage(1, 1)).toBe('1 of 1 done · 100%');
  });

  it('has a gentle message when nothing is due', () => {
    expect(getWeekSummaryMessage(0, 0)).toBe('Nothing due yet this week');
    expect(getWeekSummaryMessage(0, -1)).toBe('Nothing due yet this week');
  });

  it('uses a middle dot separator with spaces', () => {
    expect(getWeekSummaryMessage(3, 4)).toMatch(/^\d+ of \d+ done · \d+%$/);
  });
});
