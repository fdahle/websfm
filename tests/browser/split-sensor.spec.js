import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Sidebar ▸ Sensors (core/sensors/splitSuggestions.js): a camera group whose photos come
// in two image sizes is marked ⑂, and Split camera group… makes a group per size. The project is the format fixture
// (tests/fixtures/projects/v1: five photos of one camera), as in disable-images.spec.js.
const fixture = readFileSync(new URL('../fixtures/projects/v1/aukerman-5.websfm', import.meta.url))

async function openFixture(page) {
  await page.goto('/')
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
}

test('a camera group of two image sizes is marked and split by size', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough for the sidebar logic')
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)

  // Two photos of another size: the group now holds two.
  const label = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    for (const img of useImagesStore().images.slice(0, 2)) img.meta = { ...img.meta, width: img.meta.width + 400 }
    return useSensorsStore().sensors[0].label
  })
  await page.getByRole('button', { name: /^▸ Sensors/ }).click()
  const row = page.locator('.list-item').filter({ hasText: label })
  await expect(row.locator('.unaligned-tag', { hasText: '⑂' })).toBeVisible()

  // Sparse Reconstruction says so above its settings, not behind Advanced.
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().reconstructOpen = true
  })
  const sparse = page.getByRole('dialog', { name: 'Sparse Reconstruction' })
  await expect(sparse.locator('.warn-box')).toContainText(`${label} may hold photos of 2 cameras`)
  await sparse.getByRole('button', { name: 'Cancel' }).click()
  await expect(sparse).toHaveCount(0)

  await row.click({ button: 'right' })
  await page.getByRole('button', { name: 'Split camera group…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Split camera group' })
  await expect(dialog).toContainText('Image sizes: 1200×900 (3 photos), 1600×900 (2 photos).')
  await expect(dialog.locator('tbody tr')).toHaveCount(2)
  await dialog.getByRole('button', { name: 'Split into 2 groups' }).click()
  await expect(dialog).toHaveCount(0)

  const after = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const sensors = useSensorsStore().sensors
    return {
      labels: sensors.map((s) => s.label),
      counts: sensors.map((s) => useImagesStore().images.filter((i) => i.sensorId === s.id).length),
    }
  })
  expect(after.counts).toEqual([3, 2])
  expect(after.labels[1]).toContain(label)
  await expect(page.locator('.list-item .unaligned-tag', { hasText: '⑂' })).toHaveCount(0)
  expect(errors).toEqual([])
})
