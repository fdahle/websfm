import { test, expect } from './fixtures.js'

// Streamed import (dev/planning/plan-lod.md ▸ L4, L5): a LAS too large to hold in
// memory goes straight from the file into a level-of-detail octree; the cloud has no
// resident points, is drawn through the octree, and tools read it from there (a DTM,
// a crop into a resident cloud, an export). It survives a reload.

test('a streamed LAS import is drawn, gridded, cropped and exported from its octree, and survives a reload', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  const imported = await page.evaluate(async () => {
    const { cloudToLasParts } = await import('/src/core/io/las.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const n = 300_000
    const pos = new Float64Array(3 * n),
      col = new Uint8Array(3 * n),
      classification = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const x = (i % 600) * 0.5,
        y = Math.floor(i / 600) * 0.5
      pos[3 * i] = 480000 + x
      pos[3 * i + 1] = 5200000 + y
      pos[3 * i + 2] = 100 + Math.sin(x / 20) * 3
      col[3 * i] = 50 + ((x / 2) | 0)
      col[3 * i + 1] = 120
      col[3 * i + 2] = 200
      classification[i] = x > 150 ? 6 : 2
    }
    const parts = [...cloudToLasParts({ count: n, pos, col, attributes: { classification } })]
    const file = new File(parts, 'survey.las')
    const store = useReconstructionStore()
    const labels = new Set()
    const cloud = await store.importStreamedCloud(file, (d, t, label) => labels.add(label))
    return {
      count: cloud.count,
      pos: cloud.pos,
      lod: !!cloud.lod,
      attributes: cloud.lod.layout.attributes.map((a) => a.name),
      labels: [...labels],
    }
  })
  expect(imported).toEqual({
    count: 300_000,
    pos: null,
    lod: true,
    attributes: ['intensity', 'classification', 'returnNumber', 'numberOfReturns'],
    labels: ['Sorting points into chunks', 'Building the octree'],
  })
  await page.locator('.section-name', { hasText: 'Reference Data' }).click()
  await expect(page.locator('.imported-badge', { hasText: 'streamed' })).toHaveCount(1)

  const viewer = page.locator('.viewer')
  const layer = () =>
    viewer.evaluate((el) => {
      const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
      return l ? { lod: !!l.lod, ready: l.ready, visible: l.visiblePoints } : null
    })
  await expect.poll(async () => (await layer())?.visible ?? 0, { timeout: 30_000 }).toBeGreaterThan(1000)

  // Tools that need resident points read it from its octree: a DTM of its ground
  // class, a crop into a new resident cloud, an export written node by node.
  const tools = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { DEM_DEFAULTS } = await import('/src/core/defaults.user.js')
    const store = useReconstructionStore()
    const c = store.clouds[0]
    const ground = store.groundSource?.cloud?.id === c.id
    await store.generateDem({ ...DEM_DEFAULTS, points: 'ground', gsd: 2, extent: 'all' })
    const dem = store.dem && { width: store.dem.width, height: store.dem.height, points: store.dem.points }
    const crop = await store.editClouds({
      mode: 'crop',
      sourceIds: [c.id],
      settings: { min: [480000, 5200000, null], max: [480100, 5200050, null] },
      name: 'corner',
    })
    const { blob } = await store.exportCloudLod(c, { format: 'las' })
    const head = new DataView(await blob.slice(0, 375).arrayBuffer())
    return {
      ground,
      dem,
      crop: crop && { count: crop.count, resident: !!crop.pos, cls: crop.attributes.classification.length },
      las: { count: head.getUint32(107, true), size: blob.size, scale: head.getFloat64(131, true) },
    }
  })
  expect(tools.ground).toBe(true)
  // Ground (x ≤ 150) is half the 300 m width, the cloud 250 m deep: a 2 m grid ~76 × 126 cells.
  expect(tools.dem.points).toBe('ground')
  expect(tools.dem.width).toBeGreaterThan(70)
  expect(tools.dem.width).toBeLessThan(85)
  expect(tools.dem.height).toBeGreaterThan(120)
  expect(tools.dem.height).toBeLessThan(130)
  // 100 m × 50 m at 0.5 m spacing: 201 × 101 points, all of them (well inside the budget).
  expect(tools.crop).toEqual({ count: 201 * 101, resident: true, cls: 201 * 101 })
  expect(tools.las.count).toBe(300_000)
  expect(tools.las.size).toBeGreaterThan(300_000 * 26)

  // Classification styling from the octree's own statistics.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    store.setCloudStyle(store.clouds[0].id, { field: 'attribute:classification' })
  })
  await expect
    .poll(() =>
      viewer.evaluate((el) => {
        const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
        return l.legend?.entries?.map((e) => [e.value, e.count])
      }),
    )
    .toEqual([
      [2, 150_500],
      [6, 149_500],
    ])

  await page.reload()
  await page.locator('.project-main').filter({ hasText: 'My Project' }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.locator('.tab').filter({ hasText: /^3D$/ }).click()
  await expect.poll(async () => (await layer())?.visible ?? 0, { timeout: 30_000 }).toBeGreaterThan(1000)
  const restored = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const c = useReconstructionStore().clouds[0]
    return { count: c.count, pos: c.pos, nodes: c.lod.nodeCount > 0, style: c.style?.field }
  })
  expect(restored).toEqual({ count: 300_000, pos: null, nodes: true, style: 'attribute:classification' })
  expect(errors).toEqual([])
})
