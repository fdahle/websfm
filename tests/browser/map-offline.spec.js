import { test, expect } from '@playwright/test'

// The 2D map says why the basemap is missing (ViewerMap ▸ tileStatus) instead of
// showing a blank grid that looks broken: a note when tiles fail to load, and an
// explicit "Offline" note when the browser has no connection.

test('the map explains failing basemap tiles and offline state', async ({ page, context }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The automatic basemap for a UTM project is OpenStreetMap; make its server unreachable.
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort('internetdisconnected'))

  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
  })
  await page.locator('.tab', { hasText: /^2D$/ }).click()

  const note = page.locator('.map-viewer .tile-status')
  await expect(note).toContainText('Basemap tiles are not loading')

  await context.setOffline(true)
  await expect(note).toContainText('Offline: the basemap shows only areas viewed before')

  // Reconnecting retries the tiles; they still fail here, so the note falls back
  // to the unreachable-server wording rather than vanishing.
  await context.setOffline(false)
  await expect(note).toContainText('Basemap tiles are not loading')
  expect(errors).toEqual([])
})
