import { test, expect } from './fixtures.js'

// On start (Settings ▸ General ▸ On start, core/startupMemory.js): WebSfM opens the
// project that was open last, with the tabs it had open, and never reopens a project
// whose opening did not finish (the tab crashed while it loaded).

async function createProjectWithGcpTab(page) {
  await page.addInitScript(() => {
    localStorage.setItem('consoleOpen', 'false')
    localStorage.setItem('websfm.ui.openLastProject', 'true')
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const store = useGcpsStore()
    await store.addGcps([{ name: 'G1', x: 500010, y: 5000010, z: 5 }], 'EPSG:32632')
    const app = document.querySelector('#app').__vue_app__._instance.setupState
    app.openGcpTab(store.gcps[0].id, store.gcps[0].name)
  })
  await expect(page.locator('.tab', { hasText: 'GCP G1' })).toHaveClass(/active/)
}

test('the last project opens on start, with the tabs it had open', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProjectWithGcpTab(page)

  await page.reload()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect(page.locator('.project-picker')).toHaveCount(0)
  await expect(page.locator('.tab', { hasText: 'GCP G1' })).toHaveClass(/active/)

  // Closed, the tab stays closed after the next reload.
  await page.evaluate(() => document.querySelector('#app').__vue_app__._instance.setupState.closeAllTabs())
  await expect(page.locator('.tab', { hasText: 'GCP G1' })).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect(page.locator('.project-picker')).toHaveCount(0)
  await expect(page.locator('.tab', { hasText: 'GCP G1' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a project whose opening did not finish shows the project list instead', async ({ page }) => {
  await createProjectWithGcpTab(page)
  // As a crash during loading leaves it: the opening flag still set.
  await page.evaluate(() =>
    localStorage.setItem('websfm.ui.openingProject', localStorage.getItem('websfm.ui.lastProject')),
  )
  await page.reload()
  await expect(page.locator('.project-picker')).toBeVisible()
  await expect(page.locator('.toast', { hasText: 'did not finish opening the last time' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('websfm.ui.openingProject'))).toBeNull()

  // The next start, the flag cleared, opens it again.
  await page.reload()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect(page.locator('.project-picker')).toHaveCount(0)
})

test('with On start off, the project list shows', async ({ page }) => {
  await createProjectWithGcpTab(page)
  await page.addInitScript(() => localStorage.setItem('websfm.ui.openLastProject', 'false'))
  await page.reload()
  await expect(page.locator('.project-picker')).toBeVisible()
})
