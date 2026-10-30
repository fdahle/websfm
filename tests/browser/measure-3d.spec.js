import { test, expect } from './fixtures.js'

// Measure in 3D: clicks on a mesh pick points on its surface (ray cast, not just
// corners), and the toolbox reports distance and area in the project's unit.
test('measures a distance and an area on a mesh in the 3D view', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // A 10 × 10 square at z = 0, two triangles: interior points are no vertices.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    store.clouds.push({
      id: 'sq',
      name: 'Square',
      kind: 'mesh',
      createdAt: 1,
      derived: true,
      imported: false,
      cameras: new Map(),
      count: 2,
      nVerts: 4,
      pos: new Float64Array([-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0]),
      idx: Uint32Array.of(0, 1, 2, 0, 2, 3),
      col: null,
    })
    store.setCloudVisible('sq', true)
  })
  await page.locator('.tab').filter({ hasText: /^3D$/ }).click()
  const viewer = page.locator('.viewer')
  await expect.poll(() => viewer.evaluate((el) => el.__vueParentComponent.setupState.cloudLayers.size)).toBe(1)
  // Look straight down so the square fills the view predictably.
  await viewer.evaluate((el) => el.__vueParentComponent.exposed.setView('top'))
  await viewer.evaluate((el) => el.__vueParentComponent.exposed.toggleMeasureTool('distance'))
  const screenOf = (p) =>
    viewer.evaluate((el, p) => {
      const st = el.__vueParentComponent.setupState,
        r = el.getBoundingClientRect()
      st.camera.updateMatrixWorld()
      const q = st.camera.position.clone().set(p[0], p[1], p[2]).project(st.camera) // a Vector3
      return [r.left + ((q.x + 1) / 2) * r.width, r.top + ((1 - q.y) / 2) * r.height]
    }, p)
  const click = async (p) => {
    const [x, y] = await screenOf(p)
    await page.mouse.click(x, y)
  }
  await click([-3, -4, 0])
  await click([3, 4, 0])
  const box = page.locator('.floating-toolbox, [id="measure-3d"]').filter({ hasText: 'Measure in 3D' }).first()
  await expect(box).toContainText('model units')
  const read = async () => parseFloat((await box.locator('.tb-count').first().textContent()).replace(/,/g, ''))
  expect(Math.abs((await read()) - 10)).toBeLessThan(0.15) // √(6² + 8²)
  await box.getByRole('button', { name: 'Save', exact: true }).click()
  // Area: a 6 × 4 rectangle inside the square.
  await box.getByRole('button', { name: 'Area', exact: true }).click()
  for (const p of [
    [-3, -2, 0],
    [3, -2, 0],
    [3, 2, 0],
    [-3, 2, 0],
  ])
    await click(p)
  await page.keyboard.press('Enter')
  await expect(box).toContainText('surface area')
  // The clicks land on whole pixels: Firefox's canvas puts the corners up to 0.6 off.
  expect(Math.abs((await read()) - 24)).toBeLessThan(0.75)
  await expect(box).toContainText('Distance 1 (3D)')
  const saved = await page.evaluate(async () => {
    const { useMeasurementsStore } = await import('/src/stores/useMeasurementsStore.js')
    return useMeasurementsStore().records.map((r) => ({ kind: r.kind, n: r.points3d.length, source: r.source }))
  })
  expect(saved).toEqual([{ kind: 'length3d', n: 2, source: 'cloud:sq' }])
  await page.screenshot({ path: test.info().outputPath('measure-3d.png') })
  expect(errors).toEqual([])
})

// Measure ▸ DEM of difference: the DEM's Volume tool against an imported reference
// DEM (the reference 0.5 m lower over the DEM's western half): gain only, 0.5 m per
// cell the reference covers, the rest reported as not covered.
test('DEM of difference measures gain and loss against a reference DEM', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { ensureProjection } = await import('/src/core/crs.js')
    const { createFlatRasterSource } = await import('/src/core/io/rasterSource.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useExternalStore } = await import('/src/stores/useExternalStore.js')
    await ensureProjection('EPSG:32633')
    const W = 60,
      X0 = 500000,
      Y0 = 4600060
    const data = new Float32Array(W * W).fill(100),
      mask = new Uint8Array(W * W).fill(1)
    const c = document.createElement('canvas')
    c.width = c.height = W
    const g = c.getContext('2d')
    g.fillStyle = '#888'
    g.fillRect(0, 0, W, W)
    useReconstructionStore().dem = {
      width: W,
      height: W,
      gsd: 1,
      originX: X0,
      originY: Y0,
      data,
      mask,
      zMin: 100,
      zMax: 100,
      unit: 'm',
      crs: 'EPSG:32633',
      name: 'DEM',
      createdAt: 1,
      previewDataUrl: c.toDataURL(),
    }
    // Reference: same CRS, western half only (30 columns), 99.5 m.
    const meta = {
      id: 'ext-ref',
      name: 'Reference',
      kind: 'dem',
      width: 30,
      height: W,
      bands: 1,
      crs: 'EPSG:32633',
      geoTransform: { originX: X0, originY: Y0, scaleX: 1, scaleY: -1 },
      nodata: null,
    }
    const external = useExternalStore()
    external.rasters.push(meta)
    external.sources = new Map([[meta.id, createFlatRasterSource(meta, new Float32Array(30 * W).fill(99.5))]])
  })
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page
    .locator('.ribbon')
    .getByRole('button', { name: /^Measure/ })
    .click()
  await page.getByRole('menuitem', { name: /DEM of difference/ }).click()
  await expect(page.getByRole('toolbar', { name: 'Volume measurement' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Volume base surface' })).toHaveValue('ref:ext-ref')
  const viewport = page.locator('.viewport').last(),
    box = await viewport.boundingBox()
  const at = (x, y) => viewport.click({ position: { x: box.width / 2 + x, y: box.height / 2 + y } })
  for (const [x, y] of [
    [-20, -10],
    [20, -10],
    [20, 10],
    [-20, 10],
  ])
    await at(x, y)
  const result = page.getByRole('region', { name: 'Measurement result' })
  await expect(result).toContainText('Net change')
  await expect(result).toContainText('Reference DEM "Reference"')
  // Rows are <dt>label</dt><dd>value</dd>.
  const row = (label) =>
    result.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]').textContent()
  const num = (s) => parseFloat(s.replace(/[^\d.,-]/g, '').replace(/,/g, ''))
  const loss = num(await row('Loss (below the reference)'))
  expect(loss).toBe(0)
  const cov = (await row('DEM coverage')).match(/([\d.]+)% of ([\d,]+) cells/)
  const covered = Math.round((parseFloat(cov[1]) / 100) * parseFloat(cov[2].replace(/,/g, '')))
  const net = num(await result.locator('.mp-value').textContent())
  expect(net).toBeCloseTo(0.5 * covered, 0)
  expect(covered).toBeGreaterThan(0)
  expect(parseFloat(cov[1])).toBeLessThan(100) // the eastern half has no reference
  expect(errors).toEqual([])
})
