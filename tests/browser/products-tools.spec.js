import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Tools ▸ Products ▾ (contours, terrain derivatives, polygon clip), the remaining
// Point Cloud ▾ tools (Transform, ICP) and Measure ▾ ▸ Section, against the full app.
// Every product tool ends as a download; its contents are checked, not just its name.

async function createProject(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
}

async function openTool(page, menu, row) {
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: menu }).click()
  await page.getByRole('menuitem', { name: row }).click()
}

// Choose the <option> whose text contains `part` (labels carry locale-formatted counts).
async function selectByText(select, part) {
  const opts = await select.locator('option').allTextContents()
  await select.selectOption({ label: opts.find((o) => o.includes(part)) })
}

async function download(page, click) {
  const pending = page.waitForEvent('download')
  await click()
  const d = await pending
  return { name: d.suggestedFilename(), bytes: await readFile(await d.path()) }
}

test('Products ▾ exports contours, terrain derivatives and a polygon clip of the DEM', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  // A 60×60 cone DEM (height = 30 − distance from the centre), local frame.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useMeasurementsStore } = await import('/src/stores/useMeasurementsStore.js')
    const W = 60,
      data = new Float32Array(W * W),
      mask = new Uint8Array(W * W).fill(1)
    for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) data[r * W + c] = 30 - Math.hypot(c - 29.5, r - 29.5)
    useReconstructionStore().dem = {
      width: W,
      height: W,
      gsd: 1,
      originX: 0,
      originY: W,
      data,
      mask,
      zMin: Math.min(...data),
      zMax: 30,
      unit: 'm',
      crs: 'local',
      name: 'DEM',
    }
    useMeasurementsStore().records.push({
      id: 'area-1',
      name: 'Square',
      kind: 'area',
      source: 'product:dem',
      vertices: [],
      world: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 30, y: 30 },
        { x: 10, y: 30 },
      ],
    })
  })

  await openTool(page, 'Products', /Contours/)
  const ct = page.getByRole('dialog', { name: 'Contour Lines' })
  await ct.getByLabel('Interval').fill('5')
  const geo = await download(page, () => ct.getByRole('button', { name: 'Export contours', exact: true }).click())
  expect(geo.name).toMatch(/contours\.geojson$/)
  const fc = JSON.parse(geo.bytes.toString('utf8'))
  expect(fc.type).toBe('FeatureCollection')
  // A cone gives one closed ring per level (5, 10, 15, 20, 25 at least partly).
  expect(new Set(fc.features.map((f) => f.properties.elevation)).size).toBeGreaterThanOrEqual(4)

  await openTool(page, 'Products', /Slope, aspect, hillshade/)
  const tr = page.getByRole('dialog', { name: 'Slope, Aspect, Hillshade' })
  const slope = await download(page, () => tr.getByRole('button', { name: 'Export', exact: true }).click())
  expect(slope.name).toMatch(/dem-slope\.tif$/)
  expect(slope.bytes.subarray(0, 2).toString('latin1')).toBe('II') // little-endian TIFF

  await openTool(page, 'Products', /Clip to polygon/)
  const clip = page.getByRole('dialog', { name: 'Clip to Polygon' })
  await expect(clip.getByLabel('Measurement', { exact: true })).toHaveValue('area-1')
  const tif = await download(page, () => clip.getByRole('button', { name: 'Export clipped', exact: true }).click())
  expect(tif.name).toMatch(/dem-clipped\.tif$/)
  // The 20×20 square → a 20×20 raster: TIFF ImageWidth (tag 256) is LONG 20.
  const view = new DataView(tif.bytes.buffer, tif.bytes.byteOffset, tif.bytes.byteLength)
  const ifd = view.getUint32(4, true)
  const n = view.getUint16(ifd, true)
  const tags = Object.fromEntries(
    Array.from({ length: n }, (_, i) => {
      const e = ifd + 2 + i * 12
      return [view.getUint16(e, true), view.getUint32(e + 8, true)]
    }),
  )
  expect(tags[256]).toBe(20)
  expect(tags[257]).toBe(20)
  expect(errors).toEqual([])
})

test('Point Cloud ▾ transforms and ICP-aligns a cloud, and Measure ▾ sections it', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  // A wavy 40×40 surface with normals (the ICP reference), imported.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const N = 40,
      pos = new Float64Array(N * N * 3),
      nrm = new Float32Array(N * N * 3)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 3,
          x = i * 0.5,
          y = j * 0.5
        pos[k] = x
        pos[k + 1] = y
        pos[k + 2] = Math.sin(x / 2) * Math.cos(y / 3)
        const gx = 0.5 * Math.cos(x / 2) * Math.cos(y / 3),
          gy = (-Math.sin(x / 2) * Math.sin(y / 3)) / 3
        const l = Math.hypot(gx, gy, 1)
        nrm[k] = -gx / l
        nrm[k + 1] = -gy / l
        nrm[k + 2] = 1 / l
      }
    useReconstructionStore().importCloud(
      { count: N * N, pos, nrm, col: new Uint8Array(N * N * 3).fill(150) },
      'surface.ply',
    )
  })
  const clouds = () =>
    page.evaluate(async () => {
      const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
      return useReconstructionStore().clouds.map((c) => ({
        name: c.name,
        count: c.count,
        first: [...c.pos.subarray(0, 3)],
      }))
    })

  // Transform: move by (0.3, −0.2, 0.1).
  await openTool(page, /Point\s*Cloud/, /Transform/)
  const tf = page.getByRole('dialog', { name: 'Transform Cloud' })
  await tf.getByLabel('Move X').fill('0.3')
  await tf.getByLabel('Move Y').fill('-0.2')
  await tf.getByLabel('Move Z').fill('0.1')
  await tf.getByRole('button', { name: 'Transform', exact: true }).click()
  await expect
    .poll(async () => (await clouds()).find((c) => c.name.endsWith('(transformed)'))?.first[0])
    .toBeCloseTo(0.3, 9)

  // ICP brings the moved copy back onto the original.
  await openTool(page, /Point\s*Cloud/, /Align to reference/)
  const icp = page.getByRole('dialog', { name: 'Align to Reference (ICP)' })
  await selectByText(icp.getByLabel('Move', { exact: true }), '(transformed)')
  await selectByText(icp.getByLabel('Onto', { exact: true }), 'Imported (surface.ply)')
  await icp.getByLabel('Search radius').fill('2')
  await icp.getByRole('button', { name: 'Align', exact: true }).click()
  await expect
    .poll(async () => (await clouds()).find((c) => c.name.endsWith('(aligned)'))?.first ?? null)
    .not.toBeNull()
  const back = (await clouds()).find((c) => c.name.endsWith('(aligned)')).first
  expect(back[0]).toBeCloseTo(0, 2)
  expect(back[1]).toBeCloseTo(0, 2)
  expect(back[2]).toBeCloseTo(0, 2)

  // Section across the middle: a slice cloud plus a CSV profile.
  await openTool(page, 'Measure', /Section/)
  const sec = page.getByRole('dialog', { name: 'Cloud Section' })
  await selectByText(sec.getByLabel('Cloud', { exact: true }), 'Imported (surface.ply) —')
  const csv = await download(page, () => sec.getByRole('button', { name: 'Cut section', exact: true }).click())
  expect(csv.name).toMatch(/section\.csv$/)
  const rows = csv.bytes.toString('utf8').trim().split('\n')
  expect(rows[0]).toBe('station,z,offset,x,y')
  expect(rows.length).toBeGreaterThan(20)
  expect(errors).toEqual([])
})

// Unknown DEM datum: compared as is. An ellipsoidal DEM (control in ellipsoidal
// heights): the EGM2008 reference is converted to it, moving ΔZ by −N there.
for (const demDatum of [null, 'ellipsoidal'])
  test(`Evaluate ▸ DEM vs Reference compares the DEM with a reference DEM in another CRS${demDatum ? `, converting to the DEM's ${demDatum} heights` : ''}`, async ({
    page,
  }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await createProject(page)
    // A tilted-plane DEM in UTM 33N, and the same plane 0.5 m lower as a reference
    // DEM in EPSG:4326 covering only the DEM's western half — the comparison must
    // reproject every query into degrees and find a +0.5 m bias over ~50 % overlap.
    await page.evaluate(async (demDatum) => {
      const { ensureProjection, transform } = await import('/src/core/crs.js')
      const { createFlatRasterSource } = await import('/src/core/io/rasterSource.js')
      const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
      const { useExternalStore } = await import('/src/stores/useExternalStore.js')
      await ensureProjection('EPSG:32633')
      const plane = (x, y) => 100 + 0.2 * (x - 500000) - 0.1 * (y - 4600000)
      const W = 60,
        X0 = 500000,
        Y0 = 4600060
      const data = new Float32Array(W * W),
        mask = new Uint8Array(W * W).fill(1)
      for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) data[r * W + c] = plane(X0 + c + 0.5, Y0 - r - 0.5)
      useReconstructionStore().dem = {
        width: W,
        height: W,
        gsd: 1,
        originX: X0,
        originY: Y0,
        data,
        mask,
        zMin: Math.min(...data),
        zMax: Math.max(...data),
        unit: 'm',
        crs: 'EPSG:32633',
        name: 'DEM',
        createdAt: 1,
        ...(demDatum ? { verticalDatum: demDatum } : {}),
      }

      const [lon0, lat0] = transform([X0 - 10, Y0 - W - 10], 'EPSG:32633', 'EPSG:4326')
      const [lon1, lat1] = transform([X0 + 30, Y0 + 10], 'EPSG:32633', 'EPSG:4326')
      const N = 80,
        sx = (lon1 - lon0) / N,
        sy = (lat1 - lat0) / N
      const ref = new Float32Array(N * N)
      for (let r = 0; r < N; r++)
        for (let c = 0; c < N; c++) {
          const [x, y] = transform([lon0 + (c + 0.5) * sx, lat1 - (r + 0.5) * sy], 'EPSG:4326', 'EPSG:32633')
          ref[r * N + c] = plane(x, y) - 0.5
        }
      const meta = {
        id: 'ext-ref',
        name: 'Reference',
        kind: 'dem',
        width: N,
        height: N,
        bands: 1,
        crs: 'EPSG:4326',
        geoTransform: { originX: lon0, originY: lat1, scaleX: sx, scaleY: -sy },
        nodata: null,
        verticalDatum: 'geoid:EGM2008',
        verticalAccuracy: 0.2,
      }
      const external = useExternalStore()
      external.rasters.push(meta)
      external.sources = new Map([[meta.id, createFlatRasterSource(meta, ref)]])
    }, demDatum)

    await page.getByRole('button', { name: 'Evaluate', exact: true }).click()
    await page
      .locator('.ribbon')
      .getByRole('button', { name: /DEM vs\s*Reference/ })
      .click()
    const report = page.getByRole('dialog', { name: 'Quality Report', exact: true })
    const tile = (label) => report.locator('.tile').filter({ hasText: label }).locator('.tile-value')
    if (!demDatum) {
      await expect(tile('Median ΔZ')).toContainText('+0.500')
    } else {
      // h = H + N, N(EGM2008) ≈ 44.9 m near 41.5° N 15° E: the reference rises by N.
      const meta = report.locator('.ref-meta')
      await expect(meta).toContainText('converted to ellipsoidal')
      const shift = parseFloat((await meta.textContent()).match(/\(([+−-][\d.]+)/)[1].replace('−', '-'))
      expect(shift).toBeGreaterThan(40)
      expect(shift).toBeLessThan(50)
      const median = parseFloat((await tile('Median ΔZ').textContent()).replace('−', '-'))
      expect(median).toBeCloseTo(0.5 - shift, 1)
    }
    await expect(tile('NMAD')).toContainText('0.0')
    const overlap = parseFloat(await tile('Overlap').textContent())
    expect(overlap).toBeGreaterThan(40)
    expect(overlap).toBeLessThan(60)
    await expect(report.getByRole('img', { name: /DEM minus reference/ })).toBeVisible()
    await expect(report.locator('.warn-box')).toHaveCount(0)
    expect(errors).toEqual([])
  })
