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

// AprilTags in the worker (workers/ops/detect.js detectTagsInPhoto) on a 4,600 × 3,000
// photo drawn here: a small tag across a tile seam, a turned one, and one too large for
// a tile, which the downscaled pass finds. Then the dialog's AprilTag mode on the
// project, whose photos hold no tags: it searches all five and places nothing.
test('reads AprilTags anywhere in a photo, and runs from the dialog', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const tags = await page.evaluate(async () => {
    const TAG = await import('/src/core/sfm/tags/tag36h11.js')
    const { detectTagsInPhoto } = await import('/src/workers/computeClient.js')
    const W = 4600,
      H = 3000
    const c = new OffscreenCanvas(W, H)
    const ctx = c.getContext('2d')
    ctx.fillStyle = 'rgb(120,120,120)'
    ctx.fillRect(0, 0, W, H)
    // Tag `id` with its 10-cell square centred at (cx, cy), `cell` px a cell, turned by `a`.
    const draw = (id, cx, cy, cell, a) => {
      ctx.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), cx, cy)
      const code = TAG.CODES[id]
      for (let y = 0; y < 10; y++)
        for (let x = 0; x < 10; x++) {
          let white = x === 0 || y === 0 || x === 9 || y === 9
          const i = [...Array(TAG.NBITS).keys()].find((k) => TAG.BIT_X[k] + 1 === x && TAG.BIT_Y[k] + 1 === y)
          if (i !== undefined) white = Math.floor(code / 2 ** (TAG.NBITS - 1 - i)) % 2 === 1
          ctx.fillStyle = white ? 'rgb(235,235,235)' : 'rgb(15,15,15)'
          ctx.fillRect((x - 5) * cell, (y - 5) * cell, cell + 0.5, cell + 0.5)
        }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }
    // Pixel edges at integers on the canvas: the tag's centre pixel-centre is c − 0.5.
    draw(5, 1850, 1300, 5, 0.3) // across the seam of the first two tile columns (1,850 ± 25 px)
    draw(77, 3000.25, 700.75, 8, -1.1)
    draw(400, 2200, 2300, 70, 0.2) // 700 px across
    const url = URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }))
    const { tags } = await detectTagsInPhoto(url)
    URL.revokeObjectURL(url)
    return tags
  })
  const at = Object.fromEntries(tags.map((t) => [t.id, t]))
  expect(tags.map((t) => t.id)).toEqual([5, 77, 400])
  expect(Math.hypot(at[5].x - 1849.5, at[5].y - 1299.5)).toBeLessThan(0.3)
  expect(Math.hypot(at[77].x - 2999.75, at[77].y - 700.25)).toBeLessThan(0.3)
  expect(Math.hypot(at[400].x - 2199.5, at[400].y - 2299.5)).toBeLessThan(2)
  expect(at[5].score).toBe(1)

  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Images', exact: true }).click()
  await page.getByRole('menuitem', { name: /Detect targets/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Detect Targets' })
  await dialog.getByLabel('Target type').selectOption('apriltag')
  await expect(dialog).toContainText('Every tag in each of 5 photos')
  await expect(dialog).toContainText('(0 of 2 GCPs have one)')
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
    .toMatch(/^Detect targets: 0 AprilTag marks placed in 5 photos on \d+ workers?/)
  expect(errors).toEqual([])
})

// ArUco markers in the worker: two 5X5_100 markers (6 + 2 cells across with the white
// border) on a drawn photo, one turned, read with the dictionary chosen in the dialog.
test('reads ArUco markers of the chosen dictionary', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const found = await page.evaluate(async () => {
    const { arucoFamily } = await import('/src/core/sfm/tags/aruco.js')
    const { detectTagsInPhoto } = await import('/src/workers/computeClient.js')
    const fam = arucoFamily('5x5_100')
    const T = fam.WIDTH_AT_BORDER + 2
    const c = new OffscreenCanvas(3000, 2000)
    const ctx = c.getContext('2d')
    ctx.fillStyle = 'rgb(120,120,120)'
    ctx.fillRect(0, 0, 3000, 2000)
    const draw = (id, cx, cy, cell, a) => {
      ctx.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), cx, cy)
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          let white = x === 0 || y === 0 || x === T - 1 || y === T - 1
          const i = [...Array(fam.NBITS).keys()].find((k) => fam.BIT_X[k] + 1 === x && fam.BIT_Y[k] + 1 === y)
          if (i !== undefined) white = Math.floor(fam.CODES[id] / 2 ** (fam.NBITS - 1 - i)) % 2 === 1
          ctx.fillStyle = white ? 'rgb(235,235,235)' : 'rgb(15,15,15)'
          ctx.fillRect((x - T / 2) * cell, (y - T / 2) * cell, cell + 0.5, cell + 0.5)
        }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    }
    draw(42, 900, 700, 8, 0.4)
    draw(99, 2100.25, 1300.75, 6, -0.9)
    const url = URL.createObjectURL(await c.convertToBlob({ type: 'image/png' }))
    const aruco = (await detectTagsInPhoto(url, '5x5_100')).tags
    const april = (await detectTagsInPhoto(url)).tags
    URL.revokeObjectURL(url)
    return { aruco, april }
  })
  const at = Object.fromEntries(found.aruco.map((t) => [t.id, t]))
  expect(found.aruco.map((t) => t.id)).toEqual([42, 99])
  expect(Math.hypot(at[42].x - 899.5, at[42].y - 699.5)).toBeLessThan(0.3)
  expect(Math.hypot(at[99].x - 2099.75, at[99].y - 1300.25)).toBeLessThan(0.3)
  expect(found.april).toEqual([])

  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Images', exact: true }).click()
  await page.getByRole('menuitem', { name: /Detect targets/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Detect Targets' })
  await dialog.getByLabel('Target type').selectOption('aruco')
  await dialog.getByLabel('Dictionary').selectOption('6x6_250')
  await expect(dialog).toContainText('ArUco 6X6_250 markers')
  expect(errors).toEqual([])
})

// Reviewing detected marks in the GCP's marks view: ✓ accepts one (it loses its flag),
// Accept in the header takes the rest.
test('accepts detected marks in the GCP view', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  await openFixture(page)
  await page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const store = useGcpsStore()
    const g = store.gcps.find((x) => x.name === 'Bar end A')
    for (const o of g.observations) store.setObservation(g.id, o.imageId, o.imageName, o.px, o.py, { score: 0.9 })
  })
  await page.locator('.section-hd', { hasText: 'Control & Markers' }).click()
  await page.getByText('Bar end A', { exact: true }).first().dblclick()
  const view = page.locator('.gcp-view')
  await expect(view.locator('.panel-detected')).toHaveCount(4)
  await view.locator('.panel-accept').first().click()
  await expect(view.locator('.panel-detected')).toHaveCount(3)
  await view.getByRole('button', { name: 'Accept 3 detections' }).click()
  await expect(view.locator('.panel-detected')).toHaveCount(0)
  const flagged = await page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    return useGcpsStore().gcps.flatMap((g) => g.observations.filter((o) => o.source || o.score != null)).length
  })
  expect(flagged).toBe(0)
})
