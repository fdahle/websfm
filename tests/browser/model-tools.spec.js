import { test, expect } from '@playwright/test'

// Tools ▸ Model ▾ (Region, Orient model) and Point Cloud ▾ ▸ Align by point pairs:
// tools whose interaction lives in a floating toolbox over the 3D view, driven by
// real clicks (point picking) against the full application.

async function createProject(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
}

const store = (page, fn) => page.evaluate(async (src) => {
  const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
  return new Function('s', `return (${src})(s)`)(useReconstructionStore())
}, fn.toString())

async function openTool(page, menu, row) {
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: menu }).click()
  await page.getByRole('menuitem', { name: row }).click()
}

test('Region and Orient model store frame data from their toolboxes', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  // A small sparse model: 3 cameras looking down at 200 points.
  await store(page, async (s) => {
    const R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]], K = { fx: 500, fy: 500, cx: 250, cy: 250 }
    const cameras = new Map([0, 1, 2].map((i) => [`cam${i}`, { R, t: [-i, 0, 10], K }]))
    const points = Array.from({ length: 200 }, (_, i) => ({ x: (i % 20) / 2, y: Math.floor(i / 20) / 2, z: (i % 7) / 10,
      color: [200, 200, 200], views: new Map(), viewsPx: new Map() }))
    const { SparsePoints } = await import('/src/core/sfm/sparsePoints.js')
    s.clouds.push({ id: 'sparse-1', name: 'Sparse cloud', kind: 'sparse', createdAt: 42, cameras, points: SparsePoints.fromRecords(points) })
    s.mainSparseId = 'sparse-1'
  })

  await openTool(page, 'Model', /^Region/)
  const region = page.getByRole('toolbar', { name: 'Region' })
  await expect(region).toBeVisible()
  await region.getByRole('button', { name: 'Fit to sparse', exact: true }).click()
  await region.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(region).toHaveCount(0)
  const saved = await store(page, (s) => ({ region: s.region, active: s.regionState.active }))
  expect(saved.active).toBe(true)
  expect(saved.region.max[0]).toBeGreaterThan(saved.region.min[0])

  await openTool(page, 'Model', /^Orient model/)
  const orient = page.getByRole('toolbar', { name: 'Orient model' })
  await orient.getByRole('spinbutton', { name: 'Heading in degrees' }).fill('30')
  await orient.getByRole('spinbutton', { name: 'Heading in degrees' }).press('Tab')
  await orient.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(orient).toHaveCount(0)
  const frame = await store(page, async (s) => (await s.effectiveFrameSpec()).frameSpec)
  expect(frame.kind).toBe('local')
  expect(frame.source).toBe('orientation')
  expect(Math.hypot(...frame.east)).toBeCloseTo(1, 9)
  expect(errors).toEqual([])
})

test('Align by point pairs moves a cloud onto its reference from three picked pairs', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  // Grid A, and grid B = A shifted by (+15, +3, +1). Distinct z per column/row so
  // a pick lands on a well-defined point.
  await store(page, (s) => {
    const N = 10
    const make = (dx, dy, dz) => {
      const pos = new Float64Array(N * N * 3)
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 3
        pos[k] = i + dx; pos[k + 1] = j + dy; pos[k + 2] = 0.1 * i + 0.05 * j + dz
      }
      return { count: N * N, pos, col: new Uint8Array(N * N * 3).fill(200) }
    }
    s.importCloud(make(0, 0, 0), 'a.ply')
    s.importCloud(make(15, 3, 1), 'b.ply')
  })
  const viewer = page.locator('.viewer')
  await expect.poll(() => viewer.evaluate((el) => el.__vueParentComponent.setupState.cloudLayers.size)).toBe(2)
  await viewer.evaluate((el) => el.__vueParentComponent.setupState.setView('top'))
  await page.waitForTimeout(300)
  const screenOf = (cloudName, x, y, z) => viewer.evaluate((el, [cloudName, x, y, z]) => {
    const s = el.__vueParentComponent.setupState
    const layer = [...s.cloudLayers.values()].find((l) => l.source.name.includes(cloudName))
    const r = el.getBoundingClientRect()
    s.camera.updateMatrixWorld()
    const P = s.camera.position.constructor
    const v = layer.object.localToWorld(new P(x - layer.object.position.x, y - layer.object.position.y, z - layer.object.position.z)).project(s.camera)
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]
  }, [cloudName, x, y, z])

  await openTool(page, /Point\s*Cloud/, /Align by point pairs/)
  const box = page.getByRole('toolbar', { name: 'Align by point pairs' })
  await expect(box).toBeVisible()
  await box.getByRole('combobox').first().selectOption({ label: 'Imported (a.ply)' })
  await box.getByRole('combobox').nth(1).selectOption({ label: 'Imported (b.ply)' })
  for (const [i, j] of [[1, 1], [8, 2], [3, 8]]) {
    const za = 0.1 * i + 0.05 * j
    await page.mouse.click(...await screenOf('a.ply', i, j, za))
    await page.mouse.click(...await screenOf('b.ply', i + 15, j + 3, za + 1))
  }
  await expect(box.getByText(/RMS/)).toBeVisible()
  await box.getByRole('button', { name: 'Apply', exact: true }).click()
  // The transform runs in the worker; wait for the derived cloud to land.
  const alignedFirst = () => store(page, (s) => {
    const c = s.clouds.find((x) => x.name.endsWith('(aligned)'))
    return c ? [...c.pos.subarray(0, 3)] : null
  })
  await expect.poll(alignedFirst).not.toBeNull()
  const aligned = await alignedFirst()
  expect(aligned[0]).toBeCloseTo(15, 3)
  expect(aligned[1]).toBeCloseTo(3, 3)
  expect(aligned[2]).toBeCloseTo(1, 3)
  expect(errors).toEqual([])
})

test('Region box handles drag a face and the whole box in the 3D view', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)
  await store(page, (s) => {
    const R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]], K = { fx: 500, fy: 500, cx: 250, cy: 250 }
    const cameras = new Map([0, 1, 2].map((i) => [`cam${i}`, { R, t: [-i, 0, 10], K }]))
    const points = Array.from({ length: 200 }, (_, i) => ({ x: (i % 20) / 2, y: Math.floor(i / 20) / 2, z: (i % 7) / 10,
      color: [200, 200, 200], views: new Map(), viewsPx: new Map() }))
    s.clouds.push({ id: 'sparse-1', name: 'Sparse cloud', kind: 'sparse', createdAt: 42, cameras, points })
    s.mainSparseId = 'sparse-1'
  })
  const viewer = page.locator('.viewer')
  await openTool(page, 'Model', /^Region/)
  const region = page.getByRole('toolbar', { name: 'Region' })
  await expect(region).toBeVisible()
  await viewer.evaluate((el) => el.__vueParentComponent.setupState.setView('top'))
  await page.waitForTimeout(300)
  const draft = () => viewer.evaluate((el) => {
    const b = el.__vueParentComponent.props.regionBox
    return { min: [...b.min], max: [...b.max] }
  })
  // Model point → page pixels (the box is drawn in model coordinates).
  const screenOf = (p) => viewer.evaluate((el, p) => {
    const s = el.__vueParentComponent.setupState
    const r = el.getBoundingClientRect()
    s.camera.updateMatrixWorld()
    const v = new s.camera.position.constructor(...p).project(s.camera)
    return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]
  }, p)
  const drag = async (from, to) => {
    await page.mouse.move(...from)
    await page.mouse.down()
    await page.mouse.move(...to, { steps: 8 })
    await page.mouse.up()
  }

  // The X max face: dragged 2 units along +x, the rest of the box stays.
  const b0 = await draft()
  const c0 = [0, 1, 2].map((k) => (b0.min[k] + b0.max[k]) / 2)
  await drag(await screenOf([b0.max[0], c0[1], c0[2]]), await screenOf([b0.max[0] + 2, c0[1], c0[2]]))
  const b1 = await draft()
  expect(b1.max[0]).toBeCloseTo(b0.max[0] + 2, 1)
  expect(b1.min).toEqual(b0.min)
  expect(b1.max.slice(1)).toEqual(b0.max.slice(1))
  // The number fields follow the drag.
  await expect(region.getByRole('spinbutton', { name: 'X max' })).toHaveValue(String(Number(b1.max[0].toPrecision(6))))

  // The centre handle moves the whole box in the plane facing the camera: the centre
  // lands under the pointer, the size stays.
  const c1 = [0, 1, 2].map((k) => (b1.min[k] + b1.max[k]) / 2)
  const from = await screenOf(c1), to = [from[0] - 60, from[1] + 40]
  await drag(from, to)
  const b2 = await draft()
  const c2 = [0, 1, 2].map((k) => (b2.min[k] + b2.max[k]) / 2)
  const landed = await screenOf(c2)
  expect(Math.hypot(landed[0] - to[0], landed[1] - to[1])).toBeLessThan(2)
  const forward = await viewer.evaluate((el) => {
    const f = el.__vueParentComponent.setupState.camera.getWorldDirection(new (el.__vueParentComponent.setupState.camera.position.constructor)())
    return [f.x, f.y, f.z]
  })
  const moved = c2.map((v, k) => v - c1[k])
  expect(Math.hypot(...moved)).toBeGreaterThan(0.5)
  expect(Math.abs(moved[0] * forward[0] + moved[1] * forward[1] + moved[2] * forward[2])).toBeLessThan(1e-6)
  for (let k = 0; k < 3; k++) expect(b2.max[k] - b2.min[k]).toBeCloseTo(b1.max[k] - b1.min[k], 6)

  // A drag away from the handles orbits instead, and leaves the box alone.
  const r = await viewer.boundingBox()
  await drag([r.x + 30, r.y + r.height - 30], [r.x + 90, r.y + r.height - 60])
  expect(await draft()).toEqual(b2)

  // Nothing is stored until Apply.
  expect(await store(page, (s) => s.region)).toBeNull()
  await region.getByRole('button', { name: 'Apply', exact: true }).click()
  const saved = await store(page, (s) => ({ min: [...s.region.min], max: [...s.region.max] }))
  expect(saved.max[0]).toBeCloseTo(b2.max[0], 9)
  expect(errors).toEqual([])
})
