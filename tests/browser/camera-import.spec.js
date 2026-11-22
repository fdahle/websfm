import { test, expect } from './fixtures.js'

// Import ▸ Camera Poses (components/modals/import/CameraImportModal.vue): a CSV of camera
// positions with the height datum chosen in the dialog. The datum reaches each pose, so
// Sparse Model can convert the heights into the GCPs' datum (stores/reconstruction/
// sparseRun.js posesInControlDatum).

async function projectWithPhotos(page, names) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async (names) => {
    const files = await Promise.all(
      names.map(async (name) => {
        const canvas = new OffscreenCanvas(64, 48)
        canvas.getContext('2d').fillRect(0, 0, 64, 48)
        return new File([await canvas.convertToBlob({ type: 'image/jpeg' })], name, { type: 'image/jpeg' })
      }),
    )
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    await useImagesStore().addImages(files)
  }, names)
  await expect
    .poll(() =>
      page.evaluate(async () => (await import('/src/stores/useImagesStore.js')).useImagesStore().images.length),
    )
    .toBe(names.length)
}

test('camera positions keep the height datum chosen in the import dialog', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await projectWithPhotos(page, ['a.jpg', 'b.jpg'])
  const csv = ['image,lon,lat,h', 'a.jpg,6.5418,46.6532,612.40', 'b.jpg,6.5421,46.6534,612.95'].join('\n')

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page
    .locator('.ribbon')
    .getByRole('button', { name: /Camera\s*Poses/ })
    .click()
  await (await chooser).setFiles({ name: 'positions.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })

  const dialog = page.getByRole('dialog', { name: 'Import Camera Parameters' })
  const datum = dialog.getByLabel('Height datum')
  await expect(datum).toHaveValue('unknown')
  await datum.selectOption('ellipsoidal')
  await expect(dialog.getByText('2 poses')).toBeVisible()
  await dialog.getByRole('button', { name: 'Import poses' }).click()
  await expect(dialog).toHaveCount(0)

  const poses = await page.evaluate(async () =>
    (await import('/src/stores/usePosesStore.js')).usePosesStore().poses.map((p) => [p.imageName, p.verticalDatum]),
  )
  expect(poses.sort()).toEqual([
    ['a.jpg', 'ellipsoidal'],
    ['b.jpg', 'ellipsoidal'],
  ])
  expect(errors).toEqual([])
})

// The ribbon's Import commands declare what the file is, and the dialog then says so with
// links to the other kinds (ImportKindSwitch). In 0.9.0 that note threw as it rendered (a
// parameter named like its tag), so these dialogs never opened.
for (const { command, name, dialogName } of [
  { command: /Camera\s*Poses/, name: 'positions.csv', dialogName: 'Import Camera Parameters' },
  { command: /Calibration/, name: 'calibration.csv', dialogName: 'Import Camera Parameters' },
  { command: /GCP\s*File/, name: 'gcps.csv', dialogName: 'Import GCPs' },
]) {
  test(`Import ▸ ${command.source.replace('\\s*', ' ')} opens its dialog with the kind it declared`, async ({
    page,
  }) => {
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await projectWithPhotos(page, ['a.jpg'])
    await page.getByRole('button', { name: 'Import', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.locator('.ribbon').getByRole('button', { name: command }).click()
    const csv = 'name,x,y,z\na.jpg,1,2,3'
    await (await chooser).setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) })
    const dialog = page.getByRole('dialog', { name: dialogName })
    await expect(dialog.getByText('Not right? Import as')).toBeVisible()
    expect(errors).toEqual([])
  })
}
