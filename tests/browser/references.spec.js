import { test, expect } from '@playwright/test'

// A glossary entry's Sources (its refs: frontmatter) and About ▸ References
// (core/help/references.js) render their citations; each reference says what it is
// used for (the glossary entries citing it), and a click opens the entry.

test('glossary sources and About references render', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () =>
    (await import('/src/stores/useGlossaryStore.js')).useGlossaryStore().openTerm('patchmatch'),
  )
  const sources = page.locator('.term-sources')
  await expect(sources).toContainText('Bleyer, M., Rhemann, C. & Rother, C. (2011)')
  await sources.scrollIntoViewIfNeeded()
  await page.keyboard.press('Escape')
  await page.evaluate(async () => (await import('/src/stores/useGlossaryStore.js')).useGlossaryStore().close())
  await page.getByText('Other', { exact: true }).first().click()
  await page.getByRole('button', { name: /About/ }).first().click()
  await page.getByRole('button', { name: 'References', exact: true }).click()
  await expect(page.locator('.ref-list li')).toHaveCount(
    Object.keys((await import('../../src/core/help/references.js')).REFERENCES).length,
  )
  // Every paper names at least one use.
  await expect(page.locator('.ref-list li:not(:has(.ref-use))')).toHaveCount(0)
  const lightglue = page.locator('.ref-list li').filter({ hasText: 'LightGlue' })
  await expect(lightglue.locator('.ref-use')).toContainText('Used for: Keypoint')
  await lightglue.locator('.ref-use a', { hasText: 'Keypoint' }).click()
  await expect(page.getByRole('dialog', { name: 'Glossary' })).toBeVisible()
  await expect(page.locator('.gtab.active')).toHaveText(/Keypoint/)
  expect(errors).toEqual([])
})
