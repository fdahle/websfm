import { test, expect } from '@playwright/test'

// The console's command line: Ctrl-K opens and focuses it, ribbon commands and the
// verbs (help, set, stats, run, pair, select) act through the app's real wiring.
test('Ctrl-K focuses the console, whose verbs reach the stores and the workflow runner', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  await page.locator('body').click({ position: { x: 5, y: 300 } })
  await page.keyboard.press('Control+k')
  const prompt = page.locator('.prompt-input')
  await expect(prompt).toBeFocused()
  const log = page.locator('.console-body')
  const type = async (line) => { await prompt.fill(line); await prompt.press('Enter') }

  await type('help set')
  await expect(log).toContainText('usage: set <group>.<key> <value>')

  await type('set sfm.minPnpInlierRatio 0.5')
  await expect(log).toContainText('sfm.minPnpInlierRatio: 0.3 → 0.5 (default 0.3)')
  const override = await page.evaluate(async () => (await import('/src/stores/tuningOverrides.js')).tuningOverrides('sfm'))
  expect(override).toEqual({ minPnpInlierRatio: 0.5 })
  await type('set sfm.reprjThreshold 2')
  await expect(log).toContainText('is a Sparse Model dialog setting')

  // A stage with no input is refused by the runner's preflight, and nothing stays paused.
  await type('run detect')
  await expect(log).toContainText('Workflow blocked: Detect Features: requires images')
  await type('run detect')
  await expect(log.getByText('Workflow blocked: Detect Features: requires images')).toHaveCount(2)

  // Two images and one verified pair, seeded straight into the stores.
  await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
    const images = useImagesStore()
    for (const [id, name] of [[101, 'DJI_0001.JPG'], [102, 'DJI_0002.JPG']]) {
      images.images.push({ id, uuid: `u${id}`, name, width: 100, height: 100, kpStatus: 'done', kpCount: 50, meta: null })
    }
    const m = useMatchesStore()
    m.matchStore.set(m.pairId('u101', 'u102'), { idA: 'u101', idB: 'u102', rawCount: 80, inlierCount: 60, F: null, nMatches: 60,
      src: null, status: 'done', enabled: true, weak: false })
    m.matchStore = new Map(m.matchStore)
  })
  await type('stats')
  await expect(log).toContainText('Images: 2 (2 with keypoints, 100 keypoints)')
  await expect(log).toContainText('Pairs: 1 verified of 1 matched')
  await type('pair disable DJI_0001 DJI_0002')
  await expect(log).toContainText('DJI_0001.JPG ↔ DJI_0002.JPG (60 inliers) excluded from reconstruction')
  const enabled = await page.evaluate(async () => {
    const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
    const m = useMatchesStore()
    return m.getMatch('u101', 'u102').enabled
  })
  expect(enabled).toBe(false)
  await type('select 0002')
  await expect(log).toContainText('Selected DJI_0002.JPG')
  expect(await page.evaluate(async () => (await import('/src/stores/useImagesStore.js')).useImagesStore().selectedId)).toBe(102)

  // A saved workflow with an interactive block: the console reports the wait and answers it.
  await page.evaluate(async () => {
    const { useWorkflowsStore } = await import('/src/stores/useWorkflowsStore.js')
    const { createWorkflow } = await import('/src/core/workflow.js')
    useWorkflowsStore().addWorkflow(createWorkflow('Review only', ['eval-overview']))
  })
  await type('run workflow review')
  await expect(log).toContainText('Workflow waiting: Quality Report needs your input.')
  await page.keyboard.press('Escape')
  await prompt.click()
  await type('continue')
  await expect(log).toContainText('Workflow complete: Review only')

  // A ribbon command by its short name opens its dialog.
  await type('settings')
  await expect(page.getByRole('dialog', { name: /Settings/ })).toBeVisible()
  expect(errors).toEqual([])
})
