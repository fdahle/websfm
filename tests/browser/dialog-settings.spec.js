import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Every step of a processing dialog open, its advanced settings shown.
async function showEverything(dialog) {
  await dialog.getByRole('checkbox', { name: 'Show advanced settings' }).check()
  const closed = dialog.locator('.step-toggle[aria-expanded="false"]')
  while (await closed.count()) await closed.first().click()
}

// A processing dialog keeps its settings (composables/useDialogSettings.js): it opens on
// the last run's in this project, and a named preset brings a set back after Reset.
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

async function openDem(page) {
  await page.getByRole('button', { name: 'Reconstruct', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'DEM', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Build DEM' })
  await expect(dialog).toBeVisible()
  // Surface aggregation is advanced, in a step that starts closed.
  await showEverything(dialog)
  return dialog
}

test('a dialog opens on the last run and brings a preset back', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'storage logic: one browser is enough')
  test.setTimeout(180_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)

  // Run with a non-default aggregate.
  let dialog = await openDem(page)
  await expect(dialog.locator('#dem-agg')).toHaveValue('median')
  await dialog.locator('#dem-agg').selectOption('max')
  await dialog.getByRole('button', { name: 'Build DEM', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  // Wait for the run to finish (pipeline idle), so the next open sees its settings.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { useLog } = await import('/src/composables/useLog.js')
          return useLog().entries.value.some((e) => e.level === 'success' && /^DEM\b|DEM:/.test(e.message))
        }),
      { timeout: 60_000 },
    )
    .toBe(true)

  // Opened again: the last run's.
  dialog = await openDem(page)
  await expect(dialog.locator('#dem-agg')).toHaveValue('max')
  await expect(dialog.getByRole('button', { name: /Presets · last run/ })).toBeVisible()

  // Saved as a preset, reset, and brought back.
  await dialog.getByRole('button', { name: /Presets/ }).click()
  await dialog.getByPlaceholder('Name these settings').fill('Top surface')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await dialog.getByRole('button', { name: /Presets · Top surface/ }).click()
  await dialog.getByRole('menuitem', { name: 'Reset to defaults' }).click()
  await expect(dialog.locator('#dem-agg')).toHaveValue('median')
  await dialog.getByRole('button', { name: /Presets/ }).click()
  await dialog.getByRole('menuitem', { name: 'Top surface' }).click()
  await expect(dialog.locator('#dem-agg')).toHaveValue('max')
  expect(errors).toEqual([])
})

// Detect Features keeps one set of settings per detector: a preset brings back the
// detector and each detector's values. The presets menu is opaque over the dialog.
test('Detect Features saves a preset with its detector and resolution', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'storage logic: one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  await page.getByRole('button', { name: 'Reconstruct', exact: true }).click()
  await page
    .locator('.ribbon')
    .getByRole('button', { name: /Detect\s*Features/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Detect Features' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('#detector-sel')).toHaveValue('sift')
  await showEverything(dialog)
  await dialog.locator('#maxDim').fill('3200')

  await dialog.getByRole('button', { name: /Presets/ }).click()
  const panel = dialog.locator('.presets-panel')
  const bg = await panel.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  await dialog.getByPlaceholder('Name these settings').fill('Sharp SIFT')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  await dialog.locator('#detector-sel').selectOption('disk')
  await dialog.getByRole('button', { name: /Presets/ }).click()
  await dialog.getByRole('menuitem', { name: 'Reset to defaults' }).click()
  await expect(dialog.locator('#detector-sel')).toHaveValue('sift')
  await expect(dialog.locator('#maxDim')).toHaveValue('2400')
  await dialog.getByRole('button', { name: /Presets/ }).click()
  await dialog.getByRole('menuitem', { name: 'Sharp SIFT' }).click()
  await expect(dialog.locator('#detector-sel')).toHaveValue('sift')
  await expect(dialog.locator('#maxDim')).toHaveValue('3200')
  expect(errors).toEqual([])
})
