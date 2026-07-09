import { ref, markRaw } from 'vue'
import { defineStore } from 'pinia'
import { createImage } from '../utils/image.js'
import { isTiff, canDecodeTiffNatively, readTiffDimensions } from '../utils/tiff.js'
import { extractMetadata } from '../core/io/metadata.js'
import { detectKeypoints, transcodeTiff } from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useMatchesStore } from './useMatchesStore.js'

// The image set: source images, their metadata, keypoints, masks, depth maps, and
// sensor assignments. Project-scoped and persisted, but its restore/clear have
// bespoke signatures (and a strict ordering relative to sensors), so it is driven
// directly from App.vue rather than through the project-store registry for now.
export const useImagesStore = defineStore('images', () => {
  const { log } = useLog()
  const projects = useProjectsStore()

  const images = ref([])
  const selectedId = ref(null)

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

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
  async function sync() {
    if (!isPersisting()) return
    if (writing) { rerun = true; return }
    writing = true
    try {
      do { rerun = false; await writeProjectNow() } while (rerun)
    } finally {
      writing = false
    }
  }

  async function writeProjectNow() {
    const pid = projects.currentProjectId
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
          kpStatus: img.kpStatus, kpCount: img.kpCount, kpMs: img.kpMs,
          detector: img.detector ?? null, descDim: img.descDim ?? null,
          hasMask: !!img.mask, hasDepth: !!img.depth,
          sensorId: img.sensorId ?? null,
          // Fiducial observations (F4) are user clicks on the raster — tiny, and
          // persisted inline (independent of keypoint indices).
          fiducialObs: img.fiducialObs?.length ? img.fiducialObs.map((o) => ({ ...o })) : [],
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

  function extractMetadataFor(item, file, presetDims) {
    extractMetadata(file, item.url, presetDims)
      .then((meta) => {
        const found = images.value.find((img) => img.id === item.id)
        if (found) {
          found.meta = meta
          found.loading = false
          const cam = [meta.make, meta.model].filter(Boolean).join(' ') || 'unknown camera'
          const dim = meta.width && meta.height ? ` ${meta.width}×${meta.height}` : ''
          log(`Metadata: ${file.name} — ${cam}${dim}`, 'success', 'Metadata')
          if (isPersisting()) sync()
        }
      })
      .catch((err) => {
        const found = images.value.find((img) => img.id === item.id)
        if (found) found.loading = false
        log(`Metadata failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Metadata')
        if (isPersisting()) sync()
      })
  }

  async function addImages(files, onProgress) {
    let added = 0
    const tiffItems = []
    for (const file of files) {
      const item = createImage(file)
      if (images.value.some((img) => img.id === item.id)) {
        log(`Skip duplicate: ${file.name}`, 'warn', 'Images')
        continue
      }
      images.value.push(item)
      added++
      log(`Added image: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`, 'info', 'Images')

      if (isPersisting()) {
        opfs.saveImage(projects.currentProjectId, item.uuid, file)
          .catch((err) => log(`OPFS save failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Images'))
      }

      // Browsers (bar Safari) can't decode TIFF natively, so createImage's blob
      // URL renders blank until transcoded. Batch the transcode below — off the
      // main thread, in parallel — instead of blocking this loop per file; mark
      // the thumbnail as pending so the UI can show a placeholder instead of a
      // broken image while that runs.
      if (isTiff(file)) {
        item.previewPending = true
        tiffItems.push({ item, file })
        // EXIF + dimensions don't need the slow full pixel decode — the TIFF
        // header gives real width/height near-instantly (readTiffDimensions),
        // so metadata shows up right away instead of waiting on the transcode.
        readTiffDimensions(file)
          .then((dims) => extractMetadataFor(item, file, dims))
          .catch(() => extractMetadataFor(item, file))
      } else {
        extractMetadataFor(item, file)
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
            return
          }
          const { displayBlob, computeBlob, width, height } = await transcodeTiff(file, undefined, {
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
          })
          const found = images.value.find((img) => img.id === item.id)
          if (!found) return // removed mid-decode
          URL.revokeObjectURL(found.url)
          found.url = URL.createObjectURL(displayBlob)
          found.computeUrl = URL.createObjectURL(computeBlob)
          found.previewPending = false
          log(`Decoded TIFF: ${file.name} — ${width}×${height}`, 'info', 'Images')
        } catch (err) {
          const found = images.value.find((img) => img.id === item.id)
          if (found) { found.loading = false; found.previewPending = false; found.previewFailed = true }
          log(`TIFF decode failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Images')
        } finally {
          done++
          onProgress?.(done, total, file.name)
        }
      }))
    }

    if (added > 1) log(`Added ${added} images`, 'success', 'Images')
    if (isPersisting()) sync()
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
        opfs.deleteKeypoints(pid, img.uuid).catch(() => {})
        opfs.deleteDescriptors(pid, img.uuid).catch(() => {})
        opfs.deleteMask(pid, img.uuid).catch(() => {})
        opfs.deleteDepth(pid, img.uuid).catch(() => {})
        sync()
      }
      onRemoved?.(id)
    }
  }

  function updateMask(imageId, dataUrl) {
    const img = imageById(imageId)
    if (!img) return
    img.mask = dataUrl ? { dataUrl } : null
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

  async function detectOne(id, settings = {}, onDetected, shouldCancel) {
    const img = images.value.find((i) => i.id === id)
    if (!img || img.kpStatus === 'running') return
    // Re-detecting renumbers keypoints, so any existing matches for this image
    // become stale — invalidate them once detection succeeds (below).
    const hadKeypoints = img.kpStatus === 'done'
    // Log/source label follows the chosen detector (SIFT default, or SuperPoint).
    const tag = settings.detector === 'superpoint' ? 'SuperPoint' : 'SIFT'
    img.kpStatus = 'running'
    log(`${tag} start: ${img.name}`, 'info', tag)
    try {
      // Pass the per-image mask (if any) so keypoints inside masked regions are
      // dropped at detection — this propagates to matching and reconstruction.
      const res = await detectKeypoints(
        img.computeUrl ?? img.url,
        { ...settings, mask: img.mask?.dataUrl ?? null },
        { onLog: (msg) => log(msg, 'info', tag) },
      )
      // The worker can't be interrupted mid-image, so a cancel pressed while this
      // one was in flight lands here with a finished result — drop it rather than
      // attach it, reverting to the image's prior state.
      if (shouldCancel?.()) {
        const found = images.value.find((i) => i.id === id)
        if (found) found.kpStatus = hadKeypoints ? 'done' : null
        log(`${tag} discarded (cancelled): ${img.name}`, 'warn', tag)
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
        if (hadKeypoints) useMatchesStore().removeMatchesForImage(found.uuid)
        log(`${tag} done: ${found.name} — ${found.kpCount} keypoints in ${found.kpMs} ms`, 'success', tag)
        // Detailed diagnostics (debug level): the working resolution actually
        // used, how many features the cap discarded, mask drops, and the response
        // spread (the signal for tuning maxKeypoints / contrastThreshold).
        const d = res.diag
        if (d) {
          log(`${tag} ${found.name} — detect @ ${d.detectWidth}×${d.detectHeight} `
            + `(${d.scale.toFixed(3)}× of ${d.natW}×${d.natH})`, 'debug', tag)
          if (res.detector === 'superpoint') {
            // Learned detector: no near-duplicate suppression / response, so report
            // the cap + mask drops and the keypoint-score spread instead.
            log(`${tag} ${found.name} — ${d.capped} keypoints`
              + `${d.capHit ? ' (top-K cap hit)' : ''}`
              + `${d.maskedDropped > 0 ? `, −${d.maskedDropped} in mask → ${d.kept}` : ''}`
              + `; score p50 ${d.scoreP50.toFixed(3)} / p95 ${d.scoreP95.toFixed(3)}`, 'debug', tag)
          } else {
            log(`${tag} ${found.name} — ${d.rawFound} found → ${d.capped}`
              + `${d.capHit ? ` capped (min response ${d.minResponse.toFixed(3)})` : ' (under cap)'}`
              + `${d.suppressed > 0 ? `, −${d.suppressed} duplicate-position keypoints suppressed` : ''}`
              + `${d.maskedDropped > 0 ? `, −${d.maskedDropped} in mask → ${d.kept}` : ''}`
              + `; response p50 ${d.respP50.toFixed(3)} / p95 ${d.respP95.toFixed(3)}`, 'debug', tag)
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
        log(`${tag} aborted (cancelled): ${img.name}`, 'warn', tag)
        return
      }
      log(`${tag} error: ${img.name} — ${err?.message ?? err}`, 'error', tag)
      if (found) found.kpStatus = 'error'
    }
  }

  async function detectAll(settings = {}, onDetected, onProgress, shouldCancel) {
    const pending = settings.overwrite
      ? images.value
      : images.value.filter((img) => img.kpStatus !== 'done')
    const total = pending.length
    // Echo the settings actually in effect so the console records what was run.
    const { detector = 'sift', maxDim = 1200, contrastThreshold = 0.01, maxKeypoints = 5000 } = settings
    const batchTag = detector === 'superpoint' ? 'SuperPoint' : 'SIFT'
    log(`${batchTag} batch: ${total} image(s) queued — ≤${maxDim}px`
      + `${detector === 'superpoint' ? '' : `, contrast ${contrastThreshold}`}, ≤${maxKeypoints} kp`,
      'info', batchTag)
    let done = 0
    for (const img of pending) {
      if (shouldCancel?.()) { log(`${batchTag} cancelled — ${done}/${total} done`, 'warn', batchTag); return }
      await detectOne(img.id, settings, onDetected, shouldCancel)
      // Cancelled mid-image: detectOne already discarded the result, so stop here
      // without counting it as done.
      if (shouldCancel?.()) { log(`${batchTag} cancelled — ${done}/${total} done`, 'warn', batchTag); return }
      done++
      onProgress?.(done, total, img.name)
    }
    log(`${batchTag} batch complete`, 'success', batchTag)
  }

  function clearKeypoints(id) {
    const img = imageById(id)
    if (!img) return
    img.keypoints = []
    img.kpCount   = 0
    img.kpMs      = 0
    img.kpStatus  = null
    log(`Keypoints cleared: ${img.name}`, 'info', 'SIFT')
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
    const n = images.value.length
    for (const img of images.value) {
      URL.revokeObjectURL(img.url)
      if (img.computeUrl && img.computeUrl !== img.url) URL.revokeObjectURL(img.computeUrl)
    }
    images.value = []
    selectedId.value = null
    if (n > 0) log(`Session cleared (${n} image${n !== 1 ? 's' : ''} removed)`, 'warn', 'Images')
    if (purge && isPersisting()) sync()
    onCleared?.()
  }

  // Restore images from OPFS project records (used on session load / project
  // switch). Runs every record's OPFS reads + TIFF transcode in parallel
  // (Promise.all) instead of one at a time — order is preserved since
  // Promise.all resolves in input order regardless of completion order.
  async function restoreImages(records, projectId, onProgress) {
    for (const img of images.value) {
      URL.revokeObjectURL(img.url)
      if (img.computeUrl && img.computeUrl !== img.url) URL.revokeObjectURL(img.computeUrl)
    }
    images.value = []
    selectedId.value = null

    const total = records.length
    let done = 0
    const restored = await Promise.all(records.map(async (record) => {
      try {
        const blob = await opfs.loadImageBlob(projectId, record.uuid)
        // OPFS keeps the original file, so TIFFs need the same transcode as on
        // ingest (the Blob has no name, so classify by the record's name).
        let url, computeUrl
        if (isTiff(record.name)) {
          if (await canDecodeTiffNatively(blob)) {
            url = URL.createObjectURL(blob)
            computeUrl = url
          } else {
            const { displayBlob, computeBlob } = await transcodeTiff(blob)
            url = URL.createObjectURL(displayBlob)
            computeUrl = URL.createObjectURL(computeBlob)
          }
        } else {
          url = URL.createObjectURL(blob)
          computeUrl = url
        }
        const img = {
          id: record.id,
          uuid: record.uuid,
          name: record.name,
          url,
          computeUrl,
          file: null,
          meta: record.meta,
          sensorId: record.sensorId ?? null,
          loading: false,
          keypoints: [],
          kpStatus: record.kpStatus,
          kpCount: record.kpCount || 0,
          kpMs: record.kpMs || 0,
          // Older projects predate these — default to SIFT/128 (back-compat).
          detector: record.detector ?? 'sift',
          descDim: record.descDim ?? 128,
          mask: null,
          depth: null,
          // Back-compat: older projects predate fiducials ⇒ empty.
          fiducialObs: Array.isArray(record.fiducialObs) ? record.fiducialObs.map((o) => ({ ...o })) : [],
        }
        if (record.kpStatus === 'done') {
          const kps = await opfs.loadKeypoints(projectId, record.uuid)
          if (kps) {
            // Re-attach per-keypoint colours (stored separately) so a restored
            // project can still colour the sparse cloud without re-detecting.
            const colors = await opfs.loadColors(projectId, record.uuid)
            if (colors) kps.forEach((kp, i) => { if (colors[i]) kp.color = colors[i] })
            img.keypoints = markRaw(kps)
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
        return img
      } catch (err) {
        log(`Restore failed: ${record.name} — ${err?.message ?? err}`, 'error', 'Project')
        return null
      } finally {
        done++
        onProgress?.(done, total, record.name)
      }
    }))
    images.value = restored.filter(Boolean)
    log(`Project loaded: ${images.value.length} image${images.value.length !== 1 ? 's' : ''}`, 'success', 'Project')
  }

  return {
    images,
    selectedId,
    sync,
    imageById,
    selectImage,
    addImages,
    removeImage,
    updateMask,
    updateDepth,
    setFiducialObservation,
    removeFiducialObservation,
    addFiducialObservations,
    detectOne,
    detectAll,
    clearKeypoints,
    clearAll,
    restoreImages,
  }
})
