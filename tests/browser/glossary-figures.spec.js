import { test, expect } from './fixtures.js'

// A glossary figure (src/glossary/assets/*.svg) loads on its own when its entry opens
// (core/help/helpMarkdown.js writes a placeholder, composables/helpFigures.js swaps the
// figure in), and its palette follows the theme: a light ground in light mode, the
// drawn dark ground in dark mode.

for (const theme of ['light', 'dark']) {
  test(`a glossary figure loads and follows the ${theme} theme`, async ({ page }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript((t) => {
      localStorage.setItem('consoleOpen', 'false')
      localStorage.setItem('theme', t)
    }, theme)
    await page.goto('/')
    await page.getByRole('button', { name: 'Create project', exact: true }).click()
    await expect(page.locator('.loading-overlay')).toHaveCount(0)
    await page.evaluate(async () =>
      (await import('/src/stores/useGlossaryStore.js')).useGlossaryStore().openTerm('patchmatch'),
    )
    const figure = page.locator('.term-body svg.glossary-img')
    await expect(figure).toBeVisible()
    await expect(page.locator('.term-body [data-fig]')).toHaveCount(0)
    // The figure's background rect: its fill comes from --fig-bg.
    const fill = await figure
      .locator('rect')
      .first()
      .evaluate((r) => getComputedStyle(r).fill)
    const [red] = fill.match(/\d+/g).map(Number)
    if (theme === 'light') expect(red).toBeGreaterThan(200)
    else expect(red).toBeLessThan(60)
    expect(errors).toEqual([])
  })
}
