import { ref, markRaw, computed } from 'vue'
import { defineStore } from 'pinia'
import { createImage } from '../utils/image.js'
import { isTiff, canDecodeTiffNatively, nativeTiffDecodeResult, readTiffDimensions } from '../utils/tiff.js'
import { extractMetadata } from '../core/io/metadata.js'
import {
  detectKeypoints, transcodeTiff, prepareFiducialTemplates, detectFiducials, bootstrapFiducials,
  detectFiducialSpots as detectFiducialSpotsWorker, POOL_SIZE,
} from '../workers/computeClient.js'
import { fitFiducialAffine, mmToScan } from '../core/sfm/fiducials.js'
import { gateFiducialDetections, FIDUCIAL_DETECT_TUNING } from '../core/sfm/fiducialDetect.js'
import { FIDUCIAL_DETECT_DEFAULTS } from '../core/defaults.user.js'
import { migrateLegacyFiducialImage } from '../core/sfm/fiducialModel.js'
import { fiducialBatchConsensus } from '../core/sfm/fiducialConsensus.js'
import { buildBorderMask } from '../core/mask.js'
import { resolveDetectMaxDim } from '../core/features/detectResolution.js'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useModelsStore } from './useModelsStore.js'
import { mapConcurrent } from '../utils/concurrency.js'

// The image set: source images, their metadata, keypoints, masks, depth maps, and
// sensor assignments. Project-scoped and persisted, but its restore/clear have
// bespoke signatures (and a strict ordering relative to sensors), so it is driven
// directly from App.vue rather than through the project-store registry for now.
export const useImagesStore = defineStore('images', () => {
  const { log } = useLog()
  const projects = useProjectsStore()

  const images = ref([])
  const selectedId = ref(null)
  // A status flag alone is insufficient after restore: a missing/corrupt keypoint
  // sidecar used to leave an empty array advertised as ready to matching.
  const keypointReadyImages = computed(() => images.value.filter((img) =>
    img.kpStatus === 'done' && (img.keypoints?.length ?? 0) > 0))

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // TIFF compute-source readiness. A TIFF's `computeUrl` (lossless PNG) is encoded
  // *after* the display JPEG so the viewer is usable sooner (see addImages), which
  // means a detection/dense request can race ingest and find `computeUrl` still
  // null. Compute consumers must `await whenComputeReady(img)` first. Keyed by
  // uuid; absent ⇒ ready now (non-TIFF, native-decode, restored-from-cache, or the
  // PNG already landed). Plain Map (never reactive, never persisted).
  const computeReady = new Map() // uuid -> { promise, resolve, reject }
  const activeImports = new Set()
  let restoreGeneration = 0
  const pendingWrites = new Set()
  const pendingWorkCount = ref(0)

  function trackWrite(promise) {
    pendingWorkCount.value++
    const tracked = Promise.resolve(promise).finally(() => {
      pendingWrites.delete(tracked)
      pendingWorkCount.value--
    })
    pendingWrites.add(tracked)
    return tracked
  }

  // Lifecycle operations call this before switching, exporting, moving or
  // deleting a project. Loop because a TIFF import can enqueue derived writes
  // after its original-image write has already completed.
  async function flushPendingWork() {
    while (activeImports.size || pendingWrites.size || writing) {
      const pending = [...activeImports, ...pendingWrites]
      if (pending.length) await Promise.allSettled(pending)
      else await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  function markComputePending(uuid) {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    // Swallow the "unhandled rejection" warning if nothing is awaiting at the
    // moment we reject; real awaiters await `promise` directly and still see it.
    promise.catch(() => {})
    computeReady.set(uuid, { promise, resolve, reject })
  }
  function resolveComputeReady(uuid) {
    const e = computeReady.get(uuid)
    if (e) { computeReady.delete(uuid); e.resolve() }
  }
  function rejectComputeReady(uuid, err) {
    const e = computeReady.get(uuid)
    if (e) { computeReady.delete(uuid); e.reject(err) }
  }
  // Compute entry points call this before reading `computeUrl`. Resolves
  // immediately for anything that never had a pending PNG encode.
  async function whenComputeReady(img) {
    const e = computeReady.get(img?.uuid)
    if (e) await e.promise
  }

  // Write the project document with the current image list (project record +
  // per-image metadata). Was App.vue's `syncProject`; lives here now since this
  // store owns the image content. Other stores that mutate image-borne data (e.g.
  // sensor assignments) call this to re-persist.
  //
  // `sync()` is fired from many concurrent async callbacks (per-image metadata
  // `.then`, per-map `updateDepth`), and each call rewrites the *whole* project
  // doc. Overlapping writes to the same OPFS file race (last-writer-wins / lost
  // updates / FS errors), so writes are coalesced: at most one is in flight, and a
  // request that arrives mid-write schedules exactly one re-run afterwards (which
  // captures the latest state). N callers collapse to ≤2 ordered writes.
  let writing = false
  let rerun = false
  async function sync(expectedProjectId = projects.currentProjectId) {
    if (!isPersisting()) return
    if (projects.currentProjectId !== expectedProjectId) return
    if (writing) { rerun = true; return }
    writing = true
    pendingWorkCount.value++
    try {
      do {
        rerun = false
        if (projects.currentProjectId !== expectedProjectId) return
        await writeProjectNow(expectedProjectId)
      } while (rerun)
    } finally {
      writing = false
      pendingWorkCount.value--
    }
  }

  async function writeProjectNow(pid) {
    const proj = projects.projects.find((p) => p.id === pid)
    if (!proj) return
    await opfs.writeProject(pid, {
      ...proj,
      lastModified: new Date().toISOString(),
      images: images.value.map((img) => {
        // eslint-disable-next-line no-unused-vars
        const { raw: _raw, ...metaToSave } = img.meta ?? {}
        return {
          id: img.id, uuid: img.uuid, name: img.name,
          sourceName: img.sourceName ?? img.name,
          kpStatus: img.kpStatus, kpCount: img.kpCount, kpMs: img.kpMs,
          detector: img.detector ?? null, descDim: img.descDim ?? null,
          detectScale: img.detectScale ?? null,
          detectSettings: img.detectSettings ?? null,
          hasMask: !!img.mask, hasDepth: !!img.depth,
          sensorId: img.sensorId ?? null,
          // Fiducial observations (F4) are user clicks on the raster — tiny, and
          // persisted inline (independent of keypoint indices).
          fiducialObs: img.fiducialObs?.length ? img.fiducialObs.map((o) => ({ ...o })) : [],
          fiducialDetections: img.fiducialDetections?.length ? img.fiducialDetections.map((d) => ({ ...d })) : [],
          meta: img.meta ? metaToSave : null,
        }
      }),
    })
  }

  function imageById(id) {
    return images.value.find((img) => img.id === id) || null
  }

  function selectImage(id) {
    selectedId.value = id
  }

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
          if (isPersisting()) sync(projectId)
        }
      })
      .catch((err) => {
        const found = projects.currentProjectId === projectId
          ? images.value.find((img) => img.uuid === item.uuid) : null
        if (found) found.loading = false
        log(`Metadata failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Metadata')
        if (isPersisting()) sync(projectId)
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
    for (const file of files) {
      const item = createImage(file)
      // Keep the immutable source filename separate from the user-editable label.
      // TIFF decoding must not depend on whether a user keeps the .tif extension
      // in the label they choose later.
      item.sourceName = file.name
      if (images.value.some((img) => img.id === item.id)) {
        log(`Skip duplicate: ${file.name}`, 'warn', 'Images')
        continue
      }
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
            return
          }
          const { displayBlob, computeBlob, width, height, timings, srcInfo } = await transcodeTiff(file, undefined, {
            // Fires once the decode finishes, well before the full-res JPEG+PNG
            // encode below — swap in a quick low-res preview so the user sees
            // something long before the full-quality one is ready.
            onThumbnail: (thumbBlob) => {
              const found = images.value.find((img) => img.id === item.id)
              if (!found || !found.previewPending) return
              URL.revokeObjectURL(found.url)
              found.url = URL.createObjectURL(thumbBlob)
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
              found.previewPending = false
            },
          })
          const found = images.value.find((img) => img.id === item.id)
          if (!found) { resolveComputeReady(item.uuid); return } // removed mid-decode
          // onDisplay already set found.url from displayBlob; if the display
          // event never fired (older worker), fall back to setting it here.
          if (found.previewPending) {
            URL.revokeObjectURL(found.url)
            found.url = URL.createObjectURL(displayBlob)
            found.previewPending = false
          }
          found.computeUrl = URL.createObjectURL(computeBlob)
          resolveComputeReady(item.uuid)
          log(`Decoded TIFF: ${file.name} — ${width}×${height}`, 'info', 'Images')
          if (timings) {
            // Per-stage baseline for the TIFF-codec plan (TODO.md): which stage
            // dominates decides whether/what to move to a Rust/WASM codec.
            const c = { 1: 'none', 5: 'LZW', 7: 'JPEG', 8: 'Deflate', 32773: 'PackBits' }[srcInfo?.compression] ?? srcInfo?.compression
            const p = { 1: 'gray', 2: 'RGB', 3: 'palette', 6: 'YCbCr' }[srcInfo?.photometric] ?? srcInfo?.photometric
            const srcMB = srcInfo?.srcBytes ? (srcInfo.srcBytes / 1048576).toFixed(1) : '?'
            log(
              `TIFF timing (${timings.backend ?? '?'}): ${file.name} — decode ${timings.decodeMs?.toFixed(0)}ms · repack ${timings.repackMs?.toFixed(0)}ms · JPEG ${timings.jpegMs?.toFixed(0)}ms · PNG ${timings.pngMs?.toFixed(0)}ms · total ${timings.totalMs?.toFixed(0)}ms  ` +
              `[${p}/${srcInfo?.bitsPerSample ?? '?'}-bit/${srcInfo?.samplesPerPixel ?? '?'}spp/${c}, src ${srcMB} MB]`,
              'info', 'Images',
            )
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
    if (persistImport) await sync(projectId)
  }

  function removeImage(id, onRemoved) {
    const idx = images.value.findIndex((img) => img.id === id)
    if (idx !== -1) {
      const img = images.value[idx]
      URL.revokeObjectURL(img.url)
      if (img.computeUrl && img.computeUrl !== img.url) URL.revokeObjectURL(img.computeUrl)
      images.value.splice(idx, 1)
      if (selectedId.value === id) selectedId.value = null
      log(`Removed image: ${img.name}`, 'info', 'Images')
      useMatchesStore().removeMatchesForImage(img.uuid)
      if (isPersisting()) {
        const pid = projects.currentProjectId
        opfs.deleteImage(pid, img.uuid).catch(() => {})
        opfs.deleteImageDerived(pid, img.uuid).catch(() => {})
        opfs.deleteKeypoints(pid, img.uuid).catch(() => {})
        opfs.deleteDescriptors(pid, img.uuid).catch(() => {})
        opfs.deleteMask(pid, img.uuid).catch(() => {})
        opfs.deleteDepth(pid, img.uuid).catch(() => {})
        sync()
      }
      onRemoved?.(id)
    }
  }

  // Rename is label-only. The stable id/uuid continue to key tabs, matches,
  // observations and persisted binary assets, so changing the display name does
  // not break any links to the image.
  function renameImage(id, name) {
    const img = imageById(id)
    const trimmed = name?.trim()
    if (!img || !trimmed || trimmed === img.name) return false
    const previous = img.name
    img.name = trimmed
    log(`Renamed image "${previous}" → "${trimmed}"`, 'info', 'Images', { channel: 'activity' })
    if (isPersisting()) sync()
    return true
  }

  // ── Image source liveness ─────────────────────────────────────────────────
  // `img.url` is a blob: URL, which is a handle to a FILE — not a copy of the
  // bytes. An in-session image's handle points at the user's original file on
  // disk (utils/image.js), a restored one's at the OPFS copy (opfs.getFile());
  // both are re-validated by the browser on every read. So either can die
  // mid-session — the original is moved/renamed/re-synced/cleaned up, best-effort
  // OPFS is evicted — and the browser then fails the <img> with
  // ERR_FILE_NOT_FOUND. Nothing else notices: matching reads descriptors rather
  // than pixels, so a long run can finish against images the viewer can no longer
  // show, and the first symptom is a blank tab.
  //
  // Every <img> bound to `img.url` reports its failure here. The OPFS copy is
  // written at ingest and is the authority, so the first response is to re-create
  // the URL from it; only when that fails too is the image flagged lost. One heal
  // attempt per image per session — the fresh URL re-renders the <img>, and a
  // second failure must land on the flag instead of looping.
  //
  // The PROMISE is cached, not just the fact of an attempt: several views can
  // render one image at once (viewer + metadata table + mask manager), so their
  // error events arrive together, and a second caller that skipped the in-flight
  // heal would flag the image as lost while the first is busy repairing it.
  const urlHeal = new Map() // uuid → Promise<boolean>

  function healImageUrl(img) {
    let attempt = urlHeal.get(img.uuid)
    if (!attempt) {
      attempt = refreshImageUrl(img)
        .then((healed) => {
          if (healed) {
            log(`Image source recovered from project storage: ${img.name} — the file it was `
              + 'loaded from is no longer readable (moved, renamed, or deleted)', 'warn', 'Images')
          }
          return healed
        })
        .catch((err) => {
          log(`Image recovery failed: ${img.name} — ${err?.message ?? err}`, 'error', 'Images')
          return false
        })
      urlHeal.set(img.uuid, attempt)
    }
    return attempt
  }

  // Re-create `url` (and `computeUrl`) from the OPFS copy. Returns false when
  // there is nothing to heal from, leaving the image untouched.
  async function refreshImageUrl(img) {
    const projectId = projects.currentProjectId
    if (!projectId || !isPersisting()) return false

    // Reading one byte forces the browser to validate the file behind the blob,
    // so a heal can't hand back a second dead URL that fails on first paint.
    const readable = async (blob) => {
      if (!blob) return false
      try { await blob.slice(0, 1).arrayBuffer(); return true } catch { return false }
    }

    let displayBlob = null, computeBlob = null
    if (isTiff(img.sourceName ?? img.name) && nativeTiffDecodeResult() !== true) {
      // A non-native engine can't decode the raw TIFF, so only the transcode
      // cache is usable here. Re-transcoding is what reopening the project does;
      // it isn't worth running from an <img> error handler.
      ;[displayBlob, computeBlob] = await Promise.all([
        opfs.loadImageDerivedBlob(projectId, img.uuid, 'display'),
        opfs.loadImageDerivedBlob(projectId, img.uuid, 'compute'),
      ])
      if (!(await readable(displayBlob)) || !(await readable(computeBlob))) return false
    } else {
      displayBlob = await opfs.loadImageBlob(projectId, img.uuid).catch(() => null)
      if (!(await readable(displayBlob))) return false
      computeBlob = displayBlob
    }

    const hadSeparateCompute = img.computeUrl && img.computeUrl !== img.url
    URL.revokeObjectURL(img.url)
    if (hadSeparateCompute) URL.revokeObjectURL(img.computeUrl)
    img.url = URL.createObjectURL(displayBlob)
    img.computeUrl = computeBlob === displayBlob ? img.url : URL.createObjectURL(computeBlob)
    return true
  }

  // Called by every <img> that renders `img.url` (viewer, metadata table, image
  // info, mask manager, auto-mask) from its @error handler.
  async function reportImageLoadError(id) {
    const img = imageById(id)
    // previewPending is the TIFF transcode's own placeholder window: the raw blob
    // is expected to fail there and the transcode is already on its way.
    if (!img || img.previewFailed || img.previewPending) return false

    if (await healImageUrl(img)) return true

    // Re-resolve: the image may have been removed, or already flagged by a
    // sibling view, while the heal attempt ran.
    const still = imageById(id)
    if (!still || still.previewFailed) return false
    still.previewFailed = true
    still.previewFailReason = 'source-lost'
    log(`Image unavailable: ${still.name} — the browser can no longer read its pixels, and there `
      + 'is no usable copy in project storage. Re-add the file to restore it; detection, dense '
      + 'MVS and orthophoto generation will fail for this image until you do.', 'error', 'Images')
    return false
  }

  // `persist` false updates only the in-memory mask (so undo/redo, the viewer
  // overlay, and the sidebar badge stay live) WITHOUT the OPFS write, log line,
  // or project sync — used for the many intermediate commits during a mask-edit
  // session, which flushes once (persist true) when editing closes.
  function updateMask(imageId, dataUrl, persist = true) {
    const img = imageById(imageId)
    if (!img) return
    img.mask = dataUrl ? { dataUrl } : null
    if (!persist) return
    log(dataUrl ? `Mask saved: ${img.name}` : `Mask cleared: ${img.name}`, 'info', 'Images')
    if (isPersisting()) {
      const pid = projects.currentProjectId
      if (dataUrl) opfs.saveMask(pid, img.uuid, dataUrl).catch(() => {})
      else opfs.deleteMask(pid, img.uuid).catch(() => {})
      sync()
    }
  }

  function updateDepth(imageId, dataUrl) {
    const img = imageById(imageId)
    if (!img) return
    img.depth = dataUrl ? { dataUrl } : null
    log(dataUrl ? `Depth map saved: ${img.name}` : `Depth map cleared: ${img.name}`, 'info', 'Images')
    if (isPersisting()) {
      const pid = projects.currentProjectId
      if (dataUrl) opfs.saveDepth(pid, img.uuid, dataUrl).catch(() => {})
      else opfs.deleteDepth(pid, img.uuid).catch(() => {})
      sync()
    }
  }

  // Upsert a fiducial-mark observation (scan pixels) for an image (F4), replacing
  // any existing observation of the same mark — mirrors the GCP setObservation
  // shape. Re-detecting keypoints does NOT invalidate these (they're user clicks
  // on the raster, independent of keypoint indices).
  function setFiducialObservation(imageId, fidId, px, py) {
    const img = imageById(imageId)
    if (!img || !Number.isFinite(px) || !Number.isFinite(py)) return
    if (!Array.isArray(img.fiducialObs)) img.fiducialObs = []
    const existing = img.fiducialObs.find((o) => o.fidId === fidId)
    if (existing) { existing.px = px; existing.py = py }
    else img.fiducialObs.push({ fidId, px, py })
    log(`Fiducial ${fidId} marked on ${img.name} (${px.toFixed(1)}, ${py.toFixed(1)})`, 'info', 'Sensor')
    if (isPersisting()) sync()
  }

  // Bulk-import fiducial observations parsed from a file (F4). `rows` are
  // `[{ imageName, fidId, px, py }]`; each is matched to an image by name
  // (case-insensitive, extension-tolerant) and upserted. Returns the count applied.
  function addFiducialObservations(rows) {
    let applied = 0, unmatched = 0
    for (const r of rows || []) {
      const lc = String(r.imageName || '').toLowerCase()
      const base = lc.replace(/\.[^.]+$/, '')
      const img = images.value.find((i) => {
        const n = i.name.toLowerCase()
        return n === lc || n.replace(/\.[^.]+$/, '') === base
      })
      if (!img) { unmatched++; continue }
      if (!Array.isArray(img.fiducialObs)) img.fiducialObs = []
      const existing = img.fiducialObs.find((o) => o.fidId === r.fidId)
      if (existing) { existing.px = r.px; existing.py = r.py }
      else img.fiducialObs.push({ fidId: r.fidId, px: r.px, py: r.py })
      applied++
    }
    log(`Fiducial observations imported: ${applied}${unmatched ? `, ${unmatched} unmatched image(s)` : ''}`,
      applied ? 'success' : 'warn', 'Sensor')
    if (applied && isPersisting()) sync()
    return applied
  }

  function removeFiducialObservation(imageId, fidId) {
    const img = imageById(imageId)
    if (!img || !Array.isArray(img.fiducialObs)) return
    const idx = img.fiducialObs.findIndex((o) => o.fidId === fidId)
    if (idx === -1) return
    img.fiducialObs.splice(idx, 1)
    log(`Fiducial ${fidId} cleared on ${img.name}`, 'info', 'Sensor')
    if (isPersisting()) sync()
  }

  // ── automatic fiducial measurement (F4) ──────────────────────────────────
  //
  // Mark all fiducials once on ONE reference scan, then find the same marks on
  // every other image of that film sensor by ZNCC template matching (see
  // core/sfm/fiducialDetect.js for the method and the QC gates).
  //
  // Two rules shape this function:
  //  • Detections are BUFFERED, not written as they arrive. Gate 2 compares each
  //    detection against the batch median for its mark, which does not exist
  //    until every image has been matched — so application is a second pass.
  //  • Nothing is written for a failed image. A wrong interior orientation is
  //    worse than a missing one: it silently poisons every pose downstream,
  //    whereas a missing one just asks the user to click.
  //
  // @param {{ sensor: object, refId: string, settings?: object,
  //           onProgress?: (done:number,total:number)=>void }} args
  //   `refId` is the reference image's `id` (the key `imageById` takes).
  // @returns {Promise<{ perImage: object[], rotationK: number }>}
  async function autonomousFiducials(sensor, cfg, onProgress) {
    const marks = sensor?.fiducials?.marks || []
    const markIds = new Set(marks.map((m) => m.id))
    const targets = images.value.filter((img) => img.sensorId === sensor.id)
    const queue = targets.filter((img) => cfg.overwrite
      || ![...markIds].every((id) => (img.fiducialObs || []).some((o) => o.fidId === id)))
    const skipped = targets.filter((img) => !queue.includes(img)).map((img) => ({
      id: img.id, name: img.name, status: 'skipped', applied: 0, rejected: 0, rmsUm: null, rotationK: cfg.rotationK,
    }))
    log(`Fiducial autonomous detect: ${cfg.family} marks on ${queue.length} image(s), orientation ${cfg.rotationK * 90}°`, 'info', 'Fiducial')
    const buffered = []; let cursor = 0, done = 0
    const drain = async () => {
      while (true) {
        const i = cursor++
        if (i >= queue.length) return
        const img = queue[i]
        try {
          await whenComputeReady(img)
          const out = await bootstrapFiducials(img.computeUrl ?? img.url,
            marks.map((m) => ({ id: m.id, xMm: m.xMm, yMm: m.yMm })),
            { family: cfg.family, rotationK: cfg.rotationK },
            { onLog: (m) => log(m, 'info', 'Fiducial') })
          buffered.push({ id: img.id, name: img.name, detections: out.detections })
        } catch (err) {
          log(`${img.name}: autonomous fiducial detection failed — ${err.message}`, 'error', 'Fiducial')
          buffered.push({ id: img.id, name: img.name, detections: [] })
        }
        onProgress?.(++done, queue.length)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL_SIZE, queue.length)) }, drain))
    let gated = gateFiducialDetections(
      buffered.map((b) => ({ uuid: b.id, name: b.name, detections: b.detections })),
      marks, { minScore: cfg.bootstrapMinScore, maxRmsUm: cfg.maxRmsUm })

    // Bootstrap the existing, more discriminating ZNCC path from the strongest
    // autonomous image. This is the key payoff: no user-supplied reference, but
    // weak scans still receive real scan-derived templates rather than only the
    // analytic family prototype.
    const donor = gated.filter((g) => g.status !== 'failed')
      .sort((a, b) => b.accepted.length - a.accepted.length || (a.rmsUm ?? Infinity) - (b.rmsUm ?? Infinity))[0]
    const retry = gated.filter((g) => g.status === 'failed')
    if (donor && retry.length) {
      const donorImg = imageById(donor.uuid)
      if (donorImg) {
        await whenComputeReady(donorImg)
        const prepared = await prepareFiducialTemplates(donorImg.computeUrl ?? donorImg.url,
          donor.accepted.map((d) => ({ fidId: d.fidId, px: d.px, py: d.py })),
          { templateHalf: FIDUCIAL_DETECT_TUNING.templateHalf })
        for (const failed of retry) {
          const img = imageById(failed.uuid)
          if (!img) continue
          try {
            await whenComputeReady(img)
            const w = img.meta?.width || prepared.natW, h = img.meta?.height || prepared.natH
            const sx = w / prepared.natW, sy = h / prepared.natH
            const radius = Math.max(8, (cfg.searchRadiusPct / 100) * Math.max(w, h))
            const predictions = donor.accepted.map((d) => ({ fidId: d.fidId, px: d.px * sx, py: d.py * sy, radius }))
            const recovered = await detectFiducials(img.computeUrl ?? img.url, prepared.templates, predictions,
              { ...FIDUCIAL_DETECT_TUNING, tryRotations: false })
            const row = buffered.find((b) => b.id === failed.uuid)
            if (row) row.detections = recovered.results.map((d) => ({ ...d, source: 'template' }))
            log(`${img.name}: retrying from automatically learned templates`, 'info', 'Fiducial')
          } catch (err) {
            log(`${img.name}: learned-template retry failed — ${err.message}`, 'warn', 'Fiducial')
          }
        }
        gated = gateFiducialDetections(
          buffered.map((b) => ({ uuid: b.id, name: b.name, detections: b.detections })),
          marks, { minScore: Math.min(cfg.minScore, cfg.bootstrapMinScore), maxRmsUm: cfg.maxRmsUm })
      }
    }
    const perImage = []; let totalApplied = 0
    for (const g of gated) {
      const img = imageById(g.uuid)
      if (!img || g.status === 'failed') {
        perImage.push({ id: g.uuid, name: g.name, status: 'failed', applied: 0,
          rejected: g.rejected.length, rmsUm: g.rmsUm, rotationK: cfg.rotationK })
        continue
      }
      if (!Array.isArray(img.fiducialObs)) img.fiducialObs = []
      let applied = 0
      for (const d of g.accepted) {
        const existing = img.fiducialObs.find((o) => o.fidId === d.fidId)
        if (existing && !cfg.overwrite) continue
        if (existing) { existing.px = d.px; existing.py = d.py }
        else img.fiducialObs.push({ fidId: d.fidId, px: d.px, py: d.py })
        applied++
      }
      totalApplied += applied
      perImage.push({ id: g.uuid, name: g.name, status: g.status, applied,
        rejected: g.rejected.length, rmsUm: g.rmsUm, rotationK: cfg.rotationK })
    }
    if (totalApplied && isPersisting()) sync()
    const failed = perImage.filter((p) => p.status === 'failed').length
    log(`Fiducial autonomous detect complete: ${totalApplied} observation(s), ${failed} image(s) need guidance`,
      failed ? 'warn' : 'success', 'Fiducial')
    return { perImage: [...perImage, ...skipped], rotationK: cfg.rotationK }
  }

  function setFiducialDetection(imageId, detection) {
    const img = imageById(imageId)
    if (!img || !detection?.slot || !Number.isFinite(detection.px) || !Number.isFinite(detection.py)) return
    if (!Array.isArray(img.fiducialDetections)) img.fiducialDetections = []
    const clean = { slot: String(detection.slot), px: detection.px, py: detection.py,
      family: detection.family ?? 'generic', source: detection.source ?? 'manual',
      confidence: Number.isFinite(detection.confidence) ? detection.confidence : 1,
      reviewed: detection.reviewed !== false }
    const existing = img.fiducialDetections.find((d) => d.slot === clean.slot)
    if (existing) Object.assign(existing, clean)
    else img.fiducialDetections.push(clean)
    if (isPersisting()) sync()
  }

  function removeFiducialDetection(imageId, slot) {
    const img = imageById(imageId)
    const i = img?.fiducialDetections?.findIndex((d) => d.slot === slot) ?? -1
    if (i < 0) return
    img.fiducialDetections.splice(i, 1)
    if (isPersisting()) sync()
  }

  async function detectFiducialsForSensor({ sensor, imageIds = null, settings = {}, overwrite = false, onProgress } = {}) {
    if (!sensor?.id) throw new Error('Choose a film sensor')
    // Pinia/Vue callers may supply a reactive Proxy. Keep worker input plain even
    // if this action is reused without the compute-client safeguard.
    settings = { ...settings }
    const selected = new Set(imageIds || [])
    const targets = images.value.filter((img) => img.sensorId === sensor.id && (!selected.size || selected.has(img.id)))
    if (!targets.length) return { perImage: [], drafts: [] }
    const buffered = []; let cursor = 0, done = 0
    const drain = async () => {
      while (true) {
        const i = cursor++
        if (i >= targets.length) return
        const img = targets[i]
        try {
          await whenComputeReady(img)
          const out = await detectFiducialSpotsWorker(img.computeUrl ?? img.url, settings,
            { onLog: (m) => log(`${img.name}: ${m}`, 'info', 'Fiducial') })
          buffered.push({ id: img.id, name: img.name, out })
        } catch (err) {
          log(`${img.name}: fiducial spot detection failed — ${err.message}`, 'error', 'Fiducial')
          buffered.push({ id: img.id, name: img.name, out: { accepted: [], drafts: [], requested: 0, frame: null, ms: 0 }, error: err.message })
        }
        onProgress?.(++done, targets.length)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(POOL_SIZE, targets.length)) }, drain))

    // Learn real scan templates from the strongest anonymous detection per slot,
    // then retry incomplete images at the batch-median raster-relative position.
    // This remains detection-only: slots and image geometry, never metric marks.
    const donors = new Map(), normBySlot = new Map()
    for (const row of buffered) for (const d of row.out.accepted || []) {
      if (!donors.has(d.slot) || d.confidence > donors.get(d.slot).d.confidence) donors.set(d.slot, { row, d })
      if (!normBySlot.has(d.slot)) normBySlot.set(d.slot, [])
      normBySlot.get(d.slot).push({ x: d.px / row.out.natW, y: d.py / row.out.natH })
    }
    const templates = []
    for (const { row, d } of donors.values()) {
      const img = imageById(row.id)
      if (!img) continue
      try {
        const p = await prepareFiducialTemplates(img.computeUrl ?? img.url,
          [{ fidId: d.slot, px: d.px, py: d.py }], { templateHalf: FIDUCIAL_DETECT_TUNING.templateHalf })
        templates.push(...p.templates)
      } catch (err) { log(`${img.name}: donor crop failed — ${err.message}`, 'warn', 'Fiducial') }
    }
    const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
    if (templates.length) for (const row of buffered) {
      if ((row.out.accepted?.length ?? 0) >= (row.out.requested ?? 0)) continue
      const img = imageById(row.id); if (!img) continue
      const have = new Set((row.out.accepted || []).map((d) => d.slot))
      const predictions = templates.flatMap((t) => {
        if (have.has(t.fidId)) return []
        const pts = normBySlot.get(t.fidId); if (!pts?.length) return []
        return [{ fidId: t.fidId, px: median(pts.map((p) => p.x)) * row.out.natW,
          py: median(pts.map((p) => p.y)) * row.out.natH,
          radius: 0.06 * Math.max(row.out.natW, row.out.natH) }]
      })
      if (!predictions.length) continue
      try {
        const retry = await detectFiducials(img.computeUrl ?? img.url, templates, predictions,
          { ...FIDUCIAL_DETECT_TUNING, tryRotations: false })
        for (const d of retry.results.filter((x) => x.score >= 0.7)) {
          row.out.accepted.push({ slot: d.fidId, px: d.px, py: d.py, family: settings.family,
            source: 'template', confidence: d.score, score: d.score, peakMargin: null, reviewed: false })
          row.out.drafts = (row.out.drafts || []).filter((x) => x.slot !== d.fidId)
        }
      } catch (err) { log(`${img.name}: anonymous template retry failed — ${err.message}`, 'warn', 'Fiducial') }
    }
    // Cross-image agreement, once the whole batch (including the template retry)
    // is in. A mark that disagrees with the rest of the flight is demoted to the
    // review queue — the case a per-image score cannot catch is a wrong-but-confident
    // hit on something else near the slot (a data-strip annotation block).
    const consensus = fiducialBatchConsensus(buffered.map((r) => ({
      id: r.id, name: r.name, accepted: r.out.accepted || [],
      frame: r.out.frame, natW: r.out.natW, natH: r.out.natH,
    })))
    for (const s of consensus.perSlot) {
      if (!s.checked) { log(`Batch consensus: ${s.slot} skipped — only ${s.n} image(s)`, 'debug', 'Fiducial'); continue }
      log(`Batch consensus (${consensus.basis}-relative): ${s.slot} over ${s.n} image(s), `
        + `spread ${(s.spreadFrac * 100).toFixed(2)}% of frame width, tolerance ${(s.tolFrac * 100).toFixed(2)}%`,
        'debug', 'Fiducial')
    }
    if (consensus.outliers.length) {
      const dropBySlot = new Map()
      for (const o of consensus.outliers) {
        if (!dropBySlot.has(o.imageId)) dropBySlot.set(o.imageId, new Set())
        dropBySlot.get(o.imageId).add(o.slot)
        log(`${o.imageName ?? o.imageId}: ${o.slot} disagrees with the batch — `
          + `${o.distPx.toFixed(1)} px from the batch position (tolerance ${o.tolPx.toFixed(1)} px); sent to review`,
          'warn', 'Fiducial')
      }
      for (const row of buffered) {
        const drop = dropBySlot.get(row.id)
        if (!drop) continue
        row.out.drafts = [...(row.out.drafts || []),
          ...(row.out.accepted || []).filter((d) => drop.has(d.slot)).map((d) => ({ ...d, reason: 'batch-outlier' }))]
        row.out.accepted = (row.out.accepted || []).filter((d) => !drop.has(d.slot))
      }
    }

    let applied = 0, masksGenerated = 0
    for (const row of buffered) {
      const img = imageById(row.id)
      if (!img) continue
      if (!Array.isArray(img.fiducialDetections)) img.fiducialDetections = []
      for (const d of row.out.accepted || []) {
        const old = img.fiducialDetections.find((x) => x.slot === d.slot)
        if (old && !overwrite) continue
        const clean = { slot: d.slot, px: d.px, py: d.py, family: d.family,
          source: d.source, confidence: d.confidence, reviewed: false }
        if (old) Object.assign(old, clean); else img.fiducialDetections.push(clean)
        applied++
      }
      const f = row.out.frame
      if (settings.generateMasks && f?.confidence >= 0.06 && row.out.natW > 0 && row.out.natH > 0) {
        try {
          const sides = { left: f.left, top: f.top,
            right: row.out.natW - 1 - f.right, bottom: row.out.natH - 1 - f.bottom }
          const dataUrl = await buildBorderMask(row.out.natW, row.out.natH, sides,
            settings.overwrite ? null : img.mask?.dataUrl ?? null)
          updateMask(img.id, dataUrl, true)
          masksGenerated++
        } catch (err) { log(`${img.name}: frame mask failed — ${err.message}`, 'warn', 'Fiducial') }
      }
    }
    if (applied && isPersisting()) sync()
    const perImage = buffered.map((r) => ({ id: r.id, name: r.name,
      accepted: r.out.accepted?.length ?? 0, drafts: r.out.drafts?.length ?? 0,
      requested: r.out.requested ?? 0, confidence: r.out.accepted?.length
        ? r.out.accepted.reduce((s, d) => s + d.confidence, 0) / r.out.accepted.length : 0,
      frameConfidence: r.out.frame?.confidence ?? 0, ms: r.out.ms ?? 0, error: r.error ?? null }))
    return { perImage, drafts: buffered.flatMap((r) => (r.out.drafts || []).map((d) => ({ ...d, imageId: r.id, imageName: r.name }))), applied, masksGenerated }
  }

  async function autoDetectFiducials({ sensor, refId, settings = {}, onProgress } = {}) {
    const cfg = { ...FIDUCIAL_DETECT_DEFAULTS, ...settings }
    const marks = sensor?.fiducials?.marks || []
    const markIds = new Set(marks.map((m) => m.id))
    if (marks.length < 3) {
      const msg = `Sensor ${sensor?.label ?? '?'} has ${marks.length} calibrated fiducial mark(s) — need at least 3`
      log(msg, 'error', 'Fiducial'); throw new Error(msg)
    }

    if (cfg.mode === 'automatic' || !refId) return autonomousFiducials(sensor, cfg, onProgress)

    const refImg = imageById(refId)
    const refObs = (refImg?.fiducialObs || []).filter((o) => markIds.has(o.fidId))
    if (!refImg || refObs.length < 3) {
      const msg = `Reference image needs at least 3 marked fiducials (has ${refObs.length})`
      log(msg, 'error', 'Fiducial'); throw new Error(msg)
    }

    const targets = images.value.filter((img) => img.sensorId === sensor.id && img.id !== refId)
    if (!targets.length) {
      log('No other images assigned to this sensor — nothing to detect', 'warn', 'Fiducial')
      return { perImage: [], rotationK: 0 }
    }

    log(`Fiducial auto-detect: ${refObs.length} template(s) from ${refImg.name} → ${targets.length} image(s); `
      + `search ±${cfg.searchRadiusPct}%, min score ${cfg.minScore}, max RMS ${cfg.maxRmsUm} µm`
      + `${cfg.tryRotations ? ', rotation probe on' : ''}${cfg.overwrite ? ', overwriting existing' : ''}`,
      'info', 'Fiducial')

    // Templates: cut once from the reference image, reused for every target.
    // TIFF scans encode their lossless compute blob after the display JPEG, so
    // the compute source may not exist yet — and JPEG artifacts in a template
    // would bias every match made with it.
    await whenComputeReady(refImg)
    const { templates, natW: refW, natH: refH } = await prepareFiducialTemplates(
      refImg.computeUrl ?? refImg.url,
      // Vue proxies do not structured-clone.
      refObs.map((o) => ({ fidId: o.fidId, px: o.px, py: o.py })),
      { templateHalf: FIDUCIAL_DETECT_TUNING.templateHalf },
      { onLog: (m) => log(m, 'info', 'Fiducial') },
    )

    // Predictions for one target, in the REFERENCE frame (the detector's rotation
    // probe remaps them if the scan went through the scanner sideways).
    function predictionsFor(img) {
      const w = img.meta?.width || refW
      const h = img.meta?.height || refH
      const radius = Math.max(8, (cfg.searchRadiusPct / 100) * Math.max(w, h))
      // Best case: this image already has ≥3 marks, so its own interior
      // orientation pins where the rest must be — far tighter than a scaled
      // guess from the reference.
      const own = (img.fiducialObs || []).filter((o) => markIds.has(o.fidId))
      if (own.length >= 3) {
        const fit = fitFiducialAffine(own.map((o) => {
          const m = marks.find((mm) => mm.id === o.fidId)
          return { px: o.px, py: o.py, xMm: m.xMm, yMm: m.yMm }
        }))
        if (fit) {
          const out = []
          for (const t of templates) {
            const m = marks.find((mm) => mm.id === t.fidId)
            const p = m && mmToScan(m.xMm, m.yMm, fit.A)
            if (p) out.push({ fidId: t.fidId, px: p.x, py: p.y, radius })
          }
          if (out.length) return out
        }
      }
      // Fallback: the reference's own click positions, scaled for a differing
      // scan size. Within one batch the frame lands in nearly the same place.
      const sx = w / refW, sy = h / refH
      return refObs.map((o) => ({ fidId: o.fidId, px: o.px * sx, py: o.py * sy, radius }))
    }

    // ── detection pass (buffered) ────────────────────────────────────────────
    const buffered = []
    const skipped = []
    let done = 0
    const queue = targets.filter((img) => {
      const have = new Set((img.fiducialObs || []).map((o) => o.fidId))
      const complete = [...markIds].every((id) => have.has(id))
      if (complete && !cfg.overwrite) {
        skipped.push({ id: img.id, uuid: img.uuid, name: img.name, status: 'skipped', applied: 0, rejected: 0, rmsUm: null, rotationK: 0 })
        return false
      }
      return true
    })
    if (skipped.length) log(`${skipped.length} image(s) already fully marked — skipped (enable overwrite to redo)`, 'info', 'Fiducial')

    // Concurrency-limited drain loops pulling from a shared cursor — the same
    // shape as useMatchesStore.matchAll. No pinning: these ops carry no heavy
    // per-worker runtime.
    let cursor = 0
    const concurrency = Math.max(1, Math.min(POOL_SIZE, queue.length))
    const drain = async () => {
      while (true) {
        const i = cursor++
        if (i >= queue.length) return
        const img = queue[i]
        try {
          await whenComputeReady(img)
          const { results, ms } = await detectFiducials(
            img.computeUrl ?? img.url,
            templates,
            predictionsFor(img),
            { ...FIDUCIAL_DETECT_TUNING, tryRotations: cfg.tryRotations },
          )
          buffered.push({ id: img.id, uuid: img.uuid, name: img.name, detections: results })
          const mean = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0
          log(`${img.name}: ${results.length} mark(s) matched, mean zncc ${mean.toFixed(3)}`
            + `${results[0]?.rotationK ? `, scan rotated ${results[0].rotationK * 90}°` : ''} (${Math.round(ms)} ms)`,
            'info', 'Fiducial')
        } catch (err) {
          log(`${img.name}: fiducial detection failed — ${err.message}`, 'error', 'Fiducial')
          buffered.push({ id: img.id, uuid: img.uuid, name: img.name, detections: [] })
        }
        done++
        onProgress?.(done, queue.length)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, drain))

    // ── QC gates (need the whole population) + application ───────────────────
    const gated = gateFiducialDetections(
      buffered.map((b) => ({ uuid: b.id, name: b.name, detections: b.detections })),
      marks, { minScore: cfg.minScore, maxRmsUm: cfg.maxRmsUm },
    )

    const perImage = []
    let totalApplied = 0
    for (const g of gated) {
      const img = imageById(g.uuid) // gate carries our `id` through as `uuid`
      const rejected = g.rejected.length
      for (const r of g.rejected) {
        log(`${g.name}: ${r.fidId} rejected — ${r.reason}`, 'warn', 'Fiducial')
      }
      if (g.status === 'failed' || !img) {
        log(`${g.name}: FAILED QC (${g.rmsUm == null ? 'too few marks survived' : `affine RMS ${g.rmsUm.toFixed(1)} µm > ${cfg.maxRmsUm}`}) — nothing written, mark manually`,
          'warn', 'Fiducial')
        perImage.push({ id: g.uuid, name: g.name, status: 'failed', applied: 0, rejected, rmsUm: g.rmsUm, rotationK: g.rotationK })
        continue
      }
      // Apply in bulk: setFiducialObservation() sync()s and logs per call, which
      // would be hundreds of whole-project writes for one run.
      if (!Array.isArray(img.fiducialObs)) img.fiducialObs = []
      let applied = 0
      for (const d of g.accepted) {
        const existing = img.fiducialObs.find((o) => o.fidId === d.fidId)
        if (existing && !cfg.overwrite) continue
        if (existing) { existing.px = d.px; existing.py = d.py }
        else img.fiducialObs.push({ fidId: d.fidId, px: d.px, py: d.py })
        applied++
      }
      totalApplied += applied
      log(`${g.name}: ${applied} mark(s) written${rejected ? `, ${rejected} rejected` : ''}, affine RMS ${g.rmsUm.toFixed(1)} µm`,
        'success', 'Fiducial')
      perImage.push({ id: g.uuid, name: g.name, status: g.status, applied, rejected, rmsUm: g.rmsUm, rotationK: g.rotationK })
    }

    const failed = perImage.filter((p) => p.status === 'failed').length
    log(`Fiducial auto-detect complete: ${totalApplied} observation(s) across ${perImage.length - failed} image(s)`
      + `${failed ? `, ${failed} failed QC` : ''}${skipped.length ? `, ${skipped.length} skipped` : ''}`,
      failed ? 'warn' : 'success', 'Fiducial')

    // One whole-project write for the entire run.
    if (totalApplied && isPersisting()) sync()
    return { perImage: [...perImage, ...skipped], rotationK: gated[0]?.rotationK ?? 0 }
  }

  async function detectOne(id, settings = {}, onDetected, shouldCancel) {
    const img = images.value.find((i) => i.id === id)
    if (!img || img.kpStatus === 'running') return
    // SuperPoint runs a learned model — fetch its weights (with consent) first.
    if (settings.detector === 'superpoint' && !(await useModelsStore().ensureReady(['superpoint']))) {
      log('Detection cancelled — SuperPoint model was not downloaded.', 'warn', 'Detection')
      return
    }
    // Re-detecting renumbers keypoints, so any existing matches for this image
    // become stale — invalidate them once detection succeeds (below).
    const hadKeypoints = img.kpStatus === 'done'
    // Message-text label for the chosen detector (SIFT default, or SuperPoint);
    // the console *source* is the pipeline stage 'Detection', not the detector.
    const tag = settings.detector === 'superpoint' ? 'SuperPoint' : 'SIFT'
    img.kpStatus = 'running'
    log(`${tag} start: ${img.name}`, 'info', 'Detection')
    try {
      // A TIFF's lossless compute PNG may still be encoding (ingest sets the
      // display JPEG first) — wait for it, or reject if its transcode failed,
      // rather than detecting on the lossy display blob (computeUrl invariant).
      await whenComputeReady(img)
      // Working resolution. In 'auto' mode this is a fraction of THIS image's
      // native size (core/features/detectResolution.js) rather than one absolute
      // cap for a set that may span 2000–10000 px; 'absolute' (the default) passes
      // the configured value straight through. Resolved here, per image, because
      // this is where the native size is known — and logged, because a silently
      // derived working resolution is not auditable.
      const nativeMax = Math.max(img.meta?.width || 0, img.meta?.height || 0)
      const res0 = resolveDetectMaxDim(nativeMax, settings)
      if (res0.mode === 'auto') {
        log(`${tag} ${img.name} — detect at ${res0.reason}`, 'debug', 'Detection')
      }
      // Pass the per-image mask (if any) so keypoints inside masked regions are
      // dropped at detection — this propagates to matching and reconstruction.
      const res = await detectKeypoints(
        img.computeUrl ?? img.url,
        { ...settings, maxDim: res0.maxDim, mask: img.mask?.dataUrl ?? null },
        { onLog: (msg) => log(msg, 'info', 'Detection') },
      )
      // The worker can't be interrupted mid-image, so a cancel pressed while this
      // one was in flight lands here with a finished result — drop it rather than
      // attach it, reverting to the image's prior state.
      if (shouldCancel?.()) {
        const found = images.value.find((i) => i.id === id)
        if (found) found.kpStatus = hadKeypoints ? 'done' : null
        log(`${tag} discarded (cancelled): ${img.name}`, 'warn', 'Detection')
        return
      }
      const found = images.value.find((i) => i.id === id)
      if (found) {
        // markRaw: these are large and never need reactivity; leaving them as
        // Vue proxies also breaks the worker boundary (a Proxy can't be
        // structured-cloned, so postMessage throws "could not be cloned").
        found.keypoints   = markRaw(res.keypoints)
        found.descriptors = markRaw(res.descriptors)   // keep in-memory for non-persistent matching
        found.kpCount  = res.keypoints.length
        found.kpMs     = Math.round(res.ms)
        found.kpStatus = 'done'
        // Detector + descriptor width travel with the image so matching can pick
        // the right matcher and read the descriptor stride off the buffer (SIFT
        // 128-d vs SuperPoint 256-d) rather than assume a constant.
        found.detector = res.detector ?? 'sift'
        found.descDim  = res.descDim ?? 128
        // Detection scale travels with the image for the same reason descDim does:
        // keypoints come back in NATIVE pixels (detect.js maps them back), so every
        // downstream pixel threshold is denominated in native px while the
        // measurement quantum is 1/scale native px. core/scaleContext.js resolves
        // the gates against it. Absent ⇒ 1 ⇒ no correction (back-compat).
        found.detectScale = res.diag?.scale ?? 1
        // The detection settings this image's keypoints were produced WITH. Persisted
        // because a measured result without its settings is not a baseline: `detector`
        // and `detectScale` alone cannot distinguish a Balanced run from a Detailed one
        // (same scale, 2.5× the keypoint budget). Absent ⇒ null ⇒ "unknown, pre-dates
        // this field"; deliberately not back-filled from the current modal values.
        found.detectSettings = {
          maxDim: settings.maxDim ?? null,
          maxDimMode: settings.maxDimMode ?? null,
          maxKeypoints: settings.maxKeypoints ?? null,
          contrastThreshold: settings.contrastThreshold ?? null,
          tiling: settings.tiling ?? null,
        }
        if (hadKeypoints) useMatchesStore().removeMatchesForImage(found.uuid)
        log(`${tag} done: ${found.name} — ${found.kpCount} keypoints in ${found.kpMs} ms`, 'success', 'Detection')
        // Detailed diagnostics (debug level): the working resolution actually
        // used, how many features the cap discarded, mask drops, and the response
        // spread (the signal for tuning maxKeypoints / contrastThreshold).
        const d = res.diag
        if (d) {
          log(`${tag} ${found.name} — detect @ ${d.detectWidth}×${d.detectHeight} `
            + `(${d.scale.toFixed(3)}× of ${d.natW}×${d.natH})`, 'debug', 'Detection')
          if (res.detector === 'superpoint') {
            // Learned detector: no near-duplicate suppression / response, so report
            // the cap + mask drops and the keypoint-score spread instead.
            log(`${tag} ${found.name} — ${d.capped} keypoints`
              + `${d.capHit ? ' (top-K cap hit)' : ''}`
              + `${d.maskedPreCap > 0 ? `, −${d.maskedPreCap} masked before cap` : ''}`
              + `${d.maskedDropped > 0 ? `, −${d.maskedDropped} in mask → ${d.kept}` : ''}`
              + `; score p50 ${d.scoreP50.toFixed(3)} / p95 ${d.scoreP95.toFixed(3)}`, 'debug', 'Detection')
          } else {
            log(`${tag} ${found.name} — ${d.rawFound} found → ${d.capped}`
              + `${d.capHit ? ` capped (min response ${d.minResponse.toFixed(3)})` : ' (under cap)'}`
              + `${d.suppressed > 0 ? `, −${d.suppressed} duplicate-position keypoints suppressed` : ''}`
              + `${d.maskedPreCap > 0 ? `, −${d.maskedPreCap} masked before cap` : ''}`
              + `${d.maskedDropped > 0 ? `, −${d.maskedDropped} in mask → ${d.kept}` : ''}`
              + `; response p50 ${d.respP50.toFixed(3)} / p95 ${d.respP95.toFixed(3)}`, 'debug', 'Detection')
          }
        }
        if (isPersisting()) {
          const pid = projects.currentProjectId
          opfs.saveKeypoints(pid, found.uuid, found.keypoints).catch(() => {})
          opfs.saveColors(pid, found.uuid, found.keypoints).catch(() => {})
          opfs.saveDescriptors(pid, found.uuid, res.descriptors).catch(() => {})
          sync()
        }
        onDetected?.(id)
      }
    } catch (err) {
      const found = images.value.find((i) => i.id === id)
      // A cancel hard-terminates the worker pool, which rejects the in-flight
      // call — that's the user stopping the run, not a detector failure, so
      // revert the image to its prior state instead of flagging an error.
      if (shouldCancel?.()) {
        if (found) found.kpStatus = hadKeypoints ? 'done' : null
        log(`${tag} aborted (cancelled): ${img.name}`, 'warn', 'Detection')
        return
      }
      log(`${tag} error: ${img.name} — ${err?.message ?? err}`, 'error', 'Detection')
      if (found) found.kpStatus = 'error'
    }
  }

  async function detectAll(settings = {}, onDetected, onProgress, shouldCancel) {
    const pending = settings.overwrite
      ? images.value
      : images.value.filter((img) => img.kpStatus !== 'done')
    const total = pending.length
    // Echo the settings actually in effect so the console records what was run.
    const {
      detector = 'sift', maxDim = 1200, contrastThreshold = 0.01, maxKeypoints = 5000,
      maxDimMode = 'absolute', preset = 'medium',
    } = settings
    // Message-text label only; the console source is the stage 'Detection'.
    const batchTag = detector === 'superpoint' ? 'SuperPoint' : 'SIFT'
    // SuperPoint runs a learned model — fetch its weights (with consent) once for
    // the whole batch before dispatching any image.
    if (detector === 'superpoint' && !(await useModelsStore().ensureReady(['superpoint']))) {
      log('Detection cancelled — SuperPoint model was not downloaded.', 'warn', 'Detection')
      return
    }
    // Resolution: one figure in absolute mode; in auto mode it varies per image, so
    // report the band being applied rather than a number that would only be right
    // for some of the batch.
    const resLabel = maxDimMode === 'auto'
      ? `auto resolution (${preset} band, ≥${maxDim}px)`
      : `≤${maxDim}px`
    log(`${batchTag} batch: ${total} image(s) queued — ${resLabel}`
      + `${detector === 'superpoint' ? '' : `, contrast ${contrastThreshold}`}, ≤${maxKeypoints} kp`,
      'info', 'Detection')
    let done = 0
    for (const img of pending) {
      if (shouldCancel?.()) { log(`${batchTag} cancelled — ${done}/${total} done`, 'warn', 'Detection'); return }
      await detectOne(img.id, settings, onDetected, shouldCancel)
      // Cancelled mid-image: detectOne already discarded the result, so stop here
      // without counting it as done.
      if (shouldCancel?.()) { log(`${batchTag} cancelled — ${done}/${total} done`, 'warn', 'Detection'); return }
      done++
      onProgress?.(done, total, img.name)
    }
    log(`${batchTag} batch complete`, 'success', 'Detection')
  }

  // Attach an external feature index to existing images in one batch. The caller
  // has already resolved external names to uuids and coordinated replacement of
  // dependent matches. Keeping this as a store action preserves markRaw + OPFS
  // invariants and avoids a modal mutating reactive records directly.
  async function importFeatures(entries, { invalidateMatches = true } = {}) {
    const pid = projects.currentProjectId
    let imported = 0
    const writes = []
    for (const entry of entries || []) {
      const img = images.value.find((i) => i.uuid === entry.uuid)
      if (!img || !Array.isArray(entry.keypoints)) continue
      if (invalidateMatches) useMatchesStore().removeMatchesForImage(img.uuid)
      img.keypoints = markRaw(entry.keypoints)
      img.descriptors = entry.descriptors ? markRaw(entry.descriptors) : null
      img.kpStatus = 'done'
      img.kpCount = entry.keypoints.length
      img.kpMs = 0
      img.detector = entry.detector ?? 'sift'
      img.descDim = entry.descDim ?? 128
      img.detectScale = 1
      img.detectSettings = { source: entry.source ?? 'external' }
      imported++
      if (isPersisting()) {
        writes.push(opfs.saveKeypoints(pid, img.uuid, img.keypoints))
        if (img.descriptors) writes.push(opfs.saveDescriptors(pid, img.uuid, img.descriptors))
      }
    }
    if (writes.length) await Promise.all(writes)
    if (imported && isPersisting()) await sync(pid)
    log(`Features imported: ${imported} image(s)`, imported ? 'success' : 'warn', 'Import')
    return imported
  }

  function clearKeypoints(id) {
    const img = imageById(id)
    if (!img) return
    img.keypoints = []
    img.kpCount   = 0
    img.kpMs      = 0
    img.kpStatus  = null
    // The scale described keypoints that no longer exist. Inert either way (a
    // null kpStatus excludes the image from matching and SfM), but a stale value
    // must not survive into the next detection run at different settings.
    img.detectScale = null
    img.detectSettings = null
    log(`Keypoints cleared: ${img.name}`, 'info', 'Detection')
    useMatchesStore().removeMatchesForImage(img.uuid)
    if (isPersisting()) {
      const pid = projects.currentProjectId
      opfs.deleteKeypoints(pid, img.uuid).catch(() => {})
      opfs.deleteDescriptors(pid, img.uuid).catch(() => {})
      sync()
    }
  }

  // Reset the in-memory image session. Pass { purge: true } to also persist the
  // emptied list (overwriting project.json) — do NOT purge on project switch/close,
  // since that would clobber the project being left with an empty image list, and
  // restore reads project.json back. Only the explicit "clear-all" command purges.
  function clearAll(onCleared, { purge = false } = {}) {
    restoreGeneration++
    const n = images.value.length
    for (const img of images.value) {
      URL.revokeObjectURL(img.url)
      if (img.computeUrl && img.computeUrl !== img.url) URL.revokeObjectURL(img.computeUrl)
    }
    images.value = []
    selectedId.value = null
    urlHeal.clear()
    if (n > 0) log(`Session cleared (${n} image${n !== 1 ? 's' : ''} removed)`, 'warn', 'Images')
    if (purge && isPersisting()) sync()
    onCleared?.()
  }

  // Restore the cheap project.json records immediately, then hydrate pixels,
  // features and overlays with bounded concurrency. The returned promise does not
  // resolve until hydration finishes: project open uses that contract to keep its
  // loading overlay up, so command guards and viewers never observe a nominally
  // open project whose required image state is still empty.
  async function restoreImages(records, projectId, onProgress) {
    for (const img of images.value) {
      URL.revokeObjectURL(img.url)
      if (img.computeUrl && img.computeUrl !== img.url) URL.revokeObjectURL(img.computeUrl)
    }
    images.value = []
    selectedId.value = null
    // Fresh URLs from fresh handles — a previous session's heal attempts say
    // nothing about whether these can be re-read.
    urlHeal.clear()

    const generation = ++restoreGeneration
    const restored = records.map((record) => ({
      id: record.id,
      uuid: record.uuid,
      name: record.name,
      sourceName: record.sourceName ?? record.name,
      url: null,
      computeUrl: null,
      file: null,
      meta: record.meta,
      sensorId: record.sensorId ?? null,
      loading: true,
      previewPending: true,
      previewFailed: false,
      previewFailReason: null,
      keypoints: [],
      kpStatus: record.kpStatus,
      kpCount: record.kpCount || 0,
      kpMs: record.kpMs || 0,
      detector: record.detector ?? 'sift',
      descDim: record.descDim ?? 128,
      detectScale: record.detectScale ?? null,
      detectSettings: record.detectSettings ?? null,
      mask: null,
      depth: null,
      fiducialObs: Array.isArray(record.fiducialObs) ? record.fiducialObs.map((o) => ({ ...o })) : [],
      fiducialDetections: Array.isArray(record.fiducialDetections) ? record.fiducialDetections.map((d) => ({ ...d })) : [],
    }))
    images.value = restored

    const total = records.length
    if (total === 0) {
      log('Project loaded: 0 images', 'success', 'Project')
      return
    }
    let done = 0
    await mapConcurrent(records, 12, async (record, index) => {
      // `images` is a deep ref: assigning `restored` above makes its entries
      // reactive proxies, but the entries retained in the local `restored` array
      // remain raw. Mutating a raw entry updates its target without notifying Vue,
      // leaving computed guards such as `imagesLoading` cached at true forever.
      // Always mutate the proxy owned by the store.
      const img = images.value[index]
      try {
        // Load the original lazily — a TIFF cache hit needs neither the
        // original nor a (re-)decode, so we skip the OPFS read entirely there.
        let blob = null
        const loadOriginal = async () => (blob ??= await opfs.loadImageBlob(projectId, record.uuid))
        // OPFS keeps the original file, so TIFFs need the same transcode as on
        // ingest (the Blob has no name, so classify by the record's name).
        let url, computeUrl
        if (isTiff(record.sourceName ?? record.name)) {
          // Native-decode probe is session-cached; only feed it the original on
          // the first TIFF, when the result isn't known yet.
          const known = nativeTiffDecodeResult()
          const native = known !== null ? known : await canDecodeTiffNatively(await loadOriginal())
          if (native) {
            url = URL.createObjectURL(await loadOriginal())
            computeUrl = url
          } else {
            // Prefer the OPFS transcode cache (both blobs required — a partial
            // cache must not leave computeUrl pointing at nothing). Fall back to
            // a fresh transcode and backfill so older projects heal on reopen.
            const [displayBlob, computeBlob] = await Promise.all([
              opfs.loadImageDerivedBlob(projectId, record.uuid, 'display'),
              opfs.loadImageDerivedBlob(projectId, record.uuid, 'compute'),
            ])
            if (displayBlob && computeBlob) {
              url = URL.createObjectURL(displayBlob)
              computeUrl = URL.createObjectURL(computeBlob)
              log(`Restored TIFF from cache: ${record.name}`, 'info', 'Images')
            } else {
              log(`Transcoding TIFF (no cache): ${record.name}`, 'info', 'Images')
              const t = await transcodeTiff(await loadOriginal())
              url = URL.createObjectURL(t.displayBlob)
              computeUrl = URL.createObjectURL(t.computeBlob)
              if (isPersisting()) {
                opfs.saveImageDerived(projectId, record.uuid, 'display', t.displayBlob)
                  .catch((err) => log(`OPFS derived save failed (display): ${record.name} — ${err?.message ?? err}`, 'error', 'Images'))
                opfs.saveImageDerived(projectId, record.uuid, 'compute', t.computeBlob)
                  .catch((err) => log(`OPFS derived save failed (compute): ${record.name} — ${err?.message ?? err}`, 'error', 'Images'))
              }
            }
          }
        } else {
          url = URL.createObjectURL(await loadOriginal())
          computeUrl = url
        }
        if (generation !== restoreGeneration || projectId !== projects.currentProjectId
            || !images.value.includes(img)) {
          URL.revokeObjectURL(url)
          if (computeUrl && computeUrl !== url) URL.revokeObjectURL(computeUrl)
          return
        }
        img.url = url
        img.computeUrl = computeUrl
        img.previewPending = false
        if (record.kpStatus === 'done') {
          const kps = await opfs.loadKeypoints(projectId, record.uuid)
          if (kps) {
            // Re-attach per-keypoint colours (stored separately) so a restored
            // project can still colour the sparse cloud without re-detecting.
            const colors = await opfs.loadColors(projectId, record.uuid)
            if (colors) kps.forEach((kp, i) => { if (colors[i]) kp.color = colors[i] })
            img.keypoints = markRaw(kps)
            img.kpCount = kps.length
          } else {
            img.kpStatus = 'error'
            img.kpCount = 0
            log(`Keypoints missing for ${record.name} — re-run feature detection`, 'warn', 'Project')
          }
        }
        if (record.hasMask) {
          const maskDataUrl = await opfs.loadMaskDataUrl(projectId, record.uuid)
          if (maskDataUrl) img.mask = { dataUrl: maskDataUrl }
        }
        if (record.hasDepth) {
          const depthDataUrl = await opfs.loadDepthDataUrl(projectId, record.uuid)
          if (depthDataUrl) img.depth = { dataUrl: depthDataUrl }
        }
      } catch (err) {
        if (generation === restoreGeneration) {
          log(`Restore failed: ${record.name} — ${err?.message ?? err}`, 'error', 'Project')
          img.previewPending = false
          img.previewFailed = true
          img.previewFailReason = err?.message ?? String(err)
          // A source image that cannot be restored is not a usable matching input,
          // even if project.json says its old keypoint job completed.
          img.keypoints = markRaw([])
          img.kpStatus = 'error'
          img.kpCount = 0
        }
      } finally {
        if (generation === restoreGeneration) img.loading = false
        done++
        if (generation === restoreGeneration && projectId === projects.currentProjectId) {
          onProgress?.(done, total, record.name)
        }
      }
    })
    if (generation === restoreGeneration && projectId === projects.currentProjectId) {
      log(`Project assets ready: ${images.value.length} image${images.value.length !== 1 ? 's' : ''}`,
        'success', 'Project')
    }
  }

  function migrateLegacyFiducialDetections(sensors) {
    const byId = new Map((sensors || []).map((s) => [s.id, s]))
    let count = 0
    for (const img of images.value) {
      if (img.fiducialDetections?.length || !img.fiducialObs?.length) continue
      img.fiducialDetections = migrateLegacyFiducialImage(img, byId.get(img.sensorId))
      count += img.fiducialDetections.length
    }
    if (count) { log(`Migrated ${count} legacy fiducial observation(s) to anonymous slots`, 'info', 'Fiducial'); if (isPersisting()) sync() }
    return count
  }

  return {
    images,
    selectedId,
    keypointReadyImages,
    pendingWorkCount,
    sync,
    imageById,
    selectImage,
    addImages,
    removeImage,
    renameImage,
    reportImageLoadError,
    updateMask,
    updateDepth,
    setFiducialObservation,
    removeFiducialObservation,
    addFiducialObservations,
    autoDetectFiducials,
    setFiducialDetection,
    removeFiducialDetection,
    detectFiducialsForSensor,
    detectOne,
    detectAll,
    importFeatures,
    whenComputeReady,
    flushPendingWork,
    clearKeypoints,
    clearAll,
    restoreImages,
    migrateLegacyFiducialDetections,
  }
})
