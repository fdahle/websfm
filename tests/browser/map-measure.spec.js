import { test, expect } from './fixtures.js'

// Tools ▸ Measure on the 2D map with no raster at all: the map itself is the layer,
// and Ruler and Area are taken on the WGS84 ellipsoid (core/products/geodesic.js),
// here in a project left in EPSG:4326, where a grid length would be in degrees.

async function measureTool(page, row) {
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Measure', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: row }).click()
}

test('Ruler and Area measure on an empty map, on the ellipsoid, and save to the map', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.locator('.tab', { hasText: /^2D$/ }).click()
  const map = page.locator('.map-viewer .ol-map')
  await expect(map).toBeVisible()
  const mb = await map.boundingBox()
  const status = page.locator('.map-viewer .status-bar')

  // The status bar's lon/lat under a screen point.
  const lonLatAt = async (x, y) => {
    await page.mouse.move(x, y)
    const text = await status.textContent()
    const lon = Number(text.match(/Lon(?:gitude)?\s+([-\d.]+)/)[1])
    const lat = Number(text.match(/Lat(?:itude)?\s+([-\d.]+)/)[1])
    return [lon, lat]
  }
  const cx = mb.x + mb.width / 2,
    cy = mb.y + mb.height / 2
  const a = [cx - 120, cy + 30],
    b = [cx + 120, cy - 30],
    c = [cx + 60, cy + 90]
  const pa = await lonLatAt(...a),
    pb = await lonLatAt(...b)

  await measureTool(page, /^Ruler/)
  const ruler = page.getByLabel('Ruler measurement')
  await expect(ruler.getByRole('combobox', { name: 'Layer to measure' })).toHaveCount(0) // the map is the only layer
  await page.mouse.click(...a)
  await page.mouse.click(...b)
  const result = ruler.getByRole('region', { name: 'Measurement result' })
  await expect(result).toContainText('WGS 84 ellipsoid')
  const shown = (await result.locator('.mp-value').textContent()).trim()
  const expected = await page.evaluate(
    async ([p, q]) => (await import('/src/core/products/geodesic.js')).geodesicDistance(p, q),
    [pa, pb],
  )
  const value = Number(shown.replace(/[^\d.]/g, ''))
  expect(shown).toMatch(/ m$/)
  // The status bar rounds to 1e-6°, a few cm on the ground.
  expect(Math.abs(value - expected) / expected).toBeLessThan(1e-4)
  expect(value).toBeGreaterThan(1)

  await page.keyboard.press('Escape') // clear
  await measureTool(page, /^Area/)
  const areaBox = page.getByLabel('Area measurement')
  for (const p of [a, b, c]) await page.mouse.click(...p)
  const areaResult = areaBox.getByRole('region', { name: 'Measurement result' })
  await expect(areaResult.locator('.mp-value')).toContainText('m²')
  await areaResult.getByRole('textbox', { name: 'Measurement name' }).fill('Field')
  await areaResult.getByRole('button', { name: 'Save measurement', exact: true }).click()
  await expect(areaResult.getByRole('button', { name: 'Delete', exact: true })).toBeVisible()

  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await measureTool(page, /^Saved measurements/)
  const list = page.getByRole('complementary', { name: 'Saved measurements' })
  await expect(list).toContainText('Field')
  await expect(list.locator('.badge')).toHaveCount(0) // never stale
  const saved = await page.evaluate(async () => {
    const { useMeasurementsStore } = await import('/src/stores/useMeasurementsStore.js')
    return useMeasurementsStore().records.map((r) => ({ source: r.source, crs: r.crs, perimeter: r.perimeter }))
  })
  expect(saved).toEqual([{ source: 'map', crs: 'EPSG:4326', perimeter: expect.any(Number) }])
  expect(errors).toEqual([])
})
