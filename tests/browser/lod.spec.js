import { test, expect } from '@playwright/test'

// Level-of-detail octree (dev/planning/plan-lod.md ▸ L2): built in the compute worker
// into the project's lod/ folder through OPFS chunk files, read back node by node,
// and kept with the cloud across a reload.

test('a dense cloud builds its octree in the worker, and it survives a reload', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  // 1.2 M points of terrain in projected coordinates; colour encodes the index.
  const built = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    const n = 1_200_000
    let s = 3
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
    const pos = new Float64Array(3 * n), col = new Uint8Array(3 * n), cls = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const x = rnd() * 800, y = rnd() * 600
      pos[3 * i] = 500000 + x; pos[3 * i + 1] = 5600000 + y; pos[3 * i + 2] = 40 + 4 * Math.sin(x / 30) + rnd() * 0.1
      col[3 * i] = i & 255; col[3 * i + 1] = (i >> 8) & 255; col[3 * i + 2] = (i >> 16) & 255
      cls[i] = 2 + (i % 2)
    }
    store.importCloud({ count: n, pos, col, attributes: { classification: cls } }, 'terrain.las')
    const cloud = store.clouds.at(-1)
    const labels = new Set()
    const meta = await store.buildCloudLod(cloud.id, (d, t, label) => labels.add(label))
    return { meta, labels: [...labels] }
  })
  expect(built.meta.points).toBe(1_200_000)
  expect(built.meta.nodeCount).toBeGreaterThan(8)
  expect(built.labels).toEqual(['Sorting points into chunks', 'Building the octree'])

  const check = () => page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    const cloud = store.clouds.find((c) => c.lod)
    const reader = await store.openCloudLod(cloud)
    const seen = new Uint8Array(cloud.count)
    let worst = 0, wrongClass = 0, rootCount = reader.root.count
    for (const node of reader.nodes.values()) {
      const pts = await reader.read(node, { as: 'absolute' })
      for (let k = 0; k < pts.count; k++) {
        const i = pts.col[3 * k] | pts.col[3 * k + 1] << 8 | pts.col[3 * k + 2] << 16
        seen[i]++
        for (let a = 0; a < 3; a++) worst = Math.max(worst, Math.abs(pts.pos[3 * k + a] - cloud.pos[3 * i + a]))
        if (pts.attributes.classification[k] !== cloud.attributes.classification[i]) wrongClass++
      }
    }
    return { once: seen.every((v) => v === 1), worst, wrongClass, rootCount }
  })
  const first = await check()
  expect(first.once).toBe(true)
  expect(first.wrongClass).toBe(0)
  expect(first.worst).toBeLessThan(1e-4)
  expect(first.rootCount).toBeGreaterThan(1000)

  await page.reload()
  await page.locator('.project-main').filter({ hasText: 'My Project' }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().clouds.filter((c) => c.lod).length
  })).toBe(1)
  expect(await check()).toEqual(first)
  expect(errors).toEqual([])
})
