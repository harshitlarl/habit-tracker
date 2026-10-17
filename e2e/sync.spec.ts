import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { expectTextContrast } from './helpers/contrast';
import {
  describeError,
  identity,
  isCredentialsRefusal,
  isRetryableStatus,
  probeApiKey,
  withRetry,
  type IdentityError,
  type ProbeVerdict,
  type SignInResponse,
} from './helpers/identity';
import { entryPath, forgetEntry, recordAccount, scanLedger, throwawayEmail, type PendingAccount } from './helpers/ledger';

/*
 * Cloud sync against the REAL Firebase project (SPEC §13.8), on two emulated iPhones at once:
 *
 *   A  creates a tracker locally, then creates a throwaway account → the local tracker is uploaded
 *      and the card reads "Synced" within 20 s; a second tracker added while signed in survives a
 *      reload (session restored from IndexedDB).
 *   B  a fresh phone with no local data: "Create account" with the taken email and a wrong password
 *      both get calm inline errors, the right one pulls both trackers down. A check-in on B shows up
 *      on A and an un-check on A shows up on B, twice: the first write on each phone within 20 s, the
 *      second within 10 s (see "Realtime budgets" below). One-time tasks (SPEC §14.8) travel the same
 *      way: a task planned (with a time and a note) and checked off on A shows up on B within 10 s, B
 *      renames it and A follows, A un-checks it and B follows, and A deletes it while B has it open in the editor: B's
 *      sheet says it was deleted on another device, Save and Delete turn off, and nothing is re-created (QA round 1
 *      bug); the documents under users/{uid}/tasks are read back over REST to check their shape. B goes offline: the status line says so,
 *      a check-in made offline queues and reaches A once B is back online. A deletion on A (inline
 *      confirm) disappears from B within 10 s. B then runs "Delete cloud data" (two-step, light and
 *      dark) and is signed out with its local copy intact.
 *   A  notices the emptied cloud, keeps its local data and signs out — local data still there, also
 *      after a reload. Still signed out: a wrong password and "Forgot password?" answer inline. A
 *      second sign-in re-uploads the local copy. "Reset this device" signs out first and clears this
 *      device only, and signing in brings the tracker back from the cloud.
 *   C  a phone that cannot reach Google (every *.googleapis.com / *.firebaseio.com request is
 *      aborted): the app loads and works locally, and the Sync card shows the signed-out form and a
 *      readable offline error when a sign-in is attempted.
 *
 * The web config is read from .env the way Vite reads it; nothing is hardcoded. The Node-side calls
 * (probe and cleanup) use SYNC_E2E_API_KEY when it is set — in the environment or .env.local, never as
 * a VITE_ variable, which every build would publish — and the app's VITE_FIREBASE_API_KEY otherwise; the
 * browser always runs the app with the key it was built with. Before anything is created, that key is
 * probed from Node (helpers/identity.ts): a sign-in with credentials that cannot match must come back
 * refused. When Google cannot be reached, or the key is restricted by
 * HTTP referrer (Node sends none, so the cleanup below could never run), the real-backend test skips
 * itself and says why; an answer that would break the app as well (an invalid key, a disabled
 * provider) fails it. SYNC_E2E=0 leaves both tests in this file out. The account is removed in
 * afterAll through the Identity Toolkit REST API — also when assertions failed — after sweeping
 * anything left under users/{uid}/habits and users/{uid}/tasks with the owner's own token. The result is written to
 * cleanup.json next to the screenshots. Every Node-side call is retried on a dropped request or a 429/5xx (the
 * password exists only in this worker: one lost request used to leave the account behind for good), the account
 * is deleted even when the sweep could not finish, and the beforeAll also checks that Firestore's REST API answers
 * Node before anything is created. A worker killed before its afterAll (Ctrl-C, a crash) still took the password
 * with it, so the beforeAll also records the credentials in the git-ignored pending-cleanup ledger before the
 * account can exist (helpers/ledger.ts: owner-only files in e2e/.pending-cleanup/), the afterAll forgets them once
 * a sign-in with them is refused, and each run's beforeAll first removes what earlier runs left there; that sweep
 * is reported in cleanup.json under earlierRuns.
 *
 * Realtime budgets: a change on a connected phone reaches the other within REALTIME_MS (10 s). The first write a
 * phone makes after signing in or reloading gets COLD_WRITE_MS (20 s): Firestore opens its Write stream lazily, so
 * that write also pays for the WebChannel handshake (4.9–5.7 s on a good day, over 10 s on a slow link), while later
 * writes take 1–3 s. A hop that misses its budget reports what the server held at that moment, which tells a slow
 * upload from a listener that did not apply the change.
 *
 * Console errors/warnings, uncaught exceptions and native dialogs are collected on every phone and
 * asserted empty at the end. A few browser- or SDK-level messages are tolerated, each only during the
 * action that provokes it (tolerate()): WebKit's "… due to access control checks" page errors for
 * Firestore's long-poll requests cancelled by a reload, WebKit's "Failed to load resource … 400" for
 * a rejected credential, WebKit's resource errors and the Firestore SDK's own connection warnings
 * while a phone is deliberately offline, and the engine's warning when the other phone empties the
 * cloud. Next to the screenshots: console-<X>.log (every message, stamped), timings.json (sign-up,
 * sign-in, realtime and offline-queue latencies), status-trace-*.json (the status line during each
 * sign-in) and cleanup.json.
 */

const STORAGE_KEY = 'momentum-v1';
const PHONE = { width: 390, height: 844 };
const DIR =
  process.env.SYNC_SCREENSHOT_DIR ??
  path.join(process.env.SCREENSHOT_DIR ?? path.join(process.cwd(), 'e2e', 'screenshots'), 'sync');

const RUN = Date.now();
/** The ledger accepts this pattern only (helpers/ledger.ts THROWAWAY_EMAIL), so no sweep can touch a real account. */
const EMAIL = throwawayEmail(RUN);
/** 20 random characters; never printed. */
const PASSWORD = `${randomBytes(12).toString('base64url')}-Qa9`;
/** The API-key probe tries to sign in here; no such account exists, so the answer must be a refusal. */
const PROBE_EMAIL = `momentum-qa-probe-${RUN}@example.com`;

const LOCAL_TRACKER = 'Morning walk';
const CLOUD_TRACKER = 'Cloud test';
const SYNC_TASK = 'Pick up the parcel';
const SYNC_TASK_RENAMED = 'Pick up the parcel from the front desk';
const SYNC_TASK_NOTE = 'counter 3';

/** A change on a connected phone reaches the other phone within this (SPEC §13.8: realtime). */
const REALTIME_MS = 10_000;
/** The first write after a sign-in or a reload also opens Firestore's Write stream (see the header). */
const COLD_WRITE_MS = 20_000;

/** Set by the main test once it knows what the cloud should hold at cleanup time; null = not asserted. */
let expectedCloudDocs: number | null = null;
/** The API-key probe's verdict (beforeAll); the cleanup runs only when it let the test run. */
let probe: ProbeVerdict | null = null;

/** The pending-cleanup ledger (helpers/ledger.ts); git-ignored. */
const LEDGER_DIR = path.join(process.cwd(), 'e2e', '.pending-cleanup');
/** Earlier runs' accounts removed per run at most, oldest first; the rest wait for the next run. */
const SWEEP_LIMIT = 5;
/** What the beforeAll's sweep of the ledger did (written to cleanup.json as earlierRuns). */
let earlierRuns: EarlierRuns | null = null;

const FIRESTORE = 'https://firestore.googleapis.com/v1';

/* ---------- Firebase web config, read from .env (never hardcoded) ---------- */

interface FirebaseEnv {
  /** The key the Node-side Identity Toolkit calls use: SYNC_E2E_API_KEY, else the app's own key. */
  apiKey: string;
  projectId: string;
}

/** KEY=value lines of one env file; empty when the file does not exist. */
function readEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path.join(process.cwd(), file), 'utf8');
  } catch {
    return values;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    values[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function readFirebaseEnv(): FirebaseEnv | null {
  const committed = readEnvFile('.env');
  const local = readEnvFile('.env.local');
  // The app's config, with Vite's precedence: .env, then .env.local, then the process environment.
  const get = (name: string): string | undefined => process.env[name] ?? local[name] ?? committed[name];
  const appKey = get('VITE_FIREBASE_API_KEY');
  const projectId = get('VITE_FIREBASE_PROJECT_ID');
  const authDomain = get('VITE_FIREBASE_AUTH_DOMAIN');
  const appId = get('VITE_FIREBASE_APP_ID');
  if (!appKey || !projectId || !authDomain || !appId) return null;
  // A test-only key for the Node-side calls: never committed (.env is) and never VITE_-prefixed, so no
  // build can pick it up.
  const testKey = process.env.SYNC_E2E_API_KEY || local.SYNC_E2E_API_KEY;
  return { apiKey: testKey || appKey, projectId };
}

const ENV = readFirebaseEnv();

/* ---------- cleanup (Identity Toolkit + Firestore REST) ---------- */

export interface CleanupReport {
  email: string;
  /** The account's uid once a sign-in returned it: what to look for in the console if anything is left. */
  uid: string | null;
  at: string;
  /** 'no-such-account' = the credentials were refused, so the account never existed or is already gone. */
  signIn: 'ok' | 'no-such-account' | 'failed';
  signInMessage: string | null;
  firestoreDocsFound: number;
  firestoreDocsDeleted: number;
  /** Why the document sweep could not finish; the account is deleted regardless. */
  sweepError: string | null;
  accountDeleted: boolean;
  /** A final sign-in with the same credentials was refused. */
  verifiedGone: boolean;
  error: string | null;
}

/** The ledger sweep of accounts earlier runs could not remove (see the header). */
export interface EarlierRuns {
  /** Verified gone (or never created) and forgotten. */
  removed: CleanupReport[];
  /** Still there, or not verifiably gone: the entry stays for the next run. */
  kept: CleanupReport[];
  /** Ledger files that are not a readable throwaway entry; check them by hand. */
  unreadable: string[];
  /** Stale entries beyond SWEEP_LIMIT, left for the next run. */
  deferred: number;
  /** The sweep itself failed (reading the ledger); nothing was removed after that. */
  error: string | null;
}

/** Each Node-side request gets its own timeout, so a black-holed connection is retried rather than awaited for ever. */
const REQUEST_TIMEOUT_MS = 20_000;

/** fetch() for the Firestore REST calls: retried on a dropped request or a 429/5xx answer (helpers/identity.ts). */
function restFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return withRetry(() => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }), {
    retryIf: (response) => isRetryableStatus(response.status),
  });
}

/** identity() with the same retry policy. */
function identityRetried<T extends IdentityError>(
  apiKey: string,
  method: 'signInWithPassword' | 'delete',
  body: unknown,
): Promise<{ status: number; json: T }> {
  return withRetry(() => identity<T>(apiKey, method, body, AbortSignal.timeout(REQUEST_TIMEOUT_MS)), {
    retryIf: (answer) => isRetryableStatus(answer.status),
  });
}

/**
 * Null when Firestore's REST API answers Node (an unauthenticated list is refused, which is an answer), else why
 * not. Checked before the account exists: without it the cleanup could delete the account but not its documents.
 */
async function firestoreUnreachable(env: FirebaseEnv): Promise<string | null> {
  try {
    const response = await restFetch(
      `${FIRESTORE}/projects/${env.projectId}/databases/(default)/documents/users/qa-probe/habits?pageSize=1`,
    );
    return response.status < 500 ? null : `HTTP ${response.status}`;
  } catch (error) {
    return describeError(error);
  }
}

/**
 * Signs in as a throwaway user (this run's, or one from the ledger), sweeps users/{uid}/habits and
 * users/{uid}/tasks, deletes the account, and checks it is gone.
 */
async function cleanupAccount(env: FirebaseEnv, account: Pick<PendingAccount, 'email' | 'password'>): Promise<CleanupReport> {
  const report: CleanupReport = {
    email: account.email,
    uid: null,
    at: new Date().toISOString(),
    signIn: 'failed',
    signInMessage: null,
    firestoreDocsFound: 0,
    firestoreDocsDeleted: 0,
    sweepError: null,
    accountDeleted: false,
    verifiedGone: false,
    error: null,
  };
  const credentials = { email: account.email, password: account.password, returnSecureToken: true };
  try {
    const signIn = await identityRetried<SignInResponse>(env.apiKey, 'signInWithPassword', credentials);
    const { idToken, localId: uid } = signIn.json;
    if (signIn.status !== 200 || !idToken || !uid) {
      const message = signIn.json.error?.message ?? `HTTP ${signIn.status}`;
      report.signInMessage = message;
      // The password is known here, so a credentials error can only mean the account does not exist.
      const missing = isCredentialsRefusal(message);
      report.signIn = missing ? 'no-such-account' : 'failed';
      report.verifiedGone = missing;
      return report;
    }
    report.signIn = 'ok';
    report.uid = uid;

    // Anything the UI flow left behind (a failed run) would otherwise sit in Firestore for ever. The
    // engine writes two collections under users/{uid} (SPEC §14.8), so both are swept.
    const headers = { Authorization: `Bearer ${idToken}` };
    const documents = `${FIRESTORE}/projects/${env.projectId}/databases/(default)/documents/users/${uid}`;
    try {
      for (const collection of ['habits', 'tasks']) {
        const listed = await restFetch(`${documents}/${collection}?pageSize=300`, { headers });
        if (!listed.ok) throw new Error(`listing ${collection}: HTTP ${listed.status}`);
        const body = (await listed.json().catch(() => ({}))) as { documents?: Array<{ name: string }> };
        const docs = body.documents ?? [];
        report.firestoreDocsFound += docs.length;
        for (const doc of docs) {
          const deleted = await restFetch(`${FIRESTORE}/${doc.name}`, { method: 'DELETE', headers });
          if (deleted.ok) report.firestoreDocsDeleted += 1;
        }
      }
    } catch (error) {
      // Carry on to the account: its password exists only in this worker, so nothing could remove it later.
      report.sweepError = describeError(error);
    }

    const deleted = await identityRetried<IdentityError>(env.apiKey, 'delete', { idToken });
    report.accountDeleted = deleted.status === 200;
    if (!report.accountDeleted) report.error = deleted.json.error?.message ?? `HTTP ${deleted.status}`;

    const again = await identityRetried<SignInResponse>(env.apiKey, 'signInWithPassword', credentials);
    // Gone only when the credentials are refused: a 5xx or a throttle that outlasted the retries proves
    // nothing, and the ledger must not forget an account that may still be there.
    report.verifiedGone = again.status !== 200 && isCredentialsRefusal(again.json.error?.message);
  } catch (error) {
    report.error = describeError(error);
  }
  return report;
}

/**
 * Removes the accounts earlier runs left in the ledger (helpers/ledger.ts): those of runs that are over,
 * never one still in progress. An entry is forgotten once its account is verified gone; one that is not
 * stays for the next run. Never throws: a sweep that cannot run must not stop this run.
 */
async function sweepEarlierRuns(env: FirebaseEnv): Promise<EarlierRuns> {
  const result: EarlierRuns = { removed: [], kept: [], unreadable: [], deferred: 0, error: null };
  try {
    const scan = scanLedger(LEDGER_DIR, { except: EMAIL });
    result.unreadable = scan.unreadable;
    result.deferred = Math.max(0, scan.stale.length - SWEEP_LIMIT);
    for (const { file, account } of scan.stale.slice(0, SWEEP_LIMIT)) {
      const report = await cleanupAccount(env, account);
      if (report.verifiedGone) {
        forgetEntry(file);
        result.removed.push(report);
      } else {
        result.kept.push(report);
      }
    }
  } catch (error) {
    result.error = describeError(error);
  }
  return result;
}

/** One document of users/{uid}/{collection}, its Firestore REST value wrappers unwrapped. */
interface CloudDoc {
  id: string;
  fields: Record<string, unknown>;
}

/** Firestore REST wraps every value ({ stringValue }, { booleanValue }, { mapValue } …); this unwraps the scalars used here. */
function unwrapValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = value as Record<string, unknown>;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return { timestamp: v.timestampValue };
  if ('nullValue' in v) return null;
  if ('mapValue' in v) {
    const fields = ((v.mapValue as { fields?: Record<string, unknown> }).fields ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, unwrapValue(f)]));
  }
  return value;
}

/**
 * Reads users/{uid}/{collection} straight from Firestore with the owner's own token (a separate session
 * from the phones'), so the test sees what the server holds rather than what a phone's cache says.
 */
async function readCloud(env: FirebaseEnv, collection: 'habits' | 'tasks'): Promise<CloudDoc[]> {
  const signIn = await identityRetried<SignInResponse>(env.apiKey, 'signInWithPassword', {
    email: EMAIL,
    password: PASSWORD,
    returnSecureToken: true,
  });
  const { idToken, localId: uid } = signIn.json;
  if (signIn.status !== 200 || !idToken || !uid) throw new Error(`REST sign-in failed: HTTP ${signIn.status}`);
  const url = `${FIRESTORE}/projects/${env.projectId}/databases/(default)/documents/users/${uid}/${collection}?pageSize=300`;
  const listed = await restFetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!listed.ok) throw new Error(`Firestore list ${collection}: HTTP ${listed.status}`);
  const body = (await listed.json()) as { documents?: Array<{ name: string; fields?: Record<string, unknown> }> };
  return (body.documents ?? []).map((doc) => ({
    id: doc.name.slice(doc.name.lastIndexOf('/') + 1),
    fields: Object.fromEntries(Object.entries(doc.fields ?? {}).map(([k, f]) => [k, unwrapValue(f)])),
  }));
}

/* ---------- phones ---------- */

type ContextOptions = NonNullable<Parameters<Browser['newContext']>[0]>;

interface Phone {
  label: string;
  context: BrowserContext;
  page: Page;
  /** Console errors + warnings, uncaught exceptions and native dialogs — asserted empty. */
  issues: string[];
  /** Every console message, for the log file. */
  log: string[];
  /** Browser-level messages tolerated right now, each scoped to the action that provokes it (see tolerate()). */
  tolerated: RegExp[];
}

const iphone = devices['iPhone 14'];

/** Seconds since the file was loaded, for the console logs. */
const stamp = (): string => `[+${((Date.now() - RUN) / 1000).toFixed(1)}s]`;

/** Messages a phone may log without failing the run. Empty on purpose: anything logged is reported. */
const EXPECTED_CONSOLE: readonly RegExp[] = [];

/** test.step that also marks the step in each phone's console log, so a logged message can be placed in time. */
async function step(name: string, phones: readonly Phone[], body: () => Promise<void>): Promise<void> {
  for (const phone of phones) phone.log.push(`${stamp()} [step] ${name}`);
  await test.step(name, body);
}

/**
 * Tolerates one message on `phone` until the returned function is called. Only for messages the
 * browser (or the engine, by design) logs about an action the test performs on purpose; outside that
 * window the same message still fails the run.
 */
function tolerate(phone: Phone, pattern: RegExp): () => void {
  phone.tolerated.push(pattern);
  phone.log.push(`${stamp()} [tolerate] ${pattern.source}`);
  return () => {
    phone.tolerated = phone.tolerated.filter((p) => p !== pattern);
    phone.log.push(`${stamp()} [tolerate:end] ${pattern.source}`);
  };
}

/**
 * WebKit reports Firestore's open Listen/Write long-poll requests, cancelled when the document
 * unloads, as "… due to access control checks" page errors (its wording for any cross-origin
 * failure). They can only appear while a signed-in page navigates away, so a reload tolerates them.
 */
const FIRESTORE_UNLOAD_ERROR =
  /firestore\.googleapis\.com\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel\?.* due to access control checks\.$/;

/** WebKit logs every non-2xx response; Identity Toolkit answers a wrong password with HTTP 400. */
const AUTH_REJECTED_LOG = /^Failed to load resource: the server responded with a status of 400 \(\)$/;

/** The engine's own warning when another device emptied the cloud (engine.ts, onCloudCleared). */
const CLOUD_CLEARED_WARNING =
  /^Momentum sync: the cloud collection was emptied elsewhere; sync paused to keep the local copy\.$/;

/** The status line while the device cannot reach the server (syncText.ts OFFLINE_TEXT). */
const OFFLINE_STATUS = "Offline — changes will sync when you're back online";

/**
 * While a signed-in phone is deliberately offline: WebKit's resource and page errors for Firestore's
 * failing requests (including the `TYPE=terminate` beacon WebChannel sends when it closes a channel,
 * which WebKit reports as "Beacon API cannot load … WebKit encountered an internal error"), and the
 * SDK's own warnings that its Listen/Write streams dropped or the backend is unreachable.
 */
const OFFLINE_WINDOW_LOGS: readonly RegExp[] = [
  /^Failed to load resource: /,
  /Load failed/i,
  /access control checks/i,
  /network connection was lost/i,
  /Internet connection appears to be offline/i,
  /^Beacon API cannot load https:\/\/firestore\.googleapis\.com\/google\.firestore\.v1\.Firestore\/(Listen|Write)\/channel\?.*TYPE=terminate.*\. WebKit encountered an internal error$/,
  /@firebase\/firestore: Firestore \([\d.]+\): ((WebChannelConnection )?RPC '(Listen|Write)' stream \S+ transport errored|Could not reach Cloud Firestore backend)/,
];

/** Reloads a phone that may be signed in (see FIRESTORE_UNLOAD_ERROR). */
async function reload(phone: Phone): Promise<void> {
  const done = tolerate(phone, FIRESTORE_UNLOAD_ERROR);
  try {
    await phone.page.reload();
  } finally {
    done();
  }
}

async function newPhone(
  browser: Browser,
  label: string,
  baseURL: string | undefined,
  options: ContextOptions = {},
  ignore: readonly RegExp[] = EXPECTED_CONSOLE,
): Promise<Phone> {
  const context = await browser.newContext({
    userAgent: iphone?.userAgent,
    deviceScaleFactor: iphone?.deviceScaleFactor,
    isMobile: iphone?.isMobile,
    hasTouch: iphone?.hasTouch,
    viewport: PHONE,
    colorScheme: 'light',
    baseURL,
    ...options,
  });
  const page = await context.newPage();
  const phone: Phone = { label, context, page, issues: [], log: [], tolerated: [] };
  const record = (kind: string, text: string): void => {
    const expected = ignore.some((re) => re.test(text));
    const tolerated = !expected && phone.tolerated.some((re) => re.test(text));
    const tag = expected ? ' [expected]' : tolerated ? ' [tolerated]' : '';
    phone.log.push(`${stamp()} [${kind}]${tag} ${text}`);
    if (!expected && !tolerated) phone.issues.push(`[${label}] [${kind}] ${text}`);
  };
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') record(`console.${type}`, msg.text());
    else phone.log.push(`${stamp()} [console.${type}] ${msg.text()}`);
  });
  page.on('pageerror', (error) => record('pageerror', error.message));
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) phone.log.push(`${stamp()} [navigated] ${frame.url()}`);
  });
  page.on('dialog', (dialog) => {
    // The app must never use window.alert / confirm / prompt (SPEC §3.4).
    phone.issues.push(`[${label}] [dialog] window.${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return phone;
}

async function closePhone(phone: Phone): Promise<void> {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(path.join(DIR, `console-${phone.label}.log`), `${phone.log.join('\n')}\n`);
  } finally {
    await phone.context.close();
  }
}

/* ---------- app helpers ---------- */

type Tab = 'Today' | 'Week' | 'Progress' | 'Trackers';

async function openTab(page: Page, label: Tab): Promise<void> {
  const tab = page.locator('.tabbar').getByRole('button', { name: label, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-current', 'page');
}

const syncCard = (page: Page): Locator => page.locator('section.sync');
const statusLine = (page: Page): Locator => syncCard(page).locator('.sync__status');
const syncMessage = (page: Page): Locator => syncCard(page).locator('.sync__message');
const trackerNames = (page: Page): Locator => page.locator('.manage-row__name');
const checkFor = (page: Page, name: string): Locator =>
  page.getByRole('button', { name: `Mark ${name} done`, exact: true });

/** Trackers tab → the "Sync across devices" card. */
async function openSync(page: Page): Promise<Locator> {
  await openTab(page, 'Trackers');
  const card = syncCard(page);
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Sync across devices' })).toBeVisible();
  return card;
}

/**
 * Signed out, the card starts collapsed to its lead and one button (polish M3): the form is in the DOM
 * but hidden. Tapping the button reveals it, removes the button and puts the caret in Email.
 */
async function openSignInForm(page: Page): Promise<Locator> {
  const card = syncCard(page);
  const form = card.locator('.sync__form');
  const opener = card.getByRole('button', { name: 'Sign in or create account', exact: true });
  await expect(opener).toBeVisible({ timeout: 20_000 });
  await expect(opener).toHaveAttribute('aria-expanded', 'false');
  expect(await opener.getAttribute('aria-controls'), 'the button controls the form').toBe(await form.getAttribute('id'));
  await expect(form).toBeHidden();
  await expect(card.getByLabel('Email', { exact: true })).toBeHidden();
  await opener.click();
  await expect(form).toBeVisible();
  await expect(opener).toHaveCount(0);
  await expect(card.getByLabel('Email', { exact: true })).toBeFocused();
  return card;
}

async function fillCredentials(card: Locator, email: string, password: string): Promise<void> {
  await card.getByLabel('Email', { exact: true }).fill(email);
  await card.getByLabel('Password', { exact: true }).fill(password);
}

async function addTracker(page: Page, name: string): Promise<void> {
  await openTab(page, 'Trackers');
  await page.getByRole('button', { name: /^Add (your first )?tracker$/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New tracker' })).toBeVisible();
  await dialog.getByPlaceholder('e.g. Gym').fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trackerNames(page).filter({ hasText: name })).toBeVisible();
}

/** Trackers tab → tap the row → Delete → the inline question → Delete. */
async function deleteTracker(page: Page, name: string): Promise<void> {
  await openTab(page, 'Trackers');
  await page.locator('.manage-row__main').filter({ hasText: name }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Edit tracker' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = dialog.locator('.confirm');
  await expect(confirm).toContainText(`Delete ${name} and its history?`);
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trackerNames(page).filter({ hasText: name })).toHaveCount(0);
}

interface StoredState {
  habits: Array<{ id: string; name: string }>;
  completions: Record<string, Record<string, true>>;
  deletedIds?: string[];
  tasks?: Array<{ id: string; title: string; date: string; time?: string; note?: string; done: boolean; doneAt?: string }>;
  deletedTaskIds?: string[];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** Today's LOCAL date key, as the app computes it (dates.ts). */
const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** The app's formatTime(): the device-locale clock for 'HH:mm', computed in the page with the same Intl call. */
async function clockLabel(page: Page, time: string): Promise<string> {
  return page.evaluate(
    ([h, m]) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2001, 0, 15, h, m)),
    [Number(time.slice(0, 2)), Number(time.slice(3, 5))] as const,
  );
}

const taskRows = (page: Page): Locator => page.locator('section.tasks .task-row');
const taskRow = (page: Page, title: string): Locator =>
  taskRows(page).filter({ has: page.locator('.task-row__title', { hasText: new RegExp(`^${title}$`) }) });

interface StatusSample {
  /** ms since the trace started */
  at: number;
  text: string;
}
type TraceWindow = Window & { __syncTrace?: StatusSample[] };

/** Records every change of the Sync card's status line (or "(form)" while signed out) into the page. */
async function startStatusTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as TraceWindow;
    const card = document.querySelector('section.sync');
    if (!card) return;
    const started = performance.now();
    const samples: StatusSample[] = [];
    w.__syncTrace = samples;
    let last: string | null = null;
    const sample = (): void => {
      const text = card.querySelector('.sync__status')?.textContent?.trim() ?? '(form)';
      if (text === last) return;
      last = text;
      samples.push({ at: Math.round(performance.now() - started), text });
    };
    sample();
    new MutationObserver(sample).observe(card, { subtree: true, childList: true, characterData: true });
  });
}

/** Reads the trace, saves it next to the screenshots and soft-asserts it never claimed "Offline" while online. */
async function finishStatusTrace(phone: Phone, name: string): Promise<StatusSample[]> {
  const trace = await phone.page.evaluate(() => (window as TraceWindow).__syncTrace ?? []);
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, `status-trace-${name}.json`), `${JSON.stringify(trace, null, 2)}\n`);
  phone.log.push(`${stamp()} [trace:${name}] ${trace.map((s) => `${s.at}ms "${s.text}"`).join(' → ')}`);
  expect
    .soft(
      trace.map((s) => s.text),
      `${name}: the status line never claims to be offline while the device is online`,
    )
    .not.toContainEqual(expect.stringMatching(/^Offline/));
  return trace;
}

async function readStore(page: Page): Promise<StoredState | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as { state: StoredState }).state;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    return true;
  });
  await page.waitForTimeout(400);
}

/** The whole phone with `anchor` (default: the Sync card) scrolled to the top, plus the anchor alone. */
async function shot(page: Page, name: string, anchor: Locator = syncCard(page)): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  await anchor.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await settle(page);
  await page.screenshot({ path: path.join(DIR, `${name}.png`), animations: 'disabled', caret: 'hide' });
  await anchor.screenshot({ path: path.join(DIR, `${name}-card.png`), animations: 'disabled', caret: 'hide' });
}

/** Inputs ≥ 16px (iOS would zoom otherwise) and every visible button ≥ 44 × 44 CSS px, inside `scope`. */
async function expectErgonomics(scope: Locator, where: string): Promise<void> {
  const controls = await scope.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('button, input'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          name: el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? el.textContent?.trim() ?? '',
          w: Math.round(r.width),
          h: Math.round(r.height),
          font: Number.parseFloat(getComputedStyle(el).fontSize),
        };
      })
      .filter((c) => c.w > 0 && c.h > 0),
  );
  expect(controls.length, `${where}: controls to measure`).toBeGreaterThan(0);
  expect(
    controls.filter((c) => c.tag === 'input' && c.font < 16),
    `${where}: inputs under 16px`,
  ).toEqual([]);
  expect(
    controls.filter((c) => c.tag === 'button' && (c.w < 44 || c.h < 44)),
    `${where}: buttons under 44px`,
  ).toEqual([]);
}

/* ---------- tests ---------- */

test.describe('Cloud sync', () => {
  test.skip(ENV === null, 'VITE_FIREBASE_* is not configured, so the sync UI is hidden');
  test.skip(process.env.SYNC_E2E === '0', 'SYNC_E2E=0 leaves the cloud-sync specs out');

  test.describe('against the real Firebase project', () => {
    // Nothing is created before the key is known to answer Node, so a skip here leaves nothing to clean up.
    test.beforeAll(async () => {
      if (!ENV) return;
      // Room for the retried Firestore check and the sweep of earlier runs' accounts on a slow link.
      test.setTimeout(240_000);
      probe = await probeApiKey(ENV.apiKey, PROBE_EMAIL, PASSWORD);
      process.stdout.write(`[sync.spec] API-key probe: ${probe.observed}\n`);
      if (probe.action === 'run') {
        const unreachable = await firestoreUnreachable(ENV);
        if (unreachable !== null) {
          probe = {
            action: 'skip',
            observed: unreachable,
            reason: `Firestore's REST API cannot be reached from Node (${unreachable}), so the throwaway account's documents could not be swept afterwards.`,
          };
        }
      }
      if (probe.action === 'skip') {
        process.stdout.write(`[sync.spec] skipping the real-backend test: ${probe.reason}\n`);
        test.skip(true, probe.reason);
      }
      if (probe.action === 'fail') throw new Error(probe.reason);

      // The test can run: first remove what killed runs left behind, then record this run's credentials
      // before the account can exist, so a worker that dies from here on leaves them for the next run.
      earlierRuns = await sweepEarlierRuns(ENV);
      process.stdout.write(
        `[sync.spec] earlier runs' accounts: ${earlierRuns.removed.length} removed, ${earlierRuns.kept.length} kept, ` +
          `${earlierRuns.unreadable.length} unreadable, ${earlierRuns.deferred} deferred${earlierRuns.error ? `; ${earlierRuns.error}` : ''}\n`,
      );
      recordAccount(LEDGER_DIR, { email: EMAIL, password: PASSWORD, pid: process.pid, recordedAt: new Date().toISOString() });
    });

    test.afterAll(async () => {
      if (!ENV || probe?.action !== 'run') return;
      // Room for every retry of every call (helpers/identity.ts withRetry) on a slow link.
      test.setTimeout(240_000);
      const report = await cleanupAccount(ENV, { email: EMAIL, password: PASSWORD });
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path.join(DIR, 'cleanup.json'), `${JSON.stringify({ ...report, earlierRuns }, null, 2)}\n`);
      process.stdout.write(`[sync.spec] cleanup: ${JSON.stringify(report)}\n`);
      // Gone (or never created): nothing left for a later run. Otherwise the ledger keeps the credentials.
      if (report.verifiedGone) forgetEntry(entryPath(LEDGER_DIR, EMAIL));
      // Accounts earlier runs left in the ledger (cleanup.json → earlierRuns says which, and why); soft, and
      // first, so they are reported whatever this run's own cleanup did.
      expect.soft(earlierRuns?.error ?? null, 'the ledger of earlier runs could be read').toBeNull();
      expect.soft(earlierRuns?.kept.map((r) => r.email) ?? [], "earlier runs' accounts were removed").toEqual([]);
      expect.soft(earlierRuns?.unreadable ?? [], 'every ledger file is a readable entry').toEqual([]);
      expect(report.error, 'cleanup ran without errors').toBeNull();
      expect(report.verifiedGone, `the throwaway account ${EMAIL} is gone`).toBe(true);
      expect.soft(report.sweepError, `every document under users/${report.uid ?? '?'} was swept`).toBeNull();
      expect.soft(report.firestoreDocsDeleted, 'each document found was deleted').toBe(report.firestoreDocsFound);
      if (expectedCloudDocs !== null) {
        expect
          .soft(report.firestoreDocsFound, 'the cloud held exactly what the run left there (the re-uploaded tracker)')
          .toBe(expectedCloudDocs);
      }
    });

    test('two phones stay in sync in realtime, offline changes queue, and deletes and resets keep local data', async ({ browser }, testInfo) => {
      test.setTimeout(300_000);
      mkdirSync(DIR, { recursive: true });
      const baseURL = testInfo.project.use.baseURL;
      const A = await newPhone(browser, 'A', baseURL);
      const B = await newPhone(browser, 'B', baseURL);
      const htmlA = A.page.locator('html');
      const htmlB = B.page.locator('html');
      /** Milliseconds measured along the way; written to timings.json. */
      const timings: Record<string, number> = {};
      const measure = async (name: string, body: () => Promise<void>): Promise<void> => {
        const started = Date.now();
        await body();
        timings[name] = Date.now() - started;
        for (const phone of [A, B]) phone.log.push(`${stamp()} [timing] ${name}: ${timings[name]} ms`);
      };
      /**
       * One change carried from one phone to the other: `body(timeout)` makes it and waits up to `budgetMs`
       * for the other phone to show it. A miss says what the server held at that moment (`server`), which
       * tells a slow upload from a listener that did not apply the change.
       */
      const hop = async (
        name: string,
        budgetMs: number,
        body: (timeout: number) => Promise<void>,
        server: () => Promise<unknown>,
      ): Promise<void> => {
        try {
          await measure(name, () => body(budgetMs));
        } catch (error) {
          const held = await server().then(
            (value) => JSON.stringify(value),
            (e: unknown) => `nothing readable (${describeError(e)})`,
          );
          for (const phone of [A, B]) phone.log.push(`${stamp()} [timing] ${name}: missed ${budgetMs} ms; the server held ${held}`);
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`${name}: not on the other phone within ${budgetMs} ms; the server held ${held} by then.\n\n${detail}`);
        }
        expect(timings[name], `ms for "${name}"`).toBeLessThanOrEqual(budgetMs);
      };
      /** What the server holds for "Cloud test" today (REST, the owner's token). */
      const cloudCheckIn = async (): Promise<unknown> => {
        if (!ENV) return 'no Firebase env';
        const doc = (await readCloud(ENV, 'habits')).find((d) => d.fields.name === CLOUD_TRACKER);
        const completions = (doc?.fields.completions ?? {}) as Record<string, unknown>;
        return doc ? { [`completions.${localToday()}`]: completions[localToday()] ?? 'absent' } : 'no tracker document';
      };
      /** Set once the synced task's id is known (A → B: a task planned …). */
      let syncTaskId = '';
      /** What the server holds for the synced task (REST, the owner's token). */
      const cloudTask = async (): Promise<unknown> => {
        if (!ENV) return 'no Firebase env';
        const docs = await readCloud(ENV, 'tasks');
        const doc = docs.find((d) => (syncTaskId ? d.id === syncTaskId : d.fields.title === SYNC_TASK));
        return doc
          ? { title: doc.fields.title, done: doc.fields.done, doneAt: doc.fields.doneAt ?? 'absent', deleted: doc.fields.deleted ?? false }
          : `no such task document (${docs.length} under tasks)`;
      };
      /** Ends the tolerance for the engine's cloud-cleared warning on A; set inside a step, read in finally. */
      const cloudCleared: { end: (() => void) | null } = { end: null };

      try {
        await step('A: a tracker exists locally before any account', [A, B], async () => {
          await A.page.goto('/');
          await expect(A.page.locator('.view.today')).toBeVisible();
          await addTracker(A.page, LOCAL_TRACKER);
        });

        await step('A: the Sync card opens to the signed-out form, validates, reveals the password', [A, B], async () => {
          const card = await openSync(A.page);
          await expect(card.locator('.sync__lead')).toHaveText(
            'Back up and sync your trackers and tasks across your devices. Only you can read your data.',
          );
          await expectErgonomics(card, 'Sync card, signed out (collapsed)');
          await openSignInForm(A.page);
          const email = card.getByLabel('Email', { exact: true });
          const password = card.getByLabel('Password', { exact: true });
          await expect(email).toHaveAttribute('type', 'email');
          await expect(email).toHaveAttribute('autocomplete', 'username');
          await expect(email).toHaveAttribute('inputmode', 'email');
          await expect(password).toHaveAttribute('type', 'password');
          await expect(password).toHaveAttribute('autocomplete', 'current-password');
          await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
          await expect(card.getByRole('button', { name: 'Create account' })).toBeVisible();
          await expect(card.getByRole('button', { name: 'Forgot password?' })).toBeVisible();
          await expectErgonomics(card, 'Sync card, signed out');
          await shot(A.page, 'sync-signed-out-light');
          await expectTextContrast(A.page, 'Sync card, signed out (light)');

          // Empty submit: a readable reason, focus on the field that needs it.
          await card.getByRole('button', { name: 'Sign in', exact: true }).click();
          await expect(syncMessage(A.page)).toHaveText('Enter your email.');
          await expect(syncMessage(A.page)).toHaveClass(/is-error/);
          await expect(email).toBeFocused();

          // A short password is refused here, before anything is sent.
          await fillCredentials(card, EMAIL, 'short');
          await card.getByRole('button', { name: 'Create account' }).click();
          await expect(syncMessage(A.page)).toHaveText('Choose a password of at least 6 characters.');
          await expect(password).toBeFocused();

          await card.getByRole('button', { name: 'Show password' }).click();
          await expect(password).toHaveAttribute('type', 'text');
          await card.getByRole('button', { name: 'Hide password' }).click();
          await expect(password).toHaveAttribute('type', 'password');
        });

        await step('A: "Create account" → Synced within 20 s, the local tracker uploaded', [A, B], async () => {
          const card = syncCard(A.page);
          await fillCredentials(card, EMAIL, PASSWORD);
          await startStatusTrace(A.page);
          await measure('A: "Create account" → "Synced"', async () => {
            await card.getByRole('button', { name: 'Create account' }).click();
            await expect(card.locator('.sync__email')).toHaveText(EMAIL, { timeout: 20_000 });
            await expect(statusLine(A.page)).toHaveText(/^Synced/, { timeout: 20_000 });
          });
          await finishStatusTrace(A, 'signup');
          expect(timings['A: "Create account" → "Synced"'], 'ms from "Create account" to "Synced"').toBeLessThanOrEqual(
            20_000,
          );
          await expect(statusLine(A.page)).toHaveText('Synced · just now');
          await expect(card.locator('.sr-only[role="status"]')).toHaveText('Synced');
          await expect(card.locator('.sync__dot')).toHaveAttribute('data-state', 'synced');
          await expect(card.getByRole('button', { name: 'Sign out' })).toBeVisible();
          await expect(card.getByRole('button', { name: 'Delete cloud data' })).toBeVisible();
          await expect(card.locator('.sync__hint')).toHaveText('Signing out keeps everything on this device.');
          // The rest of Settings follows the account state.
          await expect(A.page.locator('.settings__body').first()).toContainText('sync to your account');
          await expect(A.page.locator('.settings__about')).toContainText('synced to your account');
          await expectErgonomics(card, 'Sync card, signed in');
          await shot(A.page, 'sync-signed-in-synced-light');
          await expectTextContrast(A.page, 'Sync card, signed in (light)');
        });

        await step('A: "Cloud test" added while signed in; a reload keeps the session and both trackers', [A, B], async () => {
          await addTracker(A.page, CLOUD_TRACKER);
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER, CLOUD_TRACKER]);
          await expect(statusLine(A.page)).toHaveText(/^Synced/, { timeout: 20_000 });

          await reload(A);
          await expect(A.page.locator('.view.today')).toBeVisible();
          const card = await openSync(A.page);
          await expect(card.locator('.sync__email')).toHaveText(EMAIL, { timeout: 20_000 });
          await expect(statusLine(A.page)).toHaveText(/^Synced/, { timeout: 20_000 });
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER, CLOUD_TRACKER]);
        });

        await step('A: dark mode; "Reset this device" explains it signs out first; import copy mentions the account', [A, B], async () => {
          await A.page.getByRole('radio', { name: 'Dark' }).click();
          await expect(htmlA).toHaveAttribute('data-theme', 'dark');
          await shot(A.page, 'sync-signed-in-synced-dark');
          await expectTextContrast(A.page, 'Sync card, signed in (dark)');

          await A.page.getByRole('button', { name: 'Reset this device' }).click();
          const reset = A.page.locator('.settings__danger .confirm');
          await expect(reset).toContainText('Reset this device?');
          await expect(reset).toContainText("You'll be signed out first");
          await expect(reset.getByRole('button', { name: 'Sign out and reset' })).toBeVisible();
          await shot(A.page, 'settings-reset-confirm-signed-in-dark', reset);
          await reset.getByRole('button', { name: 'Cancel' }).click();
          await expect(reset).toHaveCount(0);

          const backup = testInfo.outputPath('qa-backup.json');
          writeFileSync(
            backup,
            JSON.stringify({
              version: 1,
              habits: [
                {
                  id: '7e3c3b7e-5e2a-4d4e-9b0a-1f2a3b4c5d6e',
                  name: 'Imported',
                  emoji: '📦',
                  color: 'sage',
                  days: [0, 1, 2, 3, 4, 5, 6],
                  createdAt: '2026-10-01',
                  order: 0,
                },
              ],
              completions: {},
              settings: { theme: 'system', installHintDismissed: true },
            }),
          );
          await A.page.locator('input[type="file"]').setInputFiles(backup);
          const importConfirm = A.page.locator('.settings .confirm');
          await expect(importConfirm).toContainText('Replace your data with this backup?');
          // Signed in, the copy says what an import does to the account and every device (polish M12).
          await expect(importConfirm).toContainText(
            'Trackers and tasks not in this backup are deleted from your account and every signed-in device',
          );
          await expect(importConfirm).toContainText('There is no undo.');
          await importConfirm.getByRole('button', { name: 'Cancel' }).click();
          await expect(importConfirm).toHaveCount(0);
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER, CLOUD_TRACKER]); // nothing replaced
        });

        await step('B: a taken email on "Create account" and a wrong password both get calm inline errors', [A, B], async () => {
          await B.page.goto('/');
          await expect(B.page.locator('.empty')).toBeVisible();
          await openSync(B.page);
          const card = await openSignInForm(B.page);
          const message = syncMessage(B.page);
          const rejected = tolerate(B, AUTH_REJECTED_LOG);
          try {
            // The account already exists: the answer says so and points at Sign in.
            await fillCredentials(card, EMAIL, PASSWORD);
            await card.getByRole('button', { name: 'Create account' }).click();
            await expect(message).toHaveText('An account with that email already exists. Sign in instead.', {
              timeout: 20_000,
            });
            await expect(message).toHaveClass(/is-error/);
            await expect(card.locator('.sync__form')).toBeVisible(); // still signed out

            await card.getByLabel('Password', { exact: true }).fill(`${PASSWORD}-wrong`);
            await card.getByRole('button', { name: 'Sign in', exact: true }).click();
            await expect(message).toHaveText(
              /^(That email and password do not match\. Try again, or reset your password\.|That password is not right\. Try again, or reset it\.)$/,
              { timeout: 20_000 },
            );
          } finally {
            rejected();
          }
          await expect(message).toHaveClass(/is-error/);
          await expect(card.locator('.sync__form')).not.toHaveAttribute('aria-busy', 'true');
          await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
          await expectErgonomics(card, 'Sync card, wrong password');
          await shot(B.page, 'sync-error-wrong-password-light');
          await expectTextContrast(B.page, 'Sync card, wrong password (light)');
        });

        await step('B: Enter signs in; both trackers arrive with no local data at all', [A, B], async () => {
          const card = syncCard(B.page);
          expect(await readStore(B.page), 'B has nothing in localStorage yet').toBeNull();
          const password = card.getByLabel('Password', { exact: true });
          await password.fill(PASSWORD);
          await startStatusTrace(B.page);
          await measure('B: Enter → "Synced"', async () => {
            await password.press('Enter');
            await expect(card.locator('.sync__email')).toHaveText(EMAIL, { timeout: 20_000 });
            await expect(statusLine(B.page)).toHaveText(/^Synced/, { timeout: 20_000 });
          });
          await finishStatusTrace(B, 'signin');
          await expect(trackerNames(B.page)).toHaveText([LOCAL_TRACKER, CLOUD_TRACKER], { timeout: 20_000 });
          await expect(htmlB, 'settings never sync: B stays light while A is dark').toHaveAttribute('data-theme', 'light');
        });

        await step('B → A and back: check-ins cross between the phones (first write after (re)connecting ≤ 20 s, then ≤ 10 s)', [A, B], async () => {
          await openTab(A.page, 'Today');
          await expect(A.page.locator('.today__ring')).toHaveText('0/2');
          await openTab(B.page, 'Today');
          await expect(B.page.locator('.today__ring')).toHaveText('0/2');
          const checkOnB = async (timeout: number): Promise<void> => {
            await checkFor(B.page, CLOUD_TRACKER).click();
            await expect(checkFor(B.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'true');
            await expect(checkFor(A.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'true', { timeout });
          };
          // The other direction, and a removal rather than an addition (removeCompletion).
          const uncheckOnA = async (timeout: number): Promise<void> => {
            await checkFor(A.page, CLOUD_TRACKER).click();
            await expect(checkFor(A.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'false');
            await expect(checkFor(B.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'false', { timeout });
          };

          // B's first write since it signed in, and A's first since its reload: each opens a Write stream.
          await hop('B check-in → visible on A (first write after sign-in)', COLD_WRITE_MS, checkOnB, cloudCheckIn);
          await expect(B.page.locator('.today__ring')).toHaveText('1/2');
          await expect(A.page.locator('.today__ring')).toHaveText('1/2');
          await expect(checkFor(A.page, LOCAL_TRACKER)).toHaveAttribute('aria-pressed', 'false');
          await hop('A un-check → visible on B (first write after reload)', COLD_WRITE_MS, uncheckOnA, cloudCheckIn);
          await expect(A.page.locator('.today__ring')).toHaveText('0/2');
          await expect(B.page.locator('.today__ring')).toHaveText('0/2');

          // Both streams are open now: the realtime budget.
          await hop('B check-in → visible on A', REALTIME_MS, checkOnB, cloudCheckIn);
          await hop('A un-check → visible on B', REALTIME_MS, uncheckOnA, cloudCheckIn);
          await expect(A.page.locator('.today__ring')).toHaveText('0/2');
          await expect(B.page.locator('.today__ring')).toHaveText('0/2');
        });

        const today = localToday();

        await step('A → B: a task planned on A with a time and a note, then checked off, reaches B within 10 s', [A, B], async () => {
          // Both phones are on Today; B has no tasks yet.
          await expect(B.page.locator('section.tasks .tasks__empty')).toHaveText('Nothing planned today.');
          const dialog = A.page.getByRole('dialog');
          await A.page.locator('section.tasks').getByRole('button', { name: 'Add task' }).click();
          await expect(dialog.getByRole('heading', { name: 'New task' })).toBeVisible();
          await dialog.getByPlaceholder('e.g. Renew the gym membership').fill(SYNC_TASK);
          await expect(dialog.locator('.task-editor__dates .chip[aria-pressed="true"]')).toHaveText('Today');
          await dialog.getByRole('button', { name: 'Add a time' }).click();
          await dialog.locator('input[type="time"]').fill('15:00');
          await dialog.getByPlaceholder('Optional, e.g. bring the signed form').fill(SYNC_TASK_NOTE);
          const clock = await clockLabel(B.page, '15:00');
          await hop('A new task → visible on B', REALTIME_MS, async (timeout) => {
            await dialog.getByRole('button', { name: 'Save task' }).click();
            await expect(dialog).toHaveCount(0);
            await expect(taskRow(A.page, SYNC_TASK)).toHaveCount(1);
            await expect(taskRow(B.page, SYNC_TASK)).toHaveCount(1, { timeout });
          }, cloudTask);
          const rowB = taskRow(B.page, SYNC_TASK);
          await expect(rowB.locator('.task-row__meta')).toContainText(clock);
          await expect(rowB.locator('.task-row__meta')).toContainText(SYNC_TASK_NOTE);
          await expect(checkFor(B.page, SYNC_TASK)).toHaveAttribute('aria-pressed', 'false');
          await expect(B.page.locator('section.tasks .tasks__tools .small-caps')).toHaveText('1 left');

          await hop('A task check → visible on B', REALTIME_MS, async (timeout) => {
            await checkFor(A.page, SYNC_TASK).click();
            await expect(checkFor(A.page, SYNC_TASK)).toHaveAttribute('aria-pressed', 'true');
            await expect(checkFor(B.page, SYNC_TASK)).toHaveAttribute('aria-pressed', 'true', { timeout });
          }, cloudTask);
          await expect(rowB).toHaveClass(/is-done/);
          await expect(B.page.locator('section.tasks .tasks__tools .small-caps')).toHaveText('All done');
          // Tasks never touch the trackers' ring (SPEC §14.1).
          await expect(A.page.locator('.today__ring')).toHaveText('0/2');
          await expect(B.page.locator('.today__ring')).toHaveText('0/2');

          const storedB = await readStore(B.page);
          const onB = storedB?.tasks?.find((t) => t.title === SYNC_TASK);
          expect(onB, "B's stored copy").toMatchObject({ date: today, time: '15:00', note: SYNC_TASK_NOTE, done: true, doneAt: today });
          syncTaskId = onB?.id ?? '';
          const storedA = await readStore(A.page);
          expect(storedA?.tasks?.map((t) => t.id), 'the same id on both phones').toEqual([syncTaskId]);

          // What the server holds (SPEC §14.8): the task fields, a server timestamp, and no `deleted` written by setTask.
          if (!ENV) throw new Error('unreachable: the describe skips without ENV');
          const cloud = await readCloud(ENV, 'tasks');
          expect(cloud.map((d) => d.id), 'one document under users/{uid}/tasks').toEqual([syncTaskId]);
          const doc = cloud[0]?.fields ?? {};
          expect(doc).toMatchObject({
            id: syncTaskId,
            title: SYNC_TASK,
            note: SYNC_TASK_NOTE,
            date: today,
            time: '15:00',
            done: true,
            doneAt: today,
            createdAt: today,
          });
          expect(doc.updatedAt, 'updatedAt is a server timestamp').toMatchObject({ timestamp: expect.any(String) });
          expect(doc.deleted ?? false, 'a live task is not a tombstone').toBe(false);
        });

        await step('B → A: renaming the task on B reaches A within 10 s, still checked, time and note kept', [A, B], async () => {
          const dialog = B.page.getByRole('dialog');
          await taskRow(B.page, SYNC_TASK).locator('.task-row__body').click();
          await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
          const title = dialog.getByPlaceholder('e.g. Renew the gym membership');
          await expect(title).toHaveValue(SYNC_TASK);
          await expect(dialog.locator('input[type="time"]')).toHaveValue('15:00');
          await title.fill(SYNC_TASK_RENAMED);
          await hop('B rename → visible on A', REALTIME_MS, async (timeout) => {
            await dialog.getByRole('button', { name: 'Save', exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expect(taskRow(B.page, SYNC_TASK_RENAMED)).toHaveCount(1);
            await expect(taskRow(A.page, SYNC_TASK_RENAMED)).toHaveCount(1, { timeout });
          }, cloudTask);
          await expect(taskRow(A.page, SYNC_TASK)).toHaveCount(0);
          await expect(taskRows(A.page)).toHaveCount(1);
          await expect(checkFor(A.page, SYNC_TASK_RENAMED)).toHaveAttribute('aria-pressed', 'true');
          await expect(taskRow(A.page, SYNC_TASK_RENAMED).locator('.task-row__meta')).toContainText(SYNC_TASK_NOTE);
          const storedA = await readStore(A.page);
          expect(storedA?.tasks).toEqual([
            expect.objectContaining({ id: syncTaskId, title: SYNC_TASK_RENAMED, time: '15:00', done: true, doneAt: today }),
          ]);
        });

        await step('A → B: un-checking the task on A reaches B within 10 s, and the server drops doneAt', [A, B], async () => {
          await hop('A task un-check → visible on B', REALTIME_MS, async (timeout) => {
            await checkFor(A.page, SYNC_TASK_RENAMED).click();
            await expect(checkFor(A.page, SYNC_TASK_RENAMED)).toHaveAttribute('aria-pressed', 'false');
            await expect(checkFor(B.page, SYNC_TASK_RENAMED)).toHaveAttribute('aria-pressed', 'false', { timeout });
          }, cloudTask);
          await expect(B.page.locator('section.tasks .tasks__tools .small-caps')).toHaveText('1 left');
          const onB = (await readStore(B.page))?.tasks?.find((t) => t.id === syncTaskId);
          expect(onB?.done, 'B: undone').toBe(false);
          expect(onB, 'B: doneAt is kept only while done').not.toHaveProperty('doneAt');
          if (!ENV) throw new Error('unreachable: the describe skips without ENV');
          // setTask writes doneAt: deleteField() for an undone task (SPEC §14.8).
          await expect
            .poll(async () => {
              const doc = (await readCloud(ENV, 'tasks')).find((d) => d.id === syncTaskId)?.fields ?? {};
              return { done: doc.done, hasDoneAt: 'doneAt' in doc, title: doc.title };
            }, { timeout: 10_000 })
            .toEqual({ done: false, hasDoneAt: false, title: SYNC_TASK_RENAMED });
        });

        await step('A → B: deleting the task on A while B has it open in the editor — B says so within 10 s and saves nothing', [A, B], async () => {
          // B starts editing the task and has not saved: the case the "deleted on another device" guard exists for
          // (QA round 1: Save then re-created the task under a new id, undoing the delete on every device).
          const dialogB = B.page.getByRole('dialog');
          await taskRow(B.page, SYNC_TASK_RENAMED).locator('.task-row__body').click();
          await expect(dialogB.getByRole('heading', { name: 'Edit task' })).toBeVisible();
          const titleB = dialogB.getByPlaceholder('e.g. Renew the gym membership');
          const editedB = `${SYNC_TASK_RENAMED}, edited on B`;
          await titleB.fill(editedB);
          const goneB = dialogB.locator('.task-editor__gone');
          await expect(goneB).toHaveAttribute('role', 'status');
          await expect(goneB).toHaveText('');

          const dialog = A.page.getByRole('dialog');
          await taskRow(A.page, SYNC_TASK_RENAMED).locator('.task-row__body').click();
          await expect(dialog.getByRole('heading', { name: 'Edit task' })).toBeVisible();
          await dialog.getByRole('button', { name: 'Delete task' }).click();
          const confirm = dialog.locator('.confirm');
          await expect(confirm).toContainText(`Delete “${SYNC_TASK_RENAMED}”?`);
          await hop('A task delete → B\'s open editor says so', REALTIME_MS, async (timeout) => {
            await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await expect(taskRows(A.page)).toHaveCount(0);
            await expect(goneB).toHaveText('This task was deleted on another device.', { timeout });
          }, cloudTask);
          await expect(taskRows(B.page), 'the row behind the sheet is gone').toHaveCount(0);
          const saveB = dialogB.getByRole('button', { name: 'Save', exact: true });
          await expect(saveB).toBeDisabled();
          await expect(dialogB.getByRole('button', { name: 'Delete task' })).toBeDisabled();
          await expect(titleB, "B's unsaved text stays in the field").toHaveValue(editedB);
          await expectTextContrast(B.page, 'Edit task, deleted on another device (light)');
          await shot(B.page, 'task-editor-deleted-elsewhere-light', dialogB);
          // Neither Enter in the title nor a tap on the disabled Save brings the task back.
          await titleB.press('Enter');
          await saveB.click({ force: true });
          await expect(dialogB).toBeVisible();
          await B.page.keyboard.press('Escape');
          await expect(dialogB).toHaveCount(0);
          await expect(
            B.page.locator('section.tasks').getByRole('button', { name: 'Add task' }),
            'focus lands on "Add task": the row it came from is gone',
          ).toBeFocused();
          await expect(B.page.locator('section.tasks .tasks__empty')).toHaveText('Nothing planned today.');
          const storedB = await readStore(B.page);
          expect(storedB?.tasks, 'B holds no task: nothing was re-created').toEqual([]);
          expect(storedB?.deletedTaskIds, 'B learned the tombstone').toEqual([syncTaskId]);
          if (!ENV) throw new Error('unreachable: the describe skips without ENV');
          // Sync never hard-deletes: the document stays as a tombstone (only "Delete cloud data" removes it), and
          // B's closed editor wrote nothing — still exactly one task document.
          await expect
            .poll(async () => (await readCloud(ENV, 'tasks')).map((d) => [d.id, d.fields.deleted]), { timeout: 10_000 })
            .toEqual([[syncTaskId, true]]);
          await expect(taskRows(A.page), 'A got nothing back either').toHaveCount(0);
        });

        await step('B offline: the status line says so, a check-in queues and reaches A once B is back online', [A, B], async () => {
          const card = await openSync(B.page);
          await expect(statusLine(B.page)).toHaveText(/^Synced/, { timeout: 20_000 });
          const ends = OFFLINE_WINDOW_LOGS.map((pattern) => tolerate(B, pattern));
          try {
            await B.context.setOffline(true);
            await expect(statusLine(B.page)).toHaveText(OFFLINE_STATUS, { timeout: 30_000 });
            await expect(card.locator('.sync__dot')).toHaveAttribute('data-state', 'offline');
            await expect(statusLine(B.page)).not.toHaveClass(/is-error/);
            await shot(B.page, 'sync-offline-light');
            await expectTextContrast(B.page, 'Sync card, offline (light)');

            await openTab(B.page, 'Today');
            await checkFor(B.page, CLOUD_TRACKER).click();
            await expect(checkFor(B.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'true');
            await expect(B.page.locator('.today__ring')).toHaveText('1/2');
            await B.page.waitForTimeout(2_000);
            await expect(checkFor(A.page, CLOUD_TRACKER), 'A cannot know about it yet').toHaveAttribute(
              'aria-pressed',
              'false',
            );
            await openSync(B.page);
            await expect(statusLine(B.page)).toHaveText(OFFLINE_STATUS);
            // Offline, sign-out cannot flush the queue, so the hint must not promise it (auth.ts).
            await expect(card.locator('.sync__hint')).toHaveText(
              'Signing out keeps everything on this device. Changes made offline are merged into your account the next time you sign in.',
              { timeout: 10_000 },
            );
            // The live region announces the status alone, without the ticking relative time.
            await expect(card.locator('.sr-only[role="status"]')).toHaveText(OFFLINE_STATUS);
            await shot(B.page, 'sync-offline-pending-light');

            await measure('B back online → queued check-in visible on A', async () => {
              await B.context.setOffline(false);
              await expect(checkFor(A.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
            });
            await expect(statusLine(B.page)).toHaveText(/^Synced/, { timeout: 30_000 });
            await expect(card.locator('.sync__hint')).toHaveText('Signing out keeps everything on this device.');
            await expect(A.page.locator('.today__ring')).toHaveText('1/2');
            await openTab(B.page, 'Today');
            await expect(B.page.locator('.today__ring')).toHaveText('1/2');
            // Late SDK warnings about the outage, if any, must land inside this window.
            await B.page.waitForTimeout(1_500);
          } finally {
            for (const end of ends) end();
          }
        });

        await step('A → B: deleting "Cloud test" (inline confirm) removes it from B within 10 s', [A, B], async () => {
          await measure('A delete → gone from B', async () => {
            await deleteTracker(A.page, CLOUD_TRACKER);
            await expect(B.page.locator('.habit-row').filter({ hasText: CLOUD_TRACKER })).toHaveCount(0, {
              timeout: 10_000,
            });
          });
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER]);
          await expect(B.page.locator('.habit-row__name')).toHaveText([LOCAL_TRACKER]);
          await expect(B.page.locator('.today__ring')).toHaveText('0/1');
          const storedB = await readStore(B.page);
          expect(storedB?.habits.map((h) => h.name)).toEqual([LOCAL_TRACKER]);
          expect(storedB?.deletedIds?.length, 'B learned the tombstone').toBe(1);
        });

        await step('B: "Delete cloud data" asks first, then signs B out and keeps its local copy', [A, B], async () => {
          const card = await openSync(B.page);
          await expect(statusLine(B.page)).toHaveText(/^Synced/, { timeout: 20_000 });
          const trigger = card.getByRole('button', { name: 'Delete cloud data' });
          await trigger.click();
          const confirm = card.locator('.confirm');
          await expect(confirm).toContainText('Delete your cloud data?');
          await expect(confirm).toContainText(
            'This removes your trackers and tasks from the cloud and signs you out. Your data stays on this device.',
          );
          await expect(card.getByRole('button', { name: 'Sign out' })).toHaveCount(0); // the question replaces the actions
          await expectErgonomics(card, 'Sync card, delete confirm');
          await shot(B.page, 'sync-delete-confirm-light');
          await expectTextContrast(B.page, 'Sync card, delete confirm (light)');
          await confirm.getByRole('button', { name: 'Cancel' }).click();
          await expect(confirm).toHaveCount(0);
          await expect(trigger).toBeFocused();

          // The same question in dark, then for real.
          await B.page.getByRole('radio', { name: 'Dark' }).click();
          await expect(htmlB).toHaveAttribute('data-theme', 'dark');
          await trigger.click();
          await expect(card.locator('.confirm')).toContainText('Delete your cloud data?');
          await shot(B.page, 'sync-delete-confirm-dark');
          await expectTextContrast(B.page, 'Sync card, delete confirm (dark)');
          // A is about to learn that its cloud collection vanished; the engine warns about that by design.
          cloudCleared.end = tolerate(A, CLOUD_CLEARED_WARNING);
          await card.locator('.confirm').getByRole('button', { name: 'Delete', exact: true }).click();
          await expect(card.locator('.sync__form')).toBeVisible({ timeout: 45_000 });
          await expect(syncMessage(B.page)).toHaveText('Cloud data deleted. Your trackers and tasks stay on this device.');
          await expect(syncMessage(B.page)).not.toHaveClass(/is-error/);
          await expect(trackerNames(B.page)).toHaveText([LOCAL_TRACKER]);
          const keptB = await readStore(B.page);
          expect(keptB?.habits.map((h) => h.name), 'B keeps its local copy').toEqual([LOCAL_TRACKER]);
          await expect(B.page.locator('.settings__about')).toContainText('data stays on this device');
          await shot(B.page, 'sync-signed-out-after-delete-dark');
        });

        await step('A: notices the emptied cloud and keeps its data; Sign out keeps it too, across a reload', [A, B], async () => {
          const card = await openSync(A.page);
          await expect(statusLine(A.page)).toContainText('deleted from another device', { timeout: 15_000 });
          cloudCleared.end?.();
          cloudCleared.end = null;
          await expect(statusLine(A.page)).toHaveClass(/is-error/);
          await expect(card.locator('.sync__dot')).toHaveAttribute('data-state', 'error');
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER]);
          await shot(A.page, 'sync-cloud-cleared-paused-dark');
          await expectTextContrast(A.page, 'Sync card, cloud cleared (dark)');

          await card.getByRole('button', { name: 'Sign out' }).click();
          await expect(card.locator('.sync__form')).toBeVisible({ timeout: 20_000 });
          await expect(syncMessage(A.page)).toHaveText('Signed out. Your trackers and tasks stay on this device.');
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER]);
          await expect(A.page.locator('.settings__about')).toContainText('data stays on this device');
          await shot(A.page, 'sync-signed-out-after-signout-dark');

          await A.page.reload();
          await expect(A.page.locator('.view.today')).toBeVisible();
          await expect(checkFor(A.page, LOCAL_TRACKER)).toBeVisible();
          const stored = await readStore(A.page);
          expect(stored?.habits.map((h) => h.name)).toEqual([LOCAL_TRACKER]);
          expect(stored?.deletedIds?.length, 'A keeps its tombstone').toBe(1);
          expect(stored?.deletedTaskIds?.length, "A keeps the task's tombstone").toBe(1);
          const after = await openSync(A.page);
          // A fresh page: no message to show, so the card is collapsed again until tapped.
          await openSignInForm(A.page);
          await expect(after.locator('.sync__email')).toHaveCount(0);
        });

        await step('A (dark, signed out): a wrong password and "Forgot password?" both answer inline', [A, B], async () => {
          const card = syncCard(A.page);
          const message = syncMessage(A.page);
          const rejected = tolerate(A, AUTH_REJECTED_LOG);
          try {
            await fillCredentials(card, EMAIL, `${PASSWORD}-wrong`);
            await card.getByLabel('Password', { exact: true }).press('Enter');
            await expect(message).toHaveText(
              /^(That email and password do not match\. Try again, or reset your password\.|That password is not right\. Try again, or reset it\.)$/,
              { timeout: 20_000 },
            );
          } finally {
            rejected();
          }
          await expect(message).toHaveClass(/is-error/);
          await expectErgonomics(card, 'Sync card, wrong password (dark)');
          await shot(A.page, 'sync-error-wrong-password-dark');
          await expectTextContrast(A.page, 'Sync card, wrong password (dark)');

          await card.getByRole('button', { name: 'Forgot password?' }).click();
          await expect(message).toHaveText(
            `Reset email sent to ${EMAIL}. Follow the link in it to choose a new password.`,
            { timeout: 20_000 },
          );
          await expect(message).not.toHaveClass(/is-error/);
          await shot(A.page, 'sync-reset-email-sent-dark');
        });

        await step('A: signs in again (email padded with spaces) and re-uploads its local copy', [A, B], async () => {
          const card = syncCard(A.page);
          await fillCredentials(card, `  ${EMAIL}  `, PASSWORD);
          await startStatusTrace(A.page);
          await measure('A: second sign-in → "Synced"', async () => {
            await card.getByRole('button', { name: 'Sign in', exact: true }).click();
            await expect(card.locator('.sync__email')).toHaveText(EMAIL, { timeout: 20_000 });
            await expect(statusLine(A.page)).toHaveText(/^Synced/, { timeout: 20_000 });
          });
          await finishStatusTrace(A, 'signin-again');
          await expect(statusLine(A.page)).not.toHaveClass(/is-error/);
          await expect(card.locator('.sync__dot')).toHaveAttribute('data-state', 'synced');
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER]);
        });

        await step('A: "Reset this device" signs out first and clears this device only; signing in brings it back', [A, B], async () => {
          await A.page.getByRole('button', { name: 'Reset this device' }).click();
          const reset = A.page.locator('.settings__danger .confirm');
          await expect(reset).toContainText('Reset this device?');
          await expect(reset).toContainText('Sign in again any time to bring it all back.');
          await reset.getByRole('button', { name: 'Sign out and reset' }).click();
          // Reset outcomes are announced in the Reset card (polish M3), not under Your data.
          const status = A.page.locator('.settings__reset-status');
          await expect(status).toHaveText('Signed out. Everything on this device has been cleared.', { timeout: 20_000 });
          await expect(status).not.toHaveClass(/is-error/);
          const card = syncCard(A.page);
          await expect(card.locator('.sync__form')).toBeVisible({ timeout: 20_000 });
          await expect(A.page.locator('.manage-row')).toHaveCount(0);
          await expect(htmlA, 'the theme is back to System').toHaveAttribute('data-theme', 'light');
          const wiped = await readStore(A.page);
          expect(wiped?.habits).toEqual([]);
          expect(wiped?.deletedIds).toEqual([]);
          expect(wiped?.tasks).toEqual([]);
          expect(wiped?.deletedTaskIds).toEqual([]);

          await fillCredentials(card, EMAIL, PASSWORD);
          await measure('A: sign-in after reset → tracker back from the cloud', async () => {
            await card.getByRole('button', { name: 'Sign in', exact: true }).click();
            await expect(card.locator('.sync__email')).toHaveText(EMAIL, { timeout: 20_000 });
            await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER], { timeout: 20_000 });
          });
          await expect(statusLine(A.page)).toHaveText(/^Synced/, { timeout: 20_000 });
          await expect(A.page.locator('.manage__sub')).toHaveText('1 active');
          // The cleanup sweep should find exactly this tracker's document: proof the re-upload reached the server.
          expectedCloudDocs = 1;
        });

        await step('neither phone logged errors, warnings, exceptions or native dialogs', [A, B], async () => {
          expect([...A.issues, ...B.issues]).toEqual([]);
        });
      } finally {
        cloudCleared.end?.();
        writeFileSync(path.join(DIR, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
        await closePhone(A);
        await closePhone(B);
      }
    });
  });

  test('works locally and shows a readable Sync state when Google cannot be reached', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const blocked: string[] = [];
    const leaked: string[] = [];
    // Resource failures are the point of this test, not app noise.
    const C = await newPhone(
      browser,
      'C',
      testInfo.project.use.baseURL,
      // No service worker: a worker's fetches bypass page routing, and the blocks below must hold.
      { serviceWorkers: 'block' },
      [
        // Playwright's own notice for the option above, not the app's.
        /^Service Worker registration blocked by Playwright$/,
        /Failed to load resource/i,
        /Load failed/i,
        /access control checks/i,
        /network connection was lost/i,
      ],
    );
    await C.context.route(/^https?:\/\/([^/]+\.)?(googleapis\.com|firebaseio\.com)(:\d+)?\//i, async (route) => {
      blocked.push(route.request().url());
      await route.abort();
    });
    C.context.on('requestfinished', (request) => {
      if (/^https?:\/\/([^/]+\.)?(googleapis\.com|firebaseio\.com)(:\d+)?\//i.test(request.url())) {
        leaked.push(request.url());
      }
    });

    try {
      await step('the app loads and works locally', [C], async () => {
        await C.page.goto('/');
        await expect(C.page.locator('.view.today')).toBeVisible();
        await addTracker(C.page, 'Local only');
        await openTab(C.page, 'Today');
        await checkFor(C.page, 'Local only').click();
        await expect(checkFor(C.page, 'Local only')).toHaveAttribute('aria-pressed', 'true');
        await expect(C.page.locator('.today__ring')).toHaveText('1/1');
      });

      await step('the Sync card shows the signed-out form, and a sign-in attempt reads as offline', [C], async () => {
        await openSync(C.page);
        const card = await openSignInForm(C.page);
        await expect(statusLine(C.page)).toHaveCount(0);
        await shot(C.page, 'sync-unreachable-signed-out-light');

        await fillCredentials(card, 'offline-probe@example.com', 'never-reaches-google');
        await card.getByRole('button', { name: 'Sign in', exact: true }).click();
        const message = syncMessage(C.page);
        await expect(message).toHaveClass(/is-error/, { timeout: 45_000 });
        await expect(message).toHaveText('You seem to be offline. Check your connection and try again.');
        await expect(card.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
        await expectErgonomics(card, 'Sync card, unreachable');
        await shot(C.page, 'sync-unreachable-error-light');
        await expectTextContrast(C.page, 'Sync card, unreachable (light)');

        expect(blocked.length, 'Firebase was actually asked for, and blocked').toBeGreaterThan(0);
        expect(leaked, 'no request to Google got through').toEqual([]);
      });

      await step('the page is intact afterwards', [C], async () => {
        await openTab(C.page, 'Today');
        await expect(checkFor(C.page, 'Local only')).toHaveAttribute('aria-pressed', 'true');
        await openTab(C.page, 'Week');
        await expect(C.page.locator('.wk-row')).toHaveCount(1);
        await C.page.reload();
        await expect(C.page.locator('.view.today')).toBeVisible();
        await expect(checkFor(C.page, 'Local only')).toHaveAttribute('aria-pressed', 'true');
        expect(C.issues).toEqual([]);
      });
    } finally {
      await closePhone(C);
    }
  });
});
