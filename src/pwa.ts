import { registerSW } from 'virtual:pwa-register';

/** Dispatched on window once the whole app has been precached and will open offline. */
export const OFFLINE_READY_EVENT = 'momentum:offline-ready';

/**
 * Registers the service worker (registerType 'autoUpdate': a new build takes over on the next
 * launch). Guarded so it never throws in dev, in tests, or in browsers without service workers.
 */
export function setupPWA(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  try {
    registerSW({
      immediate: true,
      onOfflineReady: () => {
        window.dispatchEvent(new CustomEvent(OFFLINE_READY_EVENT));
      },
      onRegisterError: () => {
        /* Offline support is best-effort; the app works without a service worker. */
      },
    });
  } catch {
    /* Registration must never break the app. */
  }
}

setupPWA();
