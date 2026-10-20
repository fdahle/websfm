import { test, expect } from '@playwright/test'

// Tools ▸ Images ▾ ▸ Detect reseau (SAT-5) through the app's dialog: two scans with a
// drawn reseau (a 10 mm grid of crosses at 0.1 mm/px, the scan placed 7 px right and
// 4 px down), found to a fraction of a pixel and applied as the sensor's calibration.
test('Detect Reseau finds the crosses and applies a reseau calibration', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const W = 2000, H = 1000, PITCH = 0.1, DX = 7, DY = 4
    const files = await Promise.all(['a.png', 'b.png'].map(async (name, k) => {
      const c = new OffscreenCanvas(W, H), g = c.getContext('2d')
      // Textured ground: blocks of grey, different per image.
      for (let y = 0; y < H; y += 10) for (let x = 0; x < W; x += 10) {
        const v = 110 + ((x * 7 + y * 13 + k * 31) % 60); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, 10, 10)
      }
      g.strokeStyle = 'rgb(10,10,10)'; g.lineWidth = 1
      for (let j = -4; j <= 4; j++) for (let i = -9; i <= 9; i++) {
        const cx = W / 2 + DX + i * 10 / PITCH, cy = H / 2 + DY - j * 10 / PITCH
        g.beginPath(); g.moveTo(cx - 5, cy); g.lineTo(cx + 5, cy); g.moveTo(cx, cy - 5); g.lineTo(cx, cy + 5); g.stroke()
      }
      return new File([await c.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' })
    }))
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    await useImagesStore().addImages(files)
  })
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/useImagesStore.js')).useImagesStore()
    .images.filter((i) => i.meta?.width > 0).length)).toBe(2)
  await page.evaluate(async () => {
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const s = useSensorsStore()
    s.updateSensor(s.sensors[0].id, 'pixelSize', 0.1)
    document.querySelector('#app').__vue_app__._instance.setupState.handleCommand('detect-reseau')
  })
  const dlg = page.getByRole('dialog', { name: /Detect Reseau/ })
  await expect(dlg).toContainText('231 crosses per frame') // ±100 mm; the edge columns fall off the scan
  await dlg.getByRole('button', { name: 'Detect', exact: true }).click()
  await expect(dlg.locator('table.results tbody tr')).toHaveCount(2, { timeout: 60_000 })
  const out = await page.evaluate(async () => {
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const s = useSensorsStore().sensors[0], img = useImagesStore().images[0]
    const centre = img.fiducialDetections.find((d) => d.slot === 'r:0:0')
    return { kind: s.kind, transform: s.fiducialCalibration?.transform, found: img.fiducialDetections.length, centre }
  })
  expect(out.kind).toBe('film')
  expect(out.transform).toBe('reseau')
  expect(out.found).toBeGreaterThan(160)
  // The centre cross: canvas coordinates are pixel-edge, so it is at 1007, 504.
  expect(Math.hypot(out.centre.px - 1007, out.centre.py - 504)).toBeLessThan(0.3)
})

// Half frames: one drawn frame (19 × 9 crosses at 0.1 mm/px) scanned as two overlapping
// halves, f1_a (the left 1250 px) and f1_b (the right 1250 px, 5 columns shared). The
// dialog stitches them into f1.tif on the film grid, moves a GCP mark from the left half
// across, and removes the halves.
test('Detect Reseau stitches half-frame scans into one frame', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const W = 2000, H = 1000, PITCH = 0.1
    const frame = new OffscreenCanvas(W, H), g = frame.getContext('2d')
    // Textured ground without a period, so the overlap is decided by the scene.
    let seed = 7
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let y = 0; y < H; y += 10) for (let x = 0; x < W; x += 10) {
      const v = Math.round(100 + 80 * rnd()); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, 10, 10)
    }
    g.strokeStyle = 'rgb(10,10,10)'; g.lineWidth = 1
    for (let j = -4; j <= 4; j++) for (let i = -9; i <= 9; i++) {
      const cx = W / 2 + i * 10 / PITCH, cy = H / 2 - j * 10 / PITCH
      g.beginPath(); g.moveTo(cx - 5, cy); g.lineTo(cx + 5, cy); g.moveTo(cx, cy - 5); g.lineTo(cx, cy + 5); g.stroke()
    }
    const half = async (name, x0) => {
      const c = new OffscreenCanvas(1250, H)
      c.getContext('2d').drawImage(frame, -x0, 0)
      return new File([await c.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' })
    }
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    await useImagesStore().addImages([await half('f1_a.png', 0), await half('f1_b.png', 750)])
  })
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/useImagesStore.js')).useImagesStore()
    .images.filter((i) => i.meta?.width > 0).length)).toBe(2)
  await page.evaluate(async () => {
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const s = useSensorsStore()
    s.updateSensor(s.sensors[0].id, 'pixelSize', 0.1)
    // A mark on the left half at frame px (600, 300): film (−40, 20) mm.
    const a = useImagesStore().images.find((i) => i.name === 'f1_a.png')
    const gcps = useGcpsStore(), id = gcps.addPoint({ role: 'marker' })
    gcps.setObservation(id, a.id, a.name, 600, 300)
    document.querySelector('#app').__vue_app__._instance.setupState.handleCommand('detect-reseau')
  })
  const dlg = page.getByRole('dialog', { name: /Detect Reseau/ })
  await expect(dlg.getByRole('radio', { name: /Half frames \(1 pair\)/ })).toBeChecked()
  await dlg.getByRole('button', { name: 'Stitch', exact: true }).click()
  const row = dlg.locator('table.results tbody tr')
  await expect(row).toHaveCount(1, { timeout: 60_000 })
  await expect(row).toContainText('19 × 9')
  await expect(row.locator('td').nth(3)).toHaveText('5')
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/useImagesStore.js')).useImagesStore()
    .images.map((i) => `${i.name} ${i.meta?.width}×${i.meta?.height}`).join(','))).toBe('f1.tif 1900×900')
  const out = await page.evaluate(async () => {
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const img = useImagesStore().images[0]
    const s = useSensorsStore().sensors.find((x) => x.id === img.sensorId)
    // The frame's centre cross, film (0, 0), in the stitched pixels: px (950, 450).
    const { computeSourceOf } = await import('/src/utils/image.js')
    const { crossInWindow } = await import('/src/core/sfm/reseauDetect.js')
    const bmp = await createImageBitmap(await (await fetch(computeSourceOf(img))).blob())
    const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')
    ctx.drawImage(bmp, 0, 0)
    const N = 41, rgba = ctx.getImageData(930, 430, N, N).data, data = new Float32Array(N * N)
    for (let k = 0; k < N * N; k++) data[k] = rgba[4 * k]
    const c = crossInWindow({ data, width: N, height: N }, { armPx: 5, widthPx: 1 })
    return { label: s.label, stitched: s.reseauStitched, pixelSize: s.pixelSize, obs: useGcpsStore().gcps[0].observations,
      centre: c && { x: 930 + c.x, y: 430 + c.y } }
  })
  expect(out.label).toMatch(/\(stitched\)$/)
  expect(out.stitched).toBe(true)
  expect(out.pixelSize).toBe(0.1)
  // Film (−40, 20) mm on the 190 × 90 mm grid: px (550, 250).
  expect(out.obs).toHaveLength(1)
  expect(Math.hypot(out.obs[0].px - 550, out.obs[0].py - 250)).toBeLessThan(0.3)
  // The pixels sit where the marks and the principal point put them (not half a pixel off).
  expect(Math.hypot(out.centre.x - 950, out.centre.y - 450)).toBeLessThan(0.2)
})
