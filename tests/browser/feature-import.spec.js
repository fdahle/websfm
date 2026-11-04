import { test, expect } from './fixtures.js'

// Import ▸ Keypoints & Matches (composables/useFeatureImport.js) and Import ▸ Other SfM
// with a Bundler bundle.out, against the full app. Two photos and a two-view geometry
// made up here: 3D points seen by two cameras, written out as the files another tool
// would write.

const W = 640,
  H = 480,
  F = 600

// Two cameras 1 m apart looking down +z at points 4–6 m away; pixels as OpenCV projects.
function scene() {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  const points = Array.from({ length: 60 }, () => [rnd() * 2, rnd() * 1.5, 5 + rnd()])
  const cams = [
    {
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [0, 0, 0],
    },
    {
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t: [-1, 0, 0],
    },
  ]
  const project = (c, X) => {
    const p = c.R.map((r, i) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + c.t[i])
    return [(F * p[0]) / p[2] + W / 2, (F * p[1]) / p[2] + H / 2]
  }
  return { points, cams, project }
}

async function projectWithPhotos(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(
    async ({ W, H }) => {
      const files = await Promise.all(
        ['left.jpg', 'right.jpg'].map(async (name, k) => {
          const canvas = new OffscreenCanvas(W, H)
          const ctx = canvas.getContext('2d')
          ctx.fillStyle = k ? '#468' : '#864'
          ctx.fillRect(0, 0, W, H)
          return new File([await canvas.convertToBlob({ type: 'image/jpeg' })], name, { type: 'image/jpeg' })
        }),
      )
      const { useImagesStore } = await import('/src/stores/useImagesStore.js')
      await useImagesStore().addImages(files)
    },
    { W, H },
  )
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await import('/src/stores/useImagesStore.js')).useImagesStore().images.filter((i) => i.meta?.width).length,
      ),
    )
    .toBe(2)
}

test('matched points from a CSV become keypoints and verified matches', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await projectWithPhotos(page)
  const { points, cams, project } = scene()
  const rows = ['image1,x1,y1,image2,x2,y2']
  for (const X of points) {
    const [a, b] = [project(cams[0], X), project(cams[1], X)]
    rows.push(`left.jpg,${a[0].toFixed(3)},${a[1].toFixed(3)},right.jpg,${b[0].toFixed(3)},${b[1].toFixed(3)}`)
  }
  // Six wrong matches, which the geometric check must drop.
  for (let i = 0; i < 6; i++)
    rows.push(`left.jpg,${50 + i * 90},${60 + i * 50},right.jpg,${600 - i * 80},${40 + i * 70}`)

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.locator('.ribbon').getByRole('button', { name: 'Keypoints & Matches' }).click()
  await (await chooser).setFiles({ name: 'matches.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) })

  const dialog = page.getByRole('dialog', { name: 'Import Keypoints & Matches' })
  await expect(dialog.locator('.stats')).toContainText('66matches')
  await expect(dialog.getByText('Verify geometrically, as Match Features does')).toBeVisible()
  await dialog.getByRole('button', { name: 'Import selected' }).click()
  await expect(dialog).toHaveCount(0)

  const state = await page.evaluate(async () => {
    const images = (await import('/src/stores/useImagesStore.js')).useImagesStore().images
    const matches = (await import('/src/stores/useMatchesStore.js')).useMatchesStore()
    const pair = [...matches.matchStore.values()][0]
    return {
      keypoints: images.map((i) => [i.name, i.kpStatus, i.kpCount]),
      pairs: matches.matchStore.size,
      inliers: pair?.inlierCount,
      weak: pair?.weak,
      hasF: Array.isArray(pair?.F),
    }
  })
  expect(state.keypoints).toEqual([
    ['left.jpg', 'done', 66],
    ['right.jpg', 'done', 66],
  ])
  expect(state.pairs).toBe(1)
  expect(state.inliers).toBeGreaterThanOrEqual(58)
  expect(state.inliers).toBeLessThanOrEqual(61)
  expect(state.weak).toBe(false)
  expect(state.hasF).toBe(true)
  expect(errors).toEqual([])
})

test('a Bundler bundle.out with its list.txt imports as a sparse model', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await projectWithPhotos(page)
  const { points, cams, project } = scene()
  // OpenCV → Bundler: flip the camera's y and z; views about the centre, y up.
  const flip = (c) => ({ R: [c.R[0], c.R[1].map((x) => -x), c.R[2].map((x) => -x)], t: [c.t[0], -c.t[1], -c.t[2]] })
  const out = ['# Bundle file v0.3', `2 ${points.length}`]
  for (const c of cams.map(flip)) out.push(`${F} 0 0`, ...c.R.map((r) => r.join(' ')), c.t.join(' '))
  for (const X of points) {
    const views = cams.map((c, k) => {
      const [x, y] = project(c, X)
      return `${k} ${k} ${(x - W / 2).toFixed(4)} ${(H / 2 - y).toFixed(4)}`
    })
    out.push(X.join(' '), '128 128 128', `2 ${views.join(' ')}`)
  }

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: 'Other SfM' }).click()
  const source = page.getByRole('dialog', { name: 'Import from another SfM tool' })
  const chooser = page.waitForEvent('filechooser')
  await source.getByRole('button', { name: /Files or ZIP/ }).click()
  await (
    await chooser
  ).setFiles([
    { name: 'bundle.out', mimeType: 'text/plain', buffer: Buffer.from(out.join('\n')) },
    { name: 'list.txt', mimeType: 'text/plain', buffer: Buffer.from('images/left.jpg\nimages/right.jpg\n') },
  ])
  const dialog = page.getByRole('dialog', { name: 'Import from Bundler bundle.out' })
  await expect(dialog.locator('.stats')).toContainText('2already matched')
  await dialog.getByRole('button', { name: 'Import selected' }).click()
  await expect(dialog).toHaveCount(0)

  // The imported cameras see each point where the file says, in OpenCV pixels.
  const worst = await page.evaluate(async () => {
    const recon = (await import('/src/stores/useReconstructionStore.js')).useReconstructionStore()
    const cloud = recon.clouds.find((c) => c.kind === 'sparse')
    const pts = cloud.points
    let worst = 0
    let seen = 0
    for (let i = 0; i < pts.length; i++) {
      const X = pts.xyz(i)
      pts.forEachPixel(i, (uuid, px, py) => {
        const cam = cloud.cameras.get(uuid)
        const p = cam.R.map((r, k) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + cam.t[k])
        const x = (cam.K.fx * p[0]) / p[2] + cam.K.cx,
          y = (cam.K.fy * p[1]) / p[2] + cam.K.cy
        worst = Math.max(worst, Math.hypot(x - px, y - py))
        seen++
      })
    }
    if (!seen) worst = Infinity
    return { cameras: cloud.cameras.size, points: pts.length, worst }
  })
  expect(worst.cameras).toBe(2)
  expect(worst.points).toBe(60)
  expect(worst.worst).toBeLessThan(0.01)
  expect(errors).toEqual([])
})
