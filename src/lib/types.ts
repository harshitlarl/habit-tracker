export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Monday … 6 = Sunday
export type DateKey = string; // 'YYYY-MM-DD', LOCAL calendar date

export const HABIT_COLORS = ['terracotta', 'ochre', 'sage', 'slate', 'plum', 'rose', 'moss', 'graphite'] as const;
export type HabitColor = (typeof HABIT_COLORS)[number];

/*
 * Field limits, the same ones the editor enforces. The importer (store.ts) and the cloud parser
 * (sync/merge.ts) both apply them, so neither can install a tracker the editor could never save.
 */
export const HABIT_NAME_MAX = 40;
export const HABIT_NOTE_MAX = 40;
/** In UTF-16 code units, matching the free-text emoji field's maxLength: room for a flag or a ZWJ family. */
export const HABIT_EMOJI_MAX = 16;

export const isWeekday = (v: unknown): v is Weekday =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6;

export const isHabitColor = (v: unknown): v is HabitColor =>
  typeof v === 'string' && (HABIT_COLORS as readonly string[]).includes(v);

/** Ids become object keys in `completions`; these names would re-prototype that object. */
const UNSAFE_IDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Firestore reserves document ids of the form `__name__`. */
const RESERVED_ID = /^__.*__$/;
/** Firestore's limit for a document id, in UTF-8 bytes. */
const ID_MAX_BYTES = 1500;

/** True when `v` is a non-blank string: an id that can be re-keyed rather than dropped (see isValidId). */
export const isIdLike = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && !UNSAFE_IDS.has(v);

/**
 * A usable tracker id: a non-blank string that is safe as an object key AND as a Firestore document id
 * (SPEC §13.3 `users/{uid}/habits/{habitId}`): no '/', not '.' or '..', not `__reserved__`, at most
 * 1500 UTF-8 bytes. Shared by the importer, the hydration repair and the cloud parser, so a tracker
 * the cloud could never address is never installed in the first place.
 */
export const isValidId = (v: unknown): v is string =>
  isIdLike(v) &&
  !v.includes('/') &&
  v !== '.' &&
  v !== '..' &&
  !RESERVED_ID.test(v) &&
  // Every UTF-16 unit encodes to at most 3 UTF-8 bytes, so short ids skip the encoder.
  (v.length * 3 <= ID_MAX_BYTES || new TextEncoder().encode(v).length <= ID_MAX_BYTES);

export interface Habit {
  id: string;
  name: string;
  emoji: string;
  color: HabitColor;
  note?: string;
  days: Weekday[]; // scheduled weekdays — non-empty, unique, sorted ascending
  createdAt: DateKey;
  archivedAt?: DateKey;
  order: number;
}

export type Completions = Record<string, Record<DateKey, true>>; // habitId → set of dateKeys

export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  theme: Theme;
  installHintDismissed: boolean;
}

/* ---------- One-time tasks (SPEC §14) ---------- */

export const TASK_TITLE_MAX = 60;
export const TASK_NOTE_MAX = 80;
/** 'HH:mm', 24-hour. */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isTimeString = (v: unknown): v is string => typeof v === 'string' && TIME_RE.test(v);

/**
 * A one-time, dated item ("Tuesday — renew the gym membership", "Thursday 15:00 — mentor meeting").
 * Tasks sit next to trackers on Today, appear under their day in Week and carry over while undone.
 * They never count towards streaks, the progress ring or the motivation copy.
 */
export interface Task {
  id: string;
  title: string; // trimmed, 1–60 chars
  note?: string; // trimmed, ≤ 80 chars
  date: DateKey; // planned LOCAL calendar date
  time?: string; // 'HH:mm', 24-hour
  done: boolean;
  doneAt?: DateKey; // LOCAL date it was checked off (differs from `date` when done late); only while done
  createdAt: DateKey;
}

export interface AppData {
  version: 1;
  habits: Habit[];
  completions: Completions;
  settings: Settings;
  exportedAt?: string;
  /** Tombstones of deleted trackers (since cloud sync). Absent in older backups. */
  deletedIds?: string[];
  /** One-time tasks (since phase 3). Absent in older backups. */
  tasks?: Task[];
  /** Tombstones of deleted tasks. Absent in older backups. */
  deletedTaskIds?: string[];
}
