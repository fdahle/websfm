import { test, expect } from '@playwright/test'

// Sidebar ▸ Map layers: one stacking list for every raster the map can draw. The
// list's top draws on top, a move restacks the map's raster group, the opacity
// reaches the layer, and the order is saved with the project.

const W = 40

test('the Map layers list restacks the map and fades a layer', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // A DEM and an orthophoto in UTM 32N, both on the map.
  await page.evaluate(async (W) => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const png = (colour) => {
      const c = document.createElement('canvas')
      c.width = c.height = W
      const g = c.getContext('2d')
      g.fillStyle = colour
      g.fillRect(0, 0, W, W)
      return c.toDataURL()
    }
    const base = { width: W, height: W, gsd: 1, originX: 500000, originY: 5000040, crs: 'EPSG:32632', unit: 'm' }
    const recon = useReconstructionStore()
    recon.dem = {
      ...base,
      name: 'DEM',
      data: new Float32Array(W * W).fill(5),
      zMin: 5,
      zMax: 5,
      previewUrl: png('#c84'),
    }
    recon.ortho = { ...base, name: 'Orthophoto', previewUrl: png('#48c') }
    recon.setProductVisible('dem', true)
    recon.setProductVisible('ortho', true)
  }, W)
  await page.locator('.tab', { hasText: /^2D$/ }).click()

  // The preview URLs the map's raster group holds, bottom first.
  const stack = () =>
    page.locator('.map-viewer').evaluate(async (el) => {
      const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
      const recon = useReconstructionStore()
      const name = (url) => (url === recon.dem.previewUrl ? 'dem' : url === recon.ortho.previewUrl ? 'ortho' : url)
      const map = el.__vueParentComponent.setupState.ctx.map
      const group = map
        .getLayers()
        .getArray()
        .find((l) => l.getLayers && l.getLayers().getLength() && l.getLayers().item(0).get('previewUrl'))
      return group
        ? group
            .getLayers()
            .getArray()
            .map((l) => [name(l.get('previewUrl')), l.getOpacity()])
        : []
    })
  await expect.poll(stack).toEqual([
    ['dem', 1],
    ['ortho', 1],
  ])

  await page.getByRole('button', { name: /Map layers/ }).click()
  const list = page.getByRole('list', { name: 'Map layers, top first' })
  await expect(list.locator('.item-name')).toHaveText(['Orthophoto', 'DEM'])
  await list.getByRole('button', { name: 'Move DEM up' }).click()
  await expect(list.locator('.item-name')).toHaveText(['DEM', 'Orthophoto'])
  await expect.poll(stack).toEqual([
    ['ortho', 1],
    ['dem', 1],
  ])
  await list.getByRole('slider', { name: 'Opacity of DEM' }).fill('0.4')
  await expect.poll(stack).toEqual([
    ['ortho', 1],
    ['dem', 0.4],
  ])
  // Unticked layers keep their place in the list.
  await list.getByRole('checkbox', { name: 'Show Orthophoto on the map' }).uncheck()
  await expect.poll(stack).toEqual([['dem', 0.4]])
  await expect(list.locator('.item-name')).toHaveText(['DEM', 'Orthophoto'])
  expect(
    await page.evaluate(
      async () => (await import('/src/stores/useReconstructionStore.js')).useReconstructionStore().mapOrder,
    ),
  ).toEqual(['product:dem', 'product:ortho'])
  if (process.env.SHOT) await page.locator('.sidebar').screenshot({ path: process.env.SHOT })
  expect(errors).toEqual([])
})
