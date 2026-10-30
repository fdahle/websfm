import { test, expect } from './fixtures.js'

// Products ▸ right-click ▸ Symbology… on the computed DEM (re-baked preview) and
// orthophoto (brightness/contrast/gamma applied at draw time).

const W = 40

test('DEM and orthophoto symbology from the Products context menu', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(
    async ({ W }) => {
      const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
      const store = useReconstructionStore()
      const data = new Float32Array(W * W),
        mask = new Uint8Array(W * W).fill(1)
      for (let r = 0; r < W; r++) for (let c = 0; c < W; c++) data[r * W + c] = 100 + c
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = W
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#c84'
      ctx.fillRect(0, 0, W, W)
      const previewUrl = canvas.toDataURL()
      const geo = { width: W, height: W, gsd: 1, originX: 500000, originY: 5000040, crs: 'EPSG:32632', unit: 'm' }
      store.dem = { ...geo, data, mask, zMin: 100, zMax: 100 + W - 1, name: 'DEM', createdAt: 1, previewUrl }
      store.ortho = { ...geo, name: 'Orthophoto', createdAt: 2, previewUrl }
    },
    { W },
  )
  await page
    .getByRole('button', { name: /Products/ })
    .first()
    .click()

  // DEM: greyscale, no hillshade, manual range → a new baked preview.
  await page.locator('.item-name', { hasText: /^DEM$/ }).click({ button: 'right' })
  await expect(page.locator('.ctx-menu .ctx-sep')).toHaveCount(2)
  await page.locator('.ctx-menu').getByRole('button', { name: 'Symbology…', exact: true }).click()
  const demDialog = page.getByRole('dialog', { name: 'DEM symbology' })
  await demDialog.getByLabel('Colour ramp').selectOption('gray')
  await demDialog.getByLabel('Height range').selectOption('manual')
  await demDialog.getByLabel('Minimum').fill('110')
  await demDialog.getByLabel('Maximum').fill('120')
  await demDialog.getByLabel('Hillshade').uncheck()
  await demDialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(demDialog).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
        const { style, previewUrl } = useReconstructionStore().dem
        return { style, blob: previewUrl.startsWith('blob:') }
      }),
    )
    .toEqual({ style: { ramp: 'gray', range: 'manual', min: 110, max: 120, hillshade: false }, blob: true })
  // The re-baked preview: column 5 (z 105) clamps to black, column 35 (z 135) to white.
  const px = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const img = await createImageBitmap(useReconstructionStore().dem.previewBlob)
    const c = new OffscreenCanvas(img.width, img.height),
      ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return [ctx.getImageData(5, 5, 1, 1).data[0], ctx.getImageData(35, 5, 1, 1).data[0]]
  })
  expect(px).toEqual([0, 255])

  // The DEM tab's ribbon offers the same actions as the menu: Symbology… reopens
  // the dialog with the applied style, and Remove asks first.
  await page.locator('.item-name', { hasText: /^DEM$/ }).dblclick()
  const ribbon = page.locator('.ribbon')
  await ribbon.getByRole('button', { name: /Symbology/ }).click()
  await expect(page.getByRole('dialog', { name: 'DEM symbology' }).getByLabel('Colour ramp')).toHaveValue('gray')
  await page.getByRole('dialog', { name: 'DEM symbology' }).getByRole('button', { name: 'Cancel' }).click()
  await expect(ribbon.getByRole('button', { name: /^Remove$/ })).toBeEnabled()

  // Ortho: brightness up → stored on the record, drawn through the SVG filter.
  await page.locator('.item-name', { hasText: /^Orthophoto$/ }).click({ button: 'right' })
  await page.locator('.ctx-menu').getByRole('button', { name: 'Symbology…', exact: true }).click()
  const orthoDialog = page.getByRole('dialog', { name: 'Orthophoto symbology' })
  await orthoDialog.getByLabel('Brightness').fill('0.2')
  await orthoDialog.getByLabel('Gamma').fill('1.5')
  await orthoDialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
        return useReconstructionStore().ortho.style
      }),
    )
    .toEqual({ brightness: 0.2, contrast: 0, gamma: 1.5 })
  await page.locator('.item-name', { hasText: /^Orthophoto$/ }).dblclick()
  const img = page.locator('.product-viewer img.raster:visible')
  await expect(img).toHaveAttribute('style', /filter: url\("?#ortho-adjust-/)
  const filterId = (await img.getAttribute('style')).match(/#(ortho-adjust-[\w-]+)/)[1]
  await expect(page.locator(`filter#${filterId} feComponentTransfer`)).toHaveCount(2)

  expect(errors).toEqual([])
})
