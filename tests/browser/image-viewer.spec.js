import { test, expect } from '@playwright/test'

// The image viewer against the full app: open an image tab, paint a mask stroke and
// commit it, and place a control point from the right-click menu — at the native
// pixel under the cursor (the viewer maps screen → native pixels through its frame).

async function addTestImage(page) {
  await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const canvas = new OffscreenCanvas(400, 300)
    const ctx = canvas.getContext('2d')
    for (let y = 0; y < 300; y += 10)
      for (let x = 0; x < 400; x += 10) {
        ctx.fillStyle = `rgb(${(x * 7 + y * 3) % 256}, ${(x * 3 + y * 5) % 256}, ${(x + y) % 256})`
        ctx.fillRect(x, y, 10, 10)
      }
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    await useImagesStore().addImages([new File([blob], 'test.png', { type: 'image/png' })])
  })
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useImagesStore } = await import('/src/stores/useImagesStore.js')
        const img = useImagesStore().images[0]
        return !!img && !img.loading && img.meta?.width === 400
      }),
    )
    .toBe(true)
}

test('the image viewer paints and commits a mask, and marks a control point at the clicked pixel', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await addTestImage(page)

  await page
    .locator('.sidebar')
    .getByRole('button', { name: /Images/ })
    .first()
    .click()
  await page.locator('.list-item').filter({ hasText: 'test.png' }).dblclick()
  const img = page.locator('.image-viewer img.image')
  await expect(img).toBeVisible()
  await expect(img).not.toHaveClass(/pending/)
  const viewport = page.locator('.image-viewer .viewport')
  const box = await viewport.boundingBox()
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2

  // Mask: brush stroke across the middle, then leave edit mode (which flushes).
  const setPrefs = (patch) =>
    page.evaluate(async (p) => {
      const { useImageViewSettings } = await import('/src/composables/useImageViewSettings.js')
      useImageViewSettings().patchImageView(p)
    }, patch)
  await setPrefs({ maskEdit: true, gcpEdit: false })
  await page.keyboard.press('b')
  await page.mouse.move(cx - 60, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 60, cy, { steps: 12 })
  await page.mouse.up()
  await setPrefs({ maskEdit: false })
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useImagesStore } = await import('/src/stores/useImagesStore.js')
        return !!useImagesStore().images[0].mask
      }),
    )
    .toBe(true)

  // Control point: right-click the centre → Add → New control point here.
  await page.mouse.click(cx, cy, { button: 'right' })
  const menu = page.locator('.ctx-menu')
  await menu.getByRole('button', { name: /Add control\/marker here/ }).click()
  await menu.getByRole('button', { name: /New control point here/ }).click()
  const firstMark = () =>
    page.evaluate(async () => {
      const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
      return useGcpsStore().gcps[0]?.observations?.[0] ?? null
    })
  await expect.poll(firstMark).not.toBeNull()
  const obs = await firstMark()
  // The view is fitted, so the viewport centre is the image centre (200, 150).
  expect(Math.abs(obs.px - 200)).toBeLessThan(3)
  expect(Math.abs(obs.py - 150)).toBeLessThan(3)

  expect(errors).toEqual([])
})

test('a zoom typed into the status bar applies, and Esc keeps the old one', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await addTestImage(page)
  await page
    .locator('.sidebar')
    .getByRole('button', { name: /Images/ })
    .first()
    .click()
  await page.locator('.list-item').filter({ hasText: 'test.png' }).dblclick()
  await expect(page.locator('.image-viewer img.image')).not.toHaveClass(/pending/)

  const readout = page.locator('.image-viewer .status-bar .zoom-level')
  await readout.click()
  const field = page.getByLabel('Zoom (%)')
  await field.fill('250')
  await field.press('Enter')
  await expect(readout).toHaveText('250%')
  const img = page.locator('.image-viewer img.image')
  // 400 px wide at 250 %.
  expect(Math.round((await img.boundingBox()).width)).toBe(1000)

  await readout.click()
  await field.fill('10')
  await field.press('Escape')
  await expect(readout).toHaveText('250%')
  expect(errors).toEqual([])
})
