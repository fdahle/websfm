import { test, expect } from '@playwright/test'

// Computed DEM on the 2D map (CLAUDE.md ▸ map raster layers),
// against the full app: the ribbon's On Map toggle, Fit View over a raster-only
// map, the status-bar probe (a value, and "no data" over a hole — never a
// neighbour's height), and the greyed toggle for a local-frame product.

const W = 60, ORIGIN_X = 500000, ORIGIN_Y = 5000060

async function setup(page, crs) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async ({ W, ORIGIN_X, ORIGIN_Y, crs }) => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    // Flat 42 m with a 10×10 nodata hole in the middle.
    const data = new Float32Array(W * W).fill(42), mask = new Uint8Array(W * W).fill(1)
    for (let r = 25; r < 35; r++) for (let c = 25; c < 35; c++) { data[r * W + c] = NaN; mask[r * W + c] = 0 }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = W
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#c84'; ctx.fillRect(0, 0, W, W)
    useReconstructionStore().dem = { width: W, height: W, gsd: 1, originX: ORIGIN_X, originY: ORIGIN_Y, data, mask,
      zMin: 42, zMax: 42, unit: 'm', crs, name: 'DEM', previewUrl: canvas.toDataURL() }
  }, { W, ORIGIN_X, ORIGIN_Y, crs })
  await page.getByRole('button', { name: /Products/ }).first().click() // the section starts collapsed
  await page.locator('.item-name', { hasText: /^DEM$/ }).dblclick()
}

const onMapButton = (page) => page.locator('.ribbon').getByRole('button', { name: /On\s*Map/ })

// Tools ▸ Measure ▾ ▸ <row>: the measuring tools are checkable menu rows.
async function measureTool(page, row) {
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Measure', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: row }).click()
}

test('a computed DEM in the project CRS goes on the map, fits, and probes cell values', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await setup(page, 'EPSG:32632')

  // Product tab readout: the cell under the cursor, so the hole reads "no data".
  const viewport = page.locator('.product-viewer .viewport')
  const vb = await viewport.boundingBox()
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2)
  await expect(page.locator('.product-viewer .status-bar')).toContainText('no data')

  await onMapButton(page).click()
  await expect.poll(() => page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().productLayers.dem?.visible
  })).toBe(true)
  await expect(onMapButton(page)).toHaveClass(/active/)

  await page.locator('.tab', { hasText: /^2D$/ }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'View', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: /Fit\s*View/ }).click()
  const map = page.locator('.map-viewer .ol-map')
  const mb = await map.boundingBox()
  const status = page.locator('.map-viewer .status-bar')
  await page.waitForTimeout(500) // Fit View animates for 300 ms
  // Centre of the DEM = the hole; well inside the left half = a measured 42 m cell.
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2)
  await expect(status).toContainText('DEM')
  await expect(status).toContainText('no data')
  await page.mouse.move(mb.x + mb.width / 2 - Math.min(mb.width, mb.height) * 0.3, mb.y + mb.height / 2)
  await expect(status).toContainText('42.00')

  // MP-4: the Ruler on the map measures the DEM (the automatic target) in its own
  // frame. Expected = the easting difference under the two clicks ÷ UTM's k
  // (0.9996 on the central meridian) — the tool reports ground lengths.
  const y = mb.y + mb.height / 2 + 40
  const eastingAt = async (x) => {
    await page.mouse.move(x, y)
    return Number((await status.textContent()).match(/Easting\s+([-\d.]+)/)[1])
  }
  const x1 = mb.x + mb.width / 2 - 80, x2 = mb.x + mb.width / 2 + 80
  const dE = (await eastingAt(x2)) - (await eastingAt(x1))
  await measureTool(page, /^Ruler/)
  await page.mouse.click(x1, y); await page.mouse.click(x2, y)
  const result = page.getByRole('region', { name: 'Measurement result' })
  const metres = Number((await result.locator('.mp-value').textContent()).replace(/[^\d.]/g, ''))
  expect(Math.abs(metres - dE / 0.9996)).toBeLessThan(0.05)
  await result.getByRole('textbox', { name: 'Measurement name' }).fill('Map ruler')
  await result.getByRole('button', { name: 'Save measurement', exact: true }).click()
  // One record per raster: the DEM tab lists what was measured on the map.
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  await page.locator('.tab .tab-title', { hasText: /^DEM$/ }).click()
  await measureTool(page, /^Saved measurements/)
  await expect(page.getByRole('complementary', { name: 'Saved measurements' })).toContainText('Map ruler')
  expect(errors).toEqual([])
})

test('without CRS content the map shows the model frame, and a local DEM is placed in it', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { frameFromSpec, describeFrame } = await import('/src/core/products/frameSpec.js')
    const s = useReconstructionStore()
    // Three cameras looking down; the sparse points give the MAP's frame origin.
    const R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]], K = { fx: 500, fy: 500, cx: 250, cy: 250 }
    const cameras = new Map([0, 1, 2].map((i) => [`cam${i}`, { R, t: [-i, 0, 10], K }]))
    const points = Array.from({ length: 50 }, (_, i) => ({ x: i % 5, y: Math.floor(i / 5) / 5, z: 0,
      color: [200, 200, 200], views: new Map(), viewsPx: new Map() }))
    const { SparsePoints } = await import('/src/core/sfm/sparsePoints.js')
    s.clouds.push({ id: 'sparse-1', name: 'Sparse cloud', kind: 'sparse', createdAt: 42, cameras, points: SparsePoints.fromRecords(points) })
    s.mainSparseId = 'sparse-1'
    // The DEM's frame: same cameras, other points ⇒ same axes, shifted origin.
    const other = points.map((p) => ({ x: p.x + 7, y: p.y - 3, z: p.z }))
    const frame = describeFrame(frameFromSpec({ kind: 'local' }, [...cameras.values()], other), { kind: 'local' })
    const W = 100, data = new Float32Array(W * W).fill(42), mask = new Uint8Array(W * W).fill(1)
    for (let r = 45; r < 55; r++) for (let c = 45; c < 55; c++) { data[r * W + c] = NaN; mask[r * W + c] = 0 }
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = W
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4a8'; ctx.fillRect(0, 0, W, W)
    s.dem = { width: W, height: W, gsd: 1, originX: -50, originY: 50, data, mask, zMin: 42, zMax: 42,
      unit: 'model', crs: 'local', frame, name: 'DEM', previewUrl: canvas.toDataURL(),
      frameStamp: { source: null, cloudId: 'sparse-1', cloudCreatedAt: 42 } }
    s.setProductVisible('dem', true)
  })

  await page.locator('.tab', { hasText: /^2D$/ }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'View', exact: true }).click()
  const ribbon = page.locator('.ribbon')
  await expect(ribbon.getByRole('button', { name: /Model\s*Frame/ })).toHaveClass(/active/)
  // Edit GCPs (Tools ▸ Georeferencing) needs a CRS frame on the map.
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await expect(ribbon.getByRole('button', { name: /Edit\s*GCPs/ })).toHaveAttribute('aria-disabled', 'true')
  await ribbon.getByRole('button', { name: 'View', exact: true }).click()
  const note = page.locator('.map-viewer .basemap-note')
  await expect(note).toContainText('Model frame (model units, no CRS)')

  await ribbon.getByRole('button', { name: /Fit\s*View/ }).click()
  await page.waitForTimeout(500)
  const mb = await page.locator('.map-viewer .ol-map').boundingBox()
  const status = page.locator('.map-viewer .status-bar')
  // The 100-unit DEM dominates the fitted extent, so the view centre is its hole.
  await page.mouse.move(mb.x + mb.width / 2, mb.y + mb.height / 2)
  await expect(status).toContainText('X')
  await expect(status).toContainText('no data')
  await page.mouse.move(mb.x + mb.width / 2 - Math.min(mb.width, mb.height) * 0.3, mb.y + mb.height / 2)
  await expect(status).toContainText('42.00')

  // Back to the CRS map: the local DEM is still requested, and the map says why it is absent.
  await ribbon.getByRole('button', { name: /Model\s*Frame/ }).click()
  await expect(ribbon.getByRole('button', { name: /Model\s*Frame/ })).not.toHaveClass(/active/)
  await expect(note).toContainText('DEM is not shown: it is in the model frame')
  expect(errors).toEqual([])
})
