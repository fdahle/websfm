import { test, expect } from '@playwright/test'
const harness = '/tests/browser/harness.html'

// SAT-3 D1: a DEM finer than one plane allows (> 4,096 cells a side) is built block by
// block into a Float32 COG; the record's plane is the COG's overview. Run through the
// worker op itself (makeProductsOps), on a known surface, and read back with geotiff.js.
test('a DEM past 4,096 cells is a full-resolution COG with an overview plane', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto(harness)
  const out = await page.evaluate(async () => {
    const { makeProductsOps } = await import('/src/workers/ops/products.js')
    const { fromBlob } = await import('/node_modules/geotiff/dist-module/geotiff.js')
    // A tilted plane z = 100 + 0.01·x − 0.02·y over 5,000 × 1,200 m, one point per 1 m².
    const W = 5000, H = 1200, n = W * H
    const pos = new Float64Array(3 * n)
    let i = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5
      pos[i++] = px; pos[i++] = py; pos[i++] = 100 + 0.01 * px - 0.02 * py
    }
    const logs = []
    const ops = makeProductsOps({})
    const { result: dem } = await ops.generateDem([{
      points: { pos, count: n }, cameras: [],
      frame: { origin: [0, 0, 0], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1], crs: 'local', unit: 'm' },
      settings: { gsd: 1, aggregate: 'mean', fillMethod: 'idw', fillRadius: 2, extent: 'all', memBudgetBytes: 2 ** 31 },
    }], { emit: (ev, args) => { if (ev === 'log') logs.push(args[0]) } })
    const tiff = await fromBlob(dem.cog)
    const img = await tiff.getImage(0)
    const [w, h] = [img.getWidth(), img.getHeight()]
    // Cells in the middle and at a block seam (col 2047/2048), against the plane.
    const read = async (col, row) => (await img.readRasters({ window: [col, row, col + 1, row + 1] }))[0][0]
    // The grid's origin is the first point, so each cell's one point sits on its corner.
    const expectAt = (col, row) => 100 + 0.01 * (dem.originX + col * dem.fullGsd) - 0.02 * (dem.originY - row * dem.fullGsd)
    const probes = []
    for (const [c, r] of [[10, 10], [2047, 600], [2048, 600], [4999, 1199], [2500, 0]]) {
      if (c < w && r < h) probes.push({ c, r, got: await read(c, r), want: expectAt(c, r) })
    }
    const ovMid = dem.data[Math.floor(dem.height / 2) * dem.width + Math.floor(dem.width / 2)]
    return { w, h, full: [dem.fullWidth, dem.fullHeight, dem.fullGsd], plane: [dem.width, dem.height, dem.gsd],
      planeLen: dem.data.length, maskSum: dem.mask.reduce((a, b) => a + b, 0), probes, ovMid,
      // An overview cell averages its 2×2 children: their points' mean is a half child in.
      ovWant: 100 + 0.01 * (dem.originX + Math.floor(dem.width / 2) * dem.gsd + 0.5) - 0.02 * (dem.originY - Math.floor(dem.height / 2) * dem.gsd - 0.5),
      logs: logs.filter((l) => /DEM/.test(l)) }
  })
  expect(out.full[0]).toBeGreaterThan(4096)
  expect([out.w, out.h]).toEqual([out.full[0], out.full[1]])
  expect(out.full[2]).toBe(1)
  // The plane is the first overview that fits: one halving of a ~5,000-wide grid.
  expect(Math.max(out.plane[0], out.plane[1])).toBeLessThanOrEqual(4096)
  expect(out.plane[2]).toBe(2)
  expect(out.planeLen).toBe(out.plane[0] * out.plane[1])
  expect(out.maskSum).toBeGreaterThan(0.99 * out.planeLen)
  for (const p of out.probes) expect(Math.abs(p.got - p.want)).toBeLessThan(0.01)
  expect(Math.abs(out.ovMid - out.ovWant)).toBeLessThan(0.05)
  expect(out.logs.some((l) => /in \d+ blocks of 2048²/.test(l))).toBe(true)
})

// SAT-3 D2: the DEM saves its overview plane and its COG; a load reads the plane and
// opens the COG as a handle, and a re-save of the same DEM (a rename) reuses the file.
test('a DEM with a COG saves, reopens and re-saves without rewriting the COG', async ({ page }) => {
  await page.goto(harness)
  const out = await page.evaluate(async () => {
    const opfs = await import('/src/utils/opfs.js')
    const cog = new Blob([new Uint8Array(3000).fill(7)], { type: 'image/tiff' })
    const dem = { width: 2, height: 1, gsd: 2, originX: 0, originY: 0, data: new Float32Array([1, 2]), mask: new Uint8Array([1, 1]),
      zMin: 1, zMax: 2, cog, fullWidth: 4, fullHeight: 2, fullGsd: 1, createdAt: 5, name: 'DEM' }
    const saved = await opfs.saveProduct('dem-cog-test', 'dem', dem)
    const loaded = await opfs.loadProduct('dem-cog-test', 'dem')
    const again = await opfs.saveProduct('dem-cog-test', 'dem', { ...loaded, name: 'Renamed' })
    const reloaded = await opfs.loadProduct('dem-cog-test', 'dem')
    const bytes = new Uint8Array(await reloaded.cog.arrayBuffer())
    await opfs.deleteProduct('dem-cog-test', 'dem')
    return { savedBytes: saved.cogSaved?.bytes, sameFile: again.cogSaved?.name === saved.cogSaved?.name,
      plane: [...loaded.data], full: [loaded.fullWidth, loaded.fullHeight], name: reloaded.name,
      cogSize: reloaded.cog.size, first: bytes[0] }
  })
  expect(out).toEqual({ savedBytes: 3000, sameFile: true, plane: [1, 2], full: [4, 2], name: 'Renamed', cogSize: 3000, first: 7 })
})

// SAT-3 D4 (readout): the DEM tab of a block-built DEM reads the height under the
// cursor from the full-resolution COG, at full-resolution cells.
test('the DEM tab reads a block-built DEM\'s full-resolution height under the cursor', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1300, height: 850 })
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { makeProductsOps } = await import('/src/workers/ops/products.js')
    const W = 5000, H = 1200, n = W * H
    const pos = new Float64Array(3 * n)
    let i = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { pos[i++] = x; pos[i++] = y; pos[i++] = 100 + 0.01 * x - 0.02 * y }
    const { result } = await makeProductsOps({}).generateDem([{ points: { pos, count: n }, cameras: [],
      frame: { origin: [0, 0, 0], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1], crs: 'local', unit: 'm' },
      settings: { gsd: 1, aggregate: 'mean', fillMethod: 'none', extent: 'all', memBudgetBytes: 2 ** 31 } }], { emit: () => {} })
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    useReconstructionStore().dem = { ...result, createdAt: 1, name: 'DEM', previewUrl: URL.createObjectURL(result.previewBlob) }
    document.querySelector('#app').__vue_app__._instance.setupState.openProductTab('dem', 'DEM')
  })
  await expect(page.getByText('5000×1200')).toBeVisible()
  const view = page.locator('.product-viewer').first()
  const box = await view.boundingBox()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5)
  const readout = async () => (await page.locator('.coord, .value').allTextContents()).join(' ').replace(/\s+/g, ' ')
  await expect.poll(readout).toMatch(/Z [\d.]+ m/)
  const text = await readout()
  const col = Number(text.match(/col (\d+)/)[1]), row = Number(text.match(/row (\d+)/)[1])
  const z = Number(text.match(/Z ([\d.]+) m/)[1])
  expect(col).toBeGreaterThan(2500) // past the 2,500-wide overview: a full-resolution index
  // The cell's one point: x = col, y = 1199 − row (the grid's origin is the corner point).
  expect(z).toBeCloseTo(100 + 0.01 * col - 0.02 * (1199 - row), 2)
})
