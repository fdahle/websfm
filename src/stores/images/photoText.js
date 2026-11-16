import { readPhotoText, POOL_SIZE } from '../../workers/computeClient.js'
import { computeSourceOf } from '../../utils/image.js'
import { mapConcurrent } from '../../utils/concurrency.js'
import { compactLines, ocrConcurrency, OCR_ENGINE } from '../../core/ocr/textRun.js'
import { pluralize } from '../../core/textFormat.js'

// The text on the photos (core/ocr/), kept on each image record as `textLines`:
// `{ engine, lines: [{ quad, text, score, angle }], at }`, quads in native pixels. Auto
// Mask ▸ Text masks from it, and the photo's properties show it. Read once per photo
// and engine: a later mask run with other settings reuses it.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createPhotoText({ images, log, save, whenComputeReady }) {
  /** Whether `img` holds text read by the current engine. */
  const hasText = (img) => img.textLines?.engine === OCR_ENGINE

  /**
   * Read the text on `targets` (image records) that hold none from the current engine,
   * or on all of them with `force`. Spreads the photos over as many workers as
   * `budgetBytes` holds. `isCancelled()` stops between photos; a cancelled run keeps
   * what it read. Returns `{ read, failed, skipped }`.
   */
  async function readPhotoTexts(targets, { force = false, budgetBytes, onProgress, isCancelled = () => false } = {}) {
    const todo = targets.filter((img) => force || !hasText(img))
    const skipped = targets.length - todo.length
    if (!todo.length) return { read: 0, failed: 0, skipped }
    const workers = ocrConcurrency(todo.length, POOL_SIZE, budgetBytes)
    log(
      `Read text: ${pluralize(todo.length, 'photo')} on ${pluralize(workers, 'worker')}` +
        (skipped ? ` (${skipped} already read)` : ''),
      'info',
      'Images',
    )
    let done = 0,
      failed = 0,
      lines = 0
    const t0 = performance.now()
    await mapConcurrent(todo, workers, async (img) => {
      if (isCancelled()) return
      try {
        await whenComputeReady(img)
        const r = await readPhotoText(computeSourceOf(img), {})
        const kept = compactLines(r.lines)
        // The store's own (reactive) record: `img` came from its list.
        img.textLines = { engine: OCR_ENGINE, lines: kept, at: new Date().toISOString() }
        lines += kept.length
        log(
          `${img.name}: ${pluralize(kept.length, 'text line')} of ${r.lines.length} found ` +
            `(${r.width}×${r.height} px, ${r.tiles} tiles, find ${r.detectMs} ms, read ${r.readMs} ms)`,
          'info',
          'Images',
        )
      } catch (err) {
        if (isCancelled()) return
        failed++
        log(`${img.name}: reading text failed — ${err?.message ?? err}`, 'error', 'Images')
      }
      onProgress?.(++done, todo.length)
    })
    const s = ((performance.now() - t0) / 1000).toFixed(1)
    log(
      `Read text: ${pluralize(done - failed, 'photo')} in ${s} s, ${pluralize(lines, 'text line')}` +
        (failed ? `, ${failed} failed` : ''),
      failed ? 'warn' : 'success',
      'Images',
    )
    save()
    return { read: done - failed, failed, skipped }
  }

  return { readPhotoTexts, hasPhotoText: hasText }
}
