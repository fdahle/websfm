import { test, expect } from './fixtures.js'
import { readFileSync } from 'node:fs'

// Auto Mask ▸ Text end to end: the PP-OCR models download (with the prompt), run in the
// compute workers, read the text on the photos and mask it. Three photos drawn in the
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

  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().autoMaskOpen = true
  })
  const dialog = page.locator('.auto-mask')
  await dialog.getByRole('button', { name: 'Text', exact: true }).click()
  const scanGroup = dialog.locator('.group', { hasText: '1600 × 1200' })
  await scanGroup.getByRole('button', { name: 'Apply to group' }).click()
  // The download prompt for the two models, then the run.
  await page.getByRole('button', { name: /^Download \(/ }).click()
  await expect(dialog.locator('.subbar .hint', { hasText: 'photos masked' })).toBeVisible({ timeout: 180_000 })

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

  // The mask covers the data strip and the date, and leaves the ground alone.
  const coverage = await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const img = useImagesStore().images.find((i) => i.name === 'scan-0.jpg')
    const bmp = await createImageBitmap(img.mask.blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')
    g.drawImage(bmp, 0, 0)
    const at = (x, y) => g.getImageData(x, y, 1, 1).data[3] > 127
    return { strip: at(1560, 400), date: at(420, 590), ground: at(800, 300), size: [bmp.width, bmp.height] }
  })
  expect(coverage).toEqual({ strip: true, date: true, ground: false, size: [1600, 1200] })

  // Read Text: what was read, and the focal length the camera's photos agree on, which a
  // film camera takes over.
  await page.keyboard.press('Escape')
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
