import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Tools ▸ Model ▾ ▸ Optimize cameras ▸ Full lens on the saved five-photo Aukerman project,
// through the worker: the solved lens becomes the model's calibration (what dense and the
// GCP marks read), and the log names it.
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

test('Optimize cameras with the full lens records the solved lens in the model', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const r = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useLog } = await import('/src/composables/useLog.js')
    const recon = useReconstructionStore()
    const before = recon.mainSparseCloud
    const lensBefore = JSON.stringify(before.calibration?.groups?.map((g) => g.dist) ?? null)
    const after = await recon.editClouds({
      mode: 'optimize',
      sourceIds: [before.id],
      settings: { refine: 'full', createdAt: before.createdAt },
    })
    const line = useLog()
      .entries.value.filter((e) => e.message.startsWith('Optimize cameras'))
      .map((e) => [e.level, e.message])
    return {
      ok: !!after,
      lensBefore,
      groups: after?.calibration?.groups?.map((g) => ({ dist: g.dist, selfCal: g.selfCal })) ?? null,
      line,
    }
  })
  expect(r.line.at(-1)?.[0], JSON.stringify(r.line)).toBe('success')
  expect(r.ok).toBe(true)
  expect(r.line.at(-1)[1]).toMatch(/refined the focal length, principal point and lens .*lens k1 /)
  // One group (one sensor): its lens is the solved Brown lens, with no correction on top.
  expect(r.groups).toHaveLength(1)
  expect(r.groups[0].selfCal).toBeNull()
  expect(Object.keys(r.groups[0].dist).sort()).toEqual(['k1', 'k2', 'k3', 'p1', 'p2'])
  expect(JSON.stringify(r.groups.map((g) => g.dist))).not.toBe(r.lensBefore)
  expect(errors).toEqual([])
})
