import { matchMaskFiles } from '../../core/io/maskFiles.js'
import { MASK_IMPORT_DEFAULTS } from '../../core/defaults.user.js'
import { maskFromFile, POOL_SIZE } from '../../workers/computeClient.js'
import { pluralize } from '../../core/textFormat.js'
import { TAB_BUFFER_POOL_BYTES } from '../../core/bufferLimit.js'

// Masks ▸ Import folder: one mask file per image, paired by name
// (core/io/maskFiles.js), split out of useImagesStore. Each file is decoded, sized
// and normalized on the worker pool (TIFFs included), one file per worker at a time:
// the pool posts every call at once and a worker interleaves them, so 58 full-size
// scan masks sent together held seven 400 MB decodes per worker and ran out of memory.

// A mask's working memory on its worker: the decoded RGBA, the canvas, the PNG encode.
const MASK_BYTES_PER_PIXEL = 12
// The share of the tab's buffer pool a mask import may hold; image transcodes of the
// same folder may still be running beside it.
const MASK_POOL_SHARE = 0.25
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
    const largest = Math.max(
      1,
      ...plan.pairs.map(
        ({ imageId }) => (imageById(imageId)?.meta?.width ?? 0) * (imageById(imageId)?.meta?.height ?? 0),
      ),
    )
    const workers = Math.max(
      1,
      Math.min(
        POOL_SIZE,
        plan.pairs.length,
        Math.floor((MASK_POOL_SHARE * TAB_BUFFER_POOL_BYTES) / (largest * MASK_BYTES_PER_PIXEL)),
      ),
    )
    let cursor = 0
    const drain = async () => {
      while (cursor < plan.pairs.length) await importOne(plan.pairs[cursor++])
    }
    const importOne = async ({ index, imageId }) => {
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
    }
    await Promise.all(Array.from({ length: workers }, drain))
    const notes = [
      plan.unmatched.length && `${pluralize(plan.unmatched.length, 'file')} matched no image`,
      plan.duplicates.length && `${pluralize(plan.duplicates.length, 'second file')} for an image ignored`,
      plan.skipped.length && `${pluralize(plan.skipped.length, 'file')} not an image`,
      plan.imagesWithout && `${pluralize(plan.imagesWithout, 'image')} without a file`,
    ].filter(Boolean)
    log(
      `Masks imported: ${imported} of ${pluralize(plan.pairs.length, 'matched file')} (${existing}) in ` +
        `${((performance.now() - t0) / 1000).toFixed(1)} s on ${pluralize(workers, 'worker')}` +
        (notes.length ? `; ${notes.join(', ')}` : ''),
      failed || noSize ? 'warn' : 'success',
      'Images',
    )
    return { imported, failed, noSize, plan }
  }

  return { planMaskImport, importMaskFiles }
}
