import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, expect } from '@playwright/test'

// WebKit keeps no browser storage (OPFS) in Playwright's usual ephemeral contexts, as
// Safari keeps none in a private window, so the app could not create a project. Under
// WebKit each test gets a persistent context in its own empty profile instead: storage
// works as in a normal window, and no test sees another's. The profile sits in the
// system's temporary folder: WebKit's launcher refuses a path with a non-ASCII letter,
// which a test title (▸) puts into the test's own output folder.
export const test = base.extend({
  context: async ({ browserName, context, playwright, baseURL }, use) => {
    if (browserName !== 'webkit') return use(context)
    const profile = mkdtempSync(join(tmpdir(), 'websfm-webkit-'))
    const persistent = await playwright.webkit.launchPersistentContext(profile, { baseURL })
    try {
      await use(persistent)
    } finally {
      await persistent.close()
      rmSync(profile, { recursive: true, force: true })
    }
  },
})

export { expect }
