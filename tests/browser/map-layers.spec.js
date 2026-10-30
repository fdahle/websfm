import { test, expect } from './fixtures.js'

// View ▸ Map ▸ Layers: a floating panel listing the layers on the map in one stack. The
// list's top draws on top, a move restacks the map's layer group, the selected row's
// opacity reaches the layer, a row's checkbox hides it and its ✕ takes it off the map,
// and the order is saved with the project.

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
    recon.setProductVisible(recon.dem.id, true)
    recon.setProductVisible(recon.ortho.id, true)
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

  await page.locator('.ribbon').getByRole('button', { name: 'View', exact: true }).click()
  const layersBtn = page.locator('.ribbon').getByRole('button', { name: 'Layers', exact: true })
  await layersBtn.click()
  await expect(layersBtn).toHaveClass(/active/)
  const list = page.getByRole('list', { name: 'Map layers, top first' })
  await expect(list.locator('.item-name')).toHaveText(['Orthophoto', 'DEM'])
  await list.getByRole('button', { name: 'Move DEM up' }).click()
  await expect(list.locator('.item-name')).toHaveText(['DEM', 'Orthophoto'])
  await expect.poll(stack).toEqual([
    ['ortho', 1],
    ['dem', 1],
  ])
  // The settings strip shows the top row until another is clicked.
  await page.getByRole('slider', { name: 'Opacity of DEM' }).fill('0.4')
  await expect.poll(stack).toEqual([
    ['ortho', 1],
    ['dem', 0.4],
  ])
  // Unticked layers keep their place in the list.
  await list.getByRole('checkbox', { name: 'Show Orthophoto on the map' }).uncheck()
  await expect.poll(stack).toEqual([['dem', 0.4]])
  await expect(list.locator('.item-name')).toHaveText(['DEM', 'Orthophoto'])
  const mapState = () =>
    page.evaluate(async () => {
      const recon = (await import('/src/stores/useReconstructionStore.js')).useReconstructionStore()
      // Layer ids are `product:<product id>`; named by kind here.
      const kindOf = (id) =>
        id === `product:${recon.dem.id}` ? 'dem' : id === `product:${recon.ortho.id}` ? 'ortho' : id
      return {
        order: recon.mapOrder.map(kindOf),
        hidden: recon.mapHidden.map(kindOf),
        ortho: !!recon.productLayers[recon.ortho.id]?.visible,
      }
    })
  expect(await mapState()).toEqual({ order: ['dem', 'ortho'], hidden: ['ortho'], ortho: true })

  // ✕ takes it off the map; the sidebar checkbox puts it back, ticked.
  await list.getByRole('button', { name: 'Remove Orthophoto from the map' }).click()
  await expect(list.locator('.item-name')).toHaveText(['DEM'])
  expect((await mapState()).ortho).toBe(false)
  await page.locator('.section-hd', { hasText: 'Products' }).click()
  await page.getByRole('checkbox', { name: "Add Orthophoto to the map's layers" }).check()
  await expect(list.locator('.item-name')).toHaveText(['DEM', 'Orthophoto'])
  await expect.poll(stack).toEqual([
    ['ortho', 1],
    ['dem', 0.4],
  ])
  expect((await mapState()).hidden).toEqual([])
  if (process.env.SHOT) await page.locator('.map-viewer').screenshot({ path: process.env.SHOT })
  // The panel's × is the ribbon toggle.
  await page.getByRole('button', { name: 'Close the layers panel' }).click()
  await expect(list).toHaveCount(0)
  await expect(layersBtn).not.toHaveClass(/active/)
  expect(errors).toEqual([])
})

test('View ▸ Map ▸ GCPs hides the GCP symbols', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // With no GCP yet the toggle is greyed and off, like Footprints.
  await page.locator('.tab', { hasText: /^2D$/ }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'View', exact: true }).click()
  const gcpsBtn = page.locator('.ribbon').getByRole('button', { name: 'GCPs', exact: true })
  await expect(gcpsBtn).toBeDisabled()
  await expect(gcpsBtn).not.toHaveClass(/active/)
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    await useGcpsStore().addGcps([{ name: 'G1', x: 500010, y: 5000010, z: 5 }], 'EPSG:32632')
  })
  await page.locator('.tab', { hasText: /^2D$/ }).click()
  const gcpLayerVisible = () =>
    page.locator('.map-viewer').evaluate((el) => el.__vueParentComponent.setupState.ctx.gcpLayer?.getVisible())
  await expect.poll(gcpLayerVisible).toBe(true)
  await page.locator('.ribbon').getByRole('button', { name: 'View', exact: true }).click()
  const gcps = page.locator('.ribbon').getByRole('button', { name: 'GCPs', exact: true })
  await expect(gcps).toHaveClass(/active/)
  await gcps.click()
  await expect.poll(gcpLayerVisible).toBe(false)
  await expect(gcps).not.toHaveClass(/active/)
})

test('contours are a layer in the stack; View ▸ Map ▸ Footprints hides only the footprints', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useFootprintsStore } = await import('/src/stores/useFootprintsStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const store = useFootprintsStore()
    const ring = [
      [500000, 5000000],
      [500020, 5000000],
      [500020, 5000020],
    ]
    await store.addLineSet([{ path: ring, level: 5, index: false }], 'EPSG:32632', 'Contours 5 m')
    store.sets.push({
      id: 'fp',
      name: 'footprints',
      source: 'computed',
      visible: true,
      footprints: [{ id: 'a', imageName: 'IMG_1.jpg', rings: [ring] }],
    })
  })
  await page.locator('.tab', { hasText: /^2D$/ }).click()

  // [footprint overlay visible, vector layers in the stack and their visibility]
  const state = () =>
    page.locator('.map-viewer').evaluate((el) => {
      const ctx = el.__vueParentComponent.setupState.ctx
      const group = ctx.map
        .getLayers()
        .getArray()
        .find((l) => l.getLayers)
      const vectors = group
        .getLayers()
        .getArray()
        .filter((l) => l.get('vector'))
      return [ctx.footprintLayer.getVisible(), vectors.map((l) => l.getVisible())]
    })
  await expect.poll(state).toEqual([true, [true]])
  await expect(page.locator('.legend')).toContainText('Footprint')
  await expect(page.locator('.legend')).toContainText('Contours')

  await page.locator('.ribbon').getByRole('button', { name: 'View', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Footprints', exact: true }).click()
  await expect.poll(state).toEqual([false, [true]])
  await expect(page.locator('.legend')).not.toContainText('Footprint')
  await expect(page.locator('.legend')).toContainText('Contours')

  // The contours have their own row in the Layers panel, and none for the footprints.
  await page.locator('.ribbon').getByRole('button', { name: 'Layers', exact: true }).click()
  const list = page.getByRole('list', { name: 'Map layers, top first' })
  await expect(list.locator('.item-name')).toHaveText(['Contours 5 m'])
  await list.getByRole('checkbox', { name: 'Show Contours 5 m on the map' }).uncheck()
  await expect.poll(state).toEqual([false, []])
  expect(errors).toEqual([])
})

test('View ▸ Map ▸ Photos draws the source images into their footprints, as a layer', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.locator('.tab', { hasText: /^2D$/ }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'View', exact: true }).click()
  const photos = page.locator('.ribbon').getByRole('button', { name: 'Photos', exact: true })
  // Footprints give the photos their place: none yet, the toggle is greyed.
  await expect(photos).toBeDisabled()
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useFootprintsStore } = await import('/src/stores/useFootprintsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const c = document.createElement('canvas')
    c.width = 40
    c.height = 30
    c.getContext('2d').fillRect(0, 0, 40, 30)
    const url = c.toDataURL()
    const images = useImagesStore()
    for (const id of ['img-1', 'img-2'])
      images.images.push({ id, uuid: id, name: `${id}.jpg`, url, thumb: { url }, meta: {}, fiducialDetections: [] })
    const quad = (x) => [
      [x, 5000040],
      [x + 40, 5000040],
      [x + 40, 5000000],
      [x, 5000000],
      [x, 5000040],
    ]
    useFootprintsStore().sets.push({
      id: 'fp',
      name: 'footprints',
      source: 'computed',
      visible: true,
      footprints: [
        { id: 'a', imageId: 'img-1', rings: [quad(500000)] },
        { id: 'b', imageId: 'img-2', rings: [quad(500100)] },
      ],
    })
  })

  // The photos layer's item count and extent, or null when it is not in the stack.
  const drawn = () =>
    page.locator('.map-viewer').evaluate((el) => {
      const group = el.__vueParentComponent.setupState.ctx.map
        .getLayers()
        .getArray()
        .find((l) => l.getLayers)
      const layer = group
        .getLayers()
        .getArray()
        .find((l) => l.get('overlay'))
      return layer ? layer.get('overlay').extent() : null
    })
  await photos.click()
  await expect(photos).toHaveClass(/active/)
  // Only the selected image by default, and none is selected.
  await expect.poll(drawn).toBe(null)
  await page.locator('.ribbon').getByRole('button', { name: 'Layers', exact: true }).click()
  const list = page.getByRole('list', { name: 'Map layers, top first' })
  await expect(list.locator('.item-name')).toHaveText(['Photos'])
  await expect(page.getByText('Click a footprint')).toBeVisible()
  await page.evaluate(async () => {
    ;(await import('/src/stores/useImagesStore.js')).useImagesStore().selectedId = 'img-2'
  })
  await expect.poll(drawn).toEqual([500100, 5000000, 500140, 5000040])
  await page.getByLabel('Show', { exact: true }).selectOption('all')
  await expect.poll(drawn).toEqual([500000, 5000000, 500140, 5000040])
  // Saved with the project; ✕ takes the layer off the map and the toggle goes out.
  expect(
    await page.evaluate(
      async () => (await import('/src/stores/useReconstructionStore.js')).useReconstructionStore().imageLayer,
    ),
  ).toEqual({ visible: true, opacity: 1, mode: 'all' })
  await list.getByRole('button', { name: 'Remove Photos from the map' }).click()
  await expect(photos).not.toHaveClass(/active/)
  expect(errors).toEqual([])
})
