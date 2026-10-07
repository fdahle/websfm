import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Tools ▸ Products ▾ (contours, terrain derivatives, polygon clip) and the
// remaining Point Cloud ▾ tools (Transform, ICP, Section), against the full app.
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
    const W = 60, data = new Float32Array(W * W), mask = new Uint8Array(W * W).fill(1)
    for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) data[r * W + c] = 30 - Math.hypot(c - 29.5, r - 29.5)
    useReconstructionStore().dem = { width: W, height: W, gsd: 1, originX: 0, originY: W, data, mask,
      zMin: Math.min(...data), zMax: 30, unit: 'm', crs: 'local', name: 'DEM' }
    useMeasurementsStore().records.push({ id: 'area-1', name: 'Square', kind: 'area', source: 'product:dem',
      vertices: [], world: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }] })
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
  const tags = Object.fromEntries(Array.from({ length: n }, (_, i) => {
    const e = ifd + 2 + i * 12
    return [view.getUint16(e, true), view.getUint32(e + 8, true)]
  }))
  expect(tags[256]).toBe(20)
  expect(tags[257]).toBe(20)
  expect(errors).toEqual([])
})

test('Point Cloud ▾ transforms, ICP-aligns and sections a cloud', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  // A wavy 40×40 surface with normals (the ICP reference), imported.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const N = 40, pos = new Float64Array(N * N * 3), nrm = new Float32Array(N * N * 3)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3, x = i * 0.5, y = j * 0.5
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = Math.sin(x / 2) * Math.cos(y / 3)
      const gx = 0.5 * Math.cos(x / 2) * Math.cos(y / 3), gy = -Math.sin(x / 2) * Math.sin(y / 3) / 3
      const l = Math.hypot(gx, gy, 1); nrm[k] = -gx / l; nrm[k + 1] = -gy / l; nrm[k + 2] = 1 / l
    }
    useReconstructionStore().importCloud({ count: N * N, pos, nrm, col: new Uint8Array(N * N * 3).fill(150) }, 'surface.ply')
  })
  const clouds = () => page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().clouds.map((c) => ({ name: c.name, count: c.count, first: [...c.pos.subarray(0, 3)] }))
  })

  // Transform: move by (0.3, −0.2, 0.1).
  await openTool(page, /Point\s*Cloud/, /Transform/)
  const tf = page.getByRole('dialog', { name: 'Transform Cloud' })
  await tf.getByLabel('Move X').fill('0.3')
  await tf.getByLabel('Move Y').fill('-0.2')
  await tf.getByLabel('Move Z').fill('0.1')
  await tf.getByRole('button', { name: 'Transform', exact: true }).click()
  await expect.poll(async () => (await clouds()).find((c) => c.name.endsWith('(transformed)'))?.first[0]).toBeCloseTo(0.3, 9)

  // ICP brings the moved copy back onto the original.
  await openTool(page, /Point\s*Cloud/, /Align to reference/)
  const icp = page.getByRole('dialog', { name: 'Align to Reference (ICP)' })
  await selectByText(icp.getByLabel('Move', { exact: true }), '(transformed)')
  await selectByText(icp.getByLabel('Onto', { exact: true }), 'Imported (surface.ply)')
  await icp.getByLabel('Search radius').fill('2')
  await icp.getByRole('button', { name: 'Align', exact: true }).click()
  await expect.poll(async () => (await clouds()).find((c) => c.name.endsWith('(aligned)'))?.first ?? null).not.toBeNull()
  const back = (await clouds()).find((c) => c.name.endsWith('(aligned)')).first
  expect(back[0]).toBeCloseTo(0, 2)
  expect(back[1]).toBeCloseTo(0, 2)
  expect(back[2]).toBeCloseTo(0, 2)

  // Section across the middle: a slice cloud plus a CSV profile.
  await openTool(page, /Point\s*Cloud/, /Section/)
  const sec = page.getByRole('dialog', { name: 'Cloud Section' })
  await selectByText(sec.getByLabel('Cloud', { exact: true }), 'Imported (surface.ply) —')
  const csv = await download(page, () => sec.getByRole('button', { name: 'Cut section', exact: true }).click())
  expect(csv.name).toMatch(/section\.csv$/)
  const rows = csv.bytes.toString('utf8').trim().split('\n')
  expect(rows[0]).toBe('station,z,offset,x,y')
  expect(rows.length).toBeGreaterThan(20)
  expect(errors).toEqual([])
})
