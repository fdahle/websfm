import { test, expect } from './fixtures.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { unzipStore } from '../../src/utils/zip.js'

// Export ▸ Orthophoto ▸ MBTiles / XYZ tiles on the saved five-photo Aukerman project
// (EPSG:32617): Web Mercator tiles that cover the orthophoto, readable as MBTiles
// (SQLite) and as a {z}/{x}/{y} zip.
const PROJECT = new URL('../fixtures/projects/v2/aukerman-5.websfm', import.meta.url)

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
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().newProjectOpen = false
  })
  // The saved orthophoto is in the local frame (metric, from the scale bar): place it in
  // UTM 17N where Aukerman Park is, which is all a web map export needs of it.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const o = useReconstructionStore().ortho
    Object.assign(o, { crs: 'EPSG:32617', originX: 437000, originY: 4572800 })
  })
}

async function exportTiles(page, format) {
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Ortho', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Orthophoto' })
  await dialog.locator('#fmt').selectOption(format)
  const download = page.waitForEvent('download', { timeout: 60_000 })
  await dialog.getByRole('button', { name: 'Export', exact: true }).click()
  const d = await download
  return { name: d.suggestedFilename(), bytes: readFileSync(await d.path()) }
}

test('exports the orthophoto as MBTiles and as an XYZ zip', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the tile maths')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)

  const mb = await exportTiles(page, 'mbtiles')
  expect(mb.name).toMatch(/-ortho-tiles\.mbtiles$/)
  const path = test.info().outputPath('ortho.mbtiles')
  writeFileSync(path, mb.bytes)
  const sql = new DatabaseSync(path, { readOnly: true })
  const meta = Object.fromEntries(
    sql
      .prepare('SELECT name, value FROM metadata')
      .all()
      .map((r) => [r.name, r.value]),
  )
  expect(meta).toMatchObject({ format: 'png', type: 'overlay' })
  const zooms = sql.prepare('SELECT zoom_level z, count(*) n FROM tiles GROUP BY zoom_level ORDER BY z').all()
  expect(zooms[0].z).toBe(Number(meta.minzoom))
  expect(zooms.at(-1).z).toBe(Number(meta.maxzoom))
  expect(zooms.length).toBe(Number(meta.maxzoom) - Number(meta.minzoom) + 1)
  // The bounds hold Aukerman Park, Ohio.
  const [w, s, e, n] = meta.bounds.split(',').map(Number)
  expect((w + e) / 2).toBeCloseTo(-81.752, 1)
  expect((s + n) / 2).toBeCloseTo(41.304, 1)
  const tile = sql.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? LIMIT 1').get(zooms.at(-1).z)
  expect([...tile.tile_data.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG')
  sql.close()

  const xyz = await exportTiles(page, 'xyz')
  expect(xyz.name).toMatch(/-ortho-tiles\.zip$/)
  const files = unzipStore(new Uint8Array(xyz.bytes)).map((e) => e.name)
  expect(files.length).toBe(zooms.reduce((s, r) => s + r.n, 0))
  expect(files.every((f) => /^\d+\/\d+\/\d+\.png$/.test(f))).toBe(true)
  expect(errors).toEqual([])
})
