import { describe, expect, it } from 'vitest';
import { clampText } from '../text';

/** Half of a surrogate pair without its other half. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('clampText', () => {
  it('returns the trimmed value when it fits the cap', () => {
    expect(clampText('  Call the bank  ', 60)).toBe('Call the bank');
    expect(clampText('x'.repeat(60), 60)).toBe('x'.repeat(60));
    expect(clampText(`  ${'x'.repeat(60)}  `, 60)).toBe('x'.repeat(60)); // over the cap only because of padding
    expect(clampText('   ', 60)).toBe('');
    expect(clampText('', 60)).toBe('');
  });

  it('caps at `max` code units and trims whatever the cut leaves at the end', () => {
    expect(clampText('x'.repeat(70), 60)).toBe('x'.repeat(60));
    expect(clampText(`${'a'.repeat(59)} b`, 60)).toBe('a'.repeat(59));
    expect(clampText(`${'a'.repeat(56)}     b`, 60)).toBe('a'.repeat(56));
    expect(clampText(`${'a'.repeat(59)}\u3000b`, 60)).toBe('a'.repeat(59)); // U+3000 too: every whitespace trim() strips
    expect(clampText(`${'n'.repeat(79)} z`, 80)).toBe('n'.repeat(79));
  });

  it('never splits a surrogate pair: a character that does not fit is dropped whole', () => {
    expect(clampText(`${'a'.repeat(59)}😀`, 60)).toBe('a'.repeat(59));
    expect(clampText(`${'a'.repeat(58)}😀z`, 60)).toBe(`${'a'.repeat(58)}😀`);
    expect(clampText(`${'a'.repeat(58)} 😀`, 60)).toBe('a'.repeat(58)); // and the space it exposes goes too
    expect(clampText('🏋️'.repeat(6), 16)).toBe('🏋️'.repeat(5));
    expect(clampText('😀😀', 1)).toBe('');
  });

  it('is idempotent, and its result is what the importer keeps: trimmed, within the cap, well-formed', () => {
    const samples = [`${'a'.repeat(59)} b`, `  ${'n'.repeat(90)}`, `${'a'.repeat(59)}😀`, '😀'.repeat(40), ' x ', '', '🏋️'.repeat(30)];
    for (const sample of samples) {
      for (const max of [0, 1, 2, 16, 40, 60, 80]) {
        const once = clampText(sample, max);
        expect(clampText(once, max)).toBe(once);
        expect(once).toBe(once.trim());
        expect(once.length).toBeLessThanOrEqual(max);
        expect(LONE_SURROGATE.test(once)).toBe(false);
      }
    }
  });
});
