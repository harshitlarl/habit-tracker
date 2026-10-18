import { defineConfig, devices } from '@playwright/test';

/*
 * The e2e suite drives the production build (dist/) served by `vite preview`, in an emulated
 * iPhone 14 running WebKit — the engine the app ships to. The web server does not rebuild, so run
 * `npm run build` first, and `npx playwright install webkit` once per machine.
 *
 * BASE_PATH — the variable vite.config.ts reads — runs the suite in another base, such as a sub-path
 * host (SPEC §2, §12). Build and test with the same value; the preview server is given it too:
 *   BASE_PATH=/momentum/ npm run build && BASE_PATH=/momentum/ npx playwright test
 * Specs navigate to '/', which `vite preview` redirects to the base.
 *
 * On a machine where WebKit cannot launch, PW_FALLBACK_CHROMIUM=1 runs the same phone geometry in
 * Chromium instead (`npx playwright install chromium`).
 *
 * Two optional overrides keep a run apart from other work on the same machine: PW_PORT serves the
 * preview on another port (default 4174), and PW_OUTDIR serves a build made elsewhere, e.g.
 *   npx tsc -b && npx vite build --outDir /tmp/momentum-qa --emptyOutDir && PW_OUTDIR=/tmp/momentum-qa npx playwright test
 * so a concurrent `npm run build` into dist/ cannot change the app under test halfway through.
 */
const PORT = Number(process.env.PW_PORT ?? '') || 4174;
const OUT_DIR = process.env.PW_OUTDIR?.trim() ?? '';
/** Vite's base with one leading and one trailing slash; '/' when BASE_PATH is unset. */
function normalizeBase(raw: string | undefined): string {
  const inner = (raw ?? '').replace(/^\/+|\/+$/g, '');
  return inner === '' ? '/' : `/${inner}/`;
}
const BASE = normalizeBase(process.env.BASE_PATH);
const BASE_URL = `http://localhost:${PORT}${BASE}`;
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
    command: `npx vite preview --port ${PORT} --strictPort${OUT_DIR ? ` --outDir ${JSON.stringify(OUT_DIR)}` : ''}`,
    url: BASE_URL,
    // vite.config.ts reads the same variable, so the preview serves dist/ under the base it was built for.
    env: { BASE_PATH: BASE },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
