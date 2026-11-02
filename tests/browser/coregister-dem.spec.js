import { test, expect } from './fixtures.js'

// Tools ▸ Products ▸ Co-register DEM… (core/products/demCoregistration.js): a DEM 6 m
// east and 2 m above a reference DEM of the same ridged terrain is moved back onto it,
// on the stable ground a polygon layer marks, as a co-registered copy or by moving the
// georeference.

// A project in EPSG:32633 with a reference DEM of ridged terrain (10 m cells over 4 km),
// a DEM of the same terrain 6 m east and 2 m high inside it (20 m cells), and a polygon
// layer "rock" over its western two thirds. → { errors, ox, oy }
async function setupTerrain(page) {
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
  return { errors, ...setup }
}

test('co-registers a DEM onto a reference DEM as a copy', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the dialog logic')
  test.setTimeout(120_000)
  const { errors, ...setup } = await setupTerrain(page)

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

// Applied to the georeference: a DEM built in an earlier georeference cannot move it; one
// built in the current fit moves the fit by (−6, 0, −2) m, stays usable for a new move in
// place of that one, and Remove puts the fit back.
test('co-registers the georeference by a DEM built in it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the dialog logic')
  test.setTimeout(120_000)
  const { errors } = await setupTerrain(page)

  // An identity georeference, valid for this (empty) model: its evidence key is the
  // one georeferencing.js computes, and the DEM stamped as built in an earlier one.
  const fit = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const { usePosesStore } = await import('/src/stores/usePosesStore.js')
    const recon = useReconstructionStore()
    const crs = useProjectsStore().currentCrs
    const evidenceKey = JSON.stringify({
      crs,
      model: null,
      cameras: [],
      images: useImagesStore().images.map((im) => [im.id, im.uuid]),
      gcps: useGcpsStore().gcps,
      poses: usePosesStore().poses,
    })
    const I = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    recon.georef = { evidenceKey, sim: { scale: 1, R: I, t: [0, 0, 0] }, crs, rms: 0, count: 3, method: 'gcps' }
    await new Promise((r) => setTimeout(r, 0))
    // What the store's frameStampOf records for a product built now.
    const r = await recon.effectiveFrameSpec()
    const stamp = { source: r.source, scale: r.scale, crs: r.crs, unit: r.unit, frameKey: JSON.stringify(r.frameSpec) }
    const old = JSON.parse(stamp.frameKey)
    old.t = [5, 0, 0]
    recon.dem = { ...recon.dem, frameStamp: { ...stamp, frameKey: JSON.stringify(old) } }
    return { valid: !!recon.georef, stamp }
  })
  expect(fit.valid).toBe(true)

  const open = () =>
    page.evaluate(async () => {
      const { useModalsStore } = await import('/src/stores/useModalsStore.js')
      useModalsStore().toolModal = 'coregister-dem'
    })
  await open()
  const dialog = page.getByRole('dialog', { name: 'Co-register DEM' })
  await dialog.locator('#coreg-stable').selectOption({ label: 'rock' })
  await dialog.getByRole('button', { name: 'The georeference' }).click()
  await expect(dialog.locator('.warn-box')).toContainText('was built before the georeference last changed')
  await expect(dialog.getByRole('button', { name: 'Co-register', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // Built in the current fit: it moves the georeference.
  await page.evaluate(async (stamp) => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const recon = useReconstructionStore()
    recon.dem = { ...recon.dem, frameStamp: stamp }
  }, fit.stamp)
  await open()
  await dialog.locator('#coreg-stable').selectOption({ label: 'rock' })
  await dialog.getByRole('button', { name: 'The georeference' }).click()
  await expect(dialog).toContainText('The georeference moves onto "reference.tif": the DEMs and orthophotos')
  await dialog.getByRole('button', { name: 'Co-register', exact: true }).click()
  await expect(page.locator('.toast', { hasText: 'Georeference co-registered' })).toBeVisible({ timeout: 30_000 })

  const moved = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const recon = useReconstructionStore()
    return {
      coregistered: !!recon.georef?.coregistered,
      t: recon.georef?.sim.t,
      move: recon.coregistration?.move,
      demStale: recon.productFrameStatus(recon.dem).stale,
      dems: recon.rasterProducts.filter((p) => p.kind === 'dem').length,
    }
  })
  expect(moved.coregistered).toBe(true)
  expect(moved.move[0]).toBeCloseTo(-6, 0)
  expect(Math.abs(moved.move[1])).toBeLessThan(0.5)
  expect(moved.move[2]).toBeCloseTo(-2, 0)
  expect(moved.t[0]).toBeCloseTo(-6, 0)
  expect(moved.t[2]).toBeCloseTo(-2, 0)
  expect(moved.demStale).toBe(true) // built before the move: outdated, but in the fit
  expect(moved.dems).toBe(1) // no copy

  // The DEM was built in the fit: a new move replaces the current one; Remove undoes it.
  await open()
  await expect(dialog).toContainText('The georeference is co-registered to "reference.tif" (moved E −6')
  await dialog.locator('#coreg-stable').selectOption({ label: 'rock' })
  await dialog.getByRole('button', { name: 'The georeference' }).click()
  await expect(dialog).toContainText('in place of the current move')
  await expect(dialog.getByRole('button', { name: 'Co-register', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Remove' }).click()
  const removed = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const recon = useReconstructionStore()
    return { coregistered: !!recon.georef?.coregistered, t: recon.georef?.sim.t, c: recon.coregistration }
  })
  expect(removed).toEqual({ coregistered: false, t: [0, 0, 0], c: null })
  expect(errors).toEqual([])
})
