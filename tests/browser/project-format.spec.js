import { test, expect } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'

// Every committed saved project (tests/fixtures/projects/v<n>/, made by
// scripts/fixtures/make-project-fixture.mjs) still opens in this version with everything
// it held: the promise the format migrations keep (core/formatMigrations.js). A change
// that older projects cannot satisfy fails here until it raises PROJECT_FORMAT_VERSION
// with a migration.
const root = new URL('../fixtures/projects/', import.meta.url)
const versions = readdirSync(root).filter((d) => /^v\d+$/.test(d))

test('there is a saved project for the current format version', async () => {
  const { PROJECT_FORMAT_VERSION } = await import('../../src/core/projectFormat.js')
  expect(versions, `make one: node scripts/fixtures/make-project-fixture.mjs <work dir>`).toContain(
    `v${PROJECT_FORMAT_VERSION}`,
  )
})

for (const version of versions) {
  test(`a project saved in format ${version.slice(1)} opens with everything it held`, async ({ page }) => {
    test.setTimeout(120_000)
    const expected = JSON.parse(readFileSync(new URL(`${version}/expected.json`, root), 'utf8'))
    const bytes = readFileSync(new URL(`${version}/aukerman-5.websfm`, root))
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/')
    await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)

    await page.evaluate((b64) => {
      const bin = atob(b64)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      window.__fixture = new File([u8], 'aukerman-5.websfm')
    }, bytes.toString('base64'))
    // Not awaited: the open waits for the answer below.
    await page.evaluate(() => {
      document.querySelector('#app').__vue_app__._instance.setupState.importProjectFile(window.__fixture)
    })
    // Where folders are possible (Chromium) the open asks where to keep the project.
    if (await page.evaluate(() => typeof window.showDirectoryPicker === 'function')) {
      const ask = page.getByRole('dialog', { name: 'Open project file' })
      await ask.getByRole('button', { name: 'In this browser' }).click()
    }
    await expect(page.locator('.toast', { hasText: 'Project opened' })).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.loading-overlay')).toHaveCount(0)

    const got = await page.evaluate(async () => {
      const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
      const { useImagesStore } = await import('/src/stores/useImagesStore.js')
      const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
      const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
      const { useScaleBarsStore } = await import('/src/stores/useScaleBarsStore.js')
      const { usePosesStore } = await import('/src/stores/usePosesStore.js')
      const { PROJECT_FORMAT_VERSION } = await import('/src/core/projectFormat.js')
      const opfs = await import('/src/utils/opfs.js')
      const projects = useProjectsStore()
      const recon = useReconstructionStore()
      const computed = (kind) => recon.clouds.find((c) => c.kind === kind && !c.imported && !c.derived)
      const sparse = recon.mainSparseCloud
      return {
        current: PROJECT_FORMAT_VERSION,
        savedAs: (await opfs.readProject(projects.currentProjectId)).formatVersion,
        crs: projects.currentCrs,
        images: useImagesStore().images.length,
        cameras: sparse?.cameras?.size ?? 0,
        sparsePoints: sparse?.points?.length ?? 0,
        densePoints: computed('dense')?.count ?? 0,
        meshTriangles: computed('mesh')?.count ?? 0,
        depthMaps: recon.depthMapCount,
        dem: recon.dem ? { width: recon.dem.width, height: recon.dem.height } : null,
        ortho: recon.ortho ? { width: recon.ortho.width, height: recon.ortho.height } : null,
        markers: useGcpsStore().gcps.filter((g) => g.role === 'marker').length,
        scaleBars: useScaleBarsStore().bars.length,
        poses: usePosesStore().poses.length,
      }
    })
    // Opened means brought up to this version.
    expect(got.savedAs).toBe(got.current)
    expect(got).toMatchObject({
      crs: expected.crs,
      images: expected.images,
      cameras: expected.cameras,
      sparsePoints: expected.sparsePoints,
      densePoints: expected.densePoints,
      meshTriangles: expected.meshTriangles,
      depthMaps: expected.depthMaps,
      dem: expected.dem,
      ortho: expected.ortho,
      markers: expected.markers,
      scaleBars: expected.scaleBars,
      poses: expected.poses,
    })
    if (expected.formatVersion < got.current) {
      await expect(page.locator('body')).toContainText(/./) // the page is up; the log line below says why
      const logged = await page.evaluate(async () => {
        const { useLogStore } = await import('/src/stores/useLogStore.js')
        return (await useLogStore().readAll()).map((e) => e.message ?? e.msg ?? String(e))
      })
      expect(logged.some((m) => /Project upgraded: format/.test(m))).toBe(true)
    }
    expect(errors).toEqual([])
  })
}
