import { describe, expect, it } from 'vitest';
import { errorReason, isCredentialsRefusal, isRetryableStatus, judgeProbe, withRetry, type IdentityError } from './identity';

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
      // The advice names the Node-only variable, never a VITE_ key that a build would publish.
      expect(blocked.reason).toContain('SYNC_E2E_API_KEY');
      expect(blocked.reason).toContain('.env.local');
      expect(blocked.reason).not.toMatch(/VITE_FIREBASE_API_KEY=/);
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

describe('isCredentialsRefusal', () => {
  // The cleanup forgets a ledger entry only on this answer (helpers/ledger.ts): with the right password in
  // hand, a refusal means the account is gone; anything else must keep the entry for the next run.
  it('is true only for a refused sign-in, with or without email enumeration protection', () => {
    expect(isCredentialsRefusal('INVALID_LOGIN_CREDENTIALS')).toBe(true);
    expect(isCredentialsRefusal('EMAIL_NOT_FOUND')).toBe(true);
    expect(isCredentialsRefusal('INVALID_PASSWORD : The password is invalid.')).toBe(true);
    expect(isCredentialsRefusal('TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled.')).toBe(false);
    expect(isCredentialsRefusal('USER_DISABLED')).toBe(false);
    expect(isCredentialsRefusal('The service is currently unavailable.')).toBe(false);
    expect(isCredentialsRefusal('NOT_INVALID_LOGIN_CREDENTIALS')).toBe(false);
    expect(isCredentialsRefusal(null)).toBe(false);
    expect(isCredentialsRefusal(undefined)).toBe(false);
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

describe('withRetry', () => {
  /** Records the pauses instead of waiting them out. */
  const recorder = () => {
    const pauses: number[] = [];
    return { pauses, sleep: async (ms: number) => void pauses.push(ms) };
  };

  it('returns the first good answer without pausing', async () => {
    const { pauses, sleep } = recorder();
    let calls = 0;
    await expect(withRetry(async () => ++calls, { sleep })).resolves.toBe(1);
    expect(pauses).toEqual([]);
  });

  it('retries a request that got no answer, then returns the answer that came', async () => {
    const { pauses, sleep } = recorder();
    let calls = 0;
    const attempt = async (): Promise<string> => {
      calls += 1;
      if (calls < 3) throw new TypeError('fetch failed');
      return 'ok';
    };
    await expect(withRetry(attempt, { delays: [10, 20, 40], sleep })).resolves.toBe('ok');
    expect(calls).toBe(3);
    expect(pauses).toEqual([10, 20]);
  });

  it('retries a value retryIf rejects and hands back the last one when the attempts run out', async () => {
    const { pauses, sleep } = recorder();
    const statuses = [503, 429, 500];
    const result = await withRetry(async () => statuses.shift() ?? 200, {
      delays: [1, 2],
      retryIf: isRetryableStatus,
      sleep,
    });
    expect(result).toBe(500); // three attempts: 503, 429, 500 — the last outcome is returned as is
    expect(pauses).toEqual([1, 2]);
  });

  it('throws the last error once every attempt failed', async () => {
    const { pauses, sleep } = recorder();
    let calls = 0;
    const attempt = async (): Promise<never> => {
      calls += 1;
      throw new Error(`attempt ${calls}`);
    };
    await expect(withRetry(attempt, { delays: [5, 5], sleep })).rejects.toThrow('attempt 3');
    expect(pauses).toEqual([5, 5]);
  });

  it('treats 429 and 5xx as worth another attempt, and every other status as final', () => {
    expect([429, 500, 502, 503].map(isRetryableStatus)).toEqual([true, true, true, true]);
    expect([200, 400, 401, 403, 404].map(isRetryableStatus)).toEqual([false, false, false, false, false]);
  });
});
