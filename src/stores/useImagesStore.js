import { ref, markRaw, computed } from 'vue'
import { createIngest } from './images/ingest.js'
import { createDetection } from './images/detection.js'
import { createImageFiducials } from './images/fiducials.js'
import { createImageGroups } from './images/imageGroups.js'
import { createKeypointCache } from './images/keypointCache.js'
import { defineStore } from 'pinia'
import { isTiff, canDecodeTiffNatively, nativeTiffDecodeResult } from '../utils/tiff.js'
import {
  transcodeTiff, POOL_SIZE, imageQuality as imageQualityWorker,
} from '../workers/computeClient.js'
import { dataUrlToBlob } from '../core/mask.js'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { createDocumentSaver } from '../utils/documentSaver.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useReconstructionStore } from './useReconstructionStore.js'
import { mapConcurrent } from '../utils/concurrency.js'
import { normalizeImageGroups } from '../utils/imageGroups.js'
import { createImageThumbnails } from './images/thumbnails.js'

// The image set: source images, their metadata, keypoints, masks, depth maps, and
// sensor assignments. Project-scoped and persisted, but its restore/clear have
// bespoke signatures (and a strict ordering relative to sensors), so it is driven
// directly from App.vue rather than through the project-store registry for now.
export const useImagesStore = defineStore('images', () => {
  const { log } = useLog()
  const projects = useProjectsStore()

  const images = ref([])
  const selectedId = ref(null)
  // User-named folders for the sidebar list — display only, never read by the
  // pipeline (see utils/imageGroups.js). Membership is `img.groupId`.
  const imageGroups = ref([])
  // Gates read the COUNT, never the buffer: keypoints are loaded per image on demand
  // (below), so "not resident" says nothing about "not detected". A restore whose
  // keypoint file is missing sets kpStatus 'error' / kpCount 0 (restoreImages).
  const hasKeypoints = (img) => img?.kpStatus === 'done' && (img.kpCount ?? 0) > 0
  const keypointReadyImages = computed(() => images.value.filter(hasKeypoints))

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // Keypoints: on disk, resident in a byte-budgeted LRU (images/keypointCache.js).
  const {
    residentKeypoints, holdKeypoints, ensureKeypoints,
    readKeypoints, resetKeypointCache, keypointCache, keypointCacheStats,
  } = createKeypointCache({
    hasKeypoints, imageById, isPersisting, log, projects, save,
  })

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
  // after its original-image write has already completed. (project.json saves are
  // tracked persistence operations; the flushPersistence() that follows waits.)
  async function flushPendingWork() {
    while (activeImports.size || pendingWrites.size) {
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
  // `save()` is fired from many concurrent async callbacks (per-image metadata
  // `.then`, per-map `updateDepth`), and each call rewrites the *whole* project
  // doc, so it goes through the shared document saver (utils/documentSaver.js):
  // coalesced to ≤ 2 ordered writes, each built from the state at write time.
  // `expectedProjectId` lets an async caller (an ingest batch) save only if its
  // project is still the open one.
  const saveProjectDocument = createDocumentSaver({
    label: 'project',
    currentProjectId: () => projects.currentProjectId,
    isPersisting,
    build: () => projectDocument(projects.currentProjectId),
    write: (pid, doc) => doc && opfs.writeProject(pid, doc),
  })
  function save(expectedProjectId = projects.currentProjectId) {
    if (!isPersisting() || projects.currentProjectId !== expectedProjectId) return Promise.resolve()
    pendingWorkCount.value++
    return saveProjectDocument().finally(() => { pendingWorkCount.value-- })
  }

  function projectDocument(pid) {
    const proj = projects.projects.find((p) => p.id === pid)
    if (!proj) return null
    return {
      ...proj,
      lastModified: new Date().toISOString(),
      imageGroups: imageGroups.value.map((g) => ({ id: g.id, name: g.name, collapsed: !!g.collapsed })),
      images: images.value.map((img) => {
        // eslint-disable-next-line no-unused-vars
        const { raw: _raw, ...metaToSave } = img.meta ?? {}
        return {
          id: img.id, uuid: img.uuid, name: img.name,
          sourceName: img.sourceName ?? img.name,
          kpStatus: img.kpStatus, kpCount: img.kpCount, kpMs: img.kpMs,
          detector: img.detector ?? null, descDim: img.descDim ?? null,
          descNorm: img.descNorm ?? null,
          detectScale: img.detectScale ?? null,
          detectSettings: img.detectSettings ?? null,
          // Tools ▸ Images ▾ ▸ Image quality; absent ⇒ never measured.
          quality: img.quality ?? null,
          hasMask: !!img.mask, hasDepth: !!img.depth,
          sensorId: img.sensorId ?? null,
          groupId: img.groupId ?? null,
          // Fiducial detections (F4) are spots on the raster — tiny, and persisted
          // inline (independent of keypoint indices).
          fiducialDetections: img.fiducialDetections?.length ? img.fiducialDetections.map((d) => ({ ...d })) : [],
          meta: img.meta ? metaToSave : null,
        }
      }),
    }
  }

  // id → image, rebuilt lazily when the list changes. Per-image calls in a batch
  // (a depth run's updateDepth, a group's updateMask, the thumbnail queue) were each
  // a linear scan of the reactive list: O(N²) over thousands of images.
  const imageIndex = computed(() => {
    const m = new Map()
    for (const img of images.value) if (!m.has(img.id)) m.set(img.id, img)
    return m
  })
  function imageById(id) {
    return imageIndex.value.get(id) ?? null
  }

  const thumbnails = createImageThumbnails({
    imageById,
    currentProjectId: () => projects.currentProjectId,
    isPersisting,
    trackWrite,
    log,
    healImage: (id) => reportImageLoadError(id),
  })
  // Release every per-image object URL (display, compute, overlays, thumbnail).
  function releaseImageUrls(img) {
    URL.revokeObjectURL(img.url)
    if (img.computeUrl && img.computeUrl !== img.url) URL.revokeObjectURL(img.computeUrl)
    releasePreview(img.mask); releasePreview(img.depth)
    thumbnails.release(img.thumb)
  }

  function selectImage(id) {
    selectedId.value = id
  }

  // Adding images (images/ingest.js).
  const {
    addImages, } = createIngest({
    activeImports, images, isPersisting, log, markComputePending, pendingWorkCount, projects,
    rejectComputeReady, resolveComputeReady, save, thumbnails, trackWrite,
  })

  function removeImage(id, onRemoved) {
    const idx = images.value.findIndex((img) => img.id === id)
    if (idx === -1) return false
    const img = images.value[idx]
    releaseImageUrls(img)
    images.value.splice(idx, 1)
    keypointCache.delete(img.uuid)
    if (selectedId.value === id) selectedId.value = null
    log(`Removed image: ${img.name}`, 'info', 'Images')
    useMatchesStore().removeMatchesForImage(img.uuid)
    useReconstructionStore().forgetDepthMap(img.uuid)
    if (isPersisting()) {
      const pid = projects.currentProjectId
      opfs.deleteImage(pid, img.uuid).catch(() => {})
      opfs.deleteImageDerived(pid, img.uuid).catch(() => {})
      opfs.deleteKeypoints(pid, img.uuid).catch(() => {})
      opfs.deleteDescriptors(pid, img.uuid).catch(() => {})
      opfs.deleteMask(pid, img.uuid).catch(() => {})
      opfs.deleteDepth(pid, img.uuid).catch(() => {})
      save()
    }
    onRemoved?.(id)
    return true
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
    if (isPersisting()) save()
    return true
  }

  // Image groups (images/imageGroups.js).
  const {
    createImageGroup, renameImageGroup, removeImageGroup, setImagesGroup, setImageGroupCollapsed, moveImageGroup,
  } = createImageGroups({
    imageGroups, images, isPersisting, log, save,
  })

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
  // or project save — used for the many intermediate commits during a mask-edit
  // session, which flushes once (persist true) when editing closes.
  // A mask or depth preview on an image record: `{ blob, url }`. The Blob holds the
  // PNG bytes outside the V8 heap (after a restore it is the OPFS File itself, read
  // only when something decodes it); `url` is its blob: URL for the viewers, and
  // workers are handed the Blob. Never a base64 data URL: that was one heap string
  // per image for the whole session (TODO ▸ SC-1). `source` is a Blob/File or a
  // data: URL (a canvas export), decoded once here.
  function previewOf(source) {
    if (!source) return null
    const blob = typeof source === 'string' ? dataUrlToBlob(source) : source
    return markRaw({ blob, url: URL.createObjectURL(blob) })
  }
  function releasePreview(p) { if (p?.url) URL.revokeObjectURL(p.url) }

  function updateMask(imageId, source, persist = true) {
    const img = imageById(imageId)
    if (!img) return
    releasePreview(img.mask)
    img.mask = previewOf(source)
    if (!persist) return
    log(img.mask ? `Mask saved: ${img.name}` : `Mask cleared: ${img.name}`, 'info', 'Images')
    if (isPersisting()) {
      const pid = projects.currentProjectId
      if (img.mask) opfs.saveMask(pid, img.uuid, img.mask.blob).catch(() => {})
      else opfs.deleteMask(pid, img.uuid).catch(() => {})
      save()
    }
  }

  // `{ quiet, persistSync }`: a depth run updates hundreds of images at once, so it
  // logs once and syncs project.json once itself instead of per image.
  function updateDepth(imageId, source, { quiet = false, persistSync = true } = {}) {
    const img = imageById(imageId)
    if (!img) return
    releasePreview(img.depth)
    img.depth = previewOf(source)
    if (!quiet) log(img.depth ? `Depth map saved: ${img.name}` : `Depth map cleared: ${img.name}`, 'info', 'Images')
    if (isPersisting()) {
      const pid = projects.currentProjectId
      if (img.depth) opfs.saveDepth(pid, img.uuid, img.depth.blob).catch(() => {})
      else opfs.deleteDepth(pid, img.uuid).catch(() => {})
      if (persistSync) save()
    }
  }

  // Fiducial marks and detections (images/fiducials.js).
  const {
    addFiducialObservations, setFiducialDetection, removeFiducialDetection, detectFiducialsForSensor,
  } = createImageFiducials({
    imageById, images, isPersisting, log, save, updateMask, whenComputeReady,
  })

  // Keypoint detection and feature import (images/detection.js).
  const {
    detectOne, detectAll, importFeatures, clearKeypoints,
  } = createDetection({
    holdKeypoints, imageById, images, isPersisting, keypointCache, log, projects, save,
    whenComputeReady,
  })

  // Reset the in-memory image session. Pass { purge: true } to also persist the
  // emptied list (overwriting project.json) — do NOT purge on project switch/close:
  // currentProjectId already names the project being opened, whose project.json
  // restore is about to read.
  function clearAll(onCleared, { purge = false } = {}) {
    restoreGeneration++
    const n = images.value.length
    for (const img of images.value) releaseImageUrls(img)
    thumbnails.reset()
    resetKeypointCache()
    images.value = []
    imageGroups.value = []
    selectedId.value = null
    urlHeal.clear()
    if (n > 0) log(`Session cleared (${n} image${n !== 1 ? 's' : ''} removed)`, 'warn', 'Images')
    if (purge && isPersisting()) save()
    onCleared?.()
  }

  // Restore the cheap project.json records immediately, then hydrate pixels,
  // features and overlays with bounded concurrency. The returned promise does not
  // resolve until hydration finishes: project open uses that contract to keep its
  // loading overlay up, so command guards and viewers never observe a nominally
  // open project whose required image state is still empty.
  async function restoreImages(records, projectId, onProgress, { groups } = {}) {
    for (const img of images.value) releaseImageUrls(img)
    thumbnails.reset()
    resetKeypointCache()
    images.value = []
    imageGroups.value = normalizeImageGroups(groups)
    const groupIds = new Set(imageGroups.value.map((g) => g.id))
    selectedId.value = null
    // Fresh URLs from fresh handles — a previous session's heal attempts say
    // nothing about whether these can be re-read.
    urlHeal.clear()

    const generation = ++restoreGeneration
    // Keypoints are NOT read at open (ensureKeypoints / readKeypoints load them per
    // image when something needs them); one directory listing tells which images
    // still have a keypoint file, so a lost sidecar is flagged now, not later.
    const kpFiles = records.some((r) => r.kpStatus === 'done') ? await opfs.listKeypointFiles(projectId) : new Set()
    if (generation !== restoreGeneration) return
    const missingKp = []
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
      groupId: groupIds.has(record.groupId) ? record.groupId : null,
      loading: true,
      previewPending: true,
      previewFailed: false,
      previewFailReason: null,
      ...(record.kpStatus === 'done' && !kpFiles.has(record.uuid)
        ? (missingKp.push(record.name), { kpStatus: 'error', kpCount: 0 })
        : { kpStatus: record.kpStatus, kpCount: record.kpCount || 0 }),
      kpRev: 0,
      kpMs: record.kpMs || 0,
      detector: record.detector ?? 'sift',
      descDim: record.descDim ?? 128,
      descNorm: record.descNorm ?? null,
      detectScale: record.detectScale ?? null,
      detectSettings: record.detectSettings ?? null,
      quality: record.quality ?? null,
      mask: null,
      depth: null,
      // Filled on demand (a row in view) from images-derived/{uuid}.thumb — never at open.
      thumb: null,
      fiducialDetections: Array.isArray(record.fiducialDetections) ? record.fiducialDetections.map((d) => ({ ...d })) : [],
    }))
    images.value = restored
    for (const name of missingKp.slice(0, 20)) {
      log(`Keypoints missing for ${name} — re-run feature detection`, 'warn', 'Project')
    }
    if (missingKp.length > 20) log(`Keypoints missing for ${missingKp.length - 20} more image(s)`, 'warn', 'Project')

    const total = records.length
    if (total === 0) {
      log('Project loaded: 0 images', 'success', 'Project')
      return
    }
    let done = 0
    // One directory walk for the whole restore (opfs.projectSubDirs); a failure leaves
    // the loaders walking per file, as before.
    const dirNames = ['images', ...(records.some((r) => r.hasMask) ? ['masks'] : []),
      ...(records.some((r) => r.hasDepth) ? ['depthmaps'] : [])]
    const dirs = await opfs.projectSubDirs(projectId, dirNames).catch(() => null)
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
        const loadOriginal = async () => (blob ??= await opfs.loadImageBlob(projectId, record.uuid, dirs))
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
        // The OPFS Files themselves: nothing is read until a viewer or worker decodes.
        if (record.hasMask) img.mask = previewOf(await opfs.loadMaskFile(projectId, record.uuid, dirs))
        if (record.hasDepth) img.depth = previewOf(await opfs.loadDepthFile(projectId, record.uuid, dirs))
      } catch (err) {
        if (generation === restoreGeneration) {
          log(`Restore failed: ${record.name} — ${err?.message ?? err}`, 'error', 'Project')
          img.previewPending = false
          img.previewFailed = true
          img.previewFailReason = err?.message ?? String(err)
          // A source image that cannot be restored is not a usable matching input,
          // even if project.json says its old keypoint job completed.
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

  // Tools ▸ Images ▾ ▸ Image quality: score each image's sharpness and exposure
  // (core/features/imageQuality.js, in the worker) and keep the raw numbers on the
  // image (`quality`, persisted). The batch-relative verdict is derived where it is
  // shown, never stored: it changes whenever images are added or removed.
  async function estimateImageQuality(ids = null, { onProgress } = {}) {
    const wanted = ids ? new Set(ids) : null
    const targets = images.value.filter((img) => !wanted || wanted.has(img.id))
    if (!targets.length) return 0
    log(`Image quality: scoring ${targets.length} image(s)`, 'info', 'Images')
    let done = 0, failed = 0
    await mapConcurrent(targets, Math.max(1, Math.min(4, POOL_SIZE)), async (img) => {
      try {
        await whenComputeReady(img)
        const q = await imageQualityWorker(img.computeUrl ?? img.url, { mask: img.mask?.blob ?? null })
        img.quality = {
          sharpness: q.sharpness, sharpnessP90: q.sharpnessP90, meanLuma: q.meanLuma,
          overexposed: q.overexposed, underexposed: q.underexposed,
          analysisWidth: q.analysisWidth, analysisHeight: q.analysisHeight,
          masked: !!img.mask, at: new Date().toISOString(),
        }
      } catch (err) {
        failed++
        log(`${img.name}: image quality failed — ${err?.message ?? err}`, 'error', 'Images')
      }
      onProgress?.(++done, targets.length)
    })
    log(`Image quality: scored ${targets.length - failed} of ${targets.length} image(s)`, failed ? 'warn' : 'success', 'Images')
    save()
    return targets.length - failed
  }

  return {
    images,
    selectedId,
    imageGroups,
    estimateImageQuality,
    keypointReadyImages,
    // Keypoints on demand (the "Keypoints: on disk" section at the top).
    ensureKeypoints,
    readKeypoints,
    residentKeypoints,
    keypointCacheStats,
    pendingWorkCount,
    save,
    imageById,
    selectImage,
    addImages,
    removeImage,
    renameImage,
    createImageGroup,
    renameImageGroup,
    removeImageGroup,
    setImagesGroup,
    setImageGroupCollapsed,
    moveImageGroup,
    reportImageLoadError,
    // List thumbnails (stores/images/thumbnails.js).
    requestThumbnail: thumbnails.requestThumbnail,
    reportThumbnailError: thumbnails.reportThumbnailError,
    thumbsVersion: thumbnails.version,
    updateMask,
    updateDepth,
    addFiducialObservations,
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
  }
})
