import { afterEach, describe, expect, it, vi } from 'vitest';
import { isIOS, isStandalone } from '../platform';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isIOS', () => {
  it('is false under Node (no iPhone user agent, no touch points)', () => {
    expect(isIOS()).toBe(false);
  });

  it('detects iPhone, iPad and iPod user agents', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA.replace('iPhone', 'iPad'), platform: 'iPad', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA.replace('iPhone', 'iPod'), platform: 'iPod', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
  });

  it('detects iPadOS 13+ pretending to be desktop Safari (MacIntel with touch points)', () => {
    vi.stubGlobal('navigator', { userAgent: IPAD_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);
  });

  it('is false for a real Mac and for Android', () => {
    vi.stubGlobal('navigator', { userAgent: IPAD_DESKTOP_UA, platform: 'MacIntel', maxTouchPoints: 0 });
    expect(isIOS()).toBe(false);
    vi.stubGlobal('navigator', { userAgent: ANDROID_UA, platform: 'Linux armv81', maxTouchPoints: 5 });
    expect(isIOS()).toBe(false);
  });

  it('is false when navigator is missing entirely', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isIOS()).toBe(false);
  });
});

describe('isStandalone', () => {
  it('is false under Node (no window)', () => {
    expect(isStandalone()).toBe(false);
  });

  it('is true for the iOS Home Screen flag', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, standalone: true });
    expect(isStandalone()).toBe(true);
  });

  it('is true for display-mode standalone or fullscreen, false in a browser tab', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA, standalone: false });
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q.includes('standalone') }) });
    expect(isStandalone()).toBe(true);
    vi.stubGlobal('window', { matchMedia: (q: string) => ({ matches: q.includes('fullscreen') }) });
    expect(isStandalone()).toBe(true);
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    expect(isStandalone()).toBe(false);
  });

  it('is false when matchMedia is unavailable and the flag is not set', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE_UA });
    vi.stubGlobal('window', {});
    expect(isStandalone()).toBe(false);
  });
});
