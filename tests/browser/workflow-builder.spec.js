import { test, expect } from '@playwright/test'

async function openBuilder(page) {
  await page.getByRole('button', { name: 'Reconstruct', exact: true }).click()
  await page.getByRole('button', { name: 'Workflow Builder', exact: true }).click()
  return page.getByRole('dialog', { name: 'Workflow Builder', exact: true })
}

test('new project workflow supports editing, reordering, templates and persistence', async ({ page }, testInfo) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Object capture', exact: false }).click()
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  const dialog = await openBuilder(page)
  await expect(dialog.getByText('Build your workflow', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Run workflow', exact: true })).toBeDisabled()
  await dialog.getByLabel('Workflow name', { exact: true }).fill('My sparse workflow')
  await dialog.getByLabel('Workflow name', { exact: true }).press('Tab')
  await dialog.getByRole('button', { name: 'Add Detect Features', exact: true }).click()
  await dialog.getByRole('button', { name: 'Match Features Automatic', exact: true }).click()
  await dialog.getByRole('button', { name: 'Sparse Model Automatic', exact: true }).click()
  await expect(dialog.locator('.workflow-block')).toHaveCount(3)
  await expect(dialog.getByText('Detect Features: requires images', { exact: true })).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Preset', exact: true }).selectOption('high')
  await dialog.locator('.workflow-block').last().getByTitle('Move up', { exact: true }).click()
  await expect(dialog.locator('.workflow-block').nth(1)).toContainText('Sparse Model')
  await dialog.locator('.workflow-block').nth(1).getByTitle('Move down', { exact: true }).click()
  await expect(dialog.locator('.workflow-block').last()).toContainText('Preset: high')
  await page.screenshot({ path: testInfo.outputPath('builder-desktop.png') })
  await dialog.getByRole('button', { name: 'Save template', exact: true }).click()
  await dialog.getByRole('button', { name: 'Recipe', exact: true }).click()
  await expect(dialog.locator('textarea')).toHaveValue(/workflow "My sparse workflow"[\s\S]*detect-features[\s\S]*match-features[\s\S]*reconstruct/)
  await dialog.getByRole('button', { name: 'Blocks', exact: true }).click()
  await page.setViewportSize({ width: 1024, height: 768 })
  await expect(dialog.getByRole('combobox', { name: 'Preset', exact: true })).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Preset', exact: true }).selectOption('low')
  await expect(dialog.locator('.workflow-block').last()).toContainText('Preset: low')
  await page.screenshot({ path: testInfo.outputPath('builder-compact.png') })
  await dialog.getByRole('button', { name: 'New', exact: true }).click()
  await expect(dialog.getByText('Build your workflow', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'My sparse workflow', exact: true }).click()
  await expect(dialog.locator('.workflow-block')).toHaveCount(3)
  await expect(dialog.locator('.workflow-block').last()).toContainText('Preset: high')
  // Wait for real OPFS writes, then verify the same app restore path users take.
  await expect.poll(() => page.evaluate(async () => {
    const { readIndex, loadWorkflows } = await import('/src/utils/opfs.js')
    const index = await readIndex()
    const data = await loadWorkflows(index.lastOpenedId)
    return data?.workflows?.length
  })).toBe(3)
  await page.reload()
  await page.getByText('My Project', { exact: true }).click()
  const restored = await openBuilder(page)
  await expect(restored.locator('.workflow-block')).toHaveCount(3)
  await expect(restored.getByLabel('Workflow name', { exact: true })).toHaveValue('My sparse workflow')
  expect(errors).toEqual([])
})

test('interactive workflow pauses and records a completed run', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Object capture', exact: false }).click()
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  const dialog = await openBuilder(page)
  await dialog.getByRole('button', { name: 'Quality Report Interactive', exact: true }).click()
  await dialog.getByRole('button', { name: 'Run workflow', exact: true }).click()
  const report = page.getByRole('dialog', { name: 'Quality Report', exact: true })
  await expect(report).toBeVisible()
  await report.getByRole('button', { name: 'Close', exact: true }).first().click()
  await expect(dialog.getByText('Waiting for you', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'New', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Mark complete & continue', exact: true }).click()
  await expect(dialog.locator('.run-row')).toContainText('completed')
  await expect(dialog.locator('.workflow-block .status')).toHaveText('completed')
})

test('quality gate branches to a named block and the recipe text edits the same graph', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Object capture', exact: false }).click()
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  const dialog = await openBuilder(page)
  await dialog.getByRole('button', { name: 'Add Detect Features', exact: true }).click()
  for (const name of ['Match Features Automatic', 'Sparse Model Automatic', 'Quality Gate Control', 'Sparse Model Automatic']) {
    await dialog.getByRole('button', { name, exact: true }).click()
  }
  const blocks = dialog.locator('.workflow-block')
  await blocks.nth(3).click()
  await dialog.getByRole('combobox', { name: 'Metric', exact: true }).selectOption('reprojMedianPx')
  await expect(dialog.getByRole('spinbutton', { name: 'Threshold', exact: true })).toHaveValue('1')
  await dialog.getByRole('combobox', { name: 'If it fails', exact: true }).selectOption('branch')
  await expect(dialog.getByText('Quality Gate: choose where “On fail, go to” goes', { exact: true })).toBeVisible()
  await dialog.getByRole('combobox', { name: 'On fail, go to', exact: true }).selectOption({ label: '5. Sparse Model' })
  // The target is named for the jump, and the branch shows on both blocks.
  await expect(blocks.nth(4)).toContainText('reconstruct-1')
  await expect(blocks.nth(3).locator('.jump.fail')).toHaveText('fail → reconstruct-1')
  await expect(blocks.nth(4).locator('.jump.incoming')).toHaveText('← fail of Quality Gate')
  await expect(blocks.nth(3)).toContainText('Reprojection median < 1 px · else go to reconstruct-1')
  await expect(dialog.locator('.preflight .error')).toHaveText(['Detect Features: requires images'])

  await dialog.getByRole('button', { name: 'Recipe', exact: true }).click()
  const recipe = dialog.getByRole('textbox', { name: 'Recipe text', exact: true })
  await expect(recipe).toHaveValue(/gate metric="reprojMedianPx" op="<" threshold=1 onFail="branch" failTarget="reconstruct-1"/)
  await expect(recipe).toHaveValue(/\nreconstruct-1: reconstruct preset="medium"/)
  const original = await recipe.inputValue()
  // A broken line is refused with its line number; nothing is applied.
  await recipe.fill(`${original}\nbogus-block x=1\nreconstruct presett=high`)
  await dialog.getByRole('button', { name: 'Apply recipe', exact: true }).click()
  await expect(dialog.locator('.recipe-errors li')).toHaveText([
    'Line 8: unknown block “bogus-block”',
    /^Line 9: reconstruct has no setting “presett”/,
  ])
  await dialog.getByRole('button', { name: 'Revert', exact: true }).click()
  await expect(recipe).toHaveValue(original)
  // A text edit rebuilds the blocks: a tighter threshold, stop instead of the
  // branch, and a disabled tool block appended.
  await recipe.fill(original.replace('threshold=1 onFail="branch" failTarget="reconstruct-1"', 'threshold=0.5 onFail=stop')
    + '\nfilter-cloud preset=light @off')
  await dialog.getByRole('button', { name: 'Apply recipe', exact: true }).click()
  await expect(dialog.locator('.recipe-errors')).toHaveCount(0)
  await expect(recipe).toHaveValue(/gate metric="reprojMedianPx" op="<" threshold=0.5 onFail="stop"/)
  await dialog.getByRole('button', { name: 'Blocks', exact: true }).click()
  await expect(blocks).toHaveCount(6)
  await expect(blocks.nth(3)).toContainText('Reprojection median < 0.500 px · else stop')
  await expect(blocks.nth(5)).toContainText('Filter Point Cloud')
  await expect(blocks.nth(5).locator('.status')).toHaveText('Disabled')
  // A backward jump is refused by preflight.
  await dialog.getByRole('button', { name: 'Recipe', exact: true }).click()
  await recipe.fill((await recipe.inputValue()).replace('detect-features', 'top: detect-features') + '\ngoto target=top')
  await dialog.getByRole('button', { name: 'Apply recipe', exact: true }).click()
  await dialog.getByRole('button', { name: 'Blocks', exact: true }).click()
  await expect(dialog.getByText(/Go to: “top” is not below this block — jumps only go forward/)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('builder-gate.png') })
  expect(errors).toEqual([])
})

test('a cleanup chain runs tool blocks on its own outputs and records its gates', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Object capture', exact: false }).click()
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // A 2,000-point dense cloud on a 10 × 10 plane with a little noise.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    const n = 2000, pos = new Float64Array(n * 3), col = new Uint8Array(n * 3).fill(128)
    let seed = 1
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < n; i++) { pos[3 * i] = rnd() * 10; pos[3 * i + 1] = rnd() * 10; pos[3 * i + 2] = rnd() * 0.05 }
    store.clouds.push({ id: 'dense-1', name: 'Dense cloud', kind: 'dense', createdAt: 1, cameras: new Map(), count: n, pos, col })
  })
  const dialog = await openBuilder(page)
  await dialog.getByRole('button', { name: 'Recipe', exact: true }).click()
  const recipe = dialog.getByRole('textbox', { name: 'Recipe text', exact: true })
  await recipe.fill([
    'workflow "Cleanup chain"',
    'defaults warning=continue reuse=valid display=standard',
    'gate metric=densePoints op=">=" threshold=500 onFail=stop',
    'filter-cloud preset=custom methods=["voxel"] voxelCell=1',
    'gate metric=densePoints op=">=" threshold=1000000 onFail=branch failTarget=normals',
    'filter-cloud preset=light',
    'normals: estimate-normals k=8 orient=up',
  ].join('\n'))
  await dialog.getByRole('button', { name: 'Apply recipe', exact: true }).click()
  await dialog.getByRole('button', { name: 'Blocks', exact: true }).click()
  await expect(dialog.locator('.preflight .ok')).toBeVisible()
  await dialog.getByRole('button', { name: 'Run workflow', exact: true }).click()
  const blocks = dialog.locator('.workflow-block')
  await expect(dialog.locator('.run-row').first()).toContainText('completed', { timeout: 20_000 })
  await expect(blocks.locator('.status')).toHaveText(['passed', 'completed', 'failed', 'skipped', 'completed'])
  await expect(blocks.nth(0)).toContainText('Dense points 2,000 — meets >= 500')
  await expect(blocks.nth(2)).toContainText(/Dense points \d+ — fails >= 1,000,000/)
  await expect(dialog.locator('.run-row .run-gates').first()).toHaveText(/^Dense points 2,000: pass · Dense points \d+: fail$/)
  // Each tool worked on the previous one's output, never on the source again.
  const names = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().clouds.map((c) => `${c.name}:${c.count}:${!!c.nrm}`)
  })
  expect(names).toHaveLength(3)
  expect(names[0]).toBe('Dense cloud:2000:false')
  expect(names[1]).toMatch(/^Dense cloud \(filtered\):\d+:false$/)
  expect(names[2]).toMatch(/^Dense cloud \(filtered\) \(normals\):\d+:true$/)
  expect(Number(names[1].split(':')[1])).toBeLessThan(200)
  await page.screenshot({ path: test.info().outputPath('builder-chain-run.png') })
  expect(errors).toEqual([])
})
