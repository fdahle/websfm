import { extractMetadata } from '../../core/io/metadata.js'
import { createImage } from '../../utils/image.js'
import * as opfs from '../../utils/opfs.js'
import { isTiff, readTiffDimensions, canDecodeTiffNatively } from '../../utils/tiff.js'
import { transcodeTiff } from '../../workers/computeClient.js'

// TIFF transcodes in flight, bounded by pixels rather than by count. Each holds the
// decoded RGBA, its canvas and the JPEG + PNG encodes (~12 bytes per pixel), all in
// the renderer process (the workers share it). A batch used to transcode all its
// files at once: 32 Iceland 1980 scans (130 MP each) killed the renderer, and with
// GPU canvas the overlapping readbacks failed 31 of 125 images. A file larger than
// the budget still runs, alone.
const TIFF_TRANSCODE_PIXEL_BUDGET = 400e6
function createPixelBudget(cap) {
  let inFlight = 0
  const waiting = []
  const pump = () => {
    while (waiting.length && (inFlight === 0 || inFlight + waiting[0].px <= cap)) {
      const w = waiting.shift()
      inFlight += w.px
      w.resolve()
    }
  }
  return {
    acquire(px) { return new Promise((resolve) => { waiting.push({ px, resolve }); pump() }) },
    release(px) { inFlight -= px; pump() },
  }
}
const tiffBudget = createPixelBudget(TIFF_TRANSCODE_PIXEL_BUDGET)

// Adding images, split out of useImagesStore: dedupe against the session, write
// the originals and derived display/compute copies, read EXIF in the workers, and
// publish each record as soon as it can be shown. TIFFs get their lossless
// compute PNG after the display JPEG (see whenComputeReady).
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createIngest({
  activeImports, images, isPersisting, log, markComputePending, pendingWorkCount, projects,
  rejectComputeReady, resolveComputeReady, save, thumbnails, trackWrite,
}) {
  function extractMetadataFor(item, file, projectId, presetDims) {
    return extractMetadata(file, item.url, presetDims)
      .then((meta) => {
        const found = projects.currentProjectId === projectId
          ? images.value.find((img) => img.uuid === item.uuid) : null
        if (found) {
          found.meta = meta
          found.loading = false
          const cam = [meta.make, meta.model].filter(Boolean).join(' ') || 'unknown camera'
          const dim = meta.width && meta.height ? ` ${meta.width}×${meta.height}` : ''
          log(`Metadata: ${file.name} — ${cam}${dim}`, 'success', 'Metadata')
          if (isPersisting()) save(projectId)
        }
      })
      .catch((err) => {
        const found = projects.currentProjectId === projectId
          ? images.value.find((img) => img.uuid === item.uuid) : null
        if (found) found.loading = false
        log(`Metadata failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Metadata')
        if (isPersisting()) save(projectId)
      })
  }

  async function addImages(files, onProgress) {
    const task = addImagesNow(files, onProgress)
    activeImports.add(task)
    pendingWorkCount.value++
    try { return await task } finally {
      activeImports.delete(task)
      pendingWorkCount.value--
    }
  }

  async function addImagesNow(files, onProgress) {
    const projectId = projects.currentProjectId
    const persistImport = !!projectId && isPersisting()
    let added = 0
    const tiffItems = []
    const metadataTasks = []
    const batchWrites = []
    // One id set for the whole batch: a per-file scan of the (growing, reactive)
    // list was O(N²) on a multi-thousand-image drop.
    const knownIds = new Set(images.value.map((img) => img.id))
    for (const file of files) {
      const item = createImage(file)
      // Keep the immutable source filename separate from the user-editable label.
      // TIFF decoding must not depend on whether a user keeps the .tif extension
      // in the label they choose later.
      item.sourceName = file.name
      item.groupId = null
      if (knownIds.has(item.id)) {
        URL.revokeObjectURL(item.url)
        log(`Skip duplicate: ${file.name}`, 'warn', 'Images')
        continue
      }
      knownIds.add(item.id)
      images.value.push(item)
      added++
      log(`Added image: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`, 'info', 'Images')

      if (persistImport) {
        batchWrites.push(trackWrite(opfs.saveImage(projectId, item.uuid, file)
          .catch((err) => log(`OPFS save failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Images'))))
      }

      // Browsers (bar Safari) can't decode TIFF natively, so createImage's blob
      // URL renders blank until transcoded. Batch the transcode below — off the
      // main thread, in parallel — instead of blocking this loop per file; mark
      // the thumbnail as pending so the UI can show a placeholder instead of a
      // broken image while that runs.
      if (isTiff(file)) {
        item.previewPending = true
        // A TIFF's compute PNG isn't ready until the transcode finishes (or the
        // native-decode probe passes) — gate compute consumers until then.
        markComputePending(item.uuid)
        tiffItems.push({ item, file })
        // EXIF + dimensions don't need the slow full pixel decode — the TIFF
        // header gives real width/height near-instantly (readTiffDimensions),
        // so metadata shows up right away instead of waiting on the transcode.
        metadataTasks.push(readTiffDimensions(file)
          .then((dims) => extractMetadataFor(item, file, projectId, dims))
          .catch(() => extractMetadataFor(item, file, projectId)))
      } else {
        metadataTasks.push(extractMetadataFor(item, file, projectId))
        // The list thumbnail, from the File itself — background, behind any row in
        // view. Not awaited: a 5,000-image drop must not wait on 5,000 decodes.
        thumbnails.requestThumbnail(item, { source: file })
      }
    }

    if (tiffItems.length) {
      let done = 0
      const total = tiffItems.length
      await Promise.all(tiffItems.map(async ({ item, file }) => {
        try {
          if (await canDecodeTiffNatively(file)) {
            // This engine renders the raw TIFF natively — item.url (already the
            // raw object URL) works as-is for both display and compute.
            const found = images.value.find((img) => img.id === item.id)
            if (found) { found.computeUrl = found.url; found.previewPending = false }
            resolveComputeReady(item.uuid)
            // This engine decodes the TIFF itself, so the File is the display source.
            thumbnails.requestThumbnail(item, { source: file })
            return
          }
          const dims = await readTiffDimensions(file).catch(() => null)
          const px = dims?.width > 0 && dims?.height > 0 ? dims.width * dims.height : 100e6
          await tiffBudget.acquire(px)
          let transcoded
          try {
            transcoded = await transcodeTiff(file, undefined, {
              // Fires once the decode finishes, well before the full-res JPEG+PNG
              // encode below — swap in a quick low-res preview so the user sees
              // something long before the full-quality one is ready.
              onThumbnail: (thumbBlob) => {
                const found = images.value.find((img) => img.id === item.id)
                // The ≤512 px transcode preview is also the cheapest source for the
                // list thumbnail: no second decode of the full-resolution display JPEG.
                if (found) thumbnails.requestThumbnail(found, { source: thumbBlob })
                if (!found || !found.previewPending) return
                URL.revokeObjectURL(found.url)
                found.url = URL.createObjectURL(thumbBlob)
                // Tells the image viewer that `url` is this reduced preview, not the
                // native-resolution image: it maps coordinates through meta.width/height
                // and holds off editing until a later swap replaces `url` (it compares
                // the two, so any replacement — onDisplay, a heal — clears it). Session
                // only; never persisted.
                found.lowResUrl = found.url
                found.previewPending = false
              },
              // Fires when the full-res display JPEG is encoded, before the slower
              // compute PNG — swap in the full-quality display so the viewer is
              // fully usable while the PNG (computeUrl) is still encoding.
              onDisplay: (dispBlob) => {
                const found = images.value.find((img) => img.id === item.id)
                if (!found) return
                URL.revokeObjectURL(found.url)
                found.url = URL.createObjectURL(dispBlob)
                found.lowResUrl = null
                found.previewPending = false
              },
            })
          } finally {
            tiffBudget.release(px)
          }
          const { displayBlob, computeBlob, width, height, timings, srcInfo } = transcoded
          const found = images.value.find((img) => img.id === item.id)
          if (!found) { resolveComputeReady(item.uuid); return } // removed mid-decode
          // onDisplay already set found.url from displayBlob; if the display
          // event never fired (older worker), fall back to setting it here.
          if (found.previewPending || found.lowResUrl) {
            URL.revokeObjectURL(found.url)
            found.url = URL.createObjectURL(displayBlob)
            found.lowResUrl = null
            found.previewPending = false
          }
          found.computeUrl = URL.createObjectURL(computeBlob)
          resolveComputeReady(item.uuid)
          // No preview event (an older worker): fall back to the display JPEG.
          if (!found.thumb) thumbnails.requestThumbnail(found)
          log(`Decoded TIFF: ${file.name} — ${width}×${height}`, 'info', 'Images')
          if (timings) {
            // Per-stage baseline for the TIFF-codec plan (TODO.md): which stage
            // dominates decides whether/what to move to a Rust/WASM codec.
            const c = { 1: 'none', 5: 'LZW', 7: 'JPEG', 8: 'Deflate', 32773: 'PackBits' }[srcInfo?.compression] ?? srcInfo?.compression
            const p = { 1: 'gray', 2: 'RGB', 3: 'palette', 6: 'YCbCr' }[srcInfo?.photometric] ?? srcInfo?.photometric
            const srcMB = srcInfo?.srcBytes ? (srcInfo.srcBytes / 1048576).toFixed(1) : '?'
            log(
              `TIFF timing (${timings.backend ?? '?'}): ${file.name} — decode ${timings.decodeMs?.toFixed(0)}ms · repack ${timings.repackMs?.toFixed(0)}ms · JPEG ${timings.jpegMs?.toFixed(0)}ms · PNG ${timings.pngMs?.toFixed(0)}ms · total ${timings.totalMs?.toFixed(0)}ms  ` +
              `[${p ?? '?'}/${srcInfo?.bitsPerSample ?? '?'}-bit/${srcInfo?.samplesPerPixel ?? '?'}spp/${c ?? '?'}, src ${srcMB} MB]`,
              'info', 'Images',
            )
            // A 16-bit source is stretched between its 0.5 / 99.5 % levels for display
            // and detection (core/io/tonalStretch.js) — record the mapping it got.
            if (srcInfo?.stretch) {
              log(`16-bit TIFF stretched to 8-bit: ${file.name} — DN ${srcInfo.stretch.lo}…${srcInfo.stretch.hi} → 0…255 `
                + `(0.5 / 99.5 % levels; the high byte alone would span ${srcInfo.stretch.lo >> 8}…${srcInfo.stretch.hi >> 8})`,
              'info', 'Images')
            }
          }
          // Cache the transcode outputs in OPFS so reopening the project skips
          // the (multi-second) re-decode + re-encode — see the TIFF gotcha in
          // CLAUDE.md. Pure function of the immutable original; fire-and-forget.
          if (persistImport) {
            log(`Caching TIFF derived blobs: ${file.name} — display ${(displayBlob.size / 1024).toFixed(0)} KB, compute ${(computeBlob.size / 1024).toFixed(0)} KB`, 'info', 'Images')
            batchWrites.push(trackWrite(opfs.saveImageDerived(projectId, item.uuid, 'display', displayBlob)
              .catch((err) => log(`OPFS derived save failed (display): ${file.name} — ${err?.message ?? err}`, 'error', 'Images'))))
            batchWrites.push(trackWrite(opfs.saveImageDerived(projectId, item.uuid, 'compute', computeBlob)
              .catch((err) => log(`OPFS derived save failed (compute): ${file.name} — ${err?.message ?? err}`, 'error', 'Images'))))
          }
        } catch (err) {
          const found = images.value.find((img) => img.id === item.id)
          if (found) {
            found.loading = false
            found.previewPending = false
            found.previewFailed = true
            found.previewFailReason = 'decode'
          }
          // Reject readiness so compute consumers error loudly rather than
          // silently fall back to the lossy display JPEG for a TIFF (that would
          // leak JPEG artifacts into keypoints/depth — the computeUrl invariant).
          rejectComputeReady(item.uuid, err instanceof Error ? err : new Error(String(err)))
          log(`TIFF decode failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Images')
        } finally {
          done++
          onProgress?.(done, total, file.name)
        }
      }))
    }

    await Promise.allSettled(metadataTasks)
    await Promise.allSettled(batchWrites)
    if (added > 1) log(`Added ${added} images`, 'success', 'Images')
    if (persistImport) await save(projectId)
  }

  return {
    extractMetadataFor, addImages, addImagesNow,
  }
}
