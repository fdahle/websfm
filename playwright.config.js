import { defineConfig } from '@playwright/test'
// PW_PORT gives each checkout its own dev server: with the default reuse, two worktrees
// on one port would test whichever server started first.
const port = Number(process.env.PW_PORT || 4179)
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  // Chromium is where everything runs; Firefox and WebKit (Safari's engine) run the
  // same suite (`npm run test:browser:firefox`, `test:browser:webkit`), with the
  // Chromium-only tests skipped. WebKit on Linux needs a few system libraries:
  // `npx playwright install-deps webkit` with root, or `scripts/webkit-libs.sh` without.
  // Both are slower, so their tests and expect polls get longer: a worker's first start
  // from the dev server's unbundled modules alone takes about 5 s in Firefox.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' }, timeout: 120_000, expect: { timeout: 15_000 } },
    // No trace: the persistent context each WebKit test runs in (tests/browser/fixtures.js)
    // is not one Playwright's tracing can save on close.
    {
      name: 'webkit',
      use: { browserName: 'webkit', trace: 'off' },
      timeout: 120_000,
      expect: { timeout: 15_000 },
    },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/tests/browser/harness.html`,
    reuseExistingServer: !process.env.CI,
  },
})
