import { test, expect } from '@playwright/test'

// 3D-viewer rectangle/lasso selection (tool chosen in the ribbon's View ▸ Select,
// acted on from the floating toolbox) → Delete / Keep only through the cloud-edit
// worker path, against the real Viewer3D, store, worker and OPFS persistence.
test('rectangle and lasso selection edit a dense cloud non-destructively', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  // A flat 10×10 grid at unit spacing, imported as a dense reference cloud.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const pos = new Float64Array(300), col = new Uint8Array(300).fill(200)
    for (let i = 0; i < 100; i++) { pos[i * 3] = i % 10; pos[i * 3 + 1] = Math.floor(i / 10) }
    useReconstructionStore().importCloud({ count: 100, pos, col }, 'grid.ply')
  })
  const viewer = page.locator('.viewer')
  await expect.poll(() => viewer.evaluate(el => el.__vueParentComponent.setupState.cloudLayers.size)).toBe(1)
  await viewer.evaluate(el => el.__vueParentComponent.setupState.setView('top'))
  await page.waitForTimeout(300) // let the damped controls settle

  // Screen-space bbox of the grid points with x ≤ xMax, plus the point pitch in px.
  const pixelBox = (xMax) => viewer.evaluate((el, xMax) => {
    const s = el.__vueParentComponent.setupState
    const layer = [...s.cloudLayers.values()][0]
    const r = el.getBoundingClientRect()
    s.camera.updateMatrixWorld()
    const pts = []
    const src = layer.source.pos
    for (let i = 0; i < layer.source.count; i++) {
      if (src[i * 3] > xMax) continue
      const v = layer.object.localToWorld(new (s.camera.position.constructor)(
        src[i * 3] - layer.object.position.x, src[i * 3 + 1] - layer.object.position.y, 0)).project(s.camera)
      pts.push([r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height])
    }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) }
  }, xMax)

  const drag = async (box, pad, mods = []) => {
    for (const m of mods) await page.keyboard.down(m)
    await page.mouse.move(box.x0 - pad, box.y0 - pad)
    await page.mouse.down()
    await page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 4 })
    await page.mouse.move(box.x1 + pad, box.y1 + pad, { steps: 4 })
    await page.mouse.up()
    for (const m of mods) await page.keyboard.up(m)
  }

  // Columns x = 0..4 → 50 points. Pad well under half the pitch.
  const half = await pixelBox(4)
  const pad = Math.max(2, ((half.x1 - half.x0) / 4) * 0.3)
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await drag(half, pad)
  await expect(page.getByRole('toolbar', { name: 'Select points' })).toContainText('50 points selected')
  // Orbit is untouched by a selection drag (the camera did not move).
  await page.screenshot({ path: test.info().outputPath('selection.png') })

  // Alt-drag subtracts column x = 0 (10 points).
  await drag(await pixelBox(0), pad, ['Alt'])
  await expect(page.getByRole('toolbar', { name: 'Select points' })).toContainText('40 points selected')

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const clouds = () => page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().clouds.map(c => ({ id: c.id, name: c.name, count: c.count,
      derived: !!c.derived, visible: c.visible !== false }))
  })
  await expect.poll(async () => (await clouds()).length).toBe(2)
  let list = await clouds()
  expect(list[0]).toMatchObject({ count: 100, derived: false, visible: false })
  expect(list[1]).toMatchObject({ count: 60, derived: true, visible: true })
  expect(list[1].name).toMatch(/\(edited\)$/)
  const editedId = list[1].id

  // Lasso on the edited copy: keep only the row y = 0 (6 survivors: x = 0, 5..9).
  await page.getByRole('button', { name: 'Lasso', exact: true }).click()
  await expect.poll(() => viewer.evaluate(el => el.__vueParentComponent.setupState.cloudLayers.size)).toBe(1)
  await viewer.evaluate(el => el.__vueParentComponent.setupState.setView('top'))
  await page.waitForTimeout(300)
  const row = await viewer.evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    const layer = [...s.cloudLayers.values()][0]
    const r = el.getBoundingClientRect()
    const P = s.camera.position.constructor
    const at = (x, y) => {
      const v = layer.object.localToWorld(new P(x - layer.object.position.x, y - layer.object.position.y, 0)).project(s.camera)
      return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]
    }
    return [at(-0.4, -0.4), at(9.4, -0.4), at(9.4, 0.4), at(-0.4, 0.4)]
  })
  await page.mouse.move(...row[0])
  await page.mouse.down()
  for (const p of [row[1], row[2], row[3], row[0]]) await page.mouse.move(...p, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByRole('toolbar', { name: 'Select points' })).toContainText('6 points selected')
  await page.getByRole('button', { name: 'Keep only', exact: true }).click()
  await expect.poll(async () => (await clouds()).find(c => c.id === editedId)?.count).toBe(6)
  list = await clouds()
  expect(list).toHaveLength(2) // refined in place, no third copy

  await page.keyboard.press('Escape')
  await expect(page.getByRole('toolbar', { name: 'Select points' })).toHaveCount(0)

  await page.evaluate(async () => (await import('/src/utils/persistence.js')).flushPersistence())
  await page.reload()
  await page.locator('.project-main').filter({ hasText: 'My Project' }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(async () => (await clouds()).map(c => [c.count, c.derived, c.visible]))
    .toEqual([[100, false, false], [6, true, true]])
  expect(errors).toEqual([])
})
