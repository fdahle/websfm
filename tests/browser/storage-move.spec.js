import { test, expect } from './fixtures.js'

// Moving a project between browser storage and a folder (SC-2). A restored project's
// stores hold File handles into its root (image copies, masks, products, LOD files,
// the match document); the move deletes the tree they point at, and the copy in the
// new root has the same names. After a move every one of them must read again.
// The "folder" is an OPFS subdirectory: a real FileSystemDirectoryHandle, returned
// by a stubbed showDirectoryPicker.

const app = (page, expr) => page.evaluate(`document.querySelector('#app').__vue_app__._instance.setupState.${expr}`)

async function readable(page) {
  return page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const read = async (url) => {
      try {
        return (await (await fetch(url)).blob()).size > 0
      } catch {
        return false
      }
    }
    const out = []
    for (const img of useImagesStore().images) {
      out.push(`${img.name} url ${await read(img.url)}`)
      if (img.computeUrl && img.computeUrl !== img.url) out.push(`${img.name} compute ${await read(img.computeUrl)}`)
      if (img.mask) out.push(`${img.name} mask ${await read(img.mask.url)}`)
    }
    return out
  })
}

test('a project moved to a folder and back still reads its images and masks', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'folders on disk are Chromium-only')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle(`moved-${Date.now()}`, { create: true })
    }
  })
  await page.goto('/')
  await page.getByPlaceholder('My Project').fill('Move me')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const files = await Promise.all(
      ['a.jpg', 'b.jpg'].map(async (name, k) => {
        const canvas = new OffscreenCanvas(160, 120)
        const ctx = canvas.getContext('2d')
        for (let y = 0; y < 120; y += 8)
          for (let x = 0; x < 160; x += 8) {
            ctx.fillStyle = `rgb(${(x * 5 + k * 70) % 256}, ${(y * 3) % 256}, ${(x + y) % 256})`
            ctx.fillRect(x, y, 8, 8)
          }
        return new File([await canvas.convertToBlob({ type: 'image/jpeg' })], name, { type: 'image/jpeg' })
      }),
    )
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    await useImagesStore().addImages(files)
  })
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await import('/src/stores/useImagesStore.js'))
            .useImagesStore()
            .images.filter((i) => !i.loading && i.meta?.width === 160).length,
      ),
    )
    .toBe(2)
  // A mask on a.jpg, so a mask File is restored too.
  await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const store = useImagesStore()
    const canvas = new OffscreenCanvas(160, 120)
    canvas.getContext('2d').fillRect(0, 0, 80, 120)
    store.updateMask(store.images.find((i) => i.name === 'a.jpg').id, await canvas.convertToBlob({ type: 'image/png' }))
  })
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await import('/src/composables/useLog.js'))
          .useLog()
          .entries.value.some((e) => e.message === 'Mask saved: a.jpg'),
      ),
    )
    .toBe(true)
  await page.evaluate(async () => (await import('/src/utils/persistence.js')).flushPersistence())

  // Reopen, so every handle points into the project's storage rather than at the
  // Files picked this session.
  await page.reload()
  await page.getByText('Move me', { exact: true }).first().click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(() => readable(page)).toEqual(['a.jpg url true', 'a.jpg mask true', 'b.jpg url true'])

  await app(page, 'moveCurrentProjectToFolder()')
  await expect(page.locator('.toast', { hasText: 'Project moved to folder' })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(() => readable(page)).toEqual(['a.jpg url true', 'a.jpg mask true', 'b.jpg url true'])

  // And back: the folder stays, but the project reads its browser copy from now on.
  const back = app(page, 'moveCurrentProjectToBrowser()')
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await back
  await expect(page.locator('.toast', { hasText: 'Project moved into browser storage' })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(() => readable(page)).toEqual(['a.jpg url true', 'a.jpg mask true', 'b.jpg url true'])
  expect(
    await page.evaluate(
      async () =>
        (await import('/src/stores/useProjectsStore.js')).useProjectsStore().projects.find((p) => p.name === 'Move me')
          .storage,
    ),
  ).not.toBe('folder')
  expect(errors).toEqual([])
})
