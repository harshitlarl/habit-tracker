export interface EmojiOption {
  char: string;
  /** Accessible name read by screen readers. */
  name: string;
}

/** Shown in a tracker's tinted circle until the owner picks something else. */
export const DEFAULT_EMOJI = '✨';

/** 48 curated options: fitness, study, health, mind, home, work, creative, social. */
export const EMOJI_OPTIONS: readonly EmojiOption[] = [
  // fitness
  { char: '💪', name: 'Strength' },
  { char: '🏃', name: 'Run' },
  { char: '🚴', name: 'Cycle' },
  { char: '🏊', name: 'Swim' },
  { char: '🧘', name: 'Yoga' },
  { char: '⚽', name: 'Sport' },
  // study
  { char: '📚', name: 'Read' },
  { char: '✍️', name: 'Write' },
  { char: '🎓', name: 'Course' },
  { char: '🧠', name: 'Learn' },
  { char: '💻', name: 'Code' },
  { char: '🔬', name: 'Research' },
  // health
  { char: '💧', name: 'Water' },
  { char: '🥗', name: 'Eat well' },
  { char: '😴', name: 'Sleep' },
  { char: '🦷', name: 'Teeth' },
  { char: '🍎', name: 'Fruit' },
  { char: '💊', name: 'Medication' },
  // mind
  { char: '🙏', name: 'Gratitude' },
  { char: '📝', name: 'Journal' },
  { char: '🌅', name: 'Early rise' },
  { char: '🎯', name: 'Focus' },
  { char: '✨', name: 'Sparkle' },
  { char: '☕', name: 'Coffee' },
  // home
  { char: '🧹', name: 'Tidy' },
  { char: '🛏️', name: 'Make the bed' },
  { char: '🪴', name: 'Plants' },
  { char: '🍳', name: 'Cook' },
  { char: '🧺', name: 'Laundry' },
  { char: '🛒', name: 'Groceries' },
  // work
  { char: '💼', name: 'Work' },
  { char: '📧', name: 'Inbox' },
  { char: '📅', name: 'Plan' },
  { char: '📈', name: 'Review' },
  { char: '🗂️', name: 'Organise' },
  { char: '⏰', name: 'On time' },
  // creative
  { char: '🎨', name: 'Paint' },
  { char: '🎸', name: 'Guitar' },
  { char: '📷', name: 'Photo' },
  { char: '🎹', name: 'Piano' },
  { char: '🎬', name: 'Film' },
  { char: '✂️', name: 'Craft' },
  // social
  { char: '👋', name: 'Reach out' },
  { char: '📞', name: 'Call' },
  { char: '💌', name: 'Letter' },
  { char: '🤝', name: 'Meet' },
  { char: '🎉', name: 'Celebrate' },
  { char: '🐶', name: 'Walk the dog' },
];

const CURATED = new Set(EMOJI_OPTIONS.map((o) => o.char));

export function isCuratedEmoji(char: string): boolean {
  return CURATED.has(char);
}

/**
 * The first user-perceived character of `value` (one emoji, even a flag or a ZWJ sequence),
 * or '' when there is nothing but whitespace.
 */
export function firstGrapheme(value: string): string {
  const text = value.trim();
  if (text === '') return '';
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
    const first = segments[Symbol.iterator]().next();
    return first.done ? '' : first.value.segment;
  }
  return Array.from(text)[0] ?? '';
}
