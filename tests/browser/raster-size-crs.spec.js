import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fromArrayBuffer } from 'geotiff'

// The DEM / Orthophoto dialogs' size field and readout (plan-dense-past-one-tab P4), and
// a DEM exported in another CRS (P5), against the full app.

async function download(page, click) {
  const pending = page.waitForEvent('download')
  await click()
  const d = await pending
  return { name: d.suggestedFilename(), bytes: await readFile(await d.path()) }
}

test('the size readout, a long side in px, and a DEM exported in a neighbouring UTM zone', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // A 300 × 200 DEM at 1 m near the zone 32 / 33 border, z = x/100 (a ramp).
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const W = 300,
      H = 200,
      data = new Float32Array(W * H)
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) data[r * W + c] = c / 100
    useReconstructionStore().dem = {
      width: W,
      height: H,
      gsd: 1,
      originX: 690000,
      originY: 5340200,
      crs: 'EPSG:32632',
      unit: 'm',
      data,
      mask: new Uint8Array(W * H).fill(1),
      zMin: 0,
      zMax: 3,
      name: 'DEM',
      createdAt: 1,
    }
  })

  // Build Orthophoto over the DEM: the readout is exact, and follows a long side in px.
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().orthoOpen = true
  })
  const ortho = page.getByRole('dialog', { name: 'Build Orthophoto' })
  await expect(ortho.locator('.size-readout')).toHaveText(/^300 × 200 px at 1\.00 m\/px · 234 KB uncompressed$/)
  await ortho.getByLabel('Raster size by').selectOption('px')
  await ortho.getByLabel('Long side').fill('3000')
  await expect(ortho.locator('.size-readout')).toHaveText(/^3,000 × 2,001 px at 0\.100 m\/px/)
  await page.screenshot({ path: test.info().outputPath('ortho-size.png') })
  await ortho.getByRole('button', { name: 'Cancel' }).click()

  // Export the DEM reprojected into UTM 33.
  await page
    .getByRole('button', { name: /Products/ })
    .first()
    .click()
  await page.locator('.item-name', { hasText: /^DEM$/ }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Export DEM' })
  await dlg.getByLabel('Format').selectOption('cog')
  await expect(dlg.getByLabel('Coordinate system')).toContainText('As built (EPSG:32632)')
  await dlg.getByLabel('Coordinate system').selectOption('other')
  const crs = dlg.getByRole('combobox', { name: 'Coordinate reference system' })
  await crs.fill('32633')
  await page
    .getByRole('option', { name: /EPSG:32633/ })
    .first()
    .click()
  await expect(dlg.getByLabel('Resampling')).toHaveValue('bilinear')
  await page.screenshot({ path: test.info().outputPath('export-crs.png') })
  const tif = await download(page, () => dlg.getByRole('button', { name: 'Export', exact: true }).click())
  expect(tif.name).toMatch(/-dem-EPSG32633\.tif$/)
  const image = await (
    await fromArrayBuffer(tif.bytes.buffer.slice(tif.bytes.byteOffset, tif.bytes.byteOffset + tif.bytes.byteLength))
  ).getImage(0)
  expect(image.getGeoKeys().ProjectedCSTypeGeoKey).toBe(32633)
  // The zones' grids are rotated here, so the box is a little larger than the DEM.
  expect(image.getWidth()).toBeGreaterThan(300)
  expect(image.getWidth()).toBeLessThan(340)
  const [z] = await image.readRasters({ samples: [0], interleave: false })
  const mid = Math.floor(image.getHeight() / 2) * image.getWidth() + Math.floor(image.getWidth() / 2)
  expect(z[mid]).toBeGreaterThan(1.3)
  expect(z[mid]).toBeLessThan(1.7)
  expect(z[0]).toBeNaN()

  expect(errors).toEqual([])
})
