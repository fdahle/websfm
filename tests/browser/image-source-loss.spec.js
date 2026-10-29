import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Images imported from disk files whose originals then move (VERIFICATION PRJ-10,
// PRJ-11). Once its copy is written, an imported image reads the copy (IS-1), so a
// moved original no longer matters. Until then its blob: URL is a handle to the
// user's file: a moved original fails the <img>, the app heals from the OPFS copy,
// and only an image with no usable copy is flagged as lost.

const store = (page, src) =>
  page.evaluate(async (s) => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useLog } = await import('/src/composables/useLog.js')
    const opfs = await import('/src/utils/opfs.js')
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    return new Function('images', 'log', 'opfs', 'projects', `return (${s})(images, log, opfs, projects)`)(
      useImagesStore(),
      useLog(),
      opfs,
      useProjectsStore(),
    )
  }, src.toString())
const logLines = (page, re) =>
  store(page, `(images, log) => log.entries.value.map((e) => e.level + ' ' + e.message).filter((m) => ${re}.test(m))`)

// A new project with three JPEGs imported from disk files (Files backed by those
// paths) and persisted, so each also has its project-storage copy.
async function importFromDisk(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const dir = await mkdtemp(join(tmpdir(), 'websfm-srcloss-'))
  const names = ['a.jpg', 'b.jpg', 'c.jpg']
  const jpegs = await page.evaluate(
    async (n) =>
      Promise.all(
        n.map(async (_, k) => {
          const canvas = new OffscreenCanvas(320, 240)
          const ctx = canvas.getContext('2d')
          for (let y = 0; y < 240; y += 8)
            for (let x = 0; x < 320; x += 8) {
              ctx.fillStyle = `rgb(${(x * 5 + k * 70) % 256}, ${(y * 3 + k * 40) % 256}, ${(x + y) % 256})`
              ctx.fillRect(x, y, 8, 8)
            }
          const bytes = new Uint8Array(
            await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer(),
          )
          let s = ''
          for (const b of bytes) s += String.fromCharCode(b)
          return btoa(s)
        }),
      ),
    names,
  )
  const paths = names.map((n) => join(dir, n))
  await Promise.all(paths.map((p, k) => writeFile(p, Buffer.from(jpegs[k], 'base64'))))
  await page.evaluate(() =>
    document.body.appendChild(
      Object.assign(document.createElement('input'), { type: 'file', multiple: true, id: 'pick' }),
    ),
  )
  await page.setInputFiles('#pick', paths)
  await page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    await useImagesStore().addImages([...document.getElementById('pick').files])
  })
  await expect
    .poll(() => store(page, '(images) => images.images.filter((i) => !i.loading && i.meta?.width === 320).length'))
    .toBe(3)
  await page.evaluate(async () => (await import('/src/utils/persistence.js')).flushPersistence())
  return { dir, paths }
}

// b.jpg back on its original disk file, as in the window before its copy is read
// back: the case the heal is for.
const pointBAtOriginal = (page) =>
  page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const b = useImagesStore().images.find((i) => i.name === 'b.jpg')
    b.url = URL.createObjectURL([...document.getElementById('pick').files].find((f) => f.name === 'b.jpg'))
  })

// Move every original away; c.jpg also loses its project-storage copy (PRJ-11).
async function loseOriginals(page, paths) {
  await Promise.all(paths.map((p) => rename(p, `${p}.moved`)))
  await store(
    page,
    `async (images, log, opfs, projects) => {
    const c = images.images.find((i) => i.name === 'c.jpg')
    await opfs.deleteImage(projects.currentProjectId, c.uuid)
    await opfs.deleteImageDerived(projects.currentProjectId, c.uuid)
  }`,
  )
}

test('moved originals do not matter once copied, heal before that, and an image with no copy is flagged once', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'uses a Chromium DevTools session')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const { dir, paths } = await importFromDisk(page)
  try {
    await pointBAtOriginal(page)
    await loseOriginals(page, paths)

    // Chrome keeps the images decoded at ingest in its memory cache, so a viewer would
    // still show them without reading the moved file; drop it so the views must read.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.clearBrowserCache')
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })

    // IS-1: a.jpg already reads its OPFS copy — the image tab and the metadata table
    // render it with nothing to heal.
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /Images/ })
      .first()
      .click()
    await page.locator('.list-item').filter({ hasText: 'a.jpg' }).dblclick()
    const img = page.locator('.image-viewer img.image')
    await expect(img).toBeVisible()
    await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBe(320)
    await page.evaluate(async () => (await import('/src/composables/useTabs.js')).useTabs().openMetadataTab())
    // PRJ-10: b.jpg still pointed at its original, and heals from the copy, once.
    await page.locator('.list-item').filter({ hasText: 'b.jpg' }).dblclick()
    await expect
      .poll(() => logLines(page, '/^warn Image source recovered from project storage: b\\.jpg/'))
      .toHaveLength(1)
    expect(await logLines(page, '/^warn Image source recovered from project storage: a\\.jpg/')).toHaveLength(0)

    // PRJ-11: c.jpg has nothing to heal from — flagged in the sidebar and the viewer, one error.
    await page.locator('.list-item').filter({ hasText: 'c.jpg' }).dblclick()
    await expect(page.getByText('Image file no longer available').first()).toBeVisible()
    await expect.poll(() => logLines(page, '/^error Image unavailable: c\\.jpg/')).toHaveLength(1)
    await expect(page.locator('.list-item').filter({ hasText: 'c.jpg' }).locator('.failed-tag')).toHaveAttribute(
      'title',
      'image file no longer available — re-add the file',
    )
    await expect(page.locator('.list-item').filter({ hasText: 'a.jpg' }).locator('.failed-tag')).toHaveCount(0)
    expect(await store(page, `(images) => images.images.filter((i) => i.previewFailed).map((i) => i.name)`)).toEqual([
      'c.jpg',
    ])
    // The rest of the app stays usable: a healed image still opens.
    await page.locator('.list-item').filter({ hasText: 'a.jpg' }).dblclick()
    const shown = page.locator('.image-viewer img.image:visible')
    await expect(shown).toHaveCount(1)
    await expect.poll(() => shown.evaluate((el) => el.complete && el.naturalWidth)).toBe(320)
    expect(errors).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// IS-2: before a run, the Workflow Builder probes every image's file instead of
// waiting for a stage to read its pixels. a reads its copy already, b heals from
// project storage on the spot; c, with no copy, is the one reported.
test('the source probe heals what it can and reports the rest before a run', async ({ page }) => {
  const { dir, paths } = await importFromDisk(page)
  try {
    await pointBAtOriginal(page)
    await loseOriginals(page, paths)
    const lost = await store(page, `async (images) => (await images.probeImageSources()).map((i) => i.name)`)
    expect(lost).toEqual(['c.jpg'])
    expect(await logLines(page, '/^warn Image source recovered from project storage: a\\.jpg/')).toHaveLength(0)
    expect(await logLines(page, '/^warn Image source recovered from project storage: b\\.jpg/')).toHaveLength(1)
    expect(await logLines(page, '/^error Image unavailable: c\\.jpg/')).toHaveLength(1)
    // A second probe finds the healed images readable and reports c again, without new log lines.
    expect(await store(page, `async (images) => (await images.probeImageSources()).map((i) => i.name)`)).toEqual([
      'c.jpg',
    ])
    expect(await logLines(page, '/^error Image unavailable/')).toHaveLength(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
