import { defineConfig } from 'vitest/config';

// The date tests assert New York local time (DST on 2026-03-08 and 2026-11-01). `npm test` sets TZ
// as well; pinning it here keeps a bare `npx vitest` honest. It must be set before any Date is
// created, which is why it lives in the config rather than a setup file.
process.env.TZ = 'America/New_York';

export default defineConfig({
  test: {
    environment: 'node',
    // Pure helpers only: src/lib, the feature folders' model files and the e2e suite's own helpers
    // (no component tests here, nothing on the network). Playwright runs *.spec.ts, vitest *.test.ts.
    include: ['src/lib/**/*.test.ts', 'src/features/**/*.test.ts', 'e2e/helpers/**/*.test.ts'],
  },
});
