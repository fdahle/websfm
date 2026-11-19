import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// The GCP view (components/viewers/ViewerGcp.vue) on the saved five-photo Aukerman
// project, whose two scale-bar markers are marked in four photos each. With one mark
// taken away, the photo shows as a likely place where the other marks put the point;
// ✓ marks it there. Dragging in a mark's square moves the mark by the drag over the zoom.
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

// The marks of "Bar end A", by photo name.
const marksOf = (page) =>
  page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const names = new Map(useImagesStore().images.map((i) => [i.id, i.name]))
    const g = useGcpsStore().gcps.find((x) => x.name === 'Bar end A')
    return Object.fromEntries(
      g.observations.map((o) => [names.get(o.imageId), { px: o.px, py: o.py, source: o.source }]),
    )
  })

test('the GCP view shows a likely place, marks it, and moves a mark by dragging', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const before = await marksOf(page)
  expect(Object.keys(before)).toHaveLength(4)
  const removed = before['DSC00306.JPG']
  const gcpId = await page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const store = useGcpsStore()
    const g = store.gcps.find((x) => x.name === 'Bar end A')
    store.removeObservation(g.id, useImagesStore().images.find((i) => i.name === 'DSC00306.JPG').id)
    document.querySelector('#app').__vue_app__._instance.setupState.openGcpView(g.id)
    return g.id
  })
  expect(gcpId).toBeTruthy()

  const view = page.locator('.gcp-view')
  await expect(view.locator('.gcp-panel:not(.likely)')).toHaveCount(3)
  await expect(view.locator('.likely-title')).toHaveText('Likely in 1 more photo')
  await expect(view.locator('.likely-from')).toHaveText('from its 3 marks')
  const likely = view.locator('.gcp-panel.likely')
  await expect(likely).toHaveCount(1)
  await expect(likely.locator('.panel-open')).toHaveText('DSC00306.JPG')

  // ✓ marks it at the crosshair: where the other three marks put it, by the mark taken away.
  await likely.locator('.panel-accept').click()
  await expect(view.locator('.gcp-panel:not(.likely)')).toHaveCount(4)
  await expect(view.locator('.gcp-panel.likely')).toHaveCount(0)
  const placed = (await marksOf(page))['DSC00306.JPG']
  expect(Math.hypot(placed.px - removed.px, placed.py - removed.py)).toBeLessThan(3)

  // Drag in DSC00306's square by (30, −20) screen px at zoom 2: the mark moves (15, −10).
  const square = view.locator('.gcp-panel:not(.likely)', { hasText: 'DSC00306.JPG' }).locator('.panel-viewport')
  const box = await square.boundingBox()
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 15, cy - 10, { steps: 3 })
  await page.mouse.move(cx + 30, cy - 20, { steps: 3 })
  await page.mouse.up()
  await expect.poll(async () => (await marksOf(page))['DSC00306.JPG'].px).toBeCloseTo(placed.px + 15, 6)
  expect((await marksOf(page))['DSC00306.JPG'].py).toBeCloseTo(placed.py - 10, 6)

  // A click without a drag on a mark moves nothing.
  const at = (await marksOf(page))['DSC00306.JPG']
  await square.click({ position: { x: 10, y: 10 } })
  expect((await marksOf(page))['DSC00306.JPG']).toEqual(at)

  // The other marks are as they were.
  const after = await marksOf(page)
  for (const name of Object.keys(before)) if (name !== 'DSC00306.JPG') expect(after[name]).toEqual(before[name])
  expect(errors).toEqual([])
})
