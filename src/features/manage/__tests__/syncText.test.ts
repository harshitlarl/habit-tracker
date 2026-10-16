import { describe, expect, it } from 'vitest';
import { OFFLINE_TEXT, describeSync, errorMessage, relativeTime } from '../syncText';

const MIN = 60_000;
const HR = 60 * MIN;
const DAY = 24 * HR;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

describe('relativeTime', () => {
  it('reads "just now" under a minute, and when the clocks disagree', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now');
    expect(relativeTime(NOW - 59_999, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5 * MIN, NOW)).toBe('just now');
  });

  it('counts whole minutes, hours and days', () => {
    expect(relativeTime(NOW - MIN, NOW)).toBe('1 min ago');
    expect(relativeTime(NOW - 5 * MIN - 30_000, NOW)).toBe('5 min ago');
    expect(relativeTime(NOW - 59 * MIN, NOW)).toBe('59 min ago');
    expect(relativeTime(NOW - HR, NOW)).toBe('1 hr ago');
    expect(relativeTime(NOW - 23 * HR - 59 * MIN, NOW)).toBe('23 hr ago');
    expect(relativeTime(NOW - DAY, NOW)).toBe('1 day ago');
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3 days ago');
  });
});

describe('describeSync', () => {
  const synced = { status: 'synced' as const, pending: false, lastSyncedAt: NOW - 5 * MIN, error: null };

  it('shows the last server-confirmed time while synced', () => {
    expect(describeSync(synced, NOW)).toEqual({ tone: 'synced', text: 'Synced · 5 min ago' });
    expect(describeSync({ ...synced, lastSyncedAt: NOW }, NOW)).toEqual({ tone: 'synced', text: 'Synced · just now' });
    expect(describeSync({ ...synced, lastSyncedAt: null }, NOW)).toEqual({ tone: 'synced', text: 'Synced' });
  });

  it('says Syncing… while local writes wait for the server', () => {
    expect(describeSync({ ...synced, pending: true }, NOW)).toEqual({ tone: 'pending', text: 'Syncing…' });
  });

  it('offline wins over pending writes: they go on their own once back online', () => {
    expect(describeSync({ ...synced, status: 'offline', pending: true }, NOW)).toEqual({
      tone: 'offline',
      text: OFFLINE_TEXT,
    });
    expect(describeSync({ ...synced, status: 'offline' }, NOW).tone).toBe('offline');
  });

  it('puts the friendly error text first, with a fallback when none was given', () => {
    const error = { ...synced, status: 'error' as const, pending: true, error: 'You do not have access to this data.' };
    expect(describeSync(error, NOW)).toEqual({ tone: 'error', text: 'You do not have access to this data.' });
    const bare = describeSync({ ...error, error: null }, NOW);
    expect(bare.tone).toBe('error');
    expect(bare.text).not.toBe('');
  });

  it('is connecting until the first snapshot, whatever the stale status says', () => {
    expect(describeSync({ ...synced, status: 'connecting', lastSyncedAt: null }, NOW)).toEqual({
      tone: 'connecting',
      text: 'Connecting…',
    });
    expect(describeSync({ ...synced, status: 'signed-out' }, NOW).tone).toBe('connecting');
    expect(describeSync({ ...synced, status: 'off' }, NOW).tone).toBe('connecting');
  });
});

describe('errorMessage', () => {
  it('uses the message of an Error, otherwise the fallback', () => {
    expect(errorMessage(new Error('That password is not right.'), 'fallback')).toBe('That password is not right.');
    expect(errorMessage(new Error('   '), 'fallback')).toBe('fallback');
    expect(errorMessage('auth/whatever', 'fallback')).toBe('fallback');
    expect(errorMessage(undefined, 'fallback')).toBe('fallback');
  });
});
