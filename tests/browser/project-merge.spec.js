import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

// Import ▸ Project into this project (composables/useProjectMerge.js): the saved v1
// fixture (5 photos with features, matches, a model and two markers) imported into a new
// empty project brings its photos with their features, matches, sensor and marks, and a
// sparse run of the new project builds the same 5-camera model from them.
const fixture = new URL('../fixtures/projects/v1/aukerman-5.websfm', import.meta.url)
test('a project imported into another brings photos, features, matches and marks', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)

  // Project B: the fixture.
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    window.__fixture = new File([u8], 'aukerman-5.websfm')
  }, readFileSync(fixture).toString('base64'))
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
  const source = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
    return {
      id: useProjectsStore().currentProjectId,
      keypoints: useImagesStore()
        .images.map((im) => im.kpCount)
        .sort(),
      pairs: useMatchesStore().matchStore.size,
    }
  })

  // Project A: new and empty, then Import ▸ WebSfM Project….
  await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState
    await app.handleCreateProject({ name: 'Merged', sceneType: 'aerial', crs: 'EPSG:32617' })
  })
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().importProjectOpen = true
  })
  const dialog = page.getByRole('dialog', { name: 'Import Project' })
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  // Done when every photo has its features and the pairs have arrived.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { useImagesStore } = await import('/src/stores/useImagesStore.js')
          const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
          const done = useImagesStore().images.filter((im) => im.kpStatus === 'done').length
          return `${done}:${useMatchesStore().matchStore.size}`
        }),
      { timeout: 120_000 },
    )
    .toBe(`5:${source.pairs}`)
  await expect(page.locator('.progress-modal')).toHaveCount(0, { timeout: 30_000 })

  const merged = await page.evaluate(async (sourceId) => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const opfs = await import('/src/utils/opfs.js')
    const images = useImagesStore().images
    const projects = useProjectsStore()
    // The matches are this project's own once saved: read back from its document.
    const doc = await opfs.loadMatchIndex(projects.currentProjectId, ['pairs'])
    return {
      other: projects.currentProjectId !== sourceId,
      images: images.length,
      done: images.filter((im) => im.kpStatus === 'done').length,
      keypoints: images.map((im) => im.kpCount).sort(),
      onDisk: (await Promise.all(images.map((im) => opfs.loadKeypoints(projects.currentProjectId, im.uuid)))).filter(
        Boolean,
      ).length,
      pairs: useMatchesStore().matchStore.size,
      savedPairs: !!doc,
      sensors: useSensorsStore().sensors.length,
      marks: useGcpsStore().gcps.reduce((n, g) => n + g.observations.filter((o) => o.imageId).length, 0),
      markers: useGcpsStore().gcps.length,
    }
  }, source.id)
  expect(merged).toMatchObject({
    other: true,
    images: 5,
    done: 5,
    keypoints: source.keypoints,
    onDisk: 5,
    pairs: source.pairs,
    savedPairs: true,
    sensors: 1,
    markers: 2,
  })
  expect(merged.marks).toBeGreaterThan(0)

  // The imported features and matches build the model in the new project.
  const cameras = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { RECONSTRUCT_DEFAULTS } = await import('/src/core/defaults.user.js')
    const recon = useReconstructionStore()
    await recon.reconstruct({ ...RECONSTRUCT_DEFAULTS })
    return recon.mainSparseCloud?.cameras?.size ?? 0
  })
  expect(cameras).toBe(5)
  expect(errors).toEqual([])
})

test('a cancelled import keeps the photos already in, with their features and pairs', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    window.__fixture = new File([u8], 'aukerman-5.websfm')
  }, readFileSync(fixture).toString('base64'))
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
  const sourceId = await page.evaluate(
    async () => (await import('/src/stores/useProjectsStore.js')).useProjectsStore().currentProjectId,
  )
  await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState
    await app.handleCreateProject({ name: 'Merged', sceneType: 'aerial', crs: 'EPSG:32617' })
  })
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // One photo per batch, and a cancel once two are in.
  const r = await page.evaluate(async (sourceId) => {
    const { PROJECT_IMPORT_TUNING } = await import('/src/core/tuning.js')
    PROJECT_IMPORT_TUNING.photosPerBatch = 1
    const { useProjectMerge } = await import('/src/composables/useProjectMerge.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
    const result = await useProjectMerge().importProjectInto(
      sourceId,
      () => {},
      () => useImagesStore().images.length >= 2,
    )
    PROJECT_IMPORT_TUNING.photosPerBatch = 16
    const images = useImagesStore().images
    const uuids = new Set(images.map((im) => im.uuid))
    const pairs = [...useMatchesStore().matchStore.values()]
    return {
      cancelled: result.cancelled,
      images: images.length,
      done: images.filter((im) => im.kpStatus === 'done').length,
      pairs: pairs.length,
      pairsOnImported: pairs.every((e) => uuids.has(e.idA) && uuids.has(e.idB)),
    }
  }, sourceId)
  expect(r).toEqual({ cancelled: true, images: 2, done: 2, pairs: 1, pairsOnImported: true })
  expect(errors).toEqual([])
})
