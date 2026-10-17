import { describe, expect, it } from 'vitest';
import {
  COLLAPSED_EMOJI_COUNT,
  DEFAULT_EMOJI,
  EMOJI_OPTIONS,
  firstGrapheme,
  isCuratedEmoji,
  visibleEmojiOptions,
} from '../emojis';

describe('EMOJI_OPTIONS', () => {
  it('offers 48 distinct glyphs, each with an accessible name', () => {
    expect(EMOJI_OPTIONS).toHaveLength(48);
    expect(new Set(EMOJI_OPTIONS.map((o) => o.char)).size).toBe(48);
    for (const option of EMOJI_OPTIONS) {
      expect(option.name.trim().length).toBeGreaterThan(0);
      expect(firstGrapheme(option.char)).toBe(option.char); // each option is exactly one grapheme
    }
  });

  it('includes the default emoji so a new tracker starts on a highlighted cell', () => {
    expect(isCuratedEmoji(DEFAULT_EMOJI)).toBe(true);
  });
});

describe('isCuratedEmoji', () => {
  it('is true only for the curated glyphs', () => {
    expect(isCuratedEmoji('💪')).toBe(true);
    expect(isCuratedEmoji('🦄')).toBe(false);
    expect(isCuratedEmoji('')).toBe(false);
    expect(isCuratedEmoji('x')).toBe(false);
  });
});

describe('visibleEmojiOptions', () => {
  const chars = (list: readonly { char: string }[]): string[] => list.map((o) => o.char);
  const first = chars(EMOJI_OPTIONS.slice(0, COLLAPSED_EMOJI_COUNT));

  it('collapsed, shows the first 16 when the choice is among them (or is not curated at all)', () => {
    expect(COLLAPSED_EMOJI_COUNT).toBe(16);
    expect(chars(visibleEmojiOptions('💪', false))).toEqual(first);
    expect(chars(visibleEmojiOptions(EMOJI_OPTIONS[15]?.char ?? '', false))).toEqual(first);
    expect(chars(visibleEmojiOptions('🦄', false))).toEqual(first); // a typed emoji: no radio to show
    expect(chars(visibleEmojiOptions('', false))).toEqual(first);
  });

  it('collapsed, appends a choice from further down so it stays visible and checked', () => {
    const beyond = EMOJI_OPTIONS[COLLAPSED_EMOJI_COUNT + 5];
    expect(beyond).toBeDefined();
    expect(chars(visibleEmojiOptions(beyond?.char ?? '', false))).toEqual([...first, beyond?.char]);
    // The default for a new tracker sits past the first 16 and must still be on screen.
    expect(EMOJI_OPTIONS.findIndex((o) => o.char === DEFAULT_EMOJI)).toBeGreaterThanOrEqual(COLLAPSED_EMOJI_COUNT);
    expect(chars(visibleEmojiOptions(DEFAULT_EMOJI, false))).toEqual([...first, DEFAULT_EMOJI]);
  });

  it('expanded, shows every option in order', () => {
    expect(visibleEmojiOptions('💪', true)).toBe(EMOJI_OPTIONS);
    expect(visibleEmojiOptions(DEFAULT_EMOJI, true)).toBe(EMOJI_OPTIONS);
  });

  it('shows everything when the limit covers the whole list', () => {
    expect(visibleEmojiOptions('💪', false, EMOJI_OPTIONS.length)).toBe(EMOJI_OPTIONS);
  });
});

describe('firstGrapheme', () => {
  it('returns the first user-perceived character', () => {
    expect(firstGrapheme('abc')).toBe('a');
    expect(firstGrapheme('🏃🚴')).toBe('🏃');
  });

  it('keeps a whole emoji sequence together', () => {
    expect(firstGrapheme('🏋️ gym')).toBe('🏋️'); // with a variation selector
    expect(firstGrapheme('👨‍👩‍👧x')).toBe('👨‍👩‍👧'); // ZWJ family
    expect(firstGrapheme('🇬🇧 uk')).toBe('🇬🇧'); // regional indicator pair
    expect(firstGrapheme('👍🏽👍')).toBe('👍🏽'); // skin-tone modifier
  });

  it('ignores surrounding whitespace and returns "" for nothing', () => {
    expect(firstGrapheme('  🧘 ')).toBe('🧘');
    expect(firstGrapheme('')).toBe('');
    expect(firstGrapheme('   ')).toBe('');
  });
});
