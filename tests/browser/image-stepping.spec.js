import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Picture ▸ Previous / Next and their keys (core/imageOrder.js): the image tab steps
// through the photos in the image list's order, the list selects each, and it stops at
// either end. The project is the format fixture (five photos), as in disable-images.spec.js.
const fixture = readFileSync(new URL('../fixtures/projects/v1/aukerman-5.websfm', import.meta.url))

async function openFixture(page) {
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
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

const state = (page) =>
  page.evaluate(async () => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const store = useImagesStore()
    const imageTabs = app.tabs.filter((t) => t.type === 'image')
    return {
      names: store.images.map((i) => i.name),
      tab: app.activeTab?.title ?? null,
      imageTabs: imageTabs.length,
      selected: store.images.find((i) => i.id === store.selectedId)?.name ?? null,
    }
  })

test('arrow keys and Previous / Next step through the photos in list order', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const { names } = await state(page)
  expect(names.length).toBe(5)
  await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__._instance.setupState
    const { images } = app
    app.openImageTab(images[0].id, images[0].name)
  })
  await expect.poll(async () => (await state(page)).tab).toBe(names[0])

  const previous = page.getByRole('button', { name: 'Previous', exact: true })
  const next = page.getByRole('button', { name: 'Next', exact: true })
  await expect(previous).toHaveAttribute('aria-disabled', 'true')
  await expect(previous).toHaveAttribute('title', 'This is the first photo in the image list')
  await expect(next).toHaveAttribute('title', /Show the next photo in the image list \(→\)/)

  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await state(page)).tab).toBe(names[1])
  let s = await state(page)
  expect(s.selected).toBe(names[1])
  // The tab moved to the photo: still one image tab.
  expect(s.imageTabs).toBe(1)

  await next.click()
  await page.keyboard.press('PageDown')
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await state(page)).tab).toBe(names[4])
  await expect(next).toHaveAttribute('title', 'This is the last photo in the image list')
  // Past the end nothing happens.
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await state(page)).tab).toBe(names[4])

  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await state(page)).tab).toBe(names[3])
  expect(errors).toEqual([])
})

test('the image list filters by name and state, and Ctrl+A selects what it shows', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const { names } = await state(page)
  // Sidebar sections start closed.
  await page.locator('.section-hd', { hasText: /^\W*Images/ }).click()
  const rows = page.locator('.item-list .list-item')
  await expect(rows).toHaveCount(5)

  // By name: one photo's own name leaves only it.
  const field = page.getByLabel('Filter the images by name')
  await field.fill(names[2])
  await expect(rows).toHaveCount(1)
  await expect(page.locator('.filter-status')).toContainText('1 of 5')
  await field.press('Escape')
  await expect(rows).toHaveCount(5)

  // By state: disable two photos, then show the disabled ones.
  await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const store = useImagesStore()
    store.setImagesEnabled([store.images[1].id, store.images[3].id], false)
  })
  const select = page.getByLabel('Show the images that are')
  await select.selectOption('disabled')
  await expect(rows).toHaveCount(2)

  // Ctrl+A after a click selects the shown images, and Next steps through only them.
  await rows.first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await expect(page.locator('.item-list .list-item.selected')).toHaveCount(2)
  await rows.first().dblclick()
  await expect.poll(async () => (await state(page)).tab).toBe(names[1])
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await state(page)).tab).toBe(names[3])

  await page.locator('.filter-status').getByRole('button', { name: 'Clear' }).click()
  await expect(rows).toHaveCount(5)
  expect(errors).toEqual([])
})
