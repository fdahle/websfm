import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Tools ▸ Images ▸ Detect targets on the saved five-photo Aukerman project: its two scale-
// bar markers are marked in every photo that sees them. With one mark taken away, the
// marker is looked for there, where its other marks put it. The photos hold no checker
// mats; the run must plan, search and report without placing a stray mark
// (core/sfm/targetDetect.test.js checks the detector on synthetic mats).
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

test('plans where each GCP should be and searches there', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const marksBefore = await page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    return useGcpsStore().gcps.map((g) => g.observations.length)
  })
  expect(marksBefore).toEqual([4, 4])
  // Take Bar end A's mark in DSC00306 away; the plan must put it back near there.
  const removed = await page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const store = useGcpsStore()
    const g = store.gcps.find((x) => x.name === 'Bar end A')
    const img = useImagesStore().images.find((i) => i.name === 'DSC00306.JPG')
    const o = g.observations.find((x) => x.imageId === img.id)
    store.removeObservation(g.id, img.id)
    return { px: o.px, py: o.py }
  })
  const planned = await page.evaluate(async () => {
    const { useDetectTargets } = await import('/src/composables/useDetectTargets.js')
    const { TARGET_DEFAULTS } = await import('/src/core/defaults.user.js')
    const { centreToMarkPx } = await import('/src/core/sfm/displayFrame.js')
    const p = await useDetectTargets().plan({ ...TARGET_DEFAULTS })
    const q = p.photos[0].predictions[0]
    return { name: p.photos[0].img.name, x: centreToMarkPx(q.x), y: centreToMarkPx(q.y) }
  })
  expect(planned.name).toBe('DSC00306.JPG')
  expect(Math.hypot(planned.x - removed.px, planned.y - removed.py)).toBeLessThan(3)

  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Images', exact: true }).click()
  await page.getByRole('menuitem', { name: /Detect targets/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Detect Targets' })
  await expect(dialog).toContainText('1 place in 1 photo for 1 GCP')
  await dialog.getByRole('button', { name: 'Detect targets', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { useLog } = await import('/src/composables/useLog.js')
          return useLog().entries.value.find((e) => /^Detect targets:/.test(e.message))?.message ?? null
        }),
      { timeout: 60_000 },
    )
    .toMatch(/placed, 1 place searched in 1 photo/)
  const marks = await page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    return useGcpsStore().gcps.flatMap((g) => g.observations.filter((o) => o.source === 'detected'))
  })
  // Anything placed carries its flag and score.
  for (const m of marks) expect(m.score).toBeGreaterThanOrEqual(0.4)
  expect(errors).toEqual([])
})
