import { describe, expect, it } from 'vitest';
import { DEFAULT_EMOJI, EMOJI_OPTIONS, firstGrapheme, isCuratedEmoji } from '../emojis';

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
