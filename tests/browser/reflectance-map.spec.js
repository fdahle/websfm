import { test, expect } from './fixtures.js'

// Reconstruct ▸ Products ▸ Reflectance: greyed until there are band photos, and the
// dialog says what it needs. (The map itself: src/workers/ops/reflectance.test.js and
// core/products/reflectanceMap.test.js.)
test('the reflectance map asks for multispectral photos', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.getByRole('button', { name: 'Reconstruct', exact: true }).click()
  const button = page.getByRole('button', { name: /Reflect/ })
  await expect(button).toBeVisible()
  await expect(button).toBeDisabled()
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().toolModal = 'gen-reflectance'
  })
  const dialog = page.getByRole('dialog', { name: 'Reflectance Map' })
  await expect(dialog).toContainText('No photo here is a band of a multispectral camera')
  await expect(dialog.getByRole('button', { name: 'Build reflectance map' })).toBeDisabled()
  expect(errors).toEqual([])
})
