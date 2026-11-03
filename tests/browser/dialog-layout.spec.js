import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// A processing dialog's steps laid out once (dev/planning/plan-dialog-layout.md; here
// Build Depth Maps): every step a header with its short fact, its everyday fields below,
// its tuning folded in place, and Show all settings.
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
  // Every step is drawn, one header with its short fact; tuning stays folded.
  const step = (n) => dialog.locator(`[data-step-id="${n}"]`)
  await expect(step(1)).toContainText('Working resolution and source views')
  await expect(step(4)).toContainText('≥ 2 views agree')
  await expect(dialog.locator('#maxSources')).toHaveCount(0)
  await dialog.getByRole('button', { name: /Working resolution and source views: show more/ }).click()
  await expect(dialog.locator('#maxSources')).toBeVisible()
  await expect(step(1)).toContainText(/one per registered image/)
  await dialog.getByRole('button', { name: /Working resolution and source views: fold/ }).click()
  await expect(dialog.locator('#maxSources')).toHaveCount(0)

  // A drawn step's tuning unfolds in place, and folds away with its switch off.
  await expect(dialog.locator('#minNcc')).toHaveCount(0)
  await dialog.getByRole('button', { name: /Check across views: show more/ }).click()
  await expect(dialog.locator('#minNcc')).toBeVisible()
  await dialog.getByLabel('Enabled').nth(1).uncheck()
  await expect(step(4)).toContainText('off')

  // Show all settings: every step, every field.
  await dialog.getByRole('checkbox', { name: 'Show all settings' }).check()
  for (const id of ['#maxDim', '#window', '#filterRelTol']) await expect(dialog.locator(id)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /show more/ })).toHaveCount(0)
  expect(errors).toEqual([])
})
