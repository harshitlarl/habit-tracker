import { describe, expect, it } from 'vitest';
import { friendlyAuthError } from '../sync/auth';

/*
 * friendlyAuthError (SPEC §13.5): every code the sign-in form can run into maps to its own calm
 * sentence; anything else gets one generic sentence. Importing auth.ts is safe here: the SDK is only
 * reached through the dynamic imports in firebase.ts, which nothing in this file triggers.
 */

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
