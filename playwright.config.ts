import { defineConfig, devices } from '@playwright/test';

/*
 * The e2e suite drives the production build (dist/) served by `vite preview`, in an emulated
 * iPhone 14 running WebKit — the engine the app ships to. The web server does not rebuild, so run
 * `npm run build` first, and `npx playwright install webkit` once per machine.
 *
 * On a machine where WebKit cannot launch, PW_FALLBACK_CHROMIUM=1 runs the same phone geometry in
 * Chromium instead (`npx playwright install chromium`).
 */
const PORT = 4174;
const BASE_URL = `http://localhost:${PORT}`;
/* The device preset's 664px viewport leaves room for Safari's toolbars; the installed PWA has the whole screen. */
const PHONE = { width: 390, height: 844 };
const iphone = devices['iPhone 14'];
const useChromium = process.env.PW_FALLBACK_CHROMIUM === '1';

export default defineConfig({
  testDir: './e2e',
  // Only *.spec.ts files are Playwright tests; e2e/helpers/*.test.ts are vitest unit tests of the helpers.
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_URL,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
  },
  projects: [
    useChromium
      ? {
          name: 'iphone-14-chromium',
          use: {
            browserName: 'chromium',
            userAgent: iphone?.userAgent,
            viewport: PHONE,
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
          },
        }
      : {
          name: 'iphone-14-webkit',
          use: { ...iphone, browserName: 'webkit', viewport: PHONE },
        },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
