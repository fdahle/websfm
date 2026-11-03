import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// A processing dialog's steps as groups (dev/planning/plan-dialog-layout.md; here Build
// Depth Maps): each header opens its step, and the advanced fields of an open step show
// with the footer's Show advanced settings.
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

test('Depth Maps: each step a group, its advanced settings behind one switch', async ({ page, browserName }) => {
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
  const head = (n) => dialog.locator(`[data-step-id="${n}"] .step-toggle`)
  const advanced = dialog.getByRole('checkbox', { name: 'Show advanced settings' })

  // Every step is a header with its fact; the steps with an everyday switch start open.
  await expect(head(1)).toContainText('300 px · 10 views')
  await expect(head(1)).toHaveAttribute('aria-expanded', 'false')
  await expect(head(4)).toHaveAttribute('aria-expanded', 'true')
  await expect(dialog.locator('#maxSources')).toHaveCount(0)

  // Opening a group shows what it does; its advanced fields wait for the switch.
  await head(1).click()
  await expect(dialog.locator('[data-step-id="1"]')).toContainText(/one per registered image/)
  await expect(dialog.locator('#maxSources')).toBeHidden()
  await expect(dialog.locator('[data-step-id="1"]')).toContainText(/\d+ advanced settings? hidden/)
  await advanced.check()
  await expect(dialog.locator('[data-step-id="1"]')).not.toContainText(/advanced settings? hidden/)
  await expect(dialog.locator('#maxSources')).toBeVisible()
  await expect(dialog.locator('#minNcc')).toBeVisible()
  // A closed group stays closed with the switch on.
  await expect(dialog.locator('#window')).toHaveCount(0)
  await head(1).click()
  await expect(dialog.locator('#maxSources')).toHaveCount(0)

  // A step switched off reads "off", and its switch stays usable.
  await dialog.getByLabel('Enabled').nth(1).uncheck()
  await expect(head(4)).toContainText('off')
  await dialog.getByLabel('Enabled').nth(1).check()
  await advanced.uncheck()
  await expect(dialog.locator('#minNcc')).toBeHidden()

  // The steps the user opened or closed stay so when the dialog opens again.
  await head(1).click()
  await head(4).click()
  const reopen = async () => {
    await page.evaluate(async () => {
      const { useModalsStore } = await import('/src/stores/useModalsStore.js')
      useModalsStore().depthMapsOpen = false
    })
    await expect(dialog).toHaveCount(0)
    await page.evaluate(async () => {
      const { useModalsStore } = await import('/src/stores/useModalsStore.js')
      useModalsStore().depthMapsOpen = true
    })
    await expect(dialog).toBeVisible()
  }
  await reopen()
  await expect(head(1)).toHaveAttribute('aria-expanded', 'true')
  await expect(head(4)).toHaveAttribute('aria-expanded', 'false')
  await expect(head(3)).toHaveAttribute('aria-expanded', 'true')
  expect(errors).toEqual([])
})
