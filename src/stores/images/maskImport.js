import { matchMaskFiles } from '../../core/io/maskFiles.js'
import { MASK_IMPORT_DEFAULTS } from '../../core/defaults.user.js'
import { maskFromFile, POOL_SIZE } from '../../workers/computeClient.js'
import { pluralize } from '../../core/textFormat.js'

// Masks ▸ Import folder: one mask file per image, paired by name
// (core/io/maskFiles.js), split out of useImagesStore. Each file is decoded, sized
// and normalized on the worker pool (TIFFs included), all files at once: the pool
// queues one per worker.
export function createMaskImport({ imageById, images, log, updateMask }) {
  // Which files would go where, for the dialog's preview. → matchMaskFiles' result.
  function planMaskImport(files) {
    return matchMaskFiles(
      files.map((f) => f.name),
      images.value,
    )
  }

  // `existing`: 'replace' an image's mask with its file, or 'merge' the two.
  // → { imported, failed, noSize, plan }
  async function importMaskFiles(files, { existing = MASK_IMPORT_DEFAULTS.existing, onProgress } = {}) {
    const plan = planMaskImport(files)
    const t0 = performance.now()
    let done = 0
    let imported = 0
    let failed = 0
    let noSize = 0
    await Promise.all(
      plan.pairs.map(async ({ index, imageId }) => {
        const img = imageById(imageId)
        const w = img?.meta?.width
        const h = img?.meta?.height
        try {
          if (!w || !h) {
            noSize++
            log(`Mask not imported for ${img?.name}: the image's size is not known yet`, 'warn', 'Images')
            return
          }
          const base = existing === 'merge' ? (img.mask?.blob ?? null) : null
          updateMask(imageId, await maskFromFile(files[index], w, h, base))
          imported++
        } catch (err) {
          failed++
          log(`Mask not imported for ${img?.name} from ${files[index].name}: ${err?.message ?? err}`, 'error', 'Images')
        } finally {
          onProgress?.(++done, plan.pairs.length)
        }
      }),
    )
    const notes = [
      plan.unmatched.length && `${pluralize(plan.unmatched.length, 'file')} matched no image`,
      plan.duplicates.length && `${pluralize(plan.duplicates.length, 'second file')} for an image ignored`,
      plan.skipped.length && `${pluralize(plan.skipped.length, 'file')} not an image`,
      plan.imagesWithout && `${pluralize(plan.imagesWithout, 'image')} without a file`,
    ].filter(Boolean)
    log(
      `Masks imported: ${imported} of ${pluralize(plan.pairs.length, 'matched file')} (${existing}) in ` +
        `${((performance.now() - t0) / 1000).toFixed(1)} s on up to ${pluralize(Math.min(POOL_SIZE, plan.pairs.length), 'worker')}` +
        (notes.length ? `; ${notes.join(', ')}` : ''),
      failed || noSize ? 'warn' : 'success',
      'Images',
    )
    return { imported, failed, noSize, plan }
  }

  return { planMaskImport, importMaskFiles }
}
