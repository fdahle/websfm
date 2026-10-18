import { defineConfig } from '@playwright/test'
// PW_PORT: the dev server's port, so parallel checkouts can run their suites side by side.
const port = Number(process.env.PW_PORT) || 4179
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    trace: 'retain-on-failure' },
  webServer: { command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/tests/browser/harness.html`, reuseExistingServer: !process.env.CI },
})
