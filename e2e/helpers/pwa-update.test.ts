import { describe, expect, it } from 'vitest';
import { isSafeToReload, isUpdateCheckDue, UPDATE_CHECK_INTERVAL_MS, type ReloadContext } from '../../src/pwa';

/*
 * The service-worker update policy of src/pwa.ts (review #25): a new build reloads the open page at
 * once only when that interrupts nothing, and the app asks for a new build on returning to the
 * foreground at most once an hour. A vitest unit test of app code, kept here because vitest collects the
 * *.test.ts files under e2e/helpers, and src/pwa.ts loads without the PWA plugin (main.tsx passes
 * registerSW in).
 */

const calm: ReloadContext = { dialogOpen: false, activeTag: null, activeEditable: false };

describe('isSafeToReload', () => {
  it('reloads when nothing is open and nothing (or only a button) has focus', () => {
    expect(isSafeToReload(calm)).toBe(true);
    for (const tag of ['BUTTON', 'A', 'BODY', 'DIV', 'button']) {
      expect(isSafeToReload({ ...calm, activeTag: tag }), tag).toBe(true);
    }
  });

  it('waits while a sheet is open, whatever has focus', () => {
    expect(isSafeToReload({ ...calm, dialogOpen: true })).toBe(false);
    expect(isSafeToReload({ ...calm, dialogOpen: true, activeTag: 'BUTTON' })).toBe(false);
  });

  it('waits while a field has focus: input, textarea, select, contenteditable — in any letter case', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input', 'Textarea']) {
      expect(isSafeToReload({ ...calm, activeTag: tag }), tag).toBe(false);
    }
    expect(isSafeToReload({ ...calm, activeTag: 'DIV', activeEditable: true })).toBe(false);
  });
});

describe('isUpdateCheckDue', () => {
  const last = Date.UTC(2026, 9, 17, 8, 0, 0);

  it('asks again only once an hour has passed since the last check', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(isUpdateCheckDue(last, last)).toBe(false);
    expect(isUpdateCheckDue(last, last + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(isUpdateCheckDue(last, last + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
    expect(isUpdateCheckDue(last, last + 3 * UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  it('a clock set back does not trigger a check', () => {
    expect(isUpdateCheckDue(last, last - UPDATE_CHECK_INTERVAL_MS)).toBe(false);
  });
});
