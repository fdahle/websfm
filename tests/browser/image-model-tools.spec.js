import { test, expect } from '@playwright/test'

// Images ▾ ▸ Image quality (decode + score in the worker) and Model ▾ ▸ Optimize
// cameras (bundle adjustment with the focal free, through the real WASM in the
// worker and the store's in-place model commit), against the full application.

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

test('Image quality scores sharp and blurred images and flags the blurred one', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  // Three sharp checker-noise PNGs and one heavily blurred copy.
  await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const make = async (name, blur, seed) => {
      const c = new OffscreenCanvas(640, 480), g = c.getContext('2d')
      let s = seed
      for (let y = 0; y < 480; y += 8) for (let x = 0; x < 640; x += 8) {
        s = (s * 16807) % 2147483647
        const v = s % 256
        g.fillStyle = `rgb(${v},${255 - v},${(v * 3) % 256})`
        g.fillRect(x, y, 8, 8)
      }
      if (blur) {
        const b = new OffscreenCanvas(640, 480), bg = b.getContext('2d')
        bg.filter = 'blur(6px)'
        bg.drawImage(c, 0, 0)
        return new File([await b.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' })
      }
      return new File([await c.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' })
    }
    await useImagesStore().addImages([await make('a.png', false, 7), await make('b.png', false, 11),
      await make('c.png', false, 13), await make('blurry.png', true, 7)])
  })
  await openTool(page, 'Images', /Image quality/)
  const dialog = page.getByRole('dialog', { name: 'Image Quality' })
  await dialog.getByRole('button', { name: /Score all images/ }).click()
  await expect(dialog.getByText('blurry', { exact: true })).toBeVisible({ timeout: 20_000 })
  const scored = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    return Object.fromEntries(useImagesStore().images.map((img) => [img.name, img.quality?.sharpness]))
  })
  expect(scored['blurry.png']).toBeLessThan(scored['a.png'] / 4)
  await expect(dialog.getByText('1 of 4 scored image(s) flagged.')).toBeVisible()
  expect(errors).toEqual([])
})

test('Optimize cameras recovers a wrong focal length in place', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  // Five cameras on an arc around 150 points, observed with fx = 1000; the model
  // starts at fx = 960.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const s = useReconstructionStore()
    const rotY = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]]
    const cameras = new Map(Array.from({ length: 5 }, (_, i) => {
      const a = (i - 2) * 0.12, R = rotY(-a), C = [10 * Math.sin(a), 0.3 * i, 10 - 10 * Math.cos(a)]
      return [`cam${i}`, { R, t: R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2])), K: { fx: 960, fy: 960, cx: 0, cy: 0 } }]
    }))
    let seed = 3
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const points = Array.from({ length: 150 }, (_, k) => {
      const w = [rnd() * 6 - 3, rnd() * 4 - 2, 10 + rnd() * 4 - 2]
      const viewsPx = new Map([...cameras].map(([id, c]) => {
        const p = c.R.map((r, i) => r[0] * w[0] + r[1] * w[1] + r[2] * w[2] + c.t[i])
        return [id, [1000 * p[0] / p[2], 1000 * p[1] / p[2]]]
      }))
      return { x: w[0], y: w[1], z: w[2], color: [200, 200, 200], views: new Map([...cameras.keys()].map((id) => [id, k])), viewsPx }
    })
    s.clouds.push({ id: 'sparse-1', name: 'Sparse cloud', kind: 'sparse', createdAt: 42, cameras, points })
    s.mainSparseId = 'sparse-1'
  })
  await openTool(page, 'Model', /Optimize cameras/)
  const dialog = page.getByRole('dialog', { name: 'Optimize Cameras' })
  await dialog.getByRole('button', { name: 'Optimize', exact: true }).click()
  const fx = () => page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().mainSparseCloud?.cameras.get('cam0')?.K.fx
  })
  await expect.poll(fx, { timeout: 20_000 }).not.toBe(960)
  expect(Math.abs(await fx() / 1000 - 1)).toBeLessThan(0.01)
  expect(errors).toEqual([])
})
