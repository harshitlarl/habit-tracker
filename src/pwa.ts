import type { RegisterSWOptions } from 'vite-plugin-pwa/types';

/**
 * Service-worker registration and the update policy (SPEC §2: registerType 'autoUpdate').
 *
 * A new build installs in the background and takes control of the open page at once (skipWaiting +
 * clientsClaim in vite.config.ts). The page then has to reload to run the new code. The plugin's own
 * client reloads on the spot, which wiped a half-typed sheet; onNeedReload takes that over (review #25):
 * the reload happens at once only when it interrupts nothing — no dialog open, no text field focused —
 * and otherwise waits for the first such moment that follows: a sheet closing, or the owner leaving the
 * app (visibilitychange → hidden, pagehide). Leaving with a sheet still open does not count: on iOS the
 * app usually survives a quick trip to another app, and its draft should too.
 *
 * A standalone PWA can stay open for days, and the browser looks for a new service worker only on
 * navigation, so the registration is also asked to check whenever the app comes back to the foreground,
 * at most once an hour.
 *
 * registerSW (virtual:pwa-register) is passed in by main.tsx, which keeps this module loadable without
 * the plugin: the pure rules below are unit-tested (e2e/helpers/pwa-update.test.ts).
 */

/** Dispatched on window once the whole app has been precached and will open offline. */
export const OFFLINE_READY_EVENT = 'momentum:offline-ready';

/** Coming back to the foreground asks the server for a new build at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** The signature of registerSW from virtual:pwa-register. */
export type RegisterSW = (options: RegisterSWOptions) => unknown;

/** What the safe-to-reload decision looks at; readReloadContext reads it from the document. */
export interface ReloadContext {
  /** An element with role="dialog" is in the document: a sheet is open, maybe holding typed text. */
  dialogOpen: boolean;
  /** Tag name of the focused element, or null when nothing (or only <body>) has focus. */
  activeTag: string | null;
  /** The focused element is contenteditable. */
  activeEditable: boolean;
}

const FIELD_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** A reload now would wipe nothing the owner is in the middle of: no sheet open, no field focused. */
export function isSafeToReload(ctx: ReloadContext): boolean {
  if (ctx.dialogOpen || ctx.activeEditable) return false;
  return ctx.activeTag === null || !FIELD_TAGS.has(ctx.activeTag.toUpperCase());
}

/** A return to the foreground at `now` may ask for an update: the last check was at least an hour before. */
export function isUpdateCheckDue(lastCheckAt: number, now: number): boolean {
  return now - lastCheckAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** The document's side of isSafeToReload. */
export function readReloadContext(doc: Document): ReloadContext {
  const active = doc.activeElement;
  return {
    dialogOpen: doc.querySelector('[role="dialog"]') !== null,
    activeTag: active !== null && active !== doc.body ? active.tagName : null,
    activeEditable: active !== null && 'isContentEditable' in active && active.isContentEditable === true,
  };
}

/**
 * Registers the service worker with the update policy above. Guarded so it never throws in dev, in
 * tests, or in browsers without service workers.
 */
export function setupPWA(register: RegisterSW): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  try {
    register({
      immediate: true,
      onNeedReload: reloadWhenSafe,
      onOfflineReady: () => {
        window.dispatchEvent(new CustomEvent(OFFLINE_READY_EVENT));
      },
      onRegisteredSW: (_swUrl, registration) => {
        if (registration) checkForUpdatesOnReturn(registration);
      },
      onRegisterError: () => {
        /* Offline support is best-effort; the app works without a service worker. */
      },
    });
  } catch {
    /* Registration must never break the app. */
  }
}

/** A reload is waiting for a calm moment (the listeners below are attached once). */
let reloadPending = false;

/** A new build has taken control: reload into it now if that interrupts nothing, else at the next calm moment. */
function reloadWhenSafe(): void {
  if (reloadPending) return;
  if (isSafeToReload(readReloadContext(document))) {
    window.location.reload();
    return;
  }
  reloadPending = true;
  const reloadIfSafe = (): void => {
    if (isSafeToReload(readReloadContext(document))) window.location.reload();
  };
  // The owner leaves the app, so the reload happens out of sight.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reloadIfSafe();
  });
  window.addEventListener('pagehide', reloadIfSafe);
  // A sheet closing: Sheet renders its dialog in a portal directly under <body>, so its leaving is a
  // childList change there. Only that transition counts — other changes under <body> (the export's
  // download link) must not turn a moment of typing elsewhere into a reload.
  let dialogOpen = readReloadContext(document).dialogOpen;
  new MutationObserver(() => {
    const ctx = readReloadContext(document);
    const closed = dialogOpen && !ctx.dialogOpen;
    dialogOpen = ctx.dialogOpen;
    if (closed && isSafeToReload(ctx)) window.location.reload();
  }).observe(document.body, { childList: true });
}

/** Ask for a new build whenever the app comes back to the foreground, at most once an hour (and not offline). */
function checkForUpdatesOnReturn(registration: ServiceWorkerRegistration): void {
  // Registering just checked; the hour starts now.
  let lastCheckAt = Date.now();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
    const now = Date.now();
    if (!isUpdateCheckDue(lastCheckAt, now)) return;
    lastCheckAt = now;
    registration.update().catch(() => {
      /* Unreachable server: the next return tries again an hour on. */
    });
  });
}
