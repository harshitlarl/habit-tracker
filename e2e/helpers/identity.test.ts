import { describe, expect, it } from 'vitest';
import { errorReason, judgeProbe, type IdentityError } from './identity';

/*
 * The sync spec runs, skips or fails on these verdicts before it creates anything (SPEC §13.8: it
 * must always be able to clean the throwaway account up). The referrer-blocked answer cannot be
 * provoked against an unrestricted key, so its branch is pinned down here.
 */

const credentialsAnswer = (message: string) => judgeProbe({ kind: 'response', status: 400, reason: null, message });

describe('judgeProbe', () => {
  it('runs when the bogus credentials are refused, with or without email enumeration protection', () => {
    expect(credentialsAnswer('INVALID_LOGIN_CREDENTIALS')).toEqual({
      action: 'run',
      observed: 'HTTP 400 INVALID_LOGIN_CREDENTIALS',
    });
    expect(credentialsAnswer('EMAIL_NOT_FOUND').action).toBe('run');
    expect(credentialsAnswer('INVALID_PASSWORD').action).toBe('run');
  });

  it('skips on a referrer-restricted key, whether the reason is in details or only in the sentence', () => {
    const blocked = judgeProbe({
      kind: 'response',
      status: 403,
      reason: 'API_KEY_HTTP_REFERRER_BLOCKED',
      message: 'Requests from referer <empty> are blocked.',
    });
    expect(blocked.action).toBe('skip');
    expect(blocked.observed).toBe('HTTP 403 API_KEY_HTTP_REFERRER_BLOCKED Requests from referer <empty> are blocked.');
    if (blocked.action === 'skip') {
      expect(blocked.reason).toContain('API_KEY_HTTP_REFERRER_BLOCKED');
      expect(blocked.reason).toContain('.env.local');
    }
    expect(
      judgeProbe({ kind: 'response', status: 403, reason: null, message: 'Requests from referer <empty> are blocked.' })
        .action,
    ).toBe('skip');
  });

  it('skips when Google cannot be reached', () => {
    const verdict = judgeProbe({
      kind: 'unreachable',
      error: 'fetch failed (getaddrinfo ENOTFOUND identitytoolkit.googleapis.com)',
    });
    expect(verdict.action).toBe('skip');
    if (verdict.action === 'skip') expect(verdict.reason).toContain('ENOTFOUND');
  });

  it('fails on anything else: an invalid key, a disabled provider, throttling, an unexpected success', () => {
    const invalidKey = judgeProbe({
      kind: 'response',
      status: 400,
      reason: 'API_KEY_INVALID',
      message: 'API key not valid. Please pass a valid API key.',
    });
    expect(invalidKey.action).toBe('fail');
    if (invalidKey.action === 'fail') expect(invalidKey.reason).toContain('API_KEY_INVALID');
    expect(credentialsAnswer('PASSWORD_LOGIN_DISABLED').action).toBe('fail');
    expect(credentialsAnswer('TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled.').action).toBe(
      'fail',
    );
    expect(judgeProbe({ kind: 'response', status: 200, reason: null, message: null })).toMatchObject({
      action: 'fail',
      observed: 'HTTP 200',
    });
    expect(judgeProbe({ kind: 'response', status: 503, reason: null, message: null }).action).toBe('fail');
  });
});

describe('errorReason', () => {
  it('reads details[].reason and ignores envelopes without one', () => {
    const blocked: IdentityError = {
      error: {
        code: 403,
        message: 'Requests from referer <empty> are blocked.',
        status: 'PERMISSION_DENIED',
        details: [{}, { reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }],
      },
    };
    expect(errorReason(blocked)).toBe('API_KEY_HTTP_REFERRER_BLOCKED');
    expect(errorReason({ error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } })).toBeNull();
    expect(errorReason({})).toBeNull();
  });
});
