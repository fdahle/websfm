import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readMetashapeXml, metashapeChunkToImport, ellipsoidOf } from '../../src/core/io/metashapeXml.js'
import proj4 from 'proj4'

// Metashape interchange on the saved five-photo Aukerman project. Import: the Metashape
// 2.2 export of the same photos (tests/fixtures/metashape) brings its calibration, the
// poses of those five photos and the three markers with their marks. Export: what
// Export ▸ SfM Project ▸ Metashape XML writes reads back to WebSfM's own poses.
const PROJECT = new URL('../fixtures/projects/v2/aukerman-5.websfm', import.meta.url)
const METASHAPE = fileURLToPath(new URL('../fixtures/metashape/aukerman-markers.xml', import.meta.url))

async function openFixture(page) {
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    window.__fixture = new File([u8], 'aukerman-5.websfm')
  }, readFileSync(PROJECT).toString('base64'))
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__._instance.setupState.importProjectFile(window.__fixture)
  })
  if (await page.evaluate(() => typeof window.showDirectoryPicker === 'function')) {
    await page
      .getByRole('dialog', { name: 'Open project file' })
      .getByRole('button', { name: 'In this browser' })
      .click()
  }
  await expect(page.locator('.toast', { hasText: 'Project opened' })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  if (await page.locator('.project-backdrop').isVisible()) await page.keyboard.press('Escape')
  await expect(page.locator('.project-backdrop')).toHaveCount(0)
  // The start screen's New Project stays open under a project opened from code.
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().newProjectOpen = false
  })
}

test('imports calibration, poses and markers from a Metashape export', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.locator('.ribbon').getByRole('button', { name: 'Metashape Cameras' }).click()
  await (await chooser).setFiles(METASHAPE)

  const dialog = page.getByRole('dialog', { name: 'Import Metashape Cameras' })
  await expect(dialog).toContainText('of 42 cameras aligned')
  await expect(dialog).toContainText('5 photos of this project in EPSG:32617')
  await expect(dialog).toContainText('3 points')
  // Metashape ran on the full 2400 px photos, the project holds 1200 px copies.
  await expect(dialog).toContainText('made for 2400 × 1800 photos, scaled to these 1200 × 900')
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  const got = await page.evaluate(async () => {
    const { usePosesStore } = await import('/src/stores/usePosesStore.js')
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const images = useImagesStore().images
    const sensors = useSensorsStore().sensors
    const poses = usePosesStore().poses
    const gcps = useGcpsStore().gcps.filter((g) => /^GCP/.test(g.name))
    return {
      poses: poses.length,
      imported: poses.filter((p) => p.source === 'imported' && Number.isFinite(p.kappa)).map((p) => p.imageName),
      // The photos' own camera group takes the calibration (Import ▸ Calibration's rule).
      sensor: sensors.find((x) => x.id === images[0].sensorId),
      groups: new Set(images.map((im) => im.sensorId)).size,
      gcps: gcps.map((g) => [g.name, g.role, g.observations.filter((o) => o.imageId != null).length]),
    }
  })
  // Each photo keeps one pose: Metashape's replaces the one from EXIF.
  expect(got.poses).toBe(5)
  expect(got.imported.sort()).toEqual(['DSC00292.JPG', 'DSC00298.JPG', 'DSC00306.JPG', 'DSC00308.JPG', 'DSC00309.JPG'])
  expect(got.sensor).toMatchObject({ width: 1200, height: 900, distortionModel: 'brown' })
  expect(got.sensor.focal).toBeCloseTo(1776.91 / 2, 2)
  expect(got.groups).toBe(1)
  expect(got.gcps.map(([n, r]) => [n, r])).toEqual([
    ['GCP1', 'control'],
    ['GCP2', 'control'],
    ['GCP3', 'check'],
  ])
  expect(errors).toEqual([])
})

test('exports the cameras, calibration and markers for Metashape', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'SfM Project' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export SfM Project' })
  await dialog.locator('#fmt').selectOption('metashape')
  const download = page.waitForEvent('download')
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  const file = await (await download).path()
  const xml = readFileSync(file, 'utf8')

  // The cameras as WebSfM's own pose export places them, in the project CRS.
  const expected = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { similarityForExport } = await import('/src/core/products/exportFrame.js')
    const { estimatedPose } = await import('/src/core/sfm/cameraEstimated.js')
    const recon = useReconstructionStore()
    const { sim, crs } = similarityForExport(await recon.effectiveFrameSpec())
    const cams = recon.mainSparseCloud.cameras
    return {
      crs,
      poses: useImagesStore().images.map((im) => ({ name: im.name, ...estimatedPose(cams.get(im.uuid), sim) })),
    }
  })
  expect(expected.crs).toBe('EPSG:32617')
  const chunk = readMetashapeXml(xml).chunks[0]
  expect(chunk.crs.epsg).toBe('EPSG:4326')
  expect(chunk.markers.map((m) => [m.label, m.locations.length])).toEqual([
    ['Bar end A', 4],
    ['Bar end B', 4],
  ])
  const utm = '+proj=utm +zone=17 +datum=WGS84 +units=m +no_defs'
  const toUtm = proj4('+proj=longlat +datum=WGS84 +no_defs', utm)
  const back = metashapeChunkToImport(chunk, {
    ellipsoid: ellipsoidOf(utm),
    toTarget: (lon, lat) => toUtm.forward([lon, lat]),
    fromChunk: (x, y) => toUtm.forward([x, y]),
  })
  expect(back.poses).toHaveLength(5)
  for (const p of back.poses) {
    const q = expected.poses.find((e) => e.name.startsWith(p.imageName))
    expect(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)).toBeLessThan(1e-4)
    // Metashape takes the angles against grid north at each camera; WebSfM's pose export
    // against grid north at the georeference's origin (TODO ▸ A07 ▸ MX follow-up).
    for (const k of ['omega', 'phi', 'kappa']) expect(Math.abs(p[k] - q[k])).toBeLessThan(1e-3)
  }
  expect(errors).toEqual([])
})
