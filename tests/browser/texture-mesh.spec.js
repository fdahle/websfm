import { test, expect } from '@playwright/test'

// A textured mesh (Tools ▸ Mesh ▸ Texture's output) is drawn with its atlas pages and
// survives a project reload: UVs, page bytes, page table and face groups.
test('a textured mesh shows its atlas and survives project reload', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    // Two pages: page 0 red, page 1 blue; one triangle of a quad on each.
    const pageJpeg = async (colour) => {
      const c = new OffscreenCanvas(64, 32)
      const g = c.getContext('2d'); g.fillStyle = colour; g.fillRect(0, 0, 64, 32)
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer())
    }
    const a = await pageJpeg('#ff0000'), b = await pageJpeg('#0000ff')
    const data = new Uint8Array(a.length + b.length); data.set(a); data.set(b, a.length)
    store.clouds.push({
      id: 'tex-1', name: 'Quad (textured)', kind: 'mesh', createdAt: Date.now(), derived: true,
      cameras: new Map(), count: 2, nVerts: 6,
      pos: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
      idx: Uint32Array.of(0, 1, 2, 3, 4, 5), col: null,
      uv: new Float32Array([0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.1, 0.9, 0.9, 0.1, 0.9]),
      texture: { data, pages: [
        { width: 64, height: 32, offset: 0, length: a.length, type: 'image/jpeg' },
        { width: 64, height: 32, offset: a.length, length: b.length, type: 'image/jpeg' },
      ], groups: [{ page: 0, start: 0, count: 1 }, { page: 1, start: 1, count: 1 }] },
    })
    store.setCloudVisible('tex-1', true)
    await (await import('/src/utils/persistence.js')).flushPersistence()
  })
  const layer = () => page.locator('.viewer').evaluate((el) => {
    const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
    if (!l) return null
    const mats = Array.isArray(l.object.material) ? l.object.material : [l.object.material]
    return { materials: mats.length, maps: mats.map((m) => m.map?.image?.width ?? 0),
      groups: l.object.geometry.groups.length, uv: l.object.geometry.getAttribute('uv')?.count ?? 0 }
  })
  const show3d = () => page.locator('.tab').filter({ hasText: /^3D$/ }).click()
  await show3d()
  await expect.poll(layer).toEqual({ materials: 2, maps: [64, 64], groups: 2, uv: 6 })
  await page.screenshot({ path: test.info().outputPath('textured.png') })

  await page.reload()
  await page.locator('.project-main').filter({ hasText: 'My Project' }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await show3d()
  await expect.poll(layer).toEqual({ materials: 2, maps: [64, 64], groups: 2, uv: 6 })
  const restored = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const c = useReconstructionStore().clouds.find((x) => x.texture)
    return { pages: c.texture.pages.length, groups: c.texture.groups, uv: [...c.uv].slice(0, 4).map((v) => +v.toFixed(2)) }
  })
  expect(restored).toEqual({ pages: 2, groups: [{ page: 0, start: 0, count: 1 }, { page: 1, start: 1, count: 1 }], uv: [0.1, 0.1, 0.9, 0.1] })
  expect(errors).toEqual([])
})
