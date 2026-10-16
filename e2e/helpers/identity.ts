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
/** The restriction error, by reason or by its sentence ("Requests from referer <empty> are blocked."). */
const REFERRER_BLOCKED = /API_KEY_HTTP_REFERRER_BLOCKED|requests from referer .* are blocked/i;

export const REFERRER_BLOCKED_REASON =
  'the Firebase API key is restricted by HTTP referrer, so Identity Toolkit refuses requests from Node ' +
  '(API_KEY_HTTP_REFERRER_BLOCKED) and a throwaway account could not be cleaned up afterwards. Put an ' +
  'unrestricted key in .env.local (VITE_FIREBASE_API_KEY=…) to run this test; see README, ' +
  '"Firebase console settings worth a look".';

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
  if (CREDENTIALS_REFUSED.test(answer.message ?? '')) return { action: 'run', observed };
  return {
    action: 'fail',
    observed,
    reason:
      `Identity Toolkit answered the API-key probe with "${observed}" instead of refusing the bogus credentials, ` +
      "so the sync spec could neither sign up nor clean up. Check VITE_FIREBASE_API_KEY and the project's " +
      'Authentication settings.',
  };
}

/** "fetch failed (getaddrinfo ENOTFOUND identitytoolkit.googleapis.com)" rather than just "fetch failed". */
function describeError(error: unknown): string {
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
