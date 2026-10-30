import { test, expect } from './fixtures.js'
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
  // The File name field shows the name the file gets when it is left empty.
  await expect(cloudDialog.getByLabel('File name')).toHaveAttribute('placeholder', /-Imported_south$/)
  const cloud = await download(page, () => cloudDialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(cloud.name).toMatch(/-Imported_south\.xyz$/)
  expect(cloud.bytes.toString().trim().split('\n')).toHaveLength(2)

  // The DEM opens its own export dialog, naming the DEM (a project may hold several).
  await page
    .getByRole('button', { name: /Products/ })
    .first()
    .click()
  await page.locator('.item-name', { hasText: /^DEM$/ }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  const demDialog = page.getByRole('dialog', { name: 'Export DEM' })
  await expect(demDialog).toContainText('Exporting DEM')
  await demDialog.getByLabel('Format').selectOption('asc')
  await expect(demDialog.getByLabel('File name')).toHaveAttribute('placeholder', /-dem$/)
  await demDialog.getByLabel('Format').selectOption('png')
  await expect(demDialog.getByLabel('File name')).toHaveAttribute('placeholder', /-dem-hillshade$/)
  await demDialog.getByLabel('Format').selectOption('asc')
  await demDialog.getByLabel('File name').fill('terrain.asc')
  const asc = await download(page, () => demDialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(asc.name).toBe('terrain.asc')

  // A polygon file (in Reference Data, open already) as GeoJSON in the project CRS.
  await page.locator('.list-item').filter({ hasText: 'Site outline' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  const vecDialog = page.getByRole('dialog', { name: 'Export Vector Layer' })
  await expect(vecDialog.getByLabel('File name')).toHaveAttribute('placeholder', 'Site_outline')
  const gj = await download(page, () => vecDialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(gj.name).toBe('Site_outline.geojson')
  const fc = JSON.parse(gj.bytes.toString())
  expect(fc.crs.properties.name).toBe('EPSG:32632')
  expect(fc.features[0].geometry.coordinates[0]).toHaveLength(4)

  // The same layer in WGS 84 for a web map, and as KML.
  await page.locator('.list-item').filter({ hasText: 'Site outline' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  await vecDialog.getByLabel('Coordinates').selectOption('wgs84')
  const wgs = await download(page, () => vecDialog.getByRole('button', { name: 'Export', exact: true }).click())
  const fcWgs = JSON.parse(wgs.bytes.toString())
  expect(fcWgs.crs).toBeUndefined()
  const [lon, lat] = fcWgs.features[0].geometry.coordinates[0][0]
  expect(lon).toBeGreaterThan(5)
  expect(lon).toBeLessThan(15)
  // UTM 32N at northing 7,000,000: about 63°N, 9°E.
  expect(lat).toBeGreaterThan(62)
  expect(lat).toBeLessThan(64)
  await page.locator('.list-item').filter({ hasText: 'Site outline' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  await vecDialog.getByLabel('Format').selectOption('kml')
  const kml = await download(page, () => vecDialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(kml.name).toBe('Site_outline.kml')
  expect(kml.bytes.toString()).toContain('<Polygon><outerBoundaryIs>')

  expect(errors).toEqual([])
})
