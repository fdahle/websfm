import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// The 3D view's camera keys (7 top, 1 front, 3 right, 9 the opposite, 0 overview),
// a double-click that orbits about the point under the pointer, and View ▸ Camera ▸
// Save Image. Five points far apart, so a click finds only the one under it.
async function setup(page) {
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.locator('.viewer').evaluate((el) => {
    el.__vueParentComponent.setupState.setCloudLayers([
      {
        id: 'five',
        name: 'Five points',
        kind: 'dense',
        count: 5,
        cameras: new Map(),
        pos: new Float64Array([0, 0, 0, 10, 0, 0, -10, 0, 0, 0, 10, 0, 0, -10, 1]),
        col: new Uint8Array(15).fill(200),
      },
    ])
  })
}

// The camera's view direction against the scene's up (1 looking down, −1 up, 0 level).
const lookDownness = (page) =>
  page.locator('.viewer').evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    const d = s.controls.target.clone().sub(s.camera.position).normalize()
    return -d.dot(s.upAxis.clone().normalize())
  })

test('number keys pick the camera presets', async ({ page }) => {
  await setup(page)
  await page.keyboard.press('7')
  await expect.poll(() => lookDownness(page)).toBeCloseTo(1, 3)
  await page.keyboard.press('9')
  await expect.poll(() => lookDownness(page)).toBeCloseTo(-1, 3)
  await page.keyboard.press('1')
  await expect.poll(() => lookDownness(page)).toBeCloseTo(0, 3)
  await page.keyboard.press('0')
  const oblique = await lookDownness(page)
  expect(oblique).toBeGreaterThan(0.1)
  expect(oblique).toBeLessThan(0.95)
})

test('a double-click orbits about the point under the pointer', async ({ page }) => {
  await setup(page)
  // Where the point (10, 0, 0) is on screen now.
  const at = await page.locator('.viewer').evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    s.camera.updateMatrixWorld()
    const p = s.upAxis.clone().set(10, 0, 0).project(s.camera)
    return { x: ((p.x + 1) / 2) * el.clientWidth, y: ((1 - p.y) / 2) * el.clientHeight }
  })
  await page.locator('.viewer').dblclick({ position: at })
  await expect
    .poll(() => page.locator('.viewer').evaluate((el) => el.__vueParentComponent.setupState.controls.target.toArray()))
    .toEqual([10, 0, 0])
})

test('Save Image downloads the view as a PNG', async ({ page }) => {
  await setup(page)
  await page.getByRole('button', { name: 'View', exact: true }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTitle('Save the 3D view as a PNG image, as it is on screen').click(),
  ])
  expect(download.suggestedFilename()).toBe('My_Project-3d-view.png')
  const bytes = readFileSync(await download.path())
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect(bytes.length).toBeGreaterThan(1000)
})

test('5 switches to the orthographic view, where picking and the presets still work', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await setup(page)
  const kind = () => page.locator('.viewer').evaluate((el) => el.__vueParentComponent.setupState.camera.type)
  await page.keyboard.press('5')
  await expect.poll(kind).toBe('OrthographicCamera')
  await page.getByRole('button', { name: 'View', exact: true }).click()
  await expect(page.locator('.ribbon .cmd.active', { hasText: 'Ortho' })).toHaveCount(1)

  // From the top, every point is in the frame.
  await page.keyboard.press('7')
  const onScreen = await page.locator('.viewer').evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    s.camera.updateMatrixWorld()
    const pts = [
      [0, 0, 0],
      [10, 0, 0],
      [-10, 0, 0],
      [0, 10, 0],
      [0, -10, 1],
    ]
    return pts.every(([x, y, z]) => {
      const p = s.upAxis.clone().set(x, y, z).project(s.camera)
      return Math.abs(p.x) < 1 && Math.abs(p.y) < 1
    })
  })
  expect(onScreen).toBe(true)

  // A selection over the whole view takes all five points.
  const selected = await page.locator('.viewer').evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    s.toggleSelectTool('rect')
    s.applySelectionShape({ kind: 'rect', x0: -1, y0: -1, x1: 1, y1: 1 }, 'replace')
    const n = s.selectionCount
    s.exitSelection()
    return n
  })
  expect(selected).toBe(5)

  // A double-click still finds the point under the pointer.
  const at = await page.locator('.viewer').evaluate((el) => {
    const s = el.__vueParentComponent.setupState
    s.camera.updateMatrixWorld()
    const p = s.upAxis.clone().set(0, 10, 0).project(s.camera)
    return { x: ((p.x + 1) / 2) * el.clientWidth, y: ((1 - p.y) / 2) * el.clientHeight }
  })
  await page.locator('.viewer').dblclick({ position: at })
  await expect
    .poll(() => page.locator('.viewer').evaluate((el) => el.__vueParentComponent.setupState.controls.target.toArray()))
    .toEqual([0, 10, 0])

  await page.keyboard.press('5')
  await expect.poll(kind).toBe('PerspectiveCamera')
  expect(errors).toEqual([])
})

test('a saved view brings the camera back, orthographic or not, and stays with the project', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await setup(page)
  const kind = () => page.locator('.viewer').evaluate((el) => el.__vueParentComponent.setupState.camera.type)
  await page.keyboard.press('7')
  await page.getByRole('button', { name: 'View', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Views', exact: true }).click()
  const box = page.getByRole('toolbar', { name: 'Views' })
  await box.getByLabel('Name of the new view').fill('Plan')
  await box.getByRole('button', { name: 'Save', exact: true }).click()

  // An orthographic one, unnamed: it takes the next "View n".
  await page.keyboard.press('1')
  await page.keyboard.press('5')
  await expect.poll(kind).toBe('OrthographicCamera')
  await box.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(box.locator('.view-go')).toHaveText(['Plan', 'View 1ortho'])

  // Elsewhere, perspective: Plan looks down again, View 1 is orthographic again.
  await page.keyboard.press('5')
  await page.keyboard.press('0')
  await box.locator('.view-go', { hasText: 'Plan' }).click()
  await expect.poll(() => lookDownness(page)).toBeCloseTo(1, 3)
  await expect.poll(kind).toBe('PerspectiveCamera')
  await box.locator('.view-go', { hasText: 'View 1' }).click()
  await expect.poll(kind).toBe('OrthographicCamera')
  await expect.poll(() => lookDownness(page)).toBeCloseTo(0, 3)

  await page.evaluate(async () => (await import('/src/utils/persistence.js')).flushPersistence())
  await page.reload()
  await page.locator('.project-main').first().click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const saved = () =>
    page.evaluate(async () => {
      const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
      return useReconstructionStore().savedViews.map((v) => [v.name, v.ortho])
    })
  // The overlay may not be up yet right after the click: wait for the views themselves.
  await expect.poll(saved).toEqual([
    ['Plan', false],
    ['View 1', true],
  ])
  expect(errors).toEqual([])
})
