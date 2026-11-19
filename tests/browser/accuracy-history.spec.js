import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Evaluate ▸ Accuracy ▸ Since the fit before (AccuracyHistory.vue): the last two fits'
// independent checks side by side, what changed between them, and every fit kept. The
// recording itself is checked in stores/reconstruction/georeferencing.test.js.
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

test('Evaluate ▸ Accuracy compares the last fit with the one before', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { accuracySnapshot } = await import('/src/core/eval/accuracySnapshot.js')
    const row = (id, role, d) => ({ gcpId: id, name: id, role, dx: d, dy: 0, dz: d, dTotal: Math.hypot(d, d) })
    const controls = ['GCP 1', 'GCP 2', 'GCP 3'].map((id) => row(id, 'control', 0.01))
    const r = useReconstructionStore()
    r.accuracyHistory = [
      accuracySnapshot({
        report: [...controls, row('GCP 5', 'check', 0.052)],
        method: 'gcps',
        at: '2026-11-19T10:00:00Z',
      }),
      accuracySnapshot({
        report: [...controls, row('GCP 4', 'control', 0.01), row('GCP 5', 'check', 0.031)],
        method: 'gcps',
        change: 'Optimize cameras: refined the focal length, principal point and lens',
        at: '2026-11-19T11:00:00Z',
      }),
    ]
    document.querySelector('#app').__vue_app__._instance.setupState.handleCommand('eval-gcps')
  })
  const box = page.locator('.acc-history')
  await expect(box).toBeVisible()
  await expect(box).toContainText('Since the fit before')
  await expect(box).toContainText('The model changed before it: Optimize cameras')
  await expect(box).toContainText('Control points added: GCP 4.')
  const h = box.locator('tr', { hasText: 'Checkpoints (1), horizontal' })
  await expect(h).toContainText('0.052')
  await expect(h).toContainText('0.031')
  await expect(h).toContainText('▲ better')
  await box.locator('summary').click()
  await expect(box.locator('tbody tr')).toHaveCount(2 + 2)
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT + '/accuracy.png' })
  expect(errors).toEqual([])
})
