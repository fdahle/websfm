import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Reconstruct ▸ Rebuild Outdated on the saved five-photo Aukerman project (a dense
// cloud, a mesh, a DEM and an orthophoto on its sparse model): once the model changes,
// a toast offers the rebuild, and its workflow holds the outdated products' steps in
// order, each set to run again.
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
}

test('a changed model offers Rebuild Outdated, whose workflow rebuilds the products in order', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  // The project was saved with its DEM and orthophoto outdated (built in a georeference
  // it no longer has): the command can rebuild them, but that is not news, so no offer.
  await page.getByRole('button', { name: 'Reconstruct', exact: true }).click()
  const command = page.locator('.ribbon').getByRole('button', { name: /Rebuild\s*Outdated/ })
  await expect(command).toBeEnabled()
  await page.waitForTimeout(500)
  await expect(page.locator('.toast', { hasText: 'outdated' })).toHaveCount(0)
  const kinds = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const r = useReconstructionStore()
    const main = [r.mainDenseCloud, r.mainMeshCloud, r.dem, r.ortho]
    // The model changes, as Optimize Cameras or gradual selection change it.
    r.mainSparseCloud.createdAt = Date.now()
    return main.map((p) => !!p)
  })
  // Now the dense cloud and the mesh are outdated too: that is offered.
  const toast = page.locator('.toast', { hasText: 'outdated' })
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('4 products are outdated')
  await toast.click()
  await expect(page.getByRole('dialog', { name: /Workflow/ })).toBeVisible()
  const wf = await page.evaluate(async () => {
    const { useWorkflowsStore } = await import('/src/stores/useWorkflowsStore.js')
    const s = useWorkflowsStore()
    const w = s.workflows.find((x) => x.id === s.activeId)
    return { name: w.name, blocks: w.blocks.map((b) => [b.type, b.reusePolicy]) }
  })
  expect(wf.name).toBe('Rebuild outdated')
  const want = ['dense', 'gen-mesh', 'gen-dem', 'gen-ortho'].filter((_, i) => kinds[i])
  // Georeference first (the DEM and orthophoto were built in one the model no longer has).
  expect(wf.blocks[0][0]).toBe('georeference')
  expect(wf.blocks.map(([t]) => t).filter((t) => t !== 'compute-depth' && t !== 'georeference')).toEqual(want)
  expect(wf.blocks.every(([, policy]) => policy === 'rerun')).toBe(true)
  // A second time replaces the workflow instead of adding another.
  await page.evaluate(async () => {
    const { openRebuildWorkflow } = await import('/src/composables/useRebuildOutdated.js')
    await openRebuildWorkflow()
  })
  const count = await page.evaluate(async () => {
    const { useWorkflowsStore } = await import('/src/stores/useWorkflowsStore.js')
    return useWorkflowsStore().workflows.filter((w) => w.name === 'Rebuild outdated').length
  })
  expect(count).toBe(1)
  expect(errors).toEqual([])
})
