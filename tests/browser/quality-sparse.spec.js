import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Quality Report ▸ Sparse on a saved project with a sparse model: its labels come from
// the catalogue (core/i18n/<lang>/quality.js), in English and, with `lang de`, German.
const fixture = readFileSync(new URL('../fixtures/projects/v1/aukerman-5.websfm', import.meta.url))

test('Quality Report ▸ Sparse shows the model in the words of the catalogue', async ({ page }, info) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    document
      .querySelector('#app')
      .__vue_app__._instance.setupState.importProjectFile(new File([u8], 'aukerman-5.websfm'))
  }, fixture.toString('base64'))
  if (await page.evaluate(() => typeof window.showDirectoryPicker === 'function')) {
    await page
      .getByRole('dialog', { name: 'Open project file' })
      .getByRole('button', { name: 'In this browser' })
      .click()
  }
  await expect(page.locator('.toast', { hasText: 'Project opened' })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  await page.evaluate(async () => {
    const m = (await import('/src/stores/useModalsStore.js')).useModalsStore()
    m.qualitySection = 'sparse'
    m.qualityOpen = true
  })
  const report = page.getByRole('dialog', { name: 'Quality Report', exact: true })
  const label = (text) => report.locator('.tile-label').getByText(text, { exact: true })
  await expect(label('Tie points')).toBeVisible()
  await expect(label('Reprojection median')).toBeVisible()
  await expect(report.getByRole('columnheader', { name: 'Photo' })).toBeVisible()
  await expect(report.getByText('Track-length distribution')).toBeVisible()
  await expect(report).not.toContainText('Pre-BA')
  await page.screenshot({ path: info.outputPath('quality-sparse-en.png') })

  await page.evaluate(async () => (await import('/src/composables/useI18n.js')).setLanguage('de'))
  await expect(label('Verknüpfungspunkte')).toBeVisible()
  await expect(report.getByRole('columnheader', { name: 'Foto' })).toBeVisible()
  await expect(report.getByText('29.10.2026', { exact: true })).toBeVisible() // the fixture's run date
  await page.screenshot({ path: info.outputPath('quality-sparse-de.png') })
  expect(errors).toEqual([])
})
