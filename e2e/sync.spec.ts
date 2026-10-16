import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { expectTextContrast } from './helpers/contrast';
import { identity, probeApiKey, type IdentityError, type ProbeVerdict, type SignInResponse } from './helpers/identity';

/*
 * Cloud sync against the REAL Firebase project (SPEC §13.8), on two emulated iPhones at once:
 *
 *   A  creates a tracker locally, then creates a throwaway account → the local tracker is uploaded
 *      and the card reads "Synced" within 20 s; a second tracker added while signed in survives a
 *      reload (session restored from IndexedDB).
 *   B  a fresh phone with no local data: "Create account" with the taken email and a wrong password
 *      both get calm inline errors, the right one pulls both trackers down. A check-in on B shows up
 *      on A within 10 s and an un-check on A shows up on B. B goes offline: the status line says so,
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
 * The web config is read from .env the way Vite reads it; nothing is hardcoded. Before anything is
 * created, the API key is probed from Node (helpers/identity.ts): a sign-in with credentials that
 * cannot match must come back refused. When Google cannot be reached, or the key is restricted by
 * HTTP referrer (Node sends none, so the cleanup below could never run), the real-backend test skips
 * itself and says why; an answer that would break the app as well (an invalid key, a disabled
 * provider) fails it. SYNC_E2E=0 leaves both tests in this file out. The account is removed in
 * afterAll through the Identity Toolkit REST API — also when assertions failed — after sweeping
 * anything left under users/{uid}/habits with the owner's own token. The result is written to
 * cleanup.json next to the screenshots.
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
const EMAIL = `momentum-qa-2-${RUN}@example.com`;
/** 20 random characters; never printed. */
const PASSWORD = `${randomBytes(12).toString('base64url')}-Qa9`;
/** The API-key probe tries to sign in here; no such account exists, so the answer must be a refusal. */
const PROBE_EMAIL = `momentum-qa-probe-${RUN}@example.com`;

const LOCAL_TRACKER = 'Morning walk';
const CLOUD_TRACKER = 'Cloud test';

/** Set by the main test once it knows what the cloud should hold at cleanup time; null = not asserted. */
let expectedCloudDocs: number | null = null;
/** The API-key probe's verdict (beforeAll); the cleanup runs only when it let the test run. */
let probe: ProbeVerdict | null = null;

const FIRESTORE = 'https://firestore.googleapis.com/v1';

/* ---------- Firebase web config, read from .env (never hardcoded) ---------- */

interface FirebaseEnv {
  apiKey: string;
  projectId: string;
}

function readFirebaseEnv(): FirebaseEnv | null {
  const values: Record<string, string> = {};
  // Same precedence as Vite: .env, then .env.local, then the process environment.
  for (const file of ['.env', '.env.local']) {
    let text: string;
    try {
      text = readFileSync(path.join(process.cwd(), file), 'utf8');
    } catch {
      continue;
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
  }
  const get = (name: string): string | undefined => process.env[name] ?? values[name];
  const apiKey = get('VITE_FIREBASE_API_KEY');
  const projectId = get('VITE_FIREBASE_PROJECT_ID');
  const authDomain = get('VITE_FIREBASE_AUTH_DOMAIN');
  const appId = get('VITE_FIREBASE_APP_ID');
  if (!apiKey || !projectId || !authDomain || !appId) return null;
  return { apiKey, projectId };
}

const ENV = readFirebaseEnv();

/* ---------- cleanup (Identity Toolkit + Firestore REST) ---------- */

export interface CleanupReport {
  email: string;
  at: string;
  /** 'no-such-account' = the credentials were refused, so the account never existed or is already gone. */
  signIn: 'ok' | 'no-such-account' | 'failed';
  signInMessage: string | null;
  firestoreDocsFound: number;
  firestoreDocsDeleted: number;
  accountDeleted: boolean;
  /** A final sign-in with the same credentials was refused. */
  verifiedGone: boolean;
  error: string | null;
}

/** Signs in as the throwaway user, sweeps users/{uid}/habits, deletes the account, and checks it is gone. */
async function cleanupAccount(env: FirebaseEnv): Promise<CleanupReport> {
  const report: CleanupReport = {
    email: EMAIL,
    at: new Date().toISOString(),
    signIn: 'failed',
    signInMessage: null,
    firestoreDocsFound: 0,
    firestoreDocsDeleted: 0,
    accountDeleted: false,
    verifiedGone: false,
    error: null,
  };
  const credentials = { email: EMAIL, password: PASSWORD, returnSecureToken: true };
  try {
    const signIn = await identity<SignInResponse>(env.apiKey, 'signInWithPassword', credentials);
    const { idToken, localId: uid } = signIn.json;
    if (signIn.status !== 200 || !idToken || !uid) {
      const message = signIn.json.error?.message ?? `HTTP ${signIn.status}`;
      report.signInMessage = message;
      // The password is known here, so a credentials error can only mean the account does not exist.
      const missing = /EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|INVALID_PASSWORD/.test(message);
      report.signIn = missing ? 'no-such-account' : 'failed';
      report.verifiedGone = missing;
      return report;
    }
    report.signIn = 'ok';

    // Anything the UI flow left behind (a failed run) would otherwise sit in Firestore for ever.
    const headers = { Authorization: `Bearer ${idToken}` };
    const collection = `${FIRESTORE}/projects/${env.projectId}/databases/(default)/documents/users/${uid}/habits`;
    const listed = await fetch(`${collection}?pageSize=300`, { headers });
    const body = (await listed.json().catch(() => ({}))) as { documents?: Array<{ name: string }> };
    const docs = body.documents ?? [];
    report.firestoreDocsFound = docs.length;
    for (const doc of docs) {
      const deleted = await fetch(`${FIRESTORE}/${doc.name}`, { method: 'DELETE', headers });
      if (deleted.ok) report.firestoreDocsDeleted += 1;
    }

    const deleted = await identity<IdentityError>(env.apiKey, 'delete', { idToken });
    report.accountDeleted = deleted.status === 200;
    if (!report.accountDeleted) report.error = deleted.json.error?.message ?? `HTTP ${deleted.status}`;

    const again = await identity<SignInResponse>(env.apiKey, 'signInWithPassword', credentials);
    report.verifiedGone = again.status !== 200;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  return report;
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
}

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
      probe = await probeApiKey(ENV.apiKey, PROBE_EMAIL, PASSWORD);
      process.stdout.write(`[sync.spec] API-key probe: ${probe.observed}\n`);
      if (probe.action === 'skip') {
        process.stdout.write(`[sync.spec] skipping the real-backend test: ${probe.reason}\n`);
        test.skip(true, probe.reason);
      }
      if (probe.action === 'fail') throw new Error(probe.reason);
    });

    test.afterAll(async () => {
      if (!ENV || probe?.action !== 'run') return;
      const report = await cleanupAccount(ENV);
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path.join(DIR, 'cleanup.json'), `${JSON.stringify(report, null, 2)}\n`);
      process.stdout.write(`[sync.spec] cleanup: ${JSON.stringify(report)}\n`);
      expect(report.error, 'cleanup ran without errors').toBeNull();
      expect(report.verifiedGone, `the throwaway account ${EMAIL} is gone`).toBe(true);
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
      /** Ends the tolerance for the engine's cloud-cleared warning on A; set inside a step, read in finally. */
      const cloudCleared: { end: (() => void) | null } = { end: null };

      try {
        await step('A: a tracker exists locally before any account', [A, B], async () => {
          await A.page.goto('/');
          await expect(A.page.locator('.view.today')).toBeVisible();
          await addTracker(A.page, LOCAL_TRACKER);
        });

        await step('A: the Sync card shows the signed-out form, validates, reveals the password', [A, B], async () => {
          const card = await openSync(A.page);
          await expect(card.locator('.sync__lead')).toHaveText(
            'Back up and sync your trackers across your devices. Only you can read your data.',
          );
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
          // "…will be replaced, and the backup syncs to your account." (SPEC §13.6 asks for "and syncs to your account")
          await expect(importConfirm).toContainText(/, and the backup syncs to your account\./);
          await importConfirm.getByRole('button', { name: 'Cancel' }).click();
          await expect(importConfirm).toHaveCount(0);
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER, CLOUD_TRACKER]); // nothing replaced
        });

        await step('B: a taken email on "Create account" and a wrong password both get calm inline errors', [A, B], async () => {
          await B.page.goto('/');
          await expect(B.page.locator('.empty')).toBeVisible();
          const card = await openSync(B.page);
          await expect(card.locator('.sync__form')).toBeVisible({ timeout: 20_000 });
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

        await step('B → A: a check-in shows up on A within 10 s; A un-checks it and B follows', [A, B], async () => {
          await openTab(A.page, 'Today');
          await expect(A.page.locator('.today__ring')).toHaveText('0/2');
          await openTab(B.page, 'Today');
          await expect(B.page.locator('.today__ring')).toHaveText('0/2');
          await measure('B check-in → visible on A', async () => {
            await checkFor(B.page, CLOUD_TRACKER).click();
            await expect(checkFor(B.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'true');
            await expect(checkFor(A.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
          });
          await expect(B.page.locator('.today__ring')).toHaveText('1/2');
          await expect(A.page.locator('.today__ring')).toHaveText('1/2');
          await expect(checkFor(A.page, LOCAL_TRACKER)).toHaveAttribute('aria-pressed', 'false');

          // The other direction, and a removal rather than an addition (removeCompletion).
          await measure('A un-check → visible on B', async () => {
            await checkFor(A.page, CLOUD_TRACKER).click();
            await expect(checkFor(A.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'false');
            await expect(checkFor(B.page, CLOUD_TRACKER)).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 });
          });
          await expect(A.page.locator('.today__ring')).toHaveText('0/2');
          await expect(B.page.locator('.today__ring')).toHaveText('0/2');
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
            'This removes your trackers from the cloud and signs you out. Your data stays on this device.',
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
          await expect(syncMessage(B.page)).toHaveText('Cloud data deleted. Your trackers stay on this device.');
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
          await expect(syncMessage(A.page)).toHaveText('Signed out. Your trackers stay on this device.');
          await expect(trackerNames(A.page)).toHaveText([LOCAL_TRACKER]);
          await expect(A.page.locator('.settings__about')).toContainText('data stays on this device');
          await shot(A.page, 'sync-signed-out-after-signout-dark');

          await A.page.reload();
          await expect(A.page.locator('.view.today')).toBeVisible();
          await expect(checkFor(A.page, LOCAL_TRACKER)).toBeVisible();
          const stored = await readStore(A.page);
          expect(stored?.habits.map((h) => h.name)).toEqual([LOCAL_TRACKER]);
          expect(stored?.deletedIds?.length, 'A keeps its tombstone').toBe(1);
          const after = await openSync(A.page);
          await expect(after.locator('.sync__form')).toBeVisible({ timeout: 20_000 });
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
          const status = A.page.locator('.settings__status');
          await expect(status).toHaveText('Signed out. Everything on this device has been cleared.', { timeout: 20_000 });
          await expect(status).not.toHaveClass(/is-error/);
          const card = syncCard(A.page);
          await expect(card.locator('.sync__form')).toBeVisible({ timeout: 20_000 });
          await expect(A.page.locator('.manage-row')).toHaveCount(0);
          await expect(htmlA, 'the theme is back to System').toHaveAttribute('data-theme', 'light');
          const wiped = await readStore(A.page);
          expect(wiped?.habits).toEqual([]);
          expect(wiped?.deletedIds).toEqual([]);

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
        const card = await openSync(C.page);
        await expect(card.locator('.sync__form')).toBeVisible({ timeout: 20_000 });
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
