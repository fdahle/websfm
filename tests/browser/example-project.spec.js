import { test, expect } from '@playwright/test'

// "Open the example project" (core/examples.js): the images come from the host's
// examples/ folder, which CI does not have, so the manifest and two small JPEGs are
// served by a route here.
async function serveExample(page) {
  await page.goto('/tests/browser/harness.html')
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 48
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#4a7'
      ctx.fillRect(0, 0, 64, 48)
      return canvas.toDataURL('image/jpeg').split(',')[1]
    }),
    'base64',
  )
  const files = [
    { name: 'A.JPG', bytes: jpeg.length },
    { name: 'B.JPG', bytes: jpeg.length },
  ]
  await page.route('**/examples/aukerman/manifest.json', (route) => route.fulfill({ json: { files } }))
  await page.route('**/examples/aukerman/*.JPG', (route) => route.fulfill({ body: jpeg, contentType: 'image/jpeg' }))
}

test('the example project downloads, imports its images and opens the tutorial', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await serveExample(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'example project' }).click()

  await expect(page.getByRole('button', { name: 'Aukerman Park ▾', exact: true })).toBeVisible()
  const guide = page.getByRole('dialog', { name: 'Guide' })
  await expect(guide).toBeVisible()
  await expect(guide.getByText('Tutorial: Your First Reconstruction').first()).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useImagesStore } = await import('/src/stores/useImagesStore.js')
        const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
        return {
          images: useImagesStore()
            .images.map((i) => i.name)
            .sort(),
          crs: useProjectsStore().currentCrs,
        }
      }),
    )
    .toEqual({ images: ['A.JPG', 'B.JPG'], crs: 'EPSG:32617' })
  expect(errors).toEqual([])
})

test('a missing example says so and returns to the new-project dialog', async ({ page }) => {
  await page.route('**/examples/aukerman/manifest.json', (route) => route.fulfill({ status: 404, body: 'not found' }))
  await page.goto('/')
  await page.getByRole('button', { name: 'example project' }).click()
  await expect(page.getByText('Could not download the example')).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'New Project', exact: true })).toBeVisible()
  expect(
    await page.evaluate(async () => {
      const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
      return useProjectsStore().projects.length
    }),
  ).toBe(0)
})
