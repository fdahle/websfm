import { test, expect } from '@playwright/test'

// The sidebar's shared row primitives against the full app: inline rename
// (focus, Enter commits, Escape cancels without reaching App's Escape handler),
// expandable detail rows, context menus kept on screen by their measured size,
// and removals asking through the shared confirm dialog.

async function seed(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useFootprintsStore } = await import('/src/stores/useFootprintsStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const store = useReconstructionStore()
    for (const name of ['north.laz', 'south.laz']) {
      store.importCloud({ count: 2, pos: new Float64Array([500000, 7000000, 0, 500001, 7000000, 1]) }, name)
    }
    await useFootprintsStore().addFootprints([{ name: 'IMG_1.jpg', imageName: 'IMG_1.jpg',
      rings: [[[500000, 7000000], [500010, 7000000], [500010, 7000010]]] }], 'EPSG:32632', 'Site outline')
  })
}

const cloudNames = (page) => page.evaluate(async () => {
  const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
  return useReconstructionStore().clouds.map((c) => c.name)
})

test('sidebar rows rename, expand and confirm through the shared primitives', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await seed(page)
  const menu = page.locator('.ctx-menu')

  await page.getByRole('button', { name: /Reference Data/ }).click()
  const south = page.locator('.list-item').filter({ hasText: 'south.laz' })

  // Rename: the input takes focus, Enter commits.
  await south.click({ button: 'right' })
  await menu.getByRole('button', { name: 'Rename', exact: true }).click()
  const input = page.locator('.rename-input')
  await expect(input).toBeFocused()
  await input.fill('south renamed')
  await input.press('Enter')
  await expect(page.locator('.list-item').filter({ hasText: 'south renamed' })).toBeVisible()
  expect(await cloudNames(page)).toContain('south renamed')

  // Escape cancels, and the blur that follows the input unmounting commits nothing.
  await page.locator('.list-item').filter({ hasText: 'south renamed' }).click({ button: 'right' })
  await menu.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(input).toBeFocused()
  await input.fill('discarded')
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  expect(await cloudNames(page)).not.toContain('discarded')

  // Expand toggles the detail card.
  await page.getByRole('button', { name: /Shapefiles/ }).click()
  const outline = page.locator('.list-item').filter({ hasText: 'Site outline' })
  await outline.locator('.expand-btn').click()
  await expect(page.locator('.img-details').filter({ hasText: 'Polygons' })).toBeVisible()
  await outline.locator('.expand-btn').click()
  await expect(page.locator('.img-details').filter({ hasText: 'Polygons' })).toHaveCount(0)

  // A menu opened at the bottom edge is lifted by its measured height.
  const viewport = page.viewportSize()
  await page.evaluate(({ h }) => {
    const row = [...document.querySelectorAll('.list-item')].find((el) => el.textContent.includes('north.laz'))
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: h - 2 }))
  }, { h: viewport.height })
  const box = await menu.boundingBox()
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
  expect(box.y).toBeGreaterThan(0)

  // Remove asks first; Cancel keeps the cloud.
  await menu.getByRole('button', { name: 'Remove' }).click()
  const confirm = page.getByRole('dialog', { name: 'Remove cloud?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirm).toHaveCount(0)
  expect(await cloudNames(page)).toContain('Imported (north.laz)')

  expect(errors).toEqual([])
})

test('the project picker renames inline, and Escape there leaves the picker open', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByPlaceholder('My Project').fill('Picker project')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const projectButton = page.getByRole('button', { name: 'Picker project ▾', exact: true })
  await projectButton.click()
  const picker = page.locator('.project-picker')
  await expect(picker).toBeVisible()

  await picker.locator('.project-item').filter({ hasText: 'Picker project' }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  const input = picker.locator('.rename-input')
  await expect(input).toBeFocused()
  await input.fill('Never saved')
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(picker).toBeVisible()
  await expect(picker.locator('.project-item').filter({ hasText: 'Picker project' })).toBeVisible()

  await picker.locator('.project-item').filter({ hasText: 'Picker project' }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await input.fill('Renamed project')
  await input.press('Enter')
  await expect(picker.locator('.project-item').filter({ hasText: 'Renamed project' })).toBeVisible()

  expect(errors).toEqual([])
})

test('the tab context menu closes on Escape and on an outside click, then tabs close from it', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const W = 4, canvas = document.createElement('canvas')
    canvas.width = canvas.height = W
    useReconstructionStore().dem = { width: W, height: W, gsd: 1, originX: 0, originY: W, crs: 'local', unit: 'm',
      data: new Float32Array(W * W).fill(5), mask: new Uint8Array(W * W).fill(1), zMin: 5, zMax: 5,
      name: 'DEM', createdAt: 1, previewUrl: canvas.toDataURL() }
  })
  await page.getByRole('button', { name: /Products/ }).first().click()
  await page.locator('.item-name', { hasText: /^DEM$/ }).dblclick()
  const tab = page.locator('.tabstrip .tab', { hasText: 'DEM' })
  await expect(tab).toHaveClass(/active/)
  const menu = page.locator('.tab-ctx-menu')

  await tab.click({ button: 'right' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(tab).toBeVisible()

  await tab.click({ button: 'right' })
  await page.locator('.sidebar').click({ position: { x: 5, y: 5 } })
  await expect(menu).toHaveCount(0)

  await tab.click({ button: 'right' })
  await menu.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(tab).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a reference raster declares its accuracy and datum after a confident import', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { writeGeoTiff, geoKeysForEpsg } = await import('/src/core/products/geotiff.js')
    const { useExternalStore } = await import('/src/stores/useExternalStore.js')
    const z = new Float32Array(64 * 64).fill(120)
    // Float samples: a high-confidence DEM, so no confirm modal opens on import.
    await useExternalStore().importRaster(new File([writeGeoTiff({ width: 64, height: 64, samples: [{ bits: 32, format: 3 }], photometric: 1,
      data: new Uint8Array(z.buffer), pixelScale: [2, 2, 0], tiepoint: [0, 0, 0, 1000, 2000, 0], geoKeys: geoKeysForEpsg(3031, false) })], 'rema.tif'))
  })
  // The import opens the section itself; open it only if it is still collapsed.
  const section = page.getByRole('button', { name: /Reference Data/ })
  if ((await section.textContent()).includes('▸')) await section.click()
  await page.locator('.list-item').filter({ hasText: 'rema.tif' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Accuracy & datum…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reference raster accuracy' })
  await expect(dialog.getByRole('button', { name: /DEM \(elevation\)/ })).toHaveCount(0) // no kind choice here
  await dialog.getByLabel(/Horizontal accuracy/).fill('2.5')
  await dialog.getByLabel('Vertical datum').selectOption('ellipsoidal')
  await dialog.getByLabel(/Vertical accuracy/).fill('1')
  await dialog.getByLabel(/Vertical offset/).fill('-0.4')
  await dialog.getByRole('button', { name: 'Done' }).click()
  const meta = await page.evaluate(async () => {
    const { useExternalStore } = await import('/src/stores/useExternalStore.js')
    const r = useExternalStore().rasters[0]
    return { h: r.horizontalAccuracy, datum: r.verticalDatum, v: r.verticalAccuracy, off: r.vOffset }
  })
  expect(meta).toEqual({ h: 2.5, datum: 'ellipsoidal', v: 1, off: -0.4 })
  await page.locator('.list-item').filter({ hasText: 'rema.tif' }).locator('.expand-btn').click()
  await expect(page.locator('.img-details').filter({ hasText: 'σ horizontal' })).toContainText('2.5')
})
