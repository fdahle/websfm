import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

// A depth-map run whose tab dies continues where it stopped (core/runJournal.js): the
// page is closed while the run is under way, the project is opened again, Continue is
// clicked, and the maps match an uninterrupted run. The project is the format fixture
// (tests/fixtures/projects/v1: five photos).
const fixture = readFileSync(new URL('../fixtures/projects/v1/aukerman-5.websfm', import.meta.url))

async function openFixture(page) {
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    window.__fixture = new File([u8], 'aukerman-5.websfm')
  }, fixture.toString('base64'))
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
  return page.evaluate(
    async () => (await import('/src/stores/useProjectsStore.js')).useProjectsStore().currentProjectId,
  )
}

// The CPU path, one map after another on one worker, at a size where each takes a while.
const startDepth = (page, method, quality) =>
  page.evaluate(
    ({ method, quality }) => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState
      return import('/src/core/defaults.user.js').then(({ DEPTHMAP_DEFAULTS }) => {
        window.__depthRun = app.runComputeDepthMaps({
          ...DEPTHMAP_DEFAULTS,
          quality,
          method,
          useGpu: false,
          _journalMs: 0, // every saved map in the journal at once, so the test sees each
        })
      })
    },
    { method, quality },
  )

const journal = (page, id) =>
  page.evaluate(async (id) => (await import('/src/utils/opfs.js')).loadRunJournal(id, 'depth'), id)

// What each saved map is: its size and coverage, and a digest of its depth plane.
const savedMaps = (page, id) =>
  page.evaluate(async (id) => {
    const opfs = await import('/src/utils/opfs.js')
    const index = await opfs.loadDepthIndex(id)
    const root = await navigator.storage.getDirectory()
    const dir = await (
      await (await root.getDirectoryHandle('websfm')).getDirectoryHandle('projects')
    )
      .getDirectoryHandle(id)
      .then((d) => d.getDirectoryHandle('depthmaps'))
    const out = {}
    for (const m of index?.maps ?? []) {
      const bytes = new Uint8Array(
        await (await (await dir.getFileHandle(`${m.uuid}.depth.bin`)).getFile()).arrayBuffer(),
      )
      let h = 2166136261
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0
      out[m.uuid] = { width: m.width, height: m.height, validPx: m.validPx, depth: h.toString(16) }
    }
    return out
  }, id)

// Each case at a size where every map takes a moment on the CPU, so the kill lands
// between two of them.
for (const [method, phase, quality] of [
  ['fast', 'pass1', 'high'],
  ['full', 'pass2', 'medium'],
]) {
  test(`a depth-map run (${method}) killed in ${phase} continues where it stopped`, async ({
    browser,
    browserName,
  }) => {
    test.skip(browserName !== 'chromium', 'one browser is enough for the run logic')
    test.setTimeout(480_000)
    const context = await browser.newContext()
    let page = await context.newPage()
    // Each page error says which step raised it (one WASM trap was seen once, in a full
    // suite run, and not again in repeats).
    const errors = []
    let step = 'reference run'
    const watch = (p) => p.on('pageerror', (e) => errors.push(`${step}: ${e.message}`))
    watch(page)
    const id = await openFixture(page)

    // The reference: the same run, uninterrupted.
    await startDepth(page, method, quality)
    await page.evaluate(() => window.__depthRun)
    const reference = await savedMaps(page, id)
    expect(Object.keys(reference)).toHaveLength(5)
    expect(await journal(page, id)).toBeNull() // a finished run leaves no journal

    // The same run again, and the tab dies once some maps of `phase` are saved.
    step = 'run to be killed'
    await startDepth(page, method, quality)
    await expect
      .poll(
        async () => {
          const j = await journal(page, id)
          return j?.phase === phase && j.done.length >= 1 && j.done.length < 5
        },
        { timeout: 120_000, intervals: [100] },
      )
      .toBe(true)
    const stoppedAt = (await journal(page, id)).done.length
    await page.close()
    step = 'continued run'

    page = await context.newPage()
    watch(page)
    await page.goto('/')
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
    await page.evaluate(
      (id) => document.querySelector('#app').__vue_app__._instance.setupState.handleSwitchProject(id),
      id,
    )
    const ask = page.getByRole('dialog', { name: 'Continue the stopped run?' })
    await expect(ask).toContainText(`Depth maps stopped at ${stoppedAt} of 5`)
    await ask.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect
      .poll(async () => (await journal(page, id)) === null && (await savedMaps(page, id)), { timeout: 120_000 })
      .toEqual(reference)
    const logged = await page.evaluate(async () => {
      const { useLogStore } = await import('/src/stores/useLogStore.js')
      return (await useLogStore().readAll()).map((e) => e.message ?? e.msg ?? String(e))
    })
    expect(logged.some((m) => /Dense: continuing the stopped run/.test(m))).toBe(true)
    expect(errors).toEqual([])
    await context.close()
  })
}

// Every pair's outcome, as the match store holds it after the run.
const matchOutcomes = (page) =>
  page.evaluate(async () => {
    const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
    const out = {}
    for (const [id, e] of useMatchesStore().matchStore) {
      out[id] = {
        status: e.status,
        inliers: e.inlierCount ?? 0,
        raw: e.rawCount ?? 0,
        F: e.F ? [e.F].flat(2).map((v) => +Number(v).toFixed(9)) : null,
      }
    }
    return out
  })

test('a matching run killed in the pair loop continues where it stopped', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the run logic')
  test.setTimeout(240_000)
  const context = await browser.newContext()
  // One worker: the pairs finish one after another, so the kill lands between two.
  await context.addInitScript(() => localStorage.setItem('websfm.compute.workerCount', '1'))
  let page = await context.newPage()
  const errors = []
  const watch = (p) => p.on('pageerror', (e) => errors.push(e.message))
  watch(page)
  const id = await openFixture(page)
  const startMatch = () =>
    page.evaluate(() => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState
      window.__matchRun = app.runMatch({ _journalMs: 0 })
    })
  const matchJournal = () =>
    page.evaluate(async (id) => (await import('/src/utils/opfs.js')).loadRunJournal(id, 'match'), id)

  // The fixture leaves out descriptors (only matching reads them): detect again first.
  await page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState
    const { DETECT_DEFAULTS_BY_DETECTOR } = await import('/src/core/defaults.user.js')
    await app.runDetect({ ...DETECT_DEFAULTS_BY_DETECTOR.sift, overwrite: true, maxKeypoints: 1500 })
  })
  await startMatch()
  await page.evaluate(() => window.__matchRun)
  const reference = await matchOutcomes(page)
  expect(Object.values(reference).filter((e) => e.status === 'done' && e.inliers > 0).length).toBeGreaterThan(5)
  expect(Object.keys(reference)).toHaveLength(10)
  expect(await matchJournal()).toBeNull()

  await startMatch()
  await expect
    .poll(
      async () => {
        const j = await matchJournal()
        return j?.phase === 'pairs' && j.done.length >= 1 && j.done.length < 10
      },
      { timeout: 60_000, intervals: [25] },
    )
    .toBe(true)
  const stoppedAt = (await matchJournal()).done.length
  await page.close()

  page = await context.newPage()
  watch(page)
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate(
    (id) => document.querySelector('#app').__vue_app__._instance.setupState.handleSwitchProject(id),
    id,
  )
  const ask = page.getByRole('dialog', { name: 'Continue the stopped run?' })
  await expect(ask).toContainText(`Matching stopped at ${stoppedAt} of 10`)
  await ask.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect
    .poll(async () => (await matchJournal()) === null && (await matchOutcomes(page)), { timeout: 60_000 })
    .toEqual(reference)
  expect(errors).toEqual([])
  await context.close()
})

// Each image's keypoint count and a digest of its saved keypoint file.
const keypointFiles = (page, id) =>
  page.evaluate(async (id) => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const root = await navigator.storage.getDirectory()
    const project = await (
      await (await root.getDirectoryHandle('websfm')).getDirectoryHandle('projects')
    ).getDirectoryHandle(id)
    const dir = await project.getDirectoryHandle('keypoints')
    const out = {}
    for (const im of useImagesStore().images) {
      const bytes = new Uint8Array(await (await (await dir.getFileHandle(`${im.uuid}.bin`)).getFile()).arrayBuffer())
      let h = 2166136261
      for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0
      out[im.uuid] = { status: im.kpStatus, count: im.kpCount, file: h.toString(16) }
    }
    return out
  }, id)

test('a detection run killed partway continues where it stopped', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the run logic')
  test.setTimeout(240_000)
  const context = await browser.newContext()
  await context.addInitScript(() => localStorage.setItem('websfm.compute.workerCount', '1'))
  let page = await context.newPage()
  const errors = []
  const watch = (p) => p.on('pageerror', (e) => errors.push(e.message))
  watch(page)
  const id = await openFixture(page)
  const startDetect = () =>
    page.evaluate(async () => {
      const app = document.querySelector('#app').__vue_app__._instance.setupState
      const { DETECT_DEFAULTS_BY_DETECTOR } = await import('/src/core/defaults.user.js')
      window.__detectRun = app.runDetect({ ...DETECT_DEFAULTS_BY_DETECTOR.sift, overwrite: true, _journalMs: 0 })
    })
  const detectJournal = () =>
    page.evaluate(async (id) => (await import('/src/utils/opfs.js')).loadRunJournal(id, 'detect'), id)

  await startDetect()
  await page.evaluate(() => window.__detectRun)
  const reference = await keypointFiles(page, id)
  expect(Object.values(reference).every((r) => r.status === 'done' && r.count > 0)).toBe(true)
  expect(await detectJournal()).toBeNull()

  await startDetect()
  await expect
    .poll(
      async () => {
        const j = await detectJournal()
        return !!j && j.done.length >= 1 && j.done.length < 5
      },
      { timeout: 60_000, intervals: [25] },
    )
    .toBe(true)
  const stoppedAt = (await detectJournal()).done.length
  await page.close()

  page = await context.newPage()
  watch(page)
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate(
    (id) => document.querySelector('#app').__vue_app__._instance.setupState.handleSwitchProject(id),
    id,
  )
  const ask = page.getByRole('dialog', { name: 'Continue the stopped run?' })
  await expect(ask).toContainText(`Feature detection stopped at ${stoppedAt} of 5`)
  await ask.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect
    .poll(async () => (await detectJournal()) === null && (await keypointFiles(page, id)), { timeout: 60_000 })
    .toEqual(reference)
  const logged = await page.evaluate(async () => {
    const { useLogStore } = await import('/src/stores/useLogStore.js')
    return (await useLogStore().readAll()).map((e) => e.message ?? e.msg ?? String(e))
  })
  expect(logged.some((m) => /Detection: continuing the stopped run/.test(m))).toBe(true)
  expect(errors).toEqual([])
  await context.close()
})
