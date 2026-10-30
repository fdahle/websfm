import { test, expect } from './fixtures.js'
import { readFile } from 'node:fs/promises'

// Export ▸ Camera Poses and Calibration open their dialogs: the poses the sparse model
// estimated or the imported ones, the calibration as entered or as estimated.

async function download(page, click) {
  const pending = page.waitForEvent('download')
  await click()
  const d = await pending
  return { name: d.suggestedFilename(), text: (await readFile(await d.path())).toString() }
}

const rows = (text) => {
  const [head, ...lines] = text.trim().split(/\r?\n/)
  const cols = head.split(/[,\t]/)
  return lines.map((l) => Object.fromEntries(l.split(/[,\t]/).map((v, i) => [cols[i], v])))
}

test('camera poses and calibration export through their dialogs', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // Two images, a sparse model with a nadir camera over each, and one imported pose.
  await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { usePosesStore } = await import('/src/stores/usePosesStore.js')
    const { SparsePoints } = await import('/src/core/sfm/sparsePoints.js')
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const png = async (name) => {
      const c = new OffscreenCanvas(64, 48)
      c.getContext('2d').fillRect(0, 0, 8, 8)
      return new File([await c.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' })
    }
    const imagesStore = useImagesStore()
    await imagesStore.addImages([await png('a.png'), await png('b.png')])
    // Looking down −z of the model, image top to +y: omega = phi = kappa = 0.
    const R = [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ]
    const cameras = new Map(
      imagesStore.images.map((img, i) => {
        const C = [10 * i, 5, 100]
        return [
          img.uuid,
          {
            R,
            t: R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2])),
            K: { fx: 50 + i, fy: 50 + i, cx: 32, cy: 24 },
          },
        ]
      }),
    )
    const s = useReconstructionStore()
    s.clouds.push({
      id: 'sparse-1',
      name: 'Sparse cloud',
      kind: 'sparse',
      createdAt: 42,
      cameras,
      points: SparsePoints.fromRecords([]),
    })
    s.mainSparseId = 'sparse-1'
    await usePosesStore().addPoses(
      [{ imageName: 'a.png', x: 500001, y: 5000002, z: 3, omega: 4, phi: 5, kappa: 6 }],
      'EPSG:32632',
    )
  })

  const open = async (button, title) => {
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await page.locator('.ribbon').getByRole('button', { name: button }).click()
    return page.getByRole('dialog', { name: title })
  }
  const exportFrom = (dialog) =>
    download(page, () => dialog.getByRole('button', { name: 'Export', exact: true }).click())

  // Estimated by default, in the model frame (no georeference), with no accuracies.
  let dialog = await open(/Camera\s*Poses/, 'Export Camera Poses')
  await expect(dialog.getByLabel('Source')).toHaveValue('estimated')
  await expect(dialog.getByLabel('File name')).toHaveAttribute('placeholder', /-poses-estimated$/)
  let file = await exportFrom(dialog)
  expect(file.name).toMatch(/-poses-estimated\.csv$/)
  let out = rows(file.text)
  expect(out.map((r) => [r.image, Number(r.X), Number(r.Z)])).toEqual([
    ['a.png', 0, 100],
    ['b.png', 10, 100],
  ])
  for (const k of ['omega', 'phi', 'kappa']) expect(Math.abs(Number(out[0][k]))).toBeLessThan(1e-9)
  expect(out[0].accuracy_x).toBeUndefined()

  // The imported pose, as tab-separated text without its angles.
  dialog = await open(/Camera\s*Poses/, 'Export Camera Poses')
  await dialog.getByLabel('Source').selectOption('imported')
  await dialog.getByLabel('Format').selectOption('txt')
  await dialog.getByLabel('Orientation (omega, phi, kappa)').uncheck()
  file = await exportFrom(dialog)
  expect(file.name).toMatch(/-poses\.txt$/)
  expect(file.text.split('\r\n')[0]).toBe('image\tX\tY\tZ\taccuracy_x\taccuracy_y\taccuracy_z\tcrs')
  out = rows(file.text)
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({ image: 'a.png', X: '500001', Y: '5000002', Z: '3', crs: 'EPSG:32632' })

  // The calibration bundle adjustment ended with, one row per image.
  dialog = await open('Calibration', 'Export Calibration')
  await dialog.getByLabel('Source').selectOption('estimatedPerImage')
  file = await exportFrom(dialog)
  expect(file.name).toMatch(/-calibration-estimated\.csv$/)
  out = rows(file.text)
  expect(out.map((r) => [r.image, r.focal, r.focal_unit, r.source])).toEqual([
    ['a.png', '50', 'px', 'estimated'],
    ['b.png', '51', 'px', 'estimated'],
  ])

  expect(errors).toEqual([])
})
