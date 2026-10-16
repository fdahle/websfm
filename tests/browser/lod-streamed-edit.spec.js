import { test, expect } from '@playwright/test'

// Editing a streamed cloud (dev/planning/plan-lod.md ▸ L5, core/lod/transform.js): a
// selection drawn on its octree layer, a filter and the ground filter all write a NEW
// streamed cloud, node by node or tile by tile; LAZ export streams the encoder.

test('a streamed cloud is selected, filtered, classified and exported without being loaded', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  // 400 m × 250 m at 0.5 m, a 10 m box building, a few floating points.
  await page.evaluate(async () => {
    const { cloudToLasParts } = await import('/src/core/io/las.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const xs = [], cls = []
    for (let x = 0; x < 400; x += 0.5) for (let y = 0; y < 250; y += 0.5) {
      const b = x > 150 && x < 190 && y > 80 && y < 120
      xs.push(470000 + x, 5100000 + y, 200 + Math.sin(x / 60) * 2 + (b ? 10 : 0)); cls.push(1)
    }
    for (let k = 0; k < 50; k++) { xs.push(470000 + k * 7, 5100000 + 125, 260 + k % 5); cls.push(1) }
    const n = cls.length
    const parts = [...cloudToLasParts({ count: n, pos: Float64Array.from(xs), attributes: { classification: Uint8Array.from(cls) } })]
    await useReconstructionStore().importStreamedCloud(new File(parts, 'site.las'))
  })
  const store = (fn, arg) => page.evaluate(async ([src, a]) => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    // eslint-disable-next-line no-new-func
    return new Function('store', 'arg', `return (${src})(store, arg)`)(useReconstructionStore(), a)
  }, [fn.toString(), arg])
  const total = await store((s) => s.clouds[0].count)
  expect(total).toBe(800 * 500 + 50)

  // Select the left half from the top view and delete it: every point under the
  // shape goes, not only the ones drawn.
  const viewer = page.locator('.viewer')
  await expect.poll(() => viewer.evaluate((el) => [...el.__vueParentComponent.setupState.cloudLayers.values()][0]?.visiblePoints ?? 0)).toBeGreaterThan(1000)
  const drawn = await viewer.evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    s.setView('top')
    s.controls.update()
    s.toggleSelectTool('rect')
    s.applySelectionShape({ kind: 'rect', x0: -2, y0: -2, x1: 0, y1: 2 }, 'replace')
    return s.selectionCount
  })
  expect(drawn).toBeGreaterThan(0)
  await viewer.evaluate((el) => el.__vueParentComponent.setupState.commitSelection(false))
  await expect.poll(() => store((s) => s.clouds.length), { timeout: 60_000 }).toBe(2)
  const afterDelete = await store((s) => { const c = s.clouds[1]; return { count: c.count, streamed: !c.pos, derived: !!c.derived } })
  expect(afterDelete.streamed).toBe(true)
  expect(afterDelete.count).toBeLessThan(total * 0.7)
  expect(afterDelete.count).toBeGreaterThan(total * 0.3)
  await viewer.evaluate((el) => el.__vueParentComponent.setupState.toggleSelectTool('rect'))

  // Outlier filter, ground filter and an inverted crop, each into a new streamed cloud.
  const results = await store(async (s, total) => {
    const src = s.clouds[0]
    const { GROUND_DEFAULTS } = await import('/src/core/defaults.user.js')
    const filtered = await s.editClouds({ mode: 'filter', sourceIds: [src.id], settings: { methods: ['sor'], sor: { k: 12, stdRatio: 2 } } })
    const ground = await s.editClouds({ mode: 'classify-ground', sourceIds: [src.id], settings: { ...GROUND_DEFAULTS, frame: null, metresPerUnit: 1 } })
    const outside = await s.editClouds({ mode: 'crop', sourceIds: [src.id], settings: { min: [470000, null, null], max: [470100, null, null], invert: true } })
    const classes = ground.lod.stats.classes
    const { blob } = await s.exportCloudLod(src, { format: 'laz' })
    const head = new Uint8Array(await blob.slice(0, 120).arrayBuffer())
    return {
      filtered: { count: filtered.count, streamed: !filtered.pos },
      ground: { count: ground.count, groundShare: (classes[2] ?? 0) / ground.count, roof: classes[1] ?? 0, style: ground.style?.field },
      outside: outside.count, total,
      laz: { signature: String.fromCharCode(...head.subarray(0, 4)), compressed: (head[104] & 0x80) !== 0, count: new DataView(head.buffer).getUint32(107, true), size: blob.size },
    }
  }, total)
  expect(results.filtered.streamed).toBe(true)
  expect(total - results.filtered.count).toBeGreaterThanOrEqual(40) // the floating points
  expect(total - results.filtered.count).toBeLessThan(2000)
  expect(results.ground.count).toBe(total)
  expect(results.ground.style).toBe('attribute:classification')
  expect(results.ground.groundShare).toBeGreaterThan(0.95)
  expect(results.ground.roof).toBeGreaterThan(5000) // the building's roof is not ground
  expect(results.outside).toBe(total - 201 * 500 - 15) // x 0…100 m (201 columns) and the floaters there
  expect(results.laz).toEqual({ signature: 'LASF', compressed: true, count: total, size: expect.any(Number) })
  expect(results.laz.size).toBeLessThan(total * 26 / 2)
  expect(errors).toEqual([])
})
