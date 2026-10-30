import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Disable in the image list (core/imageEnabled.js): the photo keeps its pose, the next
// depth map run leaves it out, and the flag is saved. Tools ▸ Images ▾ ▸ Reduce overlap
// disables the photos it does not need the same way. The project is the format fixture
// (tests/fixtures/projects/v1: five photos with a sparse model), as in run-resume.spec.js.
const fixture = readFileSync(new URL('../fixtures/projects/v1/aukerman-5.websfm', import.meta.url))

async function openFixture(page) {
  await page.goto('/')
  // A project first, so the first-run New Project dialog is not left over the list.
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
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
  if (await page.locator('.project-backdrop').isVisible()) await page.keyboard.press('Escape')
  await expect(page.locator('.project-backdrop')).toHaveCount(0)
  return page.evaluate(
    async () => (await import('/src/stores/useProjectsStore.js')).useProjectsStore().currentProjectId,
  )
}

test('a disabled photo keeps its pose, is left out of depth maps, and stays disabled', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the run logic')
  test.setTimeout(240_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const id = await openFixture(page)

  const first = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    return useImagesStore().images[0].name
  })
  const openImages = () => page.getByRole('button', { name: /^▸ Images/ }).click()
  await openImages()
  const row = page.locator('.list-item').filter({ hasText: first })
  await row.click({ button: 'right' })
  await page.getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(row.locator('.off-tag')).toBeVisible()

  await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState
    return import('/src/core/defaults.user.js').then(({ DEPTHMAP_DEFAULTS }) =>
      app.runComputeDepthMaps({ ...DEPTHMAP_DEFAULTS, quality: 'low', useGpu: false, keepMaps: false }),
    )
  })
  const after = await page.evaluate(async (id) => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const opfs = await import('/src/utils/opfs.js')
    const off = useImagesStore().images[0]
    const index = await opfs.loadDepthIndex(id)
    return {
      maps: index.maps.length,
      offHasMap: index.maps.some((m) => m.uuid === off.uuid),
      offHasPose: useReconstructionStore().mainSparseCloud.cameras.has(off.uuid),
    }
  }, id)
  expect(after).toEqual({ maps: 4, offHasMap: false, offHasPose: true })
  const said = await page.evaluate(async () => {
    const { useLog } = await import('/src/composables/useLog.js')
    return useLog().entries.value.some((e) => e.message.includes('1 disabled image left out of the depth maps'))
  })
  expect(said).toBe(true)

  // Saved: the project opened again still has it disabled, and Enable brings it back.
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate(
    (id) => document.querySelector('#app').__vue_app__._instance.setupState.handleSwitchProject(id),
    id,
  )
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  if (await page.locator('.project-picker').isVisible()) await page.keyboard.press('Escape')
  if (!(await row.isVisible())) await openImages()
  await expect(row.locator('.off-tag')).toBeVisible({ timeout: 30_000 })
  await row.click({ button: 'right' })
  await page.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(row.locator('.off-tag')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('Reduce overlap counts as the settings change and disables the photos it does not need', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Images' }).click()
  await page.getByRole('menuitem', { name: /Reduce overlap/ }).click()
  const dialog = page.locator('.modal', { hasText: 'Reduce Overlap' })
  await expect(dialog).toContainText('sparse points stand in for the surface')

  // One photo per point: the five-photo block needs fewer than five.
  await dialog.locator('#ro-coverage').fill('1')
  await expect(dialog).toContainText(/Keeps \d of the 5 enabled photos/)
  const label = await dialog.getByRole('button', { name: /^Disable \d+ photos?$/ }).textContent()
  const n = Number(label.match(/\d+/)[0])
  expect(n).toBeGreaterThan(0)
  expect(n).toBeLessThan(5)
  await dialog.getByRole('button', { name: /^Disable \d+ photos?$/ }).click()
  await expect(dialog).toHaveCount(0)
  const disabled = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    return useImagesStore().images.filter((im) => im.enabled === false).length
  })
  expect(disabled).toBe(n)
  expect(errors).toEqual([])
})
