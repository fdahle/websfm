import { test, expect } from './fixtures.js'
import { readFile } from 'node:fs/promises'

// Export ▸ COPC (core/lod/copcWrite.js): an in-memory cloud through the export dialog,
// read back in place by WebSfM's own COPC import; that streamed cloud then written as
// COPC again, from its octree. PDAL and laspy read the same files (CHANGELOG).

async function download(page, click) {
  const pending = page.waitForEvent('download')
  await click()
  const d = await pending
  return { name: d.suggestedFilename(), bytes: await readFile(await d.path()) }
}

test('a cloud exported as COPC reads back in place, and a streamed cloud writes COPC too', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const n = 50000
    const pos = new Float64Array(3 * n),
      col = new Uint8Array(3 * n),
      classification = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      pos[3 * i] = 500000 + (i % 250)
      pos[3 * i + 1] = 7000000 + Math.floor(i / 250)
      pos[3 * i + 2] = 10 + Math.sin(i / 300)
      col[3 * i] = i % 256
      col[3 * i + 1] = 80
      col[3 * i + 2] = 160
      classification[i] = i % 2 ? 2 : 1
    }
    useReconstructionStore().importCloud({ count: n, pos, col, attributes: { classification } }, 'site.laz')
  })

  await page.getByRole('button', { name: /Reference Data/ }).click()
  await page.locator('.list-item').filter({ hasText: 'site.laz' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export Point Cloud' })
  await dialog.getByRole('radiogroup', { name: 'Format' }).locator('[data-id="copc"]').click()
  await expect(dialog).toContainText('level-of-detail octree')
  const file = await download(page, () => dialog.getByRole('button', { name: 'Export', exact: true }).click())
  expect(file.name).toMatch(/\.copc\.laz$/)

  // Back in, read in place as WebSfM reads any COPC file.
  const back = await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const cloud = await useReconstructionStore().importCopcCloud(new File([u8], 'back.copc.laz'))
    return {
      count: cloud?.count,
      format: cloud?.lod.format,
      nodes: cloud?.lod.nodeCount,
      colour: cloud?.lod.layout.colour,
      classes: Object.keys(cloud?.lod.stats?.classes ?? {}).sort(),
    }
  }, file.bytes.toString('base64'))
  expect(back).toMatchObject({ count: 50000, format: 'copc', colour: true, classes: ['1', '2'] })
  expect(back.nodes).toBeGreaterThan(1)

  // The streamed cloud, written as COPC from its octree.
  await page.locator('.list-item').filter({ hasText: 'back.copc.laz' }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Download…' }).click()
  await dialog.getByRole('radiogroup', { name: 'Format' }).locator('[data-id="copc"]').click()
  const again = await download(page, () => dialog.getByRole('button', { name: 'Export', exact: true }).click())
  const twice = await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const cloud = await useReconstructionStore().importCopcCloud(new File([u8], 'twice.copc.laz'))
    return { count: cloud?.count, nodes: cloud?.lod.nodeCount }
  }, again.bytes.toString('base64'))
  expect(twice).toEqual({ count: 50000, nodes: back.nodes })
  expect(errors).toEqual([])
})
