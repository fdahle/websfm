import { test, expect } from '@playwright/test'

// Level-of-detail viewing (dev/planning/plan-lod.md ▸ L3): a dense cloud past the
// threshold gets its octree in the background and is then drawn through it, within
// the point budget, refining as the camera comes closer.

test('a big dense cloud is drawn through its octree within the point budget', async ({ page }) => {
  test.setTimeout(180_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('viewer3dPointBudget', '1'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const n = 4_500_000
    let s = 11
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
    const pos = new Float64Array(3 * n),
      col = new Uint8Array(3 * n),
      cls = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const x = rnd() * 1000,
        y = rnd() * 1000
      pos[3 * i] = 300000 + x
      pos[3 * i + 1] = 6100000 + y
      pos[3 * i + 2] = 10 * Math.sin(x / 90) * Math.cos(y / 120) + rnd() * 0.2
      col[3 * i] = 60 + ((x / 4) | 0)
      col[3 * i + 1] = 60 + ((y / 4) | 0)
      col[3 * i + 2] = 90
      cls[i] = x > 500 ? 6 : 2
    }
    useReconstructionStore().importCloud({ count: n, pos, col, attributes: { classification: cls } }, 'big.las')
  })
  const viewer = page.locator('.viewer')
  const state = () =>
    viewer.evaluate((el) => {
      const s = el.__vueParentComponent.setupState
      const l = [...s.cloudLayers.values()][0]
      if (!l?.lod) return { lod: false }
      let nodes = 0
      for (const o of l.object.children) if (o.visible) nodes++
      return {
        lod: true,
        ready: l.ready,
        visible: l.visiblePoints,
        loaded: l.loadedPoints,
        nodes,
        legend: l.legend?.field,
      }
    })
  // The octree builds in the background, then the layer swaps to it.
  await expect.poll(async () => (await state()).lod, { timeout: 120_000 }).toBe(true)
  // Seen whole, the coarse levels already reach about a pixel's spacing.
  await expect.poll(async () => (await state()).nodes, { timeout: 30_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(1000)
  const far = await state()
  expect(far.visible).toBeGreaterThan(10_000)
  expect(far.visible).toBeLessThanOrEqual(1_000_000)
  await page.screenshot({ path: test.info().outputPath('lod-far.png') })
  expect(far.legend).toBe('rgb')

  // Close in on a corner: deeper nodes there, still within the budget.
  const deepestVisible = () =>
    viewer.evaluate((el) => {
      const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
      let deepest = 0
      for (const o of l.object.children) if (o.visible) deepest = Math.max(deepest, o.userData.level ?? 0)
      return deepest
    })
  const before = await deepestVisible()
  await viewer.evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    const target = s.controls.target.clone()
    target.x -= 400
    target.y -= 400
    s.controls.target.copy(target)
    s.camera.position.copy(target).add({ x: 0, y: -20, z: 30 })
    s.controls.update()
    s.requestRender()
  })
  await expect.poll(deepestVisible, { timeout: 30_000 }).toBeGreaterThan(before + 1)
  await page.waitForTimeout(1500)
  const near = await state()
  expect(near.visible).toBeGreaterThan(far.visible)
  expect(near.visible).toBeLessThanOrEqual(1_000_000)
  await page.screenshot({ path: test.info().outputPath('lod-near.png') })

  // Restyle by classification: the legend comes from the whole cloud's class counts.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const c = useReconstructionStore().clouds[0]
    c.style = { field: 'attribute:classification' }
  })
  await expect
    .poll(() =>
      viewer.evaluate((el) => {
        const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
        return l.legend?.entries?.map((e) => [e.value, e.count])
      }),
    )
    .toEqual([
      [2, expect.any(Number)],
      [6, expect.any(Number)],
    ])
  await page.screenshot({ path: test.info().outputPath('lod.png') })

  // Selecting needs every point: the resident cloud is drawn whole while a tool is on.
  const isLod = () =>
    viewer.evaluate((el) => [...el.__vueParentComponent.setupState.cloudLayers.values()][0].lod === true)
  await viewer.evaluate((el) => el.__vueParentComponent.setupState.toggleSelectTool('rect'))
  await expect.poll(isLod).toBe(false)
  await viewer.evaluate((el) => el.__vueParentComponent.setupState.toggleSelectTool('rect'))
  await expect.poll(isLod).toBe(true)
  expect(errors).toEqual([])
})
