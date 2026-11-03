import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// A processing dialog's steps laid out once (dev/planning/plan-dialog-layout.md, pilot:
// Build Depth Maps): a chain of short facts, only the steps with an everyday field drawn,
// each step's tuning folded in place, and Show all settings.
const PROJECT = new URL('../fixtures/projects/v2/aukerman-5.websfm', import.meta.url)

async function openFixture(page) {
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    window.__fixture = new File([u8], 'aukerman-5.websfm')
  }, readFileSync(PROJECT).toString('base64'))
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__._instance.setupState.importProjectFile(window.__fixture)
  })
  if (await page.evaluate(() => typeof window.showDirectoryPicker === 'function')) {
    await page
      .getByRole('dialog', { name: 'Open project file' })
      .getByRole('button', { name: 'In this browser' })
      .click()
  }
  await expect(page.locator('.toast', { hasText: 'Project opened' })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  if (await page.locator('.project-backdrop').isVisible()) await page.keyboard.press('Escape')
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().newProjectOpen = false
  })
}

test('Depth Maps lists each step once, its tuning in place', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'layout logic: one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().depthMapsOpen = true
  })
  const dialog = page.getByRole('dialog', { name: 'Build Depth Maps' })
  await expect(dialog).toBeVisible()
  const chain = dialog.getByRole('group', { name: 'What the run does' })
  await expect(chain.getByRole('button')).toHaveCount(4)
  await expect(chain.getByRole('button', { name: /Step 4, Check across views: ≥ 2 views agree/ })).toBeVisible()

  // Steps 1 and 2 have no everyday field: not drawn until opened from the chain.
  await expect(dialog.getByText('Working resolution and source views', { exact: true })).toHaveCount(0)
  await expect(dialog.getByText('Check across views', { exact: true })).toBeVisible()
  await chain.getByRole('button', { name: /Step 1/ }).click()
  await expect(dialog.locator('#maxSources')).toBeVisible()
  await expect(dialog.getByText(/one per registered image/)).toBeVisible()
  await dialog.getByRole('button', { name: /Working resolution and source views: fold/ }).click()
  await expect(dialog.locator('#maxSources')).toHaveCount(0)

  // A drawn step's tuning unfolds in place, and folds away with its switch off.
  await expect(dialog.locator('#minNcc')).toHaveCount(0)
  await dialog.getByRole('button', { name: /Check across views: show more/ }).click()
  await expect(dialog.locator('#minNcc')).toBeVisible()
  await dialog.getByLabel('Enabled').nth(1).uncheck()
  await expect(chain.getByRole('button', { name: /Step 4, Check across views: off/ })).toBeVisible()

  // Show all settings: every step, every field.
  await dialog.getByText('Show all settings').click()
  for (const id of ['#maxDim', '#window', '#filterRelTol']) await expect(dialog.locator(id)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /show more/ })).toHaveCount(0)
  expect(errors).toEqual([])
})
