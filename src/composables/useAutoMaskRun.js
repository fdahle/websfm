import { useImagesStore } from '../stores/useImagesStore.js'
import { useModelsStore } from '../stores/useModelsStore.js'
import { buildBorderMask } from '../utils/maskCanvas.js'
import { maskGroups } from '../utils/maskGroups.js'
import { cancelRun } from '../workers/computeClient.js'
import { autoMaskSteps } from '../core/runSteps.js'
import { pluralize } from '../core/textFormat.js'
import { useFrameMask } from './useFrameMask.js'
import { OCR_MODEL_IDS, useTextMask } from './useTextMask.js'
import { useLog } from './useLog.js'
import { t } from './useI18n.js'
import { showToast } from './useToasts.js'

const SIDES = ['top', 'right', 'bottom', 'left']

// Auto Mask's run (AutoMaskModal.vue emits the request, useDialogRuns hands it here):
// the edges first (a fixed strip, or the film frame found on each scan), then the text,
// each in the shared progress window. The two masks are one result: the edges are
// merged with or replace a photo's mask as the dialog says, and the text is added to
// what the edges left. One toast says what was done; the log has each photo.
//
// `progress`: usePipeline's progress contract ({ open, report, close, aborted }).
export function useAutoMaskRun(progress) {
  const imagesStore = useImagesStore()
  const modelsStore = useModelsStore()
  const frameMask = useFrameMask()
  const textMask = useTextMask()
  const { log } = useLog()

  // A fixed strip along the edges of every photo (in its own pixels).
  async function maskStrip(images, sides, merge, isCancelled) {
    let done = 0
    for (const img of images) {
      if (isCancelled()) return { cancelled: true }
      const base = merge && img.mask ? img.mask.blob : null
      imagesStore.updateMask(img.id, await buildBorderMask(img.meta.width, img.meta.height, { ...sides }, base))
      progress.report(++done, images.length, t('autoMask.progress.strip'), null, 'edges')
    }
    log(
      `Auto Mask ▸ Strip: ${pluralize(done, 'photo')}, ${SIDES.map((k) => sides[k]).join('/')} px`,
      'success',
      'Images',
    )
    return { masked: done }
  }

  /**
   * req: { imageIds, edges: 'off' | 'strip' | 'frame', sides, frameInset, text, textPad,
   *        textRecurring, existing: 'merge' | 'replace' }
   */
  async function runAutoMask(req) {
    const ids = new Set(req.imageIds)
    const images = imagesStore.images.filter((img) => ids.has(img.id))
    const sized = images.filter((img) => img.meta?.width > 0 && img.meta?.height > 0)
    const unsized = images.length - sized.length
    const edges = req.edges === 'strip' && SIDES.every((k) => !req.sides[k]) ? 'off' : req.edges
    if (!sized.length || (edges === 'off' && !req.text)) return
    if (unsized) log(`Auto Mask: ${pluralize(unsized, 'photo')} of unknown size skipped`, 'warn', 'Images')

    // The OCR models' consent comes BEFORE the progress window, which would cover it
    // (usePipeline ensureModels). Photos read before need no models.
    if (req.text && sized.some((img) => !imagesStore.hasPhotoText(img))) {
      if (!(await modelsStore.ensureReady(OCR_MODEL_IDS))) {
        log('Auto Mask: the text models were not downloaded; nothing was masked', 'warn', 'Images')
        return
      }
    }

    let cancelled = false
    const isCancelled = () => cancelled || progress.aborted.value
    const steps = autoMaskSteps({ edges, text: req.text })
    progress.open(
      t('autoMask.title'),
      sized.length,
      () => {
        cancelled = true
        frameMask.cancel()
        textMask.cancel()
        cancelRun('Auto Mask cancelled')
      },
      { unit: 'photos', steps },
    )
    const parts = []
    let ok = true
    try {
      const merge = req.existing === 'merge'
      if (edges === 'strip') {
        const r = await maskStrip(sized, req.sides, merge, isCancelled)
        if (r.cancelled) return
        parts.push(t('autoMask.done.strip', r))
      } else if (edges === 'frame') {
        const r = await frameMask.maskFrame(maskGroups(sized).sizedGroups, {
          insetPct: req.frameInset,
          existing: req.existing,
          onProgress: (done, total) => progress.report(done, total, t('autoMask.progress.frame'), null, 'edges'),
        })
        if (!r || r.cancelled) return
        parts.push(t('autoMask.done.frame', r))
      }
      if (req.text && !isCancelled()) {
        const r = await textMask.maskText(sized, {
          padPx: req.textPad,
          recurring: req.textRecurring,
          // After the edges, the text adds to the mask they made.
          existing: edges === 'off' ? req.existing : 'merge',
          onProgress: ({ phase, done, total }) =>
            progress.report(
              done,
              total,
              t(phase === 'read' ? 'autoMask.progress.read' : 'autoMask.progress.text'),
              null,
              phase,
            ),
        })
        if (!r || r.cancelled || r.declined) return
        parts.push(t('autoMask.done.text', r))
      }
    } catch (err) {
      ok = false
      const why = err?.message ?? String(err)
      log(`Auto Mask failed: ${why}`, 'error', 'Images')
      showToast(t('autoMask.failed'), { detail: why, kind: 'error', ms: 6000 })
    } finally {
      await progress.close(ok)
    }
    if (ok && parts.length && !isCancelled())
      showToast(t('autoMask.title'), {
        detail: [...parts, ...(unsized ? [t('autoMask.done.unsized', { n: unsized })] : [])].join(' · '),
        ms: 6000,
      })
  }

  return { runAutoMask }
}
