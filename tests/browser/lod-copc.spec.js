import { test, expect } from './fixtures.js'

// COPC read in place (core/lod/copc.js): a COPC file is a level-of-detail octree
// already, so its import copies it into the project and reads its nodes from there,
// with no octree of ours. The cloud is a streamed one like an oversized LAS: drawn
// through the octree (node chunks decoded in their own worker), gridded, cropped and
// exported from it, and it survives a reload.
// Fixture: src/core/lod/fixtures/tiny.copc.laz (PDAL, 24 000 points, EPSG:25832).

test('a COPC reference cloud is read in place, drawn through its own octree, used by the tools, and survives a reload', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  const imported = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const bytes = await (await fetch('/src/core/lod/fixtures/tiny.copc.laz')).arrayBuffer()
    const store = useReconstructionStore()
    const labels = new Set()
    const cloud = await store.importCopcCloud(new File([bytes], 'tiny.copc.laz'), (d, t, label) => labels.add(label))
    if (!cloud) {
      const { useLog } = await import('/src/composables/useLog.js')
      return {
        failed: useLog()
          .entries.value.filter((e) => e.level === 'error')
          .map((e) => e.message ?? e.msg ?? JSON.stringify(e)),
      }
    }
    return {
      count: cloud.count,
      pos: cloud.pos,
      format: cloud.lod.format,
      nodes: cloud.lod.nodeCount,
      crs: cloud.lod.file.crs,
      colour: cloud.lod.layout.colour,
      dataFile: cloud.lod.dataFile.endsWith('.copc.laz'),
      hierarchyFile: cloud.lod.hierarchyFile,
      labels: [...labels],
    }
  })
  expect(imported).toEqual({
    count: 24_000,
    pos: null,
    format: 'copc',
    nodes: 5,
    crs: 'EPSG:25832',
    colour: true,
    dataFile: true,
    hierarchyFile: null,
    labels: ['Reading the COPC hierarchy', 'Copying the file into the project'],
  })
  await page.locator('.section-name', { hasText: 'Reference Data' }).click()
  await expect(page.locator('.imported-badge', { hasText: 'COPC' })).toHaveCount(1)

  const viewer = page.locator('.viewer')
  const layer = () =>
    viewer.evaluate((el) => {
      const l = [...el.__vueParentComponent.setupState.cloudLayers.values()][0]
      return l ? { lod: !!l.lod, ready: l.ready, visible: l.visiblePoints } : null
    })
  await expect.poll(async () => (await layer())?.visible ?? 0, { timeout: 30_000 }).toBeGreaterThan(10_000)
  expect((await layer()).lod).toBe(true)

  const tools = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { DEM_DEFAULTS } = await import('/src/core/defaults.user.js')
    const store = useReconstructionStore()
    const c = store.clouds[0]
    await store.generateDem({ ...DEM_DEFAULTS, points: 'all', gsd: 2, extent: 'all' })
    const dem = store.dem && { width: store.dem.width, height: store.dem.height }
    // The building (x 40–70 m, y 20–50 m from the survey's corner) into a resident cloud.
    const crop = await store.editClouds({
      mode: 'crop',
      sourceIds: [c.id],
      settings: { min: [480040, 5200020, null], max: [480070, 5200050, null] },
      name: 'block',
    })
    // Keep outside the box: an edit of the COPC cloud itself, into a streamed cloud of ours.
    const outside = await store.editClouds({
      mode: 'crop',
      sourceIds: [c.id],
      settings: { min: [480040, 5200020, null], max: [480070, 5200050, null], invert: true },
      name: 'around',
    })
    const { blob } = await store.exportCloudLod(c, { format: 'las' })
    const head = new DataView(await blob.slice(0, 375).arrayBuffer())
    return {
      dem,
      crop: crop && {
        count: crop.count,
        resident: !!crop.pos,
        classes: [...new Set(crop.attributes.classification)].sort(),
      },
      outside: outside && {
        sum: outside.count + crop.count,
        streamed: !outside.pos && !!outside.lod,
        format: outside.lod.format ?? 'websfm',
      },
      las: { count: head.getUint32(107, true), scale: head.getFloat64(131, true) },
    }
  })
  // The survey is 120 m × 80 m: a 2 m grid of about 60 × 40 cells.
  expect(tools.dem.width).toBeGreaterThan(55)
  expect(tools.dem.width).toBeLessThan(65)
  expect(tools.dem.height).toBeGreaterThan(36)
  expect(tools.dem.height).toBeLessThan(45)
  expect(tools.crop.resident).toBe(true)
  expect(tools.crop.count).toBeGreaterThan(2000)
  expect(tools.crop.classes).toContain(6)
  expect(tools.outside).toEqual({ sum: 24_000, streamed: true, format: 'websfm' })
  expect(tools.las).toEqual({ count: 24_000, scale: 0.01 })

  await page.reload()
  await page.locator('.project-main').filter({ hasText: 'My Project' }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.locator('.tab').filter({ hasText: /^3D$/ }).click()
  await expect.poll(async () => (await layer())?.visible ?? 0, { timeout: 30_000 }).toBeGreaterThan(10_000)
  const restored = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const c = useReconstructionStore().clouds.find((x) => x.lod?.format === 'copc')
    return { count: c.count, pos: c.pos, format: c.lod.format }
  })
  expect(restored).toEqual({ count: 24_000, pos: null, format: 'copc' })
  expect(errors).toEqual([])
})
