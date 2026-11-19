import { test, expect } from './fixtures.js'

// The app's own chrome: Settings ▸ General ▸ Notices hides the bug-report button,
// Settings ▸ General ▸ Language lists the languages by how far they are translated,
// Settings' advanced rows show with its footer switch, the Guide's tab strip keeps to one row however many operations are open, and
// What's New leaves glossary terms unlinked.

async function createProject(page) {
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
}

test('Settings hides the bug-report button, and it stays hidden after a reload', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  await expect(page.locator('.bug-report-fab')).toBeVisible()

  await page.getByRole('button', { name: 'Other', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings.locator('.group-head')).toHaveText(['Appearance', 'Help', 'Editing', 'Notices'])
  const row = settings.locator('.setting-row').filter({ hasText: 'Bug report button' })
  await row.locator('.slider').click()
  await expect(page.locator('.bug-report-fab')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect(page.locator('.bug-report-fab')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Settings lists languages by how far they are translated, and switches to one', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  await page.getByRole('button', { name: 'Other', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  const select = settings.getByLabel('Language')
  await expect(select.locator('optgroup')).toHaveCount(3)
  expect(await select.locator('optgroup').evaluateAll((els) => els.map((e) => e.label))).toEqual([
    'Translated',
    'Partly translated',
    'Not translated yet',
  ])
  // A planned language is listed but cannot be chosen, and says why.
  const planned = select.locator('optgroup').nth(2).locator('option')
  expect(await planned.count()).toBeGreaterThan(0)
  for (const o of await planned.all()) {
    await expect(o).toBeDisabled()
    await expect(o).toHaveAttribute('title', /Not translated yet/)
  }

  // German, a partly translated language: the dialog redraws in it at once, says the
  // rest is English, and the choice outlives a reload.
  await select.selectOption('de')
  const einstellungen = page.getByRole('dialog', { name: 'Einstellungen', exact: true })
  await expect(einstellungen.getByRole('tab', { name: 'Allgemein' })).toBeVisible()
  await expect(einstellungen.getByText(/Teilweise übersetzt: Was noch nicht übersetzt ist/)).toBeVisible()
  await page.reload()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('de')
  await page.evaluate(() => localStorage.setItem('uiLanguage', 'en'))
  expect(errors).toEqual([])
})

test("Settings' advanced rows show with the footer switch", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('advancedSettingsExpanded', 'false'))
  await createProject(page)
  await page.getByRole('button', { name: 'Other', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('tab', { name: 'Compute' }).click()
  await expect(settings.getByText('Compute workers')).toHaveCount(0)
  await expect(settings.locator('.advanced-note')).toHaveText(/1 advanced setting hidden/)
  await settings.getByLabel('Show advanced settings').check()
  await expect(settings.getByText('Compute workers')).toBeVisible()
  await settings.getByRole('tab', { name: 'Map & 3D' }).click()
  await expect(settings.getByText('3D near clipping distance')).toBeVisible()
  await expect(settings.getByText('Satellite imagery source')).toBeVisible()
})

test('the Guide tab strip scrolls sideways only, with Home fixed', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  const ops = ['detect-features', 'match-features', 'sparse-reconstruction', 'depth-maps', 'dense-cloud']
  ops.push('mesh', 'texture-mesh', 'dem', 'orthophoto', 'georeferencing')
  const scroll = page.locator('.tab-strip .tab-scroll')
  // One at a time, as a user opens them: each new tab is scrolled into view.
  for (const [i, id] of ops.entries()) {
    await page.evaluate(async (op) => (await import('/src/stores/useGuideStore.js')).useGuideStore().openOp(op), id)
    await expect(scroll.locator('.gtab')).toHaveCount(i + 1)
  }
  await expect(scroll.locator('.gtab.active')).toBeInViewport()
  const m = await scroll.evaluate((el) => ({
    sw: el.scrollWidth,
    cw: el.clientWidth,
    sh: el.scrollHeight,
    ch: el.clientHeight,
    left: el.scrollLeft,
  }))
  expect(m.sw).toBeGreaterThan(m.cw) // ten tabs do not fit: the strip scrolls
  expect(m.sh).toBeLessThanOrEqual(m.ch) // but never vertically
  expect(m.left).toBeGreaterThan(0) // the last one opened was scrolled into view
  await expect(page.locator('.tab-strip .gtab-home')).toBeInViewport()
  expect(errors).toEqual([])
})

// The Guide's tabs (and the Glossary's, the same HelpTabStrip) move and close as the
// workspace's do: drag a tab, or right-click for the close menu.
test('Guide tabs reorder by dragging and close from their right-click menu', async ({ page }) => {
  await createProject(page)
  for (const id of ['detect-features', 'match-features', 'sparse-reconstruction'])
    await page.evaluate(async (op) => (await import('/src/stores/useGuideStore.js')).useGuideStore().openOp(op), id)
  const dialog = page.getByRole('dialog', { name: 'Guide' })
  const tabs = dialog.locator('.tab-scroll .gtab')
  const titles = () => tabs.evaluateAll((els) => els.map((e) => e.textContent.replace('×', '').trim()))
  await expect.poll(titles).toEqual(['Detect Features', 'Match Features', 'Sparse Reconstruction'])

  // Dropped onto a tab to its right, a tab lands after it.
  await tabs.nth(0).dragTo(tabs.nth(2))
  await expect.poll(titles).toEqual(['Match Features', 'Sparse Reconstruction', 'Detect Features'])

  const menu = page.locator('.tab-ctx-menu')
  await tabs.nth(1).click({ button: 'right' })
  await menu.getByRole('button', { name: 'Close others' }).click()
  await expect.poll(titles).toEqual(['Sparse Reconstruction'])
  await expect(menu).toHaveCount(0)

  // Escape closes the menu, not the Guide behind it.
  await tabs.nth(0).click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(dialog).toBeVisible()

  await tabs.nth(0).click({ button: 'right' })
  await menu.getByRole('button', { name: 'Close all' }).click()
  await expect(tabs).toHaveCount(0)
  await expect(dialog.getByRole('tab', { name: 'Home' })).toHaveClass(/active/)
})

test("What's New does not link glossary terms", async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().whatsNewOpen = true
  })
  const dialog = page.getByRole('dialog', { name: "What's new" })
  await expect(dialog.locator('.wn-release').first()).toBeVisible()
  await expect(dialog.locator('li').first()).toBeVisible()
  await expect(dialog.locator('a.glossary-link')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('System info copies a summary for a bug report, with nothing about the project', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // What the app writes to the clipboard, kept: only Chromium lets a test grant the
  // clipboard permissions, and reading the real clipboard needs them.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (t) => void (window.__copied = t), readText: async () => window.__copied ?? '' },
    })
  })
  await createProject(page)
  await page.getByRole('button', { name: 'Other', exact: true }).click()
  await page.getByRole('button', { name: 'System info', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'System info' })
  const copy = dialog.getByRole('button', { name: 'Copy for bug report' })
  await expect(copy).toBeEnabled()
  await copy.click()
  await expect.poll(() => page.evaluate(() => window.__copied ?? '')).toMatch(/^WebSfM /)
  const text = await page.evaluate(() => window.__copied)
  expect(text).toMatch(/^WebSfM \d+\.\d+\.\d+\nBrowser: \S[^\n]* on /)
  expect(text).toMatch(/\nGPU: /)
  expect(text).toMatch(/\nProject: in browser storage/)
  expect(errors).toEqual([])
})
