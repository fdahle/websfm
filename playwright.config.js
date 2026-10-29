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
  // Chromium is where everything runs; Firefox runs the same suite (`npm run
  // test:browser:firefox`), with the Chromium-only tests skipped. WebKit needs system
  // libraries Playwright cannot install without root, so it is not here yet.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' }, timeout: 120_000 },
  ],
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/tests/browser/harness.html`,
    reuseExistingServer: !process.env.CI,
  },
})
