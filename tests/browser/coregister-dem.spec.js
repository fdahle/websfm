import { test, expect } from './fixtures.js'

// Tools ▸ Products ▸ Co-register DEM… (core/products/demCoregistration.js): a DEM 6 m
// east and 2 m above a reference DEM of the same ridged terrain is moved back onto it,
// as a co-registered copy, on the stable ground a polygon layer marks.
test('co-registers a DEM onto a reference DEM as a copy', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the dialog logic')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  if (await page.locator('.project-backdrop').isVisible()) await page.keyboard.press('Escape')

  const setup = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useExternalStore } = await import('/src/stores/useExternalStore.js')
    const { useFootprintsStore } = await import('/src/stores/useFootprintsStore.js')
    const { writeGeoTiff, geoKeysForEpsg } = await import('/src/core/products/geotiff.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32633')
    const surface = (x, y) => 300 * Math.sin(x / 400) * Math.cos(y / 500) + 150 * Math.sin((x + 2 * y) / 260)
    const X0 = 500000,
      Y0 = 5000000
    // The reference: 10 m cells over 4 km.
    const n = 400
    const ref = new Float32Array(n * n)
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) ref[r * n + c] = surface(X0 + (c + 0.5) * 10, Y0 + 4000 - (r + 0.5) * 10)
    await useExternalStore().importRaster(
      new File(
        [
          writeGeoTiff({
            width: n,
            height: n,
            samples: [{ bits: 32, format: 3 }],
            photometric: 1,
            data: new Uint8Array(ref.buffer),
            pixelScale: [10, 10, 0],
            tiepoint: [0, 0, 0, X0, Y0 + 4000, 0],
            geoKeys: geoKeysForEpsg(32633, false),
          }),
        ],
        'reference.tif',
      ),
      { forceKind: 'dem' },
    )
    // The DEM: 20 m cells inside it, 6 m east and 2 m high.
    const w = 150,
      h = 150,
      ox = X0 + 500,
      oy = Y0 + 3500
    const data = new Float32Array(w * h)
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) data[r * w + c] = surface(ox + (c + 0.5) * 20 - 6, oy - (r + 0.5) * 20) + 2
    let zMin = Infinity,
      zMax = -Infinity
    for (const z of data) {
      zMin = Math.min(zMin, z)
      zMax = Math.max(zMax, z)
    }
    useReconstructionStore().dem = {
      width: w,
      height: h,
      gsd: 20,
      originX: ox,
      originY: oy,
      data,
      mask: new Uint8Array(w * h).fill(1),
      zMin,
      zMax,
      crs: 'EPSG:32633',
      unit: 'm',
      createdAt: 1,
    }
    // Stable ground: the western two thirds.
    await useFootprintsStore().addFootprints(
      [
        {
          name: 'rock',
          rings: [
            [
              [ox, oy - 3000],
              [ox + 2000, oy - 3000],
              [ox + 2000, oy],
              [ox, oy],
              [ox, oy - 3000],
            ],
          ],
        },
      ],
      'EPSG:32633',
      'rock',
    )
    return { ox, oy }
  })

  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().toolModal = 'coregister-dem'
  })
  const dialog = page.getByRole('dialog', { name: 'Co-register DEM' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Every cell of "DEM" is compared with "reference.tif"')
  await dialog.locator('#coreg-stable').selectOption({ label: 'rock' })
  await expect(dialog).toContainText('Only the cells of "DEM" inside "rock" are compared with "reference.tif"')
  // The georeference cannot move: the project has none.
  await dialog.getByRole('button', { name: 'The georeference' }).click()
  await expect(dialog.locator('.warn-box')).toContainText('no georeference to move')
  await expect(dialog.getByRole('button', { name: 'Co-register', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'The DEM' }).click()
  await dialog.getByRole('button', { name: 'Co-register', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.toast', { hasText: 'Added "DEM (co-registered)"' })).toBeVisible({ timeout: 30_000 })

  const after = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const recon = useReconstructionStore()
    const dems = recon.rasterProducts.filter((p) => p.kind === 'dem')
    return {
      names: dems.map((d) => d.name),
      main: recon.dem.name,
      originX: recon.dem.originX,
      originY: recon.dem.originY,
      steps: recon.dem.coregistration?.steps,
      shift: recon.dem.coregistration?.shift,
      vertical: recon.dem.coregistration?.vertical,
      nmad: [recon.dem.coregistration?.before.nmad, recon.dem.coregistration?.after.nmad],
      hasPreview: !!recon.dem.previewUrl,
    }
  })
  expect(after.names).toEqual(['DEM', 'DEM (co-registered)'])
  expect(after.main).toBe('DEM (co-registered)')
  expect(after.shift[0]).toBeCloseTo(6, 0)
  expect(Math.abs(after.shift[1])).toBeLessThan(0.5)
  expect(after.vertical).toBeCloseTo(2, 0)
  expect(after.originX).toBeCloseTo(setup.ox - after.shift[0], 6)
  expect(after.steps).toEqual({ horizontal: true, vertical: true, tilt: 'off' })
  expect(after.nmad[1]).toBeLessThan(after.nmad[0] / 4)
  expect(after.hasPreview).toBe(true)
  expect(errors).toEqual([])
})
