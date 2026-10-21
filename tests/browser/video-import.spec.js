import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Import ▸ Video against the full app: the dialog opens the video, scans it and plans
// the frames; Extract writes them into the project as images named
// <video>_<timestamp>.jpg, with the frame time in their metadata, one shared sensor,
// stored in OPFS (and read back from there); Match Features then starts on Sequential.
//
// Fixture: four South Building sample images, 0.75 s each (the last 1.5 s), 320×240,
// 8 fps, VP9 WebM — made with ffmpeg (VP9, because Playwright's Chromium has no H.264):
//   ffmpeg -f concat -safe 0 -i list.txt -vf "scale=320:240,fps=8,format=yuv420p" \
//          -c:v libvpx-vp9 -b:v 0 -crf 36 -an south-building-4.webm
// with list.txt naming P1180149, P1180163, P1180173, P1180178 (duration 0.75 each).
const FIXTURE = fileURLToPath(new URL('./fixtures/south-building-4.webm', import.meta.url))
const NAME = 'south-building-4.webm'

async function createProject(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
}

const imageState = (page) =>
  page.evaluate(async () => {
    const { useImagesStore } = await import('/src/stores/useImagesStore.js')
    const { useSensorsStore } = await import('/src/stores/useSensorsStore.js')
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const opfs = await import('/src/utils/opfs.js')
    const { useLog } = await import('/src/composables/useLog.js')
    const pid = useProjectsStore().currentProjectId
    const imgs = useImagesStore().images
    const stored = []
    for (const img of imgs) stored.push((await opfs.loadImageBlob(pid, img.uuid).catch(() => null))?.size ?? 0)
    return {
      names: imgs.map((i) => i.name),
      loading: imgs.filter((i) => i.loading).length,
      meta: imgs.map((i) => ({
        src: i.meta?.videoSource ?? null,
        t: i.meta?.videoTime ?? null,
        w: i.meta?.width,
        h: i.meta?.height,
      })),
      sensorIds: [...new Set(imgs.map((i) => i.sensorId))],
      sensors: useSensorsStore().sensors.map((s) => s.label),
      stored,
      // After the read-back a record's file is the OPFS copy, under the frame's own name
      // (IS-1: exports and conversions use it), so the name no longer tells them apart;
      // the read-back's log line does.
      fileNames: imgs.map((i) => i.file?.name ?? null),
      readBack: useLog()
        .entries.value.map((e) => e.message)
        .filter((m) => m.startsWith('Images read from project storage:')),
      thumbs: imgs.filter((i) => i.thumb).length,
    }
  })

test('Import ▸ Video plans frames, then extracts them into the project as images', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const chooser = page.waitForEvent('filechooser')
  await page.locator('.ribbon').getByRole('button', { name: 'Video' }).click()
  await (await chooser).setFiles(FIXTURE)

  const dialog = page.getByRole('dialog', { name: 'Import Video' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('320 × 240')
  // Automatic: the scan runs by itself; four stills separated by cuts → one frame each.
  const plan = dialog.getByTestId('video-plan')
  await expect(plan).toContainText(/^\s*\d+ frames?, /, { timeout: 30_000 })
  const autoCount = Number((await plan.textContent()).match(/(\d+) frames?/)[1])
  expect(autoCount).toBeGreaterThanOrEqual(3)
  expect(autoCount).toBeLessThanOrEqual(6)

  // Fixed interval: every 0.5 s over 3.75 s → 0, 0.5 … 3.5 = 8 frames, counted before extraction.
  await dialog.getByRole('button', { name: 'Fixed interval' }).click()
  await dialog.locator('#vid-every').fill('0.5')
  await expect(plan).toContainText('8 frames')
  await dialog.getByRole('button', { name: 'Extract 8 frames' }).click()
  await expect(dialog).toHaveCount(0)

  await expect
    .poll(
      async () => {
        const s = await imageState(page)
        // Frames arrive in batches, each read back with its own line ("4 of 4 images").
        const readBack = s.readBack.reduce((sum, m) => sum + Number(/: (\d+) of /.exec(m)?.[1] ?? 0), 0)
        return s.names.length === 8 && s.loading === 0 && readBack === 8
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const s = await imageState(page)
  expect(s.fileNames).toEqual(s.names)
  expect(s.names).toEqual(
    [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(
      (t) => `south-building-4_00m0${Math.floor(t)}.${String(Math.round((t % 1) * 1000)).padStart(3, '0')}s.jpg`,
    ),
  )
  expect(s.meta.every((m) => m.src === NAME && m.w === 320 && m.h === 240)).toBe(true)
  expect(s.meta.map((m) => m.t)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5])
  // One sensor for the whole video, named after it.
  expect(s.sensorIds).toHaveLength(1)
  expect(s.sensors).toEqual([`Video ${NAME}`])
  // Every frame is a stored JPEG in the project, and the record reads it from there.
  expect(s.stored.every((n) => n > 1000)).toBe(true)
  await expect.poll(async () => (await imageState(page)).thumbs).toBe(8)

  // The sidebar lists them.
  await page
    .locator('aside.sidebar')
    .getByRole('button', { name: /Images/ })
    .first()
    .click()
  await expect(page.locator('.list-item').filter({ hasText: 'south-building-4_00m00.000s.jpg' })).toBeVisible()
  expect(errors).toEqual([])
})

test('a dropped video opens the dialog, and its frames start Match Features on Sequential', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await createProject(page)

  // Drop the video on the sidebar, as from a file manager.
  const bytes = readFileSync(FIXTURE).toString('base64')
  const dt = await page.evaluateHandle(
    ({ b64, name }) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bin], name, { type: 'video/webm' }))
      return data
    },
    { b64: bytes, name: NAME },
  )
  await page.locator('aside.sidebar').dispatchEvent('drop', { dataTransfer: dt })

  const dialog = page.getByRole('dialog', { name: 'Import Video' })
  await expect(dialog).toBeVisible()
  const extract = dialog.getByRole('button', { name: /^Extract \d+ frames?$/ })
  await expect(extract).toBeEnabled({ timeout: 30_000 })
  const n = Number((await extract.textContent()).match(/\d+/)[0])
  await extract.click()
  await expect
    .poll(
      async () => {
        const s = await imageState(page)
        return s.names.length === n && s.loading === 0
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const s = await imageState(page)
  expect(s.names.every((name) => /^south-building-4_00m0\d\.\d{3}s\.jpg$/.test(name))).toBe(true)

  const profile = await page.evaluate(async () => {
    const { useDatasetRecommendations } = await import('/src/composables/useDatasetRecommendations.js')
    const { profile, recommendations } = useDatasetRecommendations()
    return { kind: profile.value.kind, strategy: recommendations.value.match.strategy?.value }
  })
  expect(profile).toEqual({ kind: 'video', strategy: 'sequential' })

  // The ribbon button needs keypoints; the dialog's starting state does not.
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().matchFeaturesOpen = true
  })
  const match = page.getByRole('dialog', { name: 'Match Features' })
  await expect(match).toBeVisible()
  await expect(match.locator('.seg-btn.active', { hasText: 'Sequential' })).toBeVisible()
  await expect(match).toContainText('Recommended for this dataset')
  expect(errors).toEqual([])
})
