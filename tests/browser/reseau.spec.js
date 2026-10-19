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
