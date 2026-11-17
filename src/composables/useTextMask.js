import { ref } from 'vue'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useModelsStore } from '../stores/useModelsStore.js'
import { useComputeSettings } from './useComputeSettings.js'
import { useLog } from './useLog.js'
import { cancelRun } from '../workers/computeClient.js'
import { buildPolygonMask } from '../utils/maskCanvas.js'
import { storedToLines, sharedCoords, textMaskPlan, MAX_TEXT_SHARE } from '../core/ocr/textRun.js'
import { pluralize } from '../core/textFormat.js'

export const OCR_MODEL_IDS = ['ppocr_det', 'ppocr_rec_en']

// Auto Mask ▸ Text (useAutoMaskRun.js) and Read text (ReadTextModal.vue): read the text
// on the photos (once per photo, images/photoText.js); Auto Mask then masks what
// core/ocr/textRun.js textMaskPlan says: sure
// text where it was found, and with `recurring` the text a camera prints at the same
// place on its frames, on every frame of that camera. The photos of one run form the
// frames recurrence looks at.
export function useTextMask() {
  const imagesStore = useImagesStore()
  const sensorsStore = useSensorsStore()
  const modelsStore = useModelsStore()
  const { memBudgetBytes } = useComputeSettings()
  const { log } = useLog()

  const busy = ref(false)
  // { phase: 'read' | 'mask', done, total } while a run is on; `onProgress` (a
  // maskText option) hears each change too.
  const progress = ref(null)
  let cancelled = false
  let onProgress = null
  const setProgress = (p) => {
    progress.value = p
    onProgress?.(p)
  }

  const sensorOf = (img) => sensorsStore.sensors.find((s) => s.id === img.sensorId) ?? null

  // Read the photos not read yet (all with `force`), with the progress shown; the
  // models are downloaded first, with consent. → `{ failed }`, `{ declined }` or
  // `{ cancelled }`. Called with `busy` already set by the caller.
  async function readPhase(images, force) {
    // Nothing to read (a mask rerun with other settings): no models needed.
    const toRead = force ? images : images.filter((img) => !imagesStore.hasPhotoText(img))
    if (!toRead.length) return { failed: 0, read: 0 }
    if (!(await modelsStore.ensureReady(OCR_MODEL_IDS))) return { declined: true }
    setProgress({ phase: 'read', done: 0, total: images.length })
    const { failed, read } = await imagesStore.readPhotoTexts(images, {
      force,
      budgetBytes: memBudgetBytes.value,
      isCancelled: () => cancelled,
      onProgress: (done, total) => setProgress({ phase: 'read', done, total }),
    })
    if (cancelled) {
      log('Reading text cancelled; the text read so far is kept', 'warn', 'Images')
      return { cancelled: true }
    }
    return { failed, read }
  }

  /**
   * Read the text on `images` (Tools ▸ Images ▾ ▸ Read text): those not read yet, or
   * all with `force`. → `{ read, failed }`, `{ declined }` or `{ cancelled }`.
   */
  async function readText(images, { force = false } = {}) {
    if (busy.value || !images.length) return null
    busy.value = true
    cancelled = false
    try {
      return await readPhase(images, force)
    } finally {
      busy.value = false
      progress.value = null
    }
  }

  /**
   * Mask the text on `images` (image records). `existing`: 'merge' adds the text to a
   * photo's mask, 'replace' makes the text its whole mask (none where no text is).
   * `onProgress({ phase, done, total })`: as the photos are read, then masked.
   * Resolves `{ masked, cleared, skipped, failed }`, or `{ declined }` when the models
   * were not downloaded, or `{ cancelled }`.
   */
  async function maskText(images, { padPx, recurring, existing, onProgress: hear = null }) {
    if (busy.value || !images.length) return null
    busy.value = true
    cancelled = false
    onProgress = hear
    try {
      const phase = await readPhase(images, false)
      if (phase.declined || phase.cancelled) return phase
      const { failed } = phase
      const frames = images
        .filter((img) => imagesStore.hasPhotoText(img) && img.meta?.width > 0 && img.meta?.height > 0)
        .map((img) => {
          const natW = img.meta.width,
            natH = img.meta.height
          return {
            id: img.id,
            img,
            natW,
            natH,
            camera: img.sensorId ?? `${natW}x${natH}`,
            lines: storedToLines(img.textLines.lines),
            shared: sharedCoords(img, sensorOf(img), natW, natH),
          }
        })
      const plan = textMaskPlan(frames, { padPx, recurring })
      const merge = existing === 'merge'
      let masked = 0,
        cleared = 0,
        skipped = 0,
        regions = 0,
        spread = 0
      setProgress({ phase: 'mask', done: 0, total: frames.length })
      for (const [k, f] of frames.entries()) {
        const p = plan.get(f.id)
        if (p.skipped) {
          skipped++
          log(
            `${f.img.name}: text would cover ${Math.round(p.share * 100)} % of the photo ` +
              `(more than ${Math.round(MAX_TEXT_SHARE * 100)} %); not masked`,
            'warn',
            'Images',
          )
        } else if (!p.polygons.length) {
          if (!merge && f.img.mask) {
            imagesStore.updateMask(f.id, null)
            cleared++
          }
        } else {
          const base = merge && f.img.mask ? f.img.mask.blob : null
          imagesStore.updateMask(f.id, await buildPolygonMask(f.natW, f.natH, p.polygons, base))
          masked++
          regions += p.polygons.length
          spread += p.recurring
        }
        setProgress({ phase: 'mask', done: k + 1, total: frames.length })
      }
      log(
        `Auto Mask ▸ Text: ${pluralize(masked, 'photo')} masked, ${pluralize(regions, 'text region')}` +
          (recurring ? ` (${spread} from text recurring on a camera's photos)` : '') +
          (cleared ? `, ${cleared} masks cleared (no text)` : '') +
          (skipped ? `, ${skipped} skipped` : '') +
          (failed ? `, ${failed} not read` : ''),
        skipped || failed ? 'warn' : 'success',
        'Images',
      )
      return { masked, cleared, skipped, failed }
    } finally {
      busy.value = false
      progress.value = null
      onProgress = null
    }
  }

  function cancel() {
    if (!busy.value) return
    cancelled = true
    cancelRun('Auto Mask cancelled')
  }

  return { maskText, readText, cancel, busy, progress }
}
