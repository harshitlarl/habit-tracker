export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Monday … 6 = Sunday
export type DateKey = string; // 'YYYY-MM-DD', LOCAL calendar date

export const HABIT_COLORS = ['terracotta', 'ochre', 'sage', 'slate', 'plum', 'rose', 'moss', 'graphite'] as const;
export type HabitColor = (typeof HABIT_COLORS)[number];

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

export interface AppData {
  version: 1;
  habits: Habit[];
  completions: Completions;
  settings: Settings;
  exportedAt?: string;
}
