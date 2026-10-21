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
      const g = c.getContext('2d')
      g.fillStyle = colour
      g.fillRect(0, 0, 64, 32)
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer())
    }
    const a = await pageJpeg('#ff0000'),
      b = await pageJpeg('#0000ff')
    const data = new Uint8Array(a.length + b.length)
    data.set(a)
    data.set(b, a.length)
    store.clouds.push({
      id: 'tex-1',
      name: 'Quad (textured)',
      kind: 'mesh',
      createdAt: Date.now(),
      derived: true,
      cameras: new Map(),
      count: 2,
      nVerts: 6,
      pos: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]),
      idx: Uint32Array.of(0, 1, 2, 3, 4, 5),
      col: null,
      uv: new Float32Array([0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.1, 0.9, 0.9, 0.1, 0.9]),
      texture: {
        data,
        pages: [
          { width: 64, height: 32, offset: 0, length: a.length, type: 'image/jpeg' },
          { width: 64, height: 32, offset: a.length, length: b.length, type: 'image/jpeg' },
        ],
        groups: [
          { page: 0, start: 0, count: 1 },
          { page: 1, start: 1, count: 1 },
        ],
      },
    })
    store.setCloudVisible('tex-1', true)
    await (await import('/src/utils/persistence.js')).flushPersistence()
  })
  const layer = () =>
    page.locator('.viewer').evaluate((el) => {
      const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
      if (!l) return null
      const mats = Array.isArray(l.object.material) ? l.object.material : [l.object.material]
      return {
        materials: mats.length,
        maps: mats.map((m) => m.map?.image?.width ?? 0),
        groups: l.object.geometry.groups.length,
        uv: l.object.geometry.getAttribute('uv')?.count ?? 0,
      }
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
    return {
      pages: c.texture.pages.length,
      groups: c.texture.groups,
      uv: [...c.uv].slice(0, 4).map((v) => +v.toFixed(2)),
    }
  })
  expect(restored).toEqual({
    pages: 2,
    groups: [
      { page: 0, start: 0, count: 1 },
      { page: 1, start: 1, count: 1 },
    ],
    uv: [0.1, 0.1, 0.9, 0.1],
  })
  expect(errors).toEqual([])
})

// The dialog path: Tools ▸ Mesh ▸ Texture… → Texture reaches the store's run (a
// wiring gap here once left the button doing nothing). With a camera but no photo for
// it, the run reports that cleanly instead of failing.
test('the Texture dialog runs the texture through the pipeline', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    const store = useReconstructionStore()
    const { SparsePoints } = await import('/src/core/sfm/sparsePoints.js')
    store.clouds.push({
      id: 'sparse-1',
      name: 'Sparse cloud',
      kind: 'sparse',
      createdAt: Date.now(),
      points: SparsePoints.fromRecords([{ x: 0, y: 0, z: 5 }]),
      cameras: new Map([
        [
          'cam-1',
          {
            R: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
            t: [0, 0, 0],
            K: { fx: 100, fy: 100, cx: 50, cy: 50 },
          },
        ],
      ]),
    })
    store.setMainSparse?.('sparse-1')
    store.clouds.push({
      id: 'mesh-1',
      name: 'Mesh',
      kind: 'mesh',
      createdAt: Date.now(),
      cameras: new Map(),
      count: 1,
      nVerts: 3,
      pos: new Float64Array([0, 0, 5, 1, 0, 5, 0, 1, 5]),
      idx: Uint32Array.of(0, 1, 2),
      col: null,
    })
    useModalsStore().toolModal = 'texture-mesh'
  })
  const dialog = page.getByRole('dialog', { name: 'Texture Mesh' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Texture', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useLog } = await import('/src/composables/useLog.js')
        return useLog().entries.value.some((e) =>
          /Texture: no registered photo is available/.test(e.message ?? e.msg ?? JSON.stringify(e)),
        )
      }),
    )
    .toBe(true)
  expect(errors).toEqual([])
})

// Mesh tools on a textured mesh, through the real worker: crop keeps the texture
// (faces regrouped by page), decimate drops it with a warning, sample to points takes
// the atlas colours.
test('mesh tools keep, drop or sample a texture', async ({ page }) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const res = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useLog } = await import('/src/composables/useLog.js')
    const store = useReconstructionStore()
    const jpeg = async (colour) => {
      const c = new OffscreenCanvas(16, 16),
        g = c.getContext('2d')
      g.fillStyle = colour
      g.fillRect(0, 0, 16, 16)
      return new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 1 })).arrayBuffer())
    }
    const a = await jpeg('#c81414'),
      b = await jpeg('#1414c8')
    const data = new Uint8Array(a.length + b.length)
    data.set(a)
    data.set(b, a.length)
    // A 2×1 strip: left half (x < 1) on page 0 (red), right half on page 1 (blue).
    store.clouds.push({
      id: 'tex',
      name: 'Strip',
      kind: 'mesh',
      createdAt: Date.now(),
      derived: true,
      cameras: new Map(),
      count: 4,
      nVerts: 8,
      pos: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0]),
      idx: Uint32Array.of(0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7),
      col: new Uint8Array(24).fill(90),
      uv: new Float32Array([0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9, 0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9]),
      texture: {
        data,
        pages: [
          { width: 16, height: 16, offset: 0, length: a.length, type: 'image/jpeg' },
          { width: 16, height: 16, offset: a.length, length: b.length, type: 'image/jpeg' },
        ],
        groups: [
          { page: 0, start: 0, count: 2 },
          { page: 1, start: 2, count: 2 },
        ],
      },
    })
    const crop = await store.editClouds({ mode: 'mesh-crop', sourceIds: ['tex'], settings: { min: [0.5, -1, -1] } })
    const dec = await store.editClouds({
      mode: 'mesh-decimate',
      sourceIds: ['tex'],
      settings: { targetTriangles: 2, preserveBoundary: false },
    })
    const pts = await store.editClouds({ mode: 'mesh-sample', sourceIds: ['tex'], settings: { count: 200, seed: 3 } })
    let red = 0,
      blue = 0,
      wrong = 0
    for (let i = 0; i < pts.count; i++) {
      const x = pts.pos[3 * i],
        r = pts.col[3 * i],
        bl = pts.col[3 * i + 2]
      if (x < 0.95) r > 150 && bl < 60 ? red++ : wrong++
      else if (x > 1.05) bl > 150 && r < 60 ? blue++ : wrong++
    }
    return {
      crop: { count: crop.count, groups: crop.texture?.groups, uv: crop.uv?.length },
      dec: { textured: !!dec.texture, count: dec.count },
      warned: useLog().entries.value.some((e) =>
        /no texture \(decimation/.test(e.message ?? e.msg ?? JSON.stringify(e)),
      ),
      sample: { red, blue, wrong },
    }
  })
  // The crop keeps the faces with all corners at x ≥ 0.5: the right half, on page 1.
  expect(res.crop.groups.reduce((n, g) => n + g.count, 0)).toBe(res.crop.count)
  expect(res.crop.uv).toBeGreaterThan(0)
  expect(res.dec).toEqual({ textured: false, count: 2 })
  expect(res.warned).toBe(true)
  expect(res.sample.wrong).toBe(0)
  expect(res.sample.red).toBeGreaterThan(20)
  expect(res.sample.blue).toBeGreaterThan(20)
  expect(errors).toEqual([])
})
