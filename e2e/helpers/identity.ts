/*
 * The Identity Toolkit REST calls the sync spec makes from Node, outside any browser: a probe of the
 * Firebase API key before the real-backend test creates anything, and the cleanup of the throwaway
 * account afterwards. Node sends no Referer, so a key restricted by HTTP referrer (the README's
 * optional hardening) refuses these calls with API_KEY_HTTP_REFERRER_BLOCKED even though the browser
 * flows would work — and an account the spec had created could never be removed again. The probe
 * therefore asks to sign in to an account that does not exist and expects to be told the credentials
 * are wrong; any other answer decides whether the spec skips (this machine cannot run it) or fails
 * (the project is misconfigured in a way that would break the app too). `judgeProbe` is pure and
 * unit-tested; nothing here imports Playwright, so vitest can load this file.
 *
 * The key these calls use is SYNC_E2E_API_KEY (environment or .env.local) when set, else the app's
 * VITE_FIREBASE_API_KEY (sync.spec.ts reads both). A second, unrestricted key for them must never be a
 * VITE_ variable: Vite loads .env.local for every build, `npm run deploy:firebase` included, and would
 * publish it in the bundle.
 */

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';

/**
 * Google's error envelope. Auth errors carry their code in `message` (e.g. INVALID_LOGIN_CREDENTIALS,
 * sometimes followed by " : details"); API-key errors carry a sentence in `message` and the code in
 * `details[].reason` (e.g. API_KEY_HTTP_REFERRER_BLOCKED).
 */
export interface IdentityError {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ reason?: string }>;
  };
}

export interface SignInResponse extends IdentityError {
  idToken?: string;
  localId?: string;
}

export interface RetryOptions<T> {
  /** Pauses before the 2nd, 3rd … attempt; one attempt more than there are pauses. */
  delays?: readonly number[];
  /** A value that came back but is worth another attempt too, e.g. HTTP 429 or 5xx. */
  retryIf?: (value: T) => boolean;
  /** Injected by the unit tests. */
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until it resolves with a value `retryIf` accepts, retrying after each pause in `delays`
 * when it throws (a request that got no answer: DNS, a reset connection, a timeout) or resolves with a
 * value `retryIf` rejects. The last attempt's outcome is returned or thrown as is. The cleanup of the
 * throwaway account goes through this: one dropped request must not leave an account behind whose
 * random password died with the worker.
 */
export async function withRetry<T>(
  attempt: () => Promise<T>,
  { delays = [1_000, 2_000, 4_000, 8_000], retryIf = () => false, sleep = pause }: RetryOptions<T> = {},
): Promise<T> {
  for (let i = 0; ; i += 1) {
    const last = i >= delays.length;
    try {
      const value = await attempt();
      if (last || !retryIf(value)) return value;
    } catch (error) {
      if (last) throw error;
    }
    await sleep(delays[i] ?? 0);
  }
}

/** Google said "try later" (throttled, or a server-side failure): worth another attempt. */
export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** POST accounts:{method}. A body that is not JSON reads as `{}`. */
export async function identity<T extends IdentityError>(
  apiKey: string,
  method: 'signInWithPassword' | 'delete',
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; json: T }> {
  const response = await fetch(`${IDENTITY}/accounts:${method}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, json };
}

/** The machine-readable reason of an API-key error, when the envelope carries one. */
export function errorReason(json: IdentityError): string | null {
  for (const detail of json.error?.details ?? []) {
    if (typeof detail.reason === 'string' && detail.reason !== '') return detail.reason;
  }
  return null;
}

/** What the probe observed: Identity Toolkit's answer, or the failure of the request itself. */
export type ProbeAnswer =
  | { kind: 'response'; status: number; reason: string | null; message: string | null }
  | { kind: 'unreachable'; error: string };

export type ProbeVerdict =
  /** The key answers Node and refused the bogus credentials: the spec can run and clean up after itself. */
  | { action: 'run'; observed: string }
  /** This machine cannot run the spec (no network, or a referrer-restricted key); nothing was created. */
  | { action: 'skip'; observed: string; reason: string }
  /** The project refuses in a way that would break the app as well: fail loudly. */
  | { action: 'fail'; observed: string; reason: string };

/** Identity Toolkit's answer to a sign-in that matches no account, with or without email enumeration protection. */
const CREDENTIALS_REFUSED = /^(EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD)\b/;

/**
 * The sign-in was refused for its credentials: with the right password in hand, the account does not
 * exist (never created, or deleted). Any other answer — throttling, a 5xx after every retry, a disabled
 * account — proves nothing about whether it is still there.
 */
export function isCredentialsRefusal(message: string | null | undefined): boolean {
  return CREDENTIALS_REFUSED.test(message ?? '');
}

/** The restriction error, by reason or by its sentence ("Requests from referer <empty> are blocked."). */
const REFERRER_BLOCKED = /API_KEY_HTTP_REFERRER_BLOCKED|requests from referer .* are blocked/i;

export const REFERRER_BLOCKED_REASON =
  'the Firebase API key is restricted by HTTP referrer, so Identity Toolkit refuses requests from Node ' +
  '(API_KEY_HTTP_REFERRER_BLOCKED) and a throwaway account could not be cleaned up afterwards. To run ' +
  'this test, give the Node-side calls an unrestricted key of the same project as SYNC_E2E_API_KEY, in ' +
  'the environment or in .env.local (never as VITE_FIREBASE_API_KEY, which every build would publish); ' +
  'see README, "Firebase console settings worth a look".';

export function judgeProbe(answer: ProbeAnswer): ProbeVerdict {
  if (answer.kind === 'unreachable') {
    return {
      action: 'skip',
      observed: answer.error,
      reason: `Google cannot be reached from this machine (${answer.error}).`,
    };
  }
  const observed = [`HTTP ${answer.status}`, answer.reason, answer.message].filter(Boolean).join(' ');
  if (answer.reason === 'API_KEY_HTTP_REFERRER_BLOCKED' || REFERRER_BLOCKED.test(answer.message ?? '')) {
    return { action: 'skip', observed, reason: REFERRER_BLOCKED_REASON };
  }
  if (isCredentialsRefusal(answer.message)) return { action: 'run', observed };
  return {
    action: 'fail',
    observed,
    reason:
      `Identity Toolkit answered the API-key probe with "${observed}" instead of refusing the bogus credentials, ` +
      'so the sync spec could neither sign up nor clean up. Check the key (SYNC_E2E_API_KEY when set, else ' +
      "VITE_FIREBASE_API_KEY) and the project's Authentication settings.",
  };
}

/** "fetch failed (getaddrinfo ENOTFOUND identitytoolkit.googleapis.com)" rather than just "fetch failed". */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const causeText = cause instanceof Error ? cause.message : cause === undefined ? null : String(cause);
  return causeText ? `${error.message} (${causeText})` : error.message;
}

/**
 * Signs in to an account that cannot exist (`email` is unique to the run) and judges the answer. The
 * request gets its own timeout so a black-holed network ends in a skip rather than a hook timeout.
 */
export async function probeApiKey(
  apiKey: string,
  email: string,
  password: string,
  timeoutMs = 15_000,
): Promise<ProbeVerdict> {
  let answer: ProbeAnswer;
  try {
    const { status, json } = await identity<SignInResponse>(
      apiKey,
      'signInWithPassword',
      { email, password, returnSecureToken: true },
      AbortSignal.timeout(timeoutMs),
    );
    answer = { kind: 'response', status, reason: errorReason(json), message: json.error?.message ?? null };
  } catch (error) {
    answer = { kind: 'unreachable', error: describeError(error) };
  }
  return judgeProbe(answer);
}
