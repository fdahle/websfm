import { test, expect } from './fixtures.js'

// The app's own chrome: Settings ▸ General ▸ Notices hides the bug-report button,
// the Guide's tab strip keeps to one row however many operations are open, and
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
  await expect(settings.locator('.group-head')).toHaveText([
    'Appearance',
    'Help and dialogs',
    'During a run',
    'Notices',
  ])
  const row = settings.locator('.setting-row').filter({ hasText: 'Bug report button' })
  await row.locator('.slider').click()
  await expect(page.locator('.bug-report-fab')).toHaveCount(0)

  await page.reload()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect(page.locator('.bug-report-fab')).toHaveCount(0)
  expect(errors).toEqual([])
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
