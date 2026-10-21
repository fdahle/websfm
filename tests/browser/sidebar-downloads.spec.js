import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Sidebar ▸ right-click ▸ Download… — a cloud through the export dialog aimed at
// that cloud, the DEM through its export dialog, and a polygon layer as GeoJSON.

async function download(page, click) {
  const pending = page.waitForEvent('download')
  await click()
  const d = await pending
  return { name: d.suggestedFilename(), bytes: await readFile(await d.path()) }
}

test('sidebar context menus download clouds, products and polygon layers', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
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
      store.importCloud(
        {
          count: 2,
          pos: new Float64Array([500000, 7000000, 0, 500001, 7000000, 1]),
          col: new Uint8Array([255, 0, 0, 0, 255, 0]),
        },
        name,
      )
    }
    const W = 8
    store.dem = {
      width: W,
      height: W,
      gsd: 1,
      originX: 500000,
      originY: 7000008,
      crs: 'EPSG:32632',
      unit: 'm',
      data: new Float32Array(W * W).fill(5),
      mask: new Uint8Array(W * W).fill(1),
      zMin: 5,
      zMax: 5,
      name: 'DEM',
      createdAt: 1,
    }
    await useFootprintsStore().addFootprints(
      [
        {
          name: 'IMG_1.jpg',
          imageName: 'IMG_1.jpg',
          rings: [
            [
              [500000, 7000000],
              [500010, 7000000],
              [500010, 7000010],
            ],
          ],
        },
      ],
      'EPSG:32632',
      'Site outline',
    )
  })

  // The second imported cloud, not the selected / first one.
  await page.getByRole('button', { name: /Reference Data/ }).click()
  await page.locator('.list-item').filter({ hasText: 'south.laz' }).click({ button: 'right' })
  await expect(page.locator('.ctx-menu').getByRole('button', { name: 'Download…' })).toBeVisible()
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  const cloudDialog = page.getByRole('dialog', { name: 'Export Point Cloud' })
  await expect(cloudDialog).toContainText('south.laz')
  await cloudDialog.getByLabel('Format').selectOption('xyz')
  const cloud = await download(page, () => cloudDialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(cloud.name).toMatch(/-Imported_south\.xyz$/)
  expect(cloud.bytes.toString().trim().split('\n')).toHaveLength(2)

  // The DEM opens its own export dialog.
  await page
    .getByRole('button', { name: /Products/ })
    .first()
    .click()
  await page.locator('.item-name', { hasText: /^DEM$/ }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  const demDialog = page.getByRole('dialog', { name: 'Export DEM' })
  await expect(demDialog).not.toContainText('Exporting')
  await demDialog.getByLabel('Format').selectOption('asc')
  const asc = await download(page, () => demDialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(asc.name).toMatch(/-dem\.asc$/)

  // A polygon layer as GeoJSON in the project CRS.
  await page
    .getByRole('button', { name: /Shapefiles/ })
    .first()
    .click()
  await page.locator('.list-item').filter({ hasText: 'Site outline' }).click({ button: 'right' })
  const gj = await download(page, () =>
    page.locator('.ctx-menu').getByRole('button', { name: 'Download GeoJSON' }).click(),
  )
  expect(gj.name).toBe('Site_outline.geojson')
  const fc = JSON.parse(gj.bytes.toString())
  expect(fc.crs.properties.name).toBe('EPSG:32632')
  expect(fc.features[0].geometry.coordinates[0]).toHaveLength(4)

  expect(errors).toEqual([])
})
