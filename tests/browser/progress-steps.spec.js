import { test, expect } from './fixtures.js'

// The progress dialog's step list (core/runSteps.js): a run of several steps lists them
// under the bar, the running one with its own count and bar, earlier ones ticked, and
// one the run left out struck through.
test('a run in steps lists them, with the running one counted', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const progress = (expr) =>
    page.evaluate(
      `(() => { const p = document.querySelector('#app').__vue_app__._instance.setupState.exportProgress; ${expr} })()`,
    )
  await progress(`
    p.open('Building Depth Maps', 12, () => {}, { unit: 'images' })
    p.report(0, 12, 'Starting', 0, 'pass1', [
      { id: 'pass1', label: 'PatchMatch, first pass' },
      { id: 'pass2', label: 'PatchMatch, geometric pass' },
      { id: 'filter', label: 'Cross-view filter' },
    ])
    p.report(5, 12, 'IMG_5.jpg', 0.2, 'pass1')
  `)
  const steps = page.getByRole('list', { name: 'Steps' }).locator('li')
  await expect(steps).toHaveCount(3)
  await expect(steps.nth(0)).toHaveClass(/running/)
  await expect(steps.nth(0)).toContainText('5 / 12 images')
  await expect(steps.nth(1)).toHaveClass(/todo/)
  await page
    .locator('.progress-card, .modal, [role=dialog]')
    .first()
    .catch(() => {})
  // Straight to the filter: the geometric pass never reported, so it was left out.
  await progress(`p.report(2, 12, 'Filtering', 0.8, 'filter')`)
  await expect(steps.nth(0)).toHaveClass(/done/)
  await expect(steps.nth(1)).toHaveClass(/skipped/)
  await expect(steps.nth(2)).toHaveClass(/running/)
  await expect(steps.nth(2)).toContainText('2 / 12 images')
  await progress(`p.close()`)
  expect(errors).toEqual([])
})
