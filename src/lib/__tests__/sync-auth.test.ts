import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirebaseHandles } from '../sync/firebase';

/*
 * friendlyAuthError (SPEC §13.5): every code the sign-in form can run into maps to its own calm
 * sentence; anything else gets one generic sentence. signOutUser (review #47): whether the sign-out was
 * clean — nothing waiting, or every queued write confirmed by the server first — decides whether
 * bootstrap.ts may forget the account's sync baseline. The SDK is a small fake: a signOut spy and a
 * waitForPendingWrites whose answer each test chooses.
 */

const fake = vi.hoisted(() => {
  const state = {
    flush: 'confirm' as 'confirm' | 'hang' | 'fail',
    flushCalls: 0,
    signOuts: 0,
    signOutError: null as Error | null,
  };
  const handles = {
    app: {},
    auth: {},
    db: {},
    sdk: {
      app: {},
      auth: {
        signOut: (): Promise<void> => {
          state.signOuts += 1;
          return state.signOutError ? Promise.reject(state.signOutError) : Promise.resolve();
        },
      },
      firestore: {
        waitForPendingWrites: (): Promise<void> => {
          state.flushCalls += 1;
          if (state.flush === 'hang') return new Promise<void>(() => {});
          if (state.flush === 'fail') return Promise.reject(new Error('Firestore shut down'));
          return Promise.resolve();
        },
      },
    },
  };
  return { state, handles };
});

vi.mock('../sync/firebase', () => ({
  isSyncConfigured: () => true,
  loadFirebase: () => Promise.resolve(fake.handles as unknown as FirebaseHandles),
}));

import { FLUSH_TIMEOUT_MS, friendlyAuthError, signOutUser, signOutWasClean } from '../sync/auth';
import { useSyncStore } from '../sync/syncStore';

const GENERIC = friendlyAuthError({ code: 'auth/some-code-nobody-mapped' });

const MAPPED = [
  'auth/invalid-email',
  'auth/user-not-found',
  'auth/wrong-password',
  'auth/invalid-credential',
  'auth/email-already-in-use',
  'auth/weak-password',
  'auth/too-many-requests',
  'auth/network-request-failed',
  // Beyond the SPEC list: the console toggles the README recommends, and newer SDK aliases.
  'auth/admin-restricted-operation',
  'auth/operation-not-allowed',
  'auth/invalid-login-credentials',
  'auth/user-disabled',
  'auth/missing-email',
  'auth/missing-password',
] as const;

const SENTENCE = /^[A-Z][^]*[.!?]$/;

describe('friendlyAuthError', () => {
  it('falls back to one calm generic sentence for anything it does not know', () => {
    expect(GENERIC).toMatch(SENTENCE);
    expect(GENERIC).not.toMatch(/auth\//);
    for (const value of [undefined, null, 42, '', 'not-a-code', new Error('boom'), { code: 123 }, { message: 'x' }, []]) {
      expect(friendlyAuthError(value)).toBe(GENERIC);
    }
  });

  it.each(MAPPED)('%s gets its own sentence, free of codes', (code) => {
    const message = friendlyAuthError({ code });
    expect(message).toMatch(SENTENCE);
    expect(message).not.toBe(GENERIC);
    expect(message).not.toMatch(/auth\//);
    expect(message.length).toBeLessThanOrEqual(110);
  });

  it('accepts a FirebaseError-like object, an Error carrying a code, and a bare string code', () => {
    const expected = friendlyAuthError({ code: 'auth/weak-password' });
    expect(friendlyAuthError({ code: 'auth/weak-password', message: 'Firebase: Password should be at least 6 characters (auth/weak-password).', name: 'FirebaseError' })).toBe(expected);
    expect(friendlyAuthError(Object.assign(new Error('Firebase: Error (auth/weak-password).'), { code: 'auth/weak-password' }))).toBe(expected);
    expect(friendlyAuthError('auth/weak-password')).toBe(expected);
    expect(friendlyAuthError('  auth/weak-password  ')).toBe(expected);
  });

  it('a wrong email and a wrong password read the same, as email enumeration protection intends', () => {
    expect(friendlyAuthError({ code: 'auth/invalid-credential' })).toBe(friendlyAuthError({ code: 'auth/invalid-login-credentials' }));
    expect(friendlyAuthError({ code: 'auth/invalid-credential' })).toMatch(/reset/i);
  });

  it('points a missing account at Create account, and a closed project says so', () => {
    expect(friendlyAuthError({ code: 'auth/user-not-found' })).toMatch(/create/i);
    expect(friendlyAuthError({ code: 'auth/admin-restricted-operation' })).toMatch(/closed/i);
    expect(friendlyAuthError({ code: 'auth/email-already-in-use' })).toMatch(/sign in/i);
  });

  it('treats the SDK chunk failing to download as being offline', () => {
    const offline = friendlyAuthError({ code: 'auth/network-request-failed' });
    expect(offline).toMatch(/offline|connection/i);
    expect(friendlyAuthError(new TypeError('Failed to fetch dynamically imported module: /assets/firebase-abc.js'))).toBe(offline);
    expect(friendlyAuthError(new TypeError('Importing a module script failed.'))).toBe(offline);
    expect(friendlyAuthError(new TypeError('Cannot read properties of undefined'))).toBe(GENERIC);
  });

  it('never throws on hostile input', () => {
    for (const value of [Symbol('x'), () => undefined, Object.create(null), { code: null }, { code: { nested: true } }, new Proxy({}, {})]) {
      expect(() => friendlyAuthError(value)).not.toThrow();
    }
  });
});

describe('signOutUser: was the sign-out clean?', () => {
  const ME = { uid: 'owner-1', email: 'me@example.com' };
  const online = (onLine: boolean): void => {
    vi.stubGlobal('navigator', { onLine });
  };

  beforeEach(() => {
    Object.assign(fake.state, { flush: 'confirm', flushCalls: 0, signOuts: 0, signOutError: null });
    useSyncStore.setState({ user: ME, pending: false, status: 'synced' });
    online(true);
  });

  afterEach(() => {
    signOutWasClean(ME.uid); // never leak a verdict into the next test
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('nothing waiting: clean, online or offline', async () => {
    await signOutUser();
    expect(signOutWasClean(ME.uid)).toBe(true);
    online(false);
    await signOutUser();
    expect(signOutWasClean(ME.uid)).toBe(true);
    expect(fake.state.signOuts).toBe(2);
  });

  it('writes waiting while offline: the flush is skipped and the sign-out is not clean', async () => {
    useSyncStore.setState({ pending: true, status: 'offline' });
    online(false);
    await signOutUser();
    expect(fake.state.flushCalls).toBe(0);
    expect(fake.state.signOuts).toBe(1);
    expect(signOutWasClean(ME.uid)).toBe(false);
  });

  it('writes waiting while online: clean once the server confirms them', async () => {
    useSyncStore.setState({ pending: true });
    await signOutUser();
    expect(fake.state.flushCalls).toBe(1);
    expect(signOutWasClean(ME.uid)).toBe(true);
  });

  it('writes waiting while online: not clean when the flush times out (the sign-out still goes ahead) or fails', async () => {
    useSyncStore.setState({ pending: true });
    fake.state.flush = 'hang';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    const signingOut = signOutUser().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await signingOut;
    expect(fake.state.signOuts).toBe(1);
    expect(signOutWasClean(ME.uid)).toBe(false);
    vi.useRealTimers();

    fake.state.flush = 'fail';
    await signOutUser();
    expect(signOutWasClean(ME.uid)).toBe(false);
  });

  it('answers once, only for the account it signed out; a failed sign-out leaves no verdict and reads calmly', async () => {
    useSyncStore.setState({ pending: true });
    online(false);
    await signOutUser();
    expect(signOutWasClean('someone-else')).toBeNull();
    await signOutUser();
    expect(signOutWasClean(ME.uid)).toBe(false);
    expect(signOutWasClean(ME.uid)).toBeNull(); // already read

    fake.state.signOutError = Object.assign(new Error('Firebase: Error (auth/network-request-failed).'), {
      code: 'auth/network-request-failed',
    });
    await expect(signOutUser()).rejects.toThrow(friendlyAuthError({ code: 'auth/network-request-failed' }));
    expect(signOutWasClean(ME.uid)).toBeNull();
  });
});
