import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Export ▸ Measurements: saved measurements as CSV (units in columns) and GeoJSON
// (project CRS, or RFC 7946 WGS 84), and the 3D toolbox's Export… for its own list.

async function download(page, click) {
  const pending = page.waitForEvent('download')
  await click()
  const d = await pending
  return { name: d.suggestedFilename(), text: (await readFile(await d.path())).toString() }
}

test('saved measurements export as CSV and GeoJSON with their units', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useMeasurementsStore } = await import('/src/stores/useMeasurementsStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const m = useMeasurementsStore()
    // A ruler on a UTM DEM, and a 3D distance on a model-unit layer (no CRS).
    m.add({ name: 'Fence', kind: 'length', source: 'product:dem', crs: 'EPSG:32632', unit: 'm', verticalUnit: 'm',
      groundScale: 1, world: [{ x: 500000, y: 5000000 }, { x: 500030, y: 5000040 }], vertices: [{ x: 0, y: 0 }, { x: 3, y: 4 }], distance: 50 })
    m.add({ name: 'Edge', kind: 'length3d', source: 'cloud:none', cloudName: 'Mesh', points3d: [[0, 0, 0], [3, 0, 4]],
      up: [0, 0, 1], unitSnapshot: { scale: 1, unit: 'model', label: 'model units' }, vertices: [] })
  })

  const openDialog = async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.locator('.ribbon').getByRole('button', { name: /Measure-\s*ments/ }).click()
    return page.getByRole('dialog', { name: 'Export Measurements' })
  }

  let dialog = await openDialog()
  await dialog.getByLabel('Format').selectOption('csv')
  const csv = await download(page, () => dialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(csv.name).toMatch(/-measurements\.csv$/)
  const lines = csv.text.trim().split('\n')
  expect(lines).toHaveLength(3)
  const head = lines[0].split(',')
  const fence = Object.fromEntries(head.map((h, i) => [h, lines[1].split(',')[i]]))
  expect(fence).toMatchObject({ name: 'Fence', kind: 'Ruler', length: '50', length_unit: 'm', coordinate_frame: 'EPSG:32632' })
  expect(lines[2]).toContain('model units')

  // GeoJSON, RFC 7946: UTM 32N's false easting lies on its central meridian, 9°E.
  dialog = await openDialog()
  await dialog.getByLabel('Format').selectOption('geojson')
  await dialog.getByLabel('Coordinates').selectOption('wgs84')
  const gj = await download(page, () => dialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(gj.name).toMatch(/-measurements\.geojson$/)
  const fc = JSON.parse(gj.text)
  expect(fc.crs).toBeUndefined()
  const [line, edge] = fc.features
  expect(line.geometry.type).toBe('LineString')
  expect(line.geometry.coordinates[0][0]).toBeCloseTo(9, 6)
  expect(line.geometry.coordinates[0]).toHaveLength(2)
  expect(line.properties.frame_coordinates[0]).toEqual([500000, 5000000])
  // A model-unit measurement is never placed on the globe.
  expect(edge.geometry).toBeNull()
  expect(edge.properties).toMatchObject({ length: 5, length_unit: 'model units', stale: true })

  // Project CRS: the legacy crs member, coordinates as measured.
  dialog = await openDialog()
  await dialog.getByLabel('Format').selectOption('geojson')
  await expect(dialog.getByLabel('Coordinates')).toHaveValue('project')
  const proj = JSON.parse((await download(page, () => dialog.getByRole('button', { name: 'Export', exact: true }).click())).text)
  expect(proj.crs.properties.name).toBe('EPSG:32632')
  expect(proj.features[0].geometry.coordinates).toEqual([[500000, 5000000], [500030, 5000040]])
  expect(errors).toEqual([])
})

test('the 3D toolbox exports its own saved list', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useMeasurementsStore } = await import('/src/stores/useMeasurementsStore.js')
    const store = useReconstructionStore()
    store.clouds.push({ id: 'sq', name: 'Square', kind: 'mesh', createdAt: 1, derived: true, imported: false, cameras: new Map(),
      count: 2, nVerts: 4, pos: new Float64Array([-5, -5, 0, 5, -5, 0, 5, 5, 0, -5, 5, 0]), idx: Uint32Array.of(0, 1, 2, 0, 2, 3), col: null })
    store.setCloudVisible('sq', true)
    const m = useMeasurementsStore()
    m.add({ name: 'Diagonal', kind: 'length3d', source: 'cloud:sq', cloudName: 'Square', cloudStamp: 1,
      points3d: [[-3, -4, 0], [3, 4, 0]], up: [0, 0, 1], unitSnapshot: { scale: 1, unit: 'model', label: 'model units' }, vertices: [] })
    m.add({ name: 'Elsewhere', kind: 'length', source: 'product:dem', crs: 'local', unit: 'model units', world: [{ x: 0, y: 0 }, { x: 1, y: 0 }], vertices: [], distance: 1 })
  })
  await page.locator('.tab').filter({ hasText: /^3D$/ }).click()
  const viewer = page.locator('.viewer')
  await viewer.evaluate((el) => el.__vueParentComponent.exposed.toggleMeasureTool('distance'))
  const box = page.locator('[id="measure-3d"], .floating-toolbox').filter({ hasText: 'Measure in 3D' }).first()
  await box.getByRole('button', { name: 'Export…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Measurements' })
  await expect(dialog).toContainText('1 3D measurement')
  await dialog.getByLabel('Format').selectOption('geojson')
  // Nothing here has a CRS: written in the model frame, marked as not georeferenced.
  await expect(dialog.getByLabel('Coordinates')).toHaveCount(0)
  const fc = JSON.parse((await download(page, () => dialog.getByRole('button', { name: 'Export', exact: true }).click())).text)
  expect(fc.georeferenced).toBe(false)
  expect(fc.features).toHaveLength(1)
  expect(fc.features[0].geometry).toEqual({ type: 'LineString', coordinates: [[-3, -4, 0], [3, 4, 0]] })
  expect(fc.features[0].properties).toMatchObject({ name: 'Diagonal', length: 10, horizontal_length: 10, height_change: 0,
    length_unit: 'model units', stale: false })
  expect(errors).toEqual([])
})
