import { test, expect } from './fixtures.js'
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

  // Project A: new and empty, then Import ▸ WebSfM Project.
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
  // The model comes in last (Its model: Bring in). A project without a model takes the
  // imported one as it is; wait for it, which also means every step before it is done.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
          return useReconstructionStore().mainSparseCloud?.cameras?.size ?? 0
        }),
      { timeout: 60_000 },
    )
    .toBe(5)

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

// Import ▸ Project with Its model ▸ Merge (core/sfm/modelMerge.js), against known truth:
// B is the fixture with its model moved by a similarity (another frame, as a project
// solved apart has); A is the fixture with two cameras taken out of its model. Placed by
// the three photos both solved, B's two cameras land where the fixture had them.
async function openFixture(page) {
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    document
      .querySelector('#app')
      .__vue_app__._instance.setupState.importProjectFile(new File([u8], 'aukerman-5.websfm'))
  }, readFileSync(fixture).toString('base64'))
  if (await page.evaluate(() => typeof window.showDirectoryPicker === 'function')) {
    await page
      .getByRole('dialog', { name: 'Open project file' })
      .getByRole('button', { name: 'In this browser' })
      .click()
  }
  await expect(page.locator('.toast', { hasText: 'Project opened' }).last()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.locator('.toast').evaluateAll((els) => els.forEach((e) => e.remove()))
}

test('a model solved apart is merged into this one, placed by the photos both solved', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)

  // B: the fixture, its model moved by s = 3, a turn about z and a shift.
  await openFixture(page)
  const bId = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { transformCamera } = await import('/src/core/sfm/modelMerge.js')
    const { applySimilarity } = await import('/src/core/products/georef.js')
    const recon = useReconstructionStore()
    const main = recon.mainSparseCloud
    const a = 0.8
    const sim = {
      scale: 3,
      R: [
        [Math.cos(a), -Math.sin(a), 0],
        [Math.sin(a), Math.cos(a), 0],
        [0, 0, 1],
      ],
      t: [50, -20, 7],
    }
    const cameras = new Map([...main.cameras].map(([u, c]) => [u, transformCamera(c, sim)]))
    const pos = new Float64Array(3 * main.points.length)
    for (let i = 0; i < main.points.length; i++) pos.set(applySimilarity(sim, main.points.xyz(i)), 3 * i)
    await recon.addMergedModel({
      cameras,
      points: main.points.withPositions(pos),
      calibration: main.calibration,
      name: 'Moved',
    })
    return useProjectsStore().currentProjectId
  })

  // A: the fixture again, without two of its cameras.
  await openFixture(page)
  const truth = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { cameraCenter } = await import('/src/core/sfm/geometry.js')
    const recon = useReconstructionStore()
    const main = recon.mainSparseCloud
    const out = [...main.cameras.keys()].sort().slice(3)
    const truth = Object.fromEntries(out.map((u) => [u, cameraCenter(main.cameras.get(u))]))
    const cameras = new Map([...main.cameras].filter(([u]) => !out.includes(u)))
    const { points } = main.points.withoutViews(new Set(out), 2)
    await recon.addMergedModel({ cameras, points, calibration: main.calibration, name: 'Three' })
    return truth
  })
  expect(Object.keys(truth)).toHaveLength(2)

  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().importProjectOpen = true
  })
  const dialog = page.getByRole('dialog', { name: 'Import Project' })
  await dialog.locator('#imp-proj-src').selectOption(bId)
  await expect(dialog.locator('#imp-proj-model')).toHaveValue('merge')
  await dialog.locator('#imp-proj-align').selectOption('photos')
  await dialog.getByRole('button', { name: 'Import', exact: true }).click()
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
          return useReconstructionStore().mainSparseCloud?.name ?? ''
        }),
      { timeout: 120_000 },
    )
    .toMatch(/\+/)

  const result = await page.evaluate(async (truth) => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { cameraCenter } = await import('/src/core/sfm/geometry.js')
    const recon = useReconstructionStore()
    const main = recon.mainSparseCloud
    const span = Math.max(...Object.values(truth).flatMap((c) => c.map(Math.abs)), 1)
    const err = Object.entries(truth).map(([u, c]) => {
      const cam = main.cameras.get(u)
      return cam ? Math.hypot(...cameraCenter(cam).map((v, i) => v - c[i])) / span : Infinity
    })
    const sparse = recon.clouds.filter((c) => c.kind === 'sparse')
    return {
      cameras: main.cameras.size,
      worst: Math.max(...err),
      models: sparse.map((c) => c.name),
      groups: (main.calibration?.groups ?? []).filter((g) => g.imageUuid && truth[g.imageUuid]).length,
    }
  }, truth)
  expect(result.cameras).toBe(5)
  // The fixture's rotations are orthonormal to ~1e-7 only, so moving B and placing it
  // back leaves ~1e-6 of the span; a wrong placement is off by the span itself.
  expect(result.worst).toBeLessThan(1e-4)
  expect(result.models).toContain('Three') // the model it was merged into stays
  expect(result.groups).toBe(2) // B's two cameras keep B's lens
  expect(errors).toEqual([])
})
