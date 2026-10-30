import { test, expect } from './fixtures.js'

// Tools ▸ Images ▾ ▸ Split panoramic strips through the app's dialog: one drawn strip
// (f = 100 mm, 0.1 mm/px, 1,600 × 200 px: a 92° scan) with a GCP mark, split into
// near-square segments. The mark must land where a pinhole turned to its segment sees
// the same ray, the strip must go, and the segments must share one held sensor.
test('Split Panoramic Strips cuts a strip into frame-camera segments', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const W = 1600,
    H = 200,
    PITCH = 0.1,
    F = 100
  // The mark: a ray at scan angle 0.3 rad, 4 mm below the film's centre line.
  const mark = { u: W / 2 + (0.3 * F) / PITCH, v: H / 2 + 4 / PITCH }
  await page.evaluate(
    async ({ W, H }) => {
      const c = new OffscreenCanvas(W, H),
        g = c.getContext('2d')
      for (let y = 0; y < H; y += 8)
        for (let x = 0; x < W; x += 8) {
          const v = 90 + ((x * 7 + y * 13) % 120)
          g.fillStyle = `rgb(${v},${v},${v})`
          g.fillRect(x, y, 8, 8)
        }
      const file = new File([await c.convertToBlob({ type: 'image/png' })], 'P01.png', { type: 'image/png' })
      const { useImagesStore } = await import('/src/stores/useImagesStore.js')
      await useImagesStore().addImages([file])
    },
    { W, H },
  )
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await import('/src/stores/useImagesStore.js')).useImagesStore().images.filter((i) => i.meta?.width > 0)
            .length,
      ),
    )
    .toBe(1)
  await page.evaluate(
    async ({ PITCH, F, mark }) => {
      const { useImagesStore } = await import('/src/stores/useImagesStore.js')
      const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
      const img = useImagesStore().images[0]
      const gcps = useGcpsStore(),
        gid = gcps.addPoint({ role: 'marker' })
      gcps.setObservation(gid, img.id, img.name, mark.u, mark.v)
      const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
      const s = useSensorsStore(),
        id = s.sensors[0].id
      s.updateSensor(id, 'pixelSize', PITCH)
      s.updateSensor(id, 'focalUnit', 'mm')
      s.updateSensor(id, 'focal', F)
      document.querySelector('#app').__vue_app__._instance.setupState.handleCommand('split-panoramic')
    },
    { PITCH, F, mark },
  )
  const dlg = page.getByRole('dialog', { name: /Split Panoramic Strips/ })
  await expect(dlg).toContainText('1 strip of 92° scan each → 8 segments')
  await dlg.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(dlg.locator('table.results tbody tr')).toHaveCount(1, { timeout: 60_000 })
  await expect(dlg.locator('table.results tbody tr td').nth(2)).toContainText('8 of')

  const out = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const imgs = useImagesStore().images
    const s = useSensorsStore().sensors.find((x) => x.id === imgs[0].sensorId)
    return {
      names: imgs.map((i) => i.name),
      sensors: [...new Set(imgs.map((i) => i.sensorId))].length,
      sensor: {
        focal: s.focal,
        focalUnit: s.focalUnit,
        pixelSize: s.pixelSize,
        cx: s.cx,
        cy: s.cy,
        panoramicSegments: s.panoramicSegments,
      },
      sizes: [...new Set(imgs.map((i) => `${i.meta?.width}x${i.meta?.height}`))],
      obs: useGcpsStore().gcps[0].observations.map((o) => ({
        name: o.imageName ?? imgs.find((i) => i.id === o.imageId)?.name,
        px: o.px,
        py: o.py,
      })),
    }
  })
  expect(out.names).toEqual(Array.from({ length: 8 }, (_, k) => `P01_s0${k + 1}.tif`))
  expect(out.sensors).toBe(1)
  expect(out.sensor).toMatchObject({ focal: F, focalUnit: 'mm', pixelSize: PITCH, panoramicSegments: true })
  expect(out.sizes).toHaveLength(1)
  const [w, h] = out.sizes[0].split('x').map(Number)
  expect(out.sensor.cx).toBe(w / 2 - 0.5)
  expect(out.sensor.cy).toBe(h / 2 - 0.5)
  // Scan angle 0.3 rad: segment 6 (θk = −0.8 + 5.5·0.2 = 0.3) sees it on its axis, its
  // neighbours at ±0.2 rad through their overlap only if they reach that far (they don't).
  expect(out.obs).toHaveLength(1)
  const o = out.obs[0]
  expect(o.name).toBe('P01_s06.tif')
  // On the axis: a = w/2; b = f·(t/f)/cos 0 / p = 4 mm / 0.1 below the centre.
  expect(Math.abs(o.px - w / 2)).toBeLessThan(1e-6)
  expect(Math.abs(o.py - (h / 2 + 4 / PITCH))).toBeLessThan(1e-6)
})
