import { test, expect } from '@playwright/test'

// Streamed import (dev/planning/plan-lod.md ▸ L4): a LAS too large to hold in memory
// goes straight from the file into a level-of-detail octree; the cloud has no
// resident points, is drawn through the octree, is left out by tools that need its
// points, and survives a reload.

test('a streamed LAS import is drawn, refused by point tools, and survives a reload', async ({ page }) => {
  test.setTimeout(180_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  const imported = await page.evaluate(async () => {
    const { cloudToLasParts } = await import('/src/core/io/las.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const n = 300_000
    const pos = new Float64Array(3 * n), col = new Uint8Array(3 * n), classification = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const x = (i % 600) * 0.5, y = Math.floor(i / 600) * 0.5
      pos[3 * i] = 480000 + x; pos[3 * i + 1] = 5200000 + y; pos[3 * i + 2] = 100 + Math.sin(x / 20) * 3
      col[3 * i] = 50 + (x / 2 | 0); col[3 * i + 1] = 120; col[3 * i + 2] = 200
      classification[i] = x > 150 ? 6 : 2
    }
    const parts = [...cloudToLasParts({ count: n, pos, col, attributes: { classification } })]
    const file = new File(parts, 'survey.las')
    const store = useReconstructionStore()
    const labels = new Set()
    const cloud = await store.importStreamedCloud(file, (d, t, label) => labels.add(label))
    return { count: cloud.count, pos: cloud.pos, lod: !!cloud.lod, attributes: cloud.lod.layout.attributes.map((a) => a.name), labels: [...labels] }
  })
  expect(imported).toEqual({ count: 300_000, pos: null, lod: true,
    attributes: ['intensity', 'classification', 'returnNumber', 'numberOfReturns'],
    labels: ['Sorting points into chunks', 'Building the octree'] })
  await page.locator('.section-name', { hasText: 'Reference Data' }).click()
  await expect(page.locator('.imported-badge', { hasText: 'streamed' })).toHaveCount(1)

  const viewer = page.locator('.viewer')
  const layer = () => viewer.evaluate((el) => {
    const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
    return l ? { lod: !!l.lod, ready: l.ready, visible: l.visiblePoints } : null
  })
  await expect.poll(async () => (await layer())?.visible ?? 0, { timeout: 30_000 }).toBeGreaterThan(1000)

  // Tools that need resident points leave it out or refuse it.
  const tools = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    const c = store.clouds[0]
    const edit = await store.editClouds({ mode: 'crop', sourceIds: [c.id], settings: {} })
    return { edit, dem: store.demSource?.kind ?? null }
  })
  expect(tools.edit).toBe(null)
  expect(tools.dem).toBe(null)

  // Classification styling from the octree's own statistics.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    store.setCloudStyle(store.clouds[0].id, { field: 'attribute:classification' })
  })
  await expect.poll(() => viewer.evaluate((el) => {
    const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
    return l.legend?.entries?.map((e) => [e.value, e.count])
  })).toEqual([[2, 150_500], [6, 149_500]])

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
