import { extractMetadata } from '../../core/io/metadata.js'
import { createImage } from '../../utils/image.js'
import * as opfs from '../../utils/opfs.js'
import { isTiff, readTiffDimensions, canDecodeTiffNatively } from '../../utils/tiff.js'
import { transcodeTiff, buildPyramid } from '../../workers/computeClient.js'
import { needsPyramid } from '../../core/io/rasterPyramid.js'
import { pyramidSource } from '../../utils/image.js'
import { markRaw } from 'vue'
import { pluralize } from '../../core/textFormat.js'
import { uniqueImageLabel } from '../../core/io/imageDuplicates.js'

const READ_BACK_CONCURRENCY = 16

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
    acquire(px) {
      return new Promise((resolve) => {
        waiting.push({ px, resolve })
        pump()
      })
    },
    release(px) {
      inFlight -= px
      pump()
    },
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
  activeImports,
  images,
  isPersisting,
  log,
  markComputePending,
  pendingWorkCount,
  projects,
  rejectComputeReady,
  resolveComputeReady,
  save,
  thumbnails,
  trackWrite,
}) {
  // `extraMeta`: fields the file itself cannot carry (a video frame's source and
  // time), merged over what EXIF gave.
  function extractMetadataFor(item, file, projectId, presetDims, extraMeta = null) {
    return extractMetadata(file, item.url, presetDims)
      .then((meta) => {
        const found =
          projects.currentProjectId === projectId ? images.value.find((img) => img.uuid === item.uuid) : null
        if (found) {
          found.meta = extraMeta ? { ...meta, ...extraMeta } : meta
          found.loading = false
          const cam =
            [meta.make, meta.model].filter(Boolean).join(' ') ||
            (extraMeta?.videoSource
              ? `frame of ${extraMeta.videoSource} at ${Number(extraMeta.videoTime ?? 0).toFixed(3)} s`
              : 'unknown camera')
          const dim = meta.width && meta.height ? ` ${meta.width}×${meta.height}` : ''
          log(`Metadata: ${file.name} — ${cam}${dim}`, 'success', 'Metadata')
          if (isPersisting()) save(projectId)
        }
      })
      .catch((err) => {
        const found =
          projects.currentProjectId === projectId ? images.value.find((img) => img.uuid === item.uuid) : null
        if (found) found.loading = false
        log(`Metadata failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Metadata')
        if (isPersisting()) save(projectId)
      })
  }

  // `options` (both optional), for files made in the browser rather than picked:
  //   extras: Map<File, { meta, dims, thumb }> — metadata to merge over EXIF, the
  //     known pixel size (skips the <img> probe) and a ready list thumbnail;
  //   fromStorage: the originals are in memory (video frames), so once the copy is
  //     read back their URLs are revoked to free them: a long video must not hold
  //     every extracted frame in memory.
  //   allowDuplicates: the user chose to add files already in the project (see
  //     useImportRouting.addImagesRouted). Each gets a fresh id and a numbered
  //     label ("a (2).JPG") instead of being skipped, so the rows stay apart.
  // In a project with storage every image is read back from its copy once written
  // (IS-1), so a moved, renamed or cloud-evicted original no longer matters.
  async function addImages(files, onProgress, options = {}) {
    const task = addImagesNow(files, onProgress, options)
    activeImports.add(task)
    pendingWorkCount.value++
    try {
      return await task
    } finally {
      activeImports.delete(task)
      pendingWorkCount.value--
    }
  }

  async function addImagesNow(files, onProgress, { extras = null, fromStorage = false, allowDuplicates = false } = {}) {
    const projectId = projects.currentProjectId
    const persistImport = !!projectId && isPersisting()
    const stored = []
    // uuid → the object URL made from the picked File, to re-point at the copy.
    const originalUrls = new Map()
    let added = 0
    const tiffItems = []
    const metadataTasks = []
    const batchWrites = []
    // One id set for the whole batch: a per-file scan of the (growing, reactive)
    // list was O(N²) on a multi-thousand-image drop.
    const knownIds = new Set(images.value.map((img) => img.id))
    const takenLabels = allowDuplicates ? new Set(images.value.map((img) => img.name)) : null
    for (const file of files) {
      const item = createImage(file)
      // Import ▸ Project into this project (stores/projectMerge.js): the photo keeps its
      // uuid, sensor and label from the other project, so its features, matches and
      // marks need no renumbering.
      const given = extras?.get(file) ?? null
      if (given?.uuid) item.uuid = given.uuid
      // Keep the immutable source filename separate from the user-editable label.
      // TIFF decoding must not depend on whether a user keeps the .tif extension
      // in the label they choose later.
      item.sourceName = file.name
      item.groupId = null
      if (allowDuplicates) {
        const base = item.id
        for (let n = 2; knownIds.has(item.id); n++) item.id = `${base}#${n}`
        item.name = uniqueImageLabel(given?.name ?? item.name, takenLabels)
        takenLabels.add(item.name)
        if (given?.sensorId) item.sensorId = given.sensorId
      } else if (knownIds.has(item.id)) {
        URL.revokeObjectURL(item.url)
        log(`Skip duplicate: ${file.name}`, 'warn', 'Images')
        continue
      }
      knownIds.add(item.id)
      images.value.push(item)
      added++
      log(`Added image: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`, 'info', 'Images')

      if (persistImport) {
        originalUrls.set(item.uuid, item.url)
        batchWrites.push(
          trackWrite(
            opfs
              .saveImage(projectId, item.uuid, file)
              .then(() => stored.push(item.uuid))
              .catch((err) => log(`OPFS save failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Images')),
          ),
        )
      }
      const extra = extras?.get(file) ?? null

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
        metadataTasks.push(
          readTiffDimensions(file)
            .then((dims) => extractMetadataFor(item, file, projectId, dims))
            .catch(() => extractMetadataFor(item, file, projectId)),
        )
      } else {
        metadataTasks.push(extractMetadataFor(item, file, projectId, extra?.dims ?? null, extra?.meta ?? null))
        // The list thumbnail, from the File itself — background, behind any row in
        // view. Not awaited: a 5,000-image drop must not wait on 5,000 decodes.
        thumbnails.requestThumbnail(item, { source: extra?.thumb ?? file })
      }
    }

    if (tiffItems.length) {
      let done = 0
      const total = tiffItems.length
      await Promise.all(
        tiffItems.map(async ({ item, file }) => {
          try {
            // Past the canvas limit (a native KH-9 scan, 2 GP): no transcode can exist,
            // natively or not — build the tiled pyramid by window reads instead.
            const dims0 = await readTiffDimensions(file).catch(() => null)
            if (dims0 && needsPyramid(dims0.width, dims0.height)) {
              await ingestPyramid(item, file, dims0, persistImport, projectId, batchWrites)
              return
            }
            if (await canDecodeTiffNatively(file)) {
              // This engine renders the raw TIFF natively — item.url (already the
              // raw object URL) works as-is for both display and compute.
              const found = images.value.find((img) => img.id === item.id)
              if (found) {
                found.computeUrl = found.url
                found.previewPending = false
              }
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
            if (!found) {
              resolveComputeReady(item.uuid)
              return
            } // removed mid-decode
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
              const c =
                { 1: 'none', 5: 'LZW', 7: 'JPEG', 8: 'Deflate', 32773: 'PackBits' }[srcInfo?.compression] ??
                srcInfo?.compression
              const p = { 1: 'gray', 2: 'RGB', 3: 'palette', 6: 'YCbCr' }[srcInfo?.photometric] ?? srcInfo?.photometric
              // Only the source fields the decoder could tell us; an unknown one is left out.
              const shape = [
                p,
                srcInfo?.bitsPerSample && `${srcInfo.bitsPerSample}-bit`,
                srcInfo?.samplesPerPixel && `${srcInfo.samplesPerPixel} spp`,
                c,
                srcInfo?.srcBytes && `src ${(srcInfo.srcBytes / 1048576).toFixed(1)} MB`,
              ]
                .filter((v) => v != null && v !== false && v !== '')
                .join(' · ')
              // JPEG and PNG encode concurrently: JPEG is time-to-JPEG, PNG the whole encode.
              log(
                `TIFF timing (${timings.backend ?? 'unknown'}): ${file.name} — decode ${timings.decodeMs?.toFixed(0)} ms · repack ${timings.repackMs?.toFixed(0)} ms · ` +
                  `JPEG ${timings.jpegMs?.toFixed(0)} ms · PNG ${timings.pngMs?.toFixed(0)} ms · total ${timings.totalMs?.toFixed(0)} ms` +
                  (shape ? `  [${shape}]` : ''),
                'debug',
                'Images',
              )
              // A 16-bit source is stretched between its 0.5 / 99.5 % levels for display
              // and detection (core/io/tonalStretch.js) — record the mapping it got.
              if (srcInfo?.stretch) {
                log(
                  `16-bit TIFF stretched to 8-bit: ${file.name} — DN ${srcInfo.stretch.lo}…${srcInfo.stretch.hi} → 0…255 ` +
                    `(0.5 / 99.5 % levels; the high byte alone would span ${srcInfo.stretch.lo >> 8}…${srcInfo.stretch.hi >> 8})`,
                  'debug',
                  'Images',
                )
              }
            }
            // Cache the transcode outputs in OPFS so reopening the project skips
            // the (multi-second) re-decode + re-encode — see the TIFF gotcha in
            // CLAUDE.md. Pure function of the immutable original; fire-and-forget.
            if (persistImport) {
              log(
                `Caching TIFF derived blobs: ${file.name} — display ${(displayBlob.size / 1024).toFixed(0)} KB, compute ${(computeBlob.size / 1024).toFixed(0)} KB`,
                'debug',
                'Images',
              )
              batchWrites.push(
                trackWrite(
                  opfs
                    .saveImageDerived(projectId, item.uuid, 'display', displayBlob)
                    .catch((err) =>
                      log(
                        `OPFS derived save failed (display): ${file.name} — ${err?.message ?? err}`,
                        'error',
                        'Images',
                      ),
                    ),
                ),
              )
              batchWrites.push(
                trackWrite(
                  opfs
                    .saveImageDerived(projectId, item.uuid, 'compute', computeBlob)
                    .catch((err) =>
                      log(
                        `OPFS derived save failed (compute): ${file.name} — ${err?.message ?? err}`,
                        'error',
                        'Images',
                      ),
                    ),
                ),
              )
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
        }),
      )
    }

    await Promise.allSettled(metadataTasks)
    await Promise.allSettled(batchWrites)
    if (stored.length) await readBackFromStorage(projectId, stored, originalUrls, { release: fromStorage })
    if (added > 1) log(`Added ${added} images`, 'success', 'Images')
    if (persistImport) await save(projectId)
  }

  // An image past the canvas limit: its compute pixels become a tiled pyramid
  // (workers/rasterSource.js), its display a reduced JPEG of one level — the viewer
  // maps it through the native size and treats it as a preview (no editing at
  // native resolution yet). One at a time: the build reads row bands of the whole
  // width, so it takes the full transcode budget.
  async function ingestPyramid(item, file, dims, persistImport, projectId, batchWrites) {
    await tiffBudget.acquire(TIFF_TRANSCODE_PIXEL_BUDGET)
    let pyr
    try {
      log(
        `Large TIFF: ${file.name} — ${dims.width}×${dims.height} (${((dims.width * dims.height) / 1e6).toFixed(0)} MP) is past ` +
          'one canvas; building a tiled pyramid',
        'info',
        'Images',
      )
      pyr = await buildPyramid(file)
    } finally {
      tiffBudget.release(TIFF_TRANSCODE_PIXEL_BUDGET)
    }
    const found = images.value.find((img) => img.id === item.id)
    if (!found) {
      resolveComputeReady(item.uuid)
      return
    }
    URL.revokeObjectURL(found.url)
    found.url = URL.createObjectURL(pyr.displayBlob)
    found.lowResUrl = null
    found.previewPending = false
    found.pyramidIndex = markRaw(pyr.index)
    found.computePyramid = markRaw(pyramidSource(found.uuid, pyr.index, pyr.blob))
    resolveComputeReady(item.uuid)
    thumbnails.requestThumbnail(found, { source: pyr.thumbBlob })
    const L = pyr.index.levels
    log(
      `Pyramid: ${file.name} — ${L.length} levels, ${L.reduce((n, l) => n + l.cols * l.rows, 0)} tiles of ` +
        `${pyr.index.tileSize} px, ${(pyr.blob.size / 1024 ** 2).toFixed(0)} MB, ${pyr.index.channels === 1 ? 'gray' : 'RGB'} ` +
        `in ${(pyr.ms / 1000).toFixed(1)} s; display ${L.find((l) => Math.max(l.width, l.height) <= 8192)?.width ?? '?'} px wide`,
      'debug',
      'Images',
    )
    if (persistImport) {
      batchWrites.push(
        trackWrite(
          opfs
            .saveImageDerived(projectId, item.uuid, 'display', pyr.displayBlob)
            .catch((err) =>
              log(`OPFS derived save failed (display): ${file.name} — ${err?.message ?? err}`, 'error', 'Images'),
            ),
        ),
      )
      batchWrites.push(
        trackWrite(
          opfs
            .saveImageDerived(projectId, item.uuid, 'pyramid', pyr.blob)
            .catch((err) =>
              log(`OPFS derived save failed (pyramid): ${file.name} — ${err?.message ?? err}`, 'error', 'Images'),
            ),
        ),
      )
    }
  }

  // Point the records at their stored copies (File-backed, read on demand — what a
  // restore gives them). After the metadata read, which still decodes the original's
  // `url` when it has no dims. Only a URL still made from the original moves: a TIFF's
  // transcoded display / compute blobs are already in memory. `getFile()` reads no
  // bytes, so this costs a handle per image.
  // `release`: the originals are in-memory Blobs; revoke their URLs so they can be
  // freed. A picked disk File's URL is left registered (it holds a handle, not the
  // bytes): a worker job queued with it must still be able to read it.
  async function readBackFromStorage(projectId, uuids, originalUrls, { release = false } = {}) {
    const started = performance.now()
    let moved = 0
    // The lookups are storage round trips (~5 ms each, measured on 300 images), so
    // they run READ_BACK_CONCURRENCY at a time; the records are updated in order.
    const byUuid = new Map(images.value.map((img) => [img.uuid, img]))
    for (let i = 0; i < uuids.length; i += READ_BACK_CONCURRENCY) {
      if (projects.currentProjectId !== projectId) return
      const batch = uuids.slice(i, i + READ_BACK_CONCURRENCY)
      const files = await Promise.all(batch.map((uuid) => opfs.loadImageBlob(projectId, uuid).catch(() => null)))
      if (projects.currentProjectId !== projectId) return
      batch.forEach((uuid, k) => {
        if (repoint(byUuid.get(uuid), files[k])) moved++
      })
    }
    log(
      `Images read from project storage: ${moved} of ${pluralize(uuids.length, 'image')}, ` +
        `in ${(performance.now() - started).toFixed(0)} ms`,
      'debug',
      'Images',
    )

    function repoint(found, file) {
      if (!found || !(file?.size > 0)) return false
      const uuid = found.uuid
      const original = originalUrls.get(uuid)
      const url = URL.createObjectURL(file)
      let used = false
      if (found.url === original) {
        found.url = url
        used = true
      }
      if (found.computeUrl === original) {
        found.computeUrl = url
        used = true
      }
      if (!used) URL.revokeObjectURL(url)
      if (release && original) URL.revokeObjectURL(original)
      // Keeps the original's name and type (exports and the TIFF conversion use them);
      // wrapping the stored File copies nothing.
      const prev = found.file
      found.file = new File([file], prev?.name ?? found.sourceName ?? found.name, {
        type: prev?.type || file.type,
        lastModified: prev?.lastModified ?? file.lastModified,
      })
      return true
    }
  }

  return {
    extractMetadataFor,
    addImages,
    addImagesNow,
  }
}
