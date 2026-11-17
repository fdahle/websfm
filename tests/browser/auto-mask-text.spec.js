import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Auto Mask end to end: the PP-OCR models download (with the prompt), run in the compute
// workers, read the text on the photos and mask it; then the film frame and the text in
// one run. Three photos drawn in the
// page carry a data strip at the same place (read on all three: recurring text) and one
// a date on the photograph; the five Aukerman photos of the fixture carry none. The
// models are not in the repository (npm run fetch:models), so without them the test is
// skipped.
const PROJECT = new URL('../fixtures/projects/v2/aukerman-5.websfm', import.meta.url)

async function openFixture(page) {
  await page.goto('/')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
  await page.evaluate((b64) => {
    const bin = atob(b64)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    window.__fixture = new File([u8], 'aukerman-5.websfm')
  }, readFileSync(PROJECT).toString('base64'))
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
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().newProjectOpen = false
  })
}

test('reads the text on the photos and masks it', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser is enough')
  test.setTimeout(240_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openFixture(page)
  const haveModels = await page.evaluate(async () => {
    const r = await fetch('/models/ppocr_det.onnx', { method: 'HEAD' })
    return r.ok && !/text\/html/.test(r.headers.get('content-type') ?? '')
  })
  test.skip(!haveModels, 'the PP-OCR models are not in public/models (npm run fetch:models)')

  // Three 1600 × 1200 "scans": textured ground, a data strip running down the right edge
  // and a frame number; the first also has a date written on the photograph.
  const added = await page.evaluate(async () => {
    const files = []
    for (let k = 0; k < 3; k++) {
      const c = new OffscreenCanvas(1600, 1200)
      const g = c.getContext('2d')
      g.fillStyle = '#9a9a9a'
      g.fillRect(0, 0, 1600, 1200)
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `rgb(${60 + ((i * 37 + k * 11) % 140)},${60 + ((i * 53) % 140)},${60 + ((i * 71) % 140)})`
        g.fillRect((i * 97 + k * 29) % 1500, (i * 61) % 1100, 30 + (i % 50), 20 + (i % 40))
      }
      g.fillStyle = '#000'
      g.fillRect(1500, 0, 100, 1200)
      g.fillStyle = '#fff'
      g.font = 'bold 36px sans-serif'
      g.save()
      g.translate(1565, 120)
      g.rotate(Math.PI / 2)
      g.fillText('F31 USN GS T12A 13 12 27 68', 0, 0)
      g.restore()
      g.fillText(String(142 + k), 1510, 1150)
      g.fillStyle = '#000'
      g.fillRect(40, 1110, 300, 60)
      g.fillStyle = '#fff'
      g.fillText('FL 152.86', 60, 1155)
      if (k === 0) {
        g.fillStyle = '#fff'
        g.font = 'bold 48px sans-serif'
        g.fillText('ARIZ 9-6-78', 300, 600)
      }
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
      files.push(new File([blob], `scan-${k}.jpg`, { type: 'image/jpeg' }))
    }
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const store = useImagesStore()
    await store.addImages(files)
    return store.images.filter((i) => i.name.startsWith('scan-')).length
  })
  expect(added).toBe(3)
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const { useImagesStore } = await import('/src/stores/useImagesStore.js')
          return useImagesStore().images.filter((i) => i.name.startsWith('scan-') && i.meta?.width === 1600).length
        }),
      { timeout: 30_000 },
    )
    .toBe(3)

  // The dialog on the scans' sensor: Text alone. Run closes it; the masks are written in
  // the progress window and a toast sums them up.
  const scanSensor = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    return useImagesStore().images.find((i) => i.name === 'scan-0.jpg').sensorId
  })
  const dialog = page.locator('.auto-mask')
  async function openAutoMask() {
    await page.evaluate(async () => {
      const { useModalsStore } = await import('/src/stores/useModalsStore.js')
      useModalsStore().autoMaskOpen = true
    })
    await dialog.locator('select').selectOption(scanSensor)
  }
  await openAutoMask()
  await dialog.getByRole('button', { name: 'Off', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Mask text' }).check()
  await dialog.getByRole('button', { name: 'Mask 3 photos' }).click()
  await expect(dialog).toHaveCount(0)
  // The download prompt for the two models comes before the progress window.
  await page.getByRole('button', { name: /^Download \(/ }).click()
  await expect(page.locator('.toast', { hasText: 'Text on 3 photos' })).toBeVisible({ timeout: 180_000 })

  const result = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const scans = useImagesStore().images.filter((i) => i.name.startsWith('scan-'))
    return scans.map((img) => ({
      name: img.name,
      texts: img.textLines?.lines.map((l) => l.text) ?? null,
      masked: !!img.mask,
    }))
  })
  for (const r of result) {
    expect(r.masked).toBe(true)
    expect(r.texts.some((t) => t.replace(/\s/g, '').includes('USNGS'))).toBe(true)
  }
  expect(result[0].texts.some((t) => t.includes('9-6-78'))).toBe(true)

  const maskAt = (name, points) =>
    page.evaluate(
      async ([name, points]) => {
        const { useImagesStore } = await import('/src/stores/useImagesStore.js')
        const img = useImagesStore().images.find((i) => i.name === name)
        const bmp = await createImageBitmap(img.mask.blob)
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const g = c.getContext('2d')
        g.drawImage(bmp, 0, 0)
        const out = { size: [bmp.width, bmp.height] }
        for (const [k, [x, y]] of Object.entries(points)) out[k] = g.getImageData(x, y, 1, 1).data[3] > 127
        return out
      },
      [name, points],
    )

  // The mask covers the data strip and the date, and leaves the ground alone.
  expect(await maskAt('scan-0.jpg', { strip: [1560, 400], date: [420, 590], ground: [800, 300] })).toEqual({
    strip: true,
    date: true,
    ground: false,
    size: [1600, 1200],
  })

  // Film frame and Text together, replacing the masks: the black band down the right side
  // is the scans' only frame, the date on the photograph comes from the text (read before,
  // so no download), and nothing else is left of the old masks.
  await openAutoMask()
  await dialog.getByRole('button', { name: 'Film frame', exact: true }).click()
  await dialog.getByRole('checkbox', { name: 'Mask text' }).check()
  await dialog.getByRole('radio', { name: 'Replace' }).check()
  await dialog.getByRole('button', { name: 'Mask 3 photos' }).click()
  const toast = page.locator('.toast', { hasText: 'Film frame on 3 photos' })
  await expect(toast).toBeVisible({ timeout: 60_000 })
  await expect(toast).toContainText('Text on 3 photos')
  await expect(toast).not.toContainText('without a frame')
  expect(
    await maskAt('scan-0.jpg', { band: [1510, 700], date: [420, 590], ground: [800, 300], left: [5, 600] }),
  ).toEqual({ band: true, date: true, ground: false, left: false, size: [1600, 1200] })
  // The other photos were not touched.
  const others = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    return useImagesStore().images.filter((i) => !i.name.startsWith('scan-') && i.mask).length
  })
  expect(others).toBe(0)

  // Read Text: what was read, and the focal length the camera's photos agree on, which a
  // film camera takes over.
  const sensorId = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    const id = useImagesStore().images.find((i) => i.name === 'scan-0.jpg').sensorId
    useSensorsStore().updateSensor(id, 'kind', 'film')
    useModalsStore().readTextOpen = true
    return id
  })
  const reader = page.locator('.read-text')
  await expect(reader.locator('tr', { hasText: 'scan-0.jpg' })).toContainText('9-6-78')
  const camera = reader.locator('.camera').filter({ hasText: '152.860 mm (3 of 3 photos)' })
  await expect(camera).toBeVisible()
  await camera.getByRole('button', { name: 'Use 152.860 mm' }).click()
  const focal = await page.evaluate(async (id) => {
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const s = useSensorsStore().sensors.find((x) => x.id === id)
    return [s.focal, s.focalUnit]
  }, sensorId)
  expect(focal).toEqual([152.86, 'mm'])
  await expect(camera.getByRole('button', { name: 'Use 152.860 mm' })).toBeDisabled()
  expect(errors).toEqual([])
})
