import { ref } from 'vue'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useLog } from './useLog.js'
import { cancelRun, detectPhotoFrame, POOL_SIZE } from '../workers/computeClient.js'
import { buildBorderMask } from '../utils/maskCanvas.js'
import { computeSourceOf } from '../utils/image.js'
import { mapConcurrent } from '../utils/concurrency.js'
import { consistentMargins, nativeFrameMargins } from '../core/maskFrame.js'
import { pluralize } from '../core/textFormat.js'

// Auto Mask ▸ Film frame (useAutoMaskRun.js): find the film frame on each scan
// (core/maskFrame.js, in the workers, one scan per worker), make the frames of a group
// of same-size scans consistent (a side far off the group's takes its median), and mask
// outside them, grown by the inset.
export function useFrameMask() {
  const imagesStore = useImagesStore()
  const { log } = useLog()
  const busy = ref(false)
  const progress = ref(null) // { done, total }
  let cancelled = false

  /**
   * Mask outside the frame on `groups` (Auto Mask's size groups: `{ w, h, images }`).
   * `insetPct`: % of the long side added inside the frame. `existing`: 'merge' | 'replace'.
   * `onProgress(done, total)`: after each scan is searched.
   * → `{ masked, none, replaced, failed }` or `{ cancelled }`.
   */
  async function maskFrame(groups, { insetPct, existing, onProgress = null }) {
    const sized = groups.filter((g) => g.w && g.h && g.images.length)
    const total = sized.reduce((n, g) => n + g.images.length, 0)
    if (busy.value || !total) return null
    busy.value = true
    cancelled = false
    progress.value = { done: 0, total }
    const merge = existing === 'merge'
    let done = 0,
      masked = 0,
      none = 0,
      replaced = 0,
      failed = 0
    try {
      const workers = Math.max(1, Math.min(POOL_SIZE, total))
      log(`Auto Mask ▸ Frame: ${pluralize(total, 'photo')} on ${pluralize(workers, 'worker')}`, 'info', 'Images')
      const raw = new Map()
      await mapConcurrent(
        sized.flatMap((g) => g.images),
        workers,
        async (img) => {
          if (cancelled) return
          try {
            await imagesStore.whenComputeReady(img)
            raw.set(img.id, await detectPhotoFrame(computeSourceOf(img)))
          } catch (err) {
            if (cancelled) return
            failed++
            log(`${img.name}: frame detection failed — ${err?.message ?? err}`, 'error', 'Images')
          }
          progress.value = { done: ++done, total }
          onProgress?.(done, total)
        },
      )
      if (cancelled) {
        log('Auto Mask ▸ Frame cancelled; no mask was written', 'warn', 'Images')
        return { cancelled: true }
      }
      for (const g of sized) {
        const imgs = g.images.filter((img) => raw.has(img.id))
        if (!imgs.length) continue
        const r0 = raw.get(imgs[0].id)
        const consistent = consistentMargins(
          imgs.map((img) => raw.get(img.id)),
          r0.width,
          r0.height,
        )
        for (const [k, img] of imgs.entries()) {
          const r = raw.get(img.id),
            c = consistent[k]
          const m = nativeFrameMargins(c, r.sx, r.sy, r.natW, r.natH, insetPct / 100)
          if (c.replaced.length) replaced++
          const sides = ['top', 'right', 'bottom', 'left']
          if (sides.every((s) => !m[s])) {
            none++
            log(`${img.name}: no frame found`, 'warn', 'Images')
            continue
          }
          log(
            `${img.name}: frame ${sides.map((s) => m[s]).join('/')} px` +
              (c.replaced.length ? ` (${c.replaced.join(', ')} from the group's median)` : ''),
            'info',
            'Images',
          )
          const base = merge && img.mask ? img.mask.blob : null
          imagesStore.updateMask(img.id, await buildBorderMask(r.natW, r.natH, m, base))
          masked++
        }
      }
      log(
        `Auto Mask ▸ Frame: ${pluralize(masked, 'photo')} masked` +
          (replaced ? `, ${replaced} with a side from the group's median` : '') +
          (none ? `, ${none} without a frame` : '') +
          (failed ? `, ${failed} failed` : ''),
        none || failed ? 'warn' : 'success',
        'Images',
      )
      return { masked, none, replaced, failed }
    } finally {
      busy.value = false
      progress.value = null
    }
  }

  function cancel() {
    if (!busy.value) return
    cancelled = true
    cancelRun('Auto Mask cancelled')
  }

  return { maskFrame, cancel, busy, progress }
}
