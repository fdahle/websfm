// The reconstruction store's persistence: reconstruction.json written (only the
// clouds that changed) and read back, the guards that keep a save from
// overwriting a model this session could not read or has released for a rerun,
// and the reset on project switch.
//
// Moved verbatim from the store: what it shares comes in by name; names the store
// defines further down come in late (late.js).

import { markRaw, nextTick } from 'vue'
import * as opfs from '../../utils/opfs.js'
import { yieldToPaint } from '../../utils/concurrency.js'
import { normalizeRegion } from '../../core/products/region.js'
import { normalizeProductLayers } from '../../core/products/productLayers.js'
import { normalizeMapOrder } from '../../core/products/mapOrder.js'
import { normalizeImageLayer } from '../../core/products/imageOverlay.js'
import { normalizeOrientation } from '../../core/products/orientation.js'
import { formatBytes } from '../../core/dense/memBudget.js'
import { depthMapBytes } from '../../core/dense/depthMapCodec.js'
import { serializeCloud, deserializeCloud } from './cloudSerde.js'
import { SparsePoints } from '../../core/sfm/sparsePoints.js'
import { createSavedCloudFiles } from './savedCloudFiles.js'
import { currentEvidenceKey } from '../../core/sfm/georefEvidence.js'
import { showToast } from '../../composables/useToasts.js'
import { pluralize } from '../../core/textFormat.js'

export function createPersistence({
  clearDepthMaps,
  clouds,
  coregistration,
  denseSummary,
  depthMapsMeta,
  depthSummary,
  ensureMainSparse,
  georef,
  healthDirty,
  imageLayer,
  isPersisting,
  loadDepthIndexIntoMeta,
  log,
  mainProductIds,
  mainSparseCloud,
  mainSparseId,
  makeCloudId,
  mapHidden,
  mapOrder,
  orientation,
  productLayers,
  projects,
  pruneLod,
  rasterProducts,
  reconStatus,
  region,
  scaleFit,
  selectedCloudId,
  summary,
  summaryHistory,
  withPreviewUrl,
}) {
  // Bumped by anything that makes an in-flight restore stale (a new restore,
  // clear, a reconstruct that will replace the model it is reading).
  let restoreGeneration = 0
  const supersedeRestore = () => {
    restoreGeneration++
  }

  // Serialise every cloud to the on-disk shape (metadata + binary buffers).
  // Committed sidecar files per unchanged dense/mesh cloud (savedCloudFiles.js).
  const savedCloudFiles = createSavedCloudFiles()
  // The project whose saved model could not be read this session (see restore).
  // Until something is put in its place, an empty save would overwrite that
  // document and collect its buffers — so save() declines it.
  let unreadableProjectId = null
  // The project whose main sparse model a rerun has swapped for an empty placeholder
  // (releaseReplaceableModelForRerun). The saved document is then the only copy, so
  // save() declines until the new model lands (upsertSparseCloud) or the saved one is
  // read back (recoverReleasedModel).
  let releasedProjectId = null
  // A model in the released placeholder's place (upsertSparseCloud): saving is safe again.
  const modelLanded = () => {
    releasedProjectId = null
  }

  // `reuse[i]` (optional) — files to point cloud i at instead of re-serialising it.
  function serialize(reuse = null) {
    return {
      clouds: clouds.value.map((c, i) => serializeCloud(c, { reuse: reuse?.[i] ?? null })),
      // Which sparse cloud downstream stages consume (MC). Absent in legacy docs ⇒
      // restore falls back to the first sparse cloud.
      mainSparseId: mainSparseId.value,
      // The main dense cloud, mesh, DEM and ortho (the rasters are saved apart).
      mainProductIds: mainProductIds.value,
      // Small + reusable across sessions; the DEM/ortho rasters themselves are
      // recomputable and stay out of the persisted doc.
      georef: georef.value,
      // Derived, not evidence — the bars live in scalebars.json (see D11).
      scaleFit: scaleFit.value,
      coregistration: coregistration.value,
      region: region.value,
      orientation: orientation.value,
      productLayers: productLayers.value,
      mapOrder: mapOrder.value,
      mapHidden: mapHidden.value,
      imageLayer: imageLayer.value,
      // Run-quality summaries (Q3) — tiny, kept for cross-run comparison.
      summary: summary.value,
      denseSummary: denseSummary.value,
      depthSummary: depthSummary.value,
      summaryHistory: summaryHistory.value,
    }
  }

  // Writes only the clouds whose heavy data changed since the last committed save; the
  // rest keep their files (savedCloudFiles.js). If a reused file has gone — another tab
  // saved this project in between — the saver writes nothing and this resends in full.
  async function save() {
    if (!isPersisting()) return false
    const projectId = projects.currentProjectId
    if (projectId === unreadableProjectId && clouds.value.length === 0) return false
    if (releasedProjectId) return false
    try {
      for (const full of [false, true]) {
        const list = clouds.value
        const reuse = full ? null : list.map((c) => savedCloudFiles.lookup(c, projectId))
        const res = await opfs.saveReconstruction(projectId, serialize(reuse))
        if (res?.ok === false) {
          savedCloudFiles.clear()
          continue
        }
        if (res?.files) for (const c of list) savedCloudFiles.remember(c, projectId, res.files[c.id])
        const reused = reuse?.filter(Boolean).length ?? 0
        if (reused) {
          log(
            `Saved the reconstruction — ${pluralize(list.length - reused, 'cloud')} written, ${reused} unchanged kept`,
            'debug',
            'Reconstruction',
          )
        }
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // A sparse rerun replaces the current main model. Keeping that model's tracks
  // (hundreds of MB at millions of points) resident while constructing the worker input can
  // make the memory preflight reject a run that fits comfortably from a clean state.
  // Replace it with a lightweight placeholder only when headroom is insufficient.
  // Nothing is persisted from here until a new model lands: save() declines while the
  // placeholder stands, and a run that ends without a model reads the saved one back
  // (recoverReleasedModel). The dense clouds, meshes, DEMs and orthophotos stay: they
  // outlive the rebuild (marked outdated), so dropping them here would lose them at
  // the next save.
  function releaseReplaceableModelForRerun() {
    const main = mainSparseCloud.value
    const replaceId = main?.id ?? null
    const pointCount = main?.points?.length ?? 0
    const cameraCount = main?.cameras?.size ?? 0
    if (pointCount > 0 || cameraCount > 0) releasedProjectId = projects.currentProjectId

    clouds.value = clouds.value.flatMap((cloud) => {
      if (cloud.kind === 'sparse' && cloud.secondary) return []
      if (cloud.id !== replaceId || cloud.kind !== 'sparse') return [cloud]
      return [{ ...cloud, cameras: markRaw(new Map()), points: markRaw(SparsePoints.empty()), count: 0 }]
    })
    clearDepthMaps()
    georef.value = null
    scaleFit.value = null
    coregistration.value = null
    summary.value = null
    denseSummary.value = null
    depthSummary.value = null
    healthDirty.value++
    // Depth previews stay: they are Blobs outside the heap, and leaving them lets
    // invalidateSparseDependents find and retire them once the new solve lands.
    if (selectedCloudId.value && !clouds.value.some((c) => c.id === selectedCloudId.value))
      selectedCloudId.value = replaceId

    return { released: pointCount > 0 || cameraCount > 0, pointCount, cameraCount }
  }

  // A rerun that released the model and ended without a new one (failed, cancelled,
  // refused by the memory check): read the saved reconstruction back, so the session
  // holds the solved model, its georeference and secondary models again, and saving
  // resumes. A no-op when nothing was released or a model has landed since.
  async function recoverReleasedModel() {
    const projectId = releasedProjectId
    if (!projectId) return false
    releasedProjectId = null
    if (projectId !== projects.currentProjectId) return false
    const status = reconStatus.value
    await restore({ projectId })
    if (status === 'error') reconStatus.value = 'error'
    log('Reloaded the saved reconstruction after the rerun ended without a new model', 'info', 'Reconstruction')
    return true
  }

  // Reset the in-memory clouds. Pass { purge: true } to also delete the persisted
  // reconstruction.json — do NOT purge on project switch, since restore reads it.
  function clear({ purge = false } = {}) {
    restoreGeneration++
    unreadableProjectId = null
    releasedProjectId = null
    clouds.value = []
    selectedCloudId.value = null
    mainSparseId.value = null
    reconStatus.value = 'idle'
    clearDepthMaps()
    rasterProducts.value = []
    mainProductIds.value = {}
    georef.value = null
    scaleFit.value = null
    coregistration.value = null
    region.value = null
    orientation.value = null
    productLayers.value = {}
    mapOrder.value = []
    mapHidden.value = []
    imageLayer.value = null
    summary.value = null
    denseSummary.value = null
    depthSummary.value = null
    summaryHistory.value = []
    if (purge && isPersisting()) {
      opfs.deleteReconstruction(projects.currentProjectId).catch(() => {})
      opfs.deleteProducts(projects.currentProjectId).catch(() => {})
      opfs.deleteDepthPlanes(projects.currentProjectId).catch(() => {})
    }
  }

  // Project Settings cleanup: retain reconstruction/clouds while dropping the
  // recomputable depth-map and raster-product caches from memory and storage.
  async function clearDerived() {
    clearDepthMaps()
    rasterProducts.value = []
    const { dem: _dem, ortho: _ortho, ...cloudMains } = mainProductIds.value
    mainProductIds.value = cloudMains
    if (isPersisting()) await opfs.deleteProjectDerived(projects.currentProjectId)
    log('Cleared cached image transcodes, depth maps, and raster products.', 'success', 'Project')
  }

  // Rebuild one cloud from version-2 metadata + binary buffers (inverse of
  // serializeCloud). markRaw: point clouds are large and only ever replaced
  // wholesale, never mutated per-point — deep reactivity freezes render/restore.
  //
  // `report` feeds the project-load overlay (stores/projectStores.js). Every slow
  // step announces itself and then yields once so the label is actually painted:
  // decoding a cloud and the first render of the restored model are each one long
  // synchronous task, and a label set inside such a task is never drawn. The
  // per-phase timing line is how a slow open is attributed to a step.
  async function restore({ projectId, report = () => {} }) {
    // Reset first so switching to a project without a saved model doesn't leave
    // the previous project's clouds in memory (loadReconstruction returns null for
    // an empty project and would otherwise no-op).
    clear()
    const generation = restoreGeneration
    const isCurrentRestore = () => generation === restoreGeneration && projectId === projects.currentProjectId
    const phases = []
    let lapStart = performance.now()
    const lap = (phase) => {
      const t = performance.now()
      phases.push(`${phase} ${Math.round(t - lapStart)} ms`)
      lapStart = t
    }
    // The model, the raster products and the depth index are independent files:
    // read them concurrently so project open waits for the slowest, not the sum.
    report('Reading the model files…')
    const productsRead = opfs.loadProducts(projectId).catch(() => [])
    const depthIndexRead = opfs.loadDepthIndex(projectId).catch(() => null)
    let data
    try {
      data = await opfs.loadReconstruction(projectId)
    } catch (err) {
      if (!isCurrentRestore()) return
      // Not the same as "no model yet": the document is there but unreadable. Keep
      // it on disk untouched (save() refuses an empty save over it) and leave
      // the depth planes alone, since their staleness check needs the model.
      unreadableProjectId = projectId
      const detail = String(err?.message ?? err)
      log(
        `Could not read the saved reconstruction — ${detail}. It is left on disk unchanged; ` +
          'a new reconstruction or import will replace it.',
        'error',
        'Reconstruction',
      )
      showToast('Saved reconstruction could not be read', { detail, kind: 'error', ms: 8000 })
      return
    }
    if (!isCurrentRestore()) return
    if (!data) {
      // No sparse model, so any saved depth planes are orphans (they only exist in a
      // sparse cloud's frame). Let the staleness check collect them rather than leak
      // hundreds of MB of OPFS forever.
      await loadDepthIndexIntoMeta(projectId, isCurrentRestore, depthIndexRead)
      return
    }
    lap('read')

    const raw = Array.isArray(data.clouds) ? data.clouds : []

    // One cloud per task, so the overlay can say which one is decoding. Each cloud's
    // own decode time goes into the timing line, so a slow open names its cloud.
    const restored = []
    const perCloud = []
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]
      const name = c.name ?? c.kind ?? 'cloud'
      report(`Decoding "${name}"`, i + 1, raw.length)
      await yieldToPaint()
      if (!isCurrentRestore()) return
      const t = performance.now()
      restored.push(deserializeCloud(c, makeCloudId))
      perCloud.push(
        `${name} [${c.kind ?? 'sparse'}, ${(c.pointCount ?? 0).toLocaleString()} pts] ` +
          `${Math.round(performance.now() - t)} ms`,
      )
    }
    lap('decode')
    if (perCloud.length) phases[phases.length - 1] += ` (${perCloud.join(', ')})`
    report('Preparing the 3D view and panels…')
    await yieldToPaint()
    if (!isCurrentRestore()) return
    clouds.value = restored
    // The arrays just read ARE the committed files' contents, so the first save after
    // opening need not rewrite them.
    savedCloudFiles.clear()
    raw.forEach((c, i) => {
      if (c.savedFiles) savedCloudFiles.remember(clouds.value[i], projectId, c.savedFiles)
    })
    // Octree files no cloud names any more (a deleted cloud, an unfinished build).
    pruneLod().catch(() => {})
    for (const c of clouds.value) {
      if (!c.attributeError) continue
      log(
        `Cloud "${c.name}": point attributes could not be restored (${c.attributeError}) — ` +
          'the points are intact; re-import the file to recover intensity/classification',
        'warn',
        'Reconstruction',
      )
      delete c.attributeError
    }
    selectedCloudId.value = clouds.value[0]?.id ?? null
    mainSparseId.value = data.mainSparseId ?? null
    ensureMainSparse() // legacy docs (no mainSparseId) → first sparse cloud
    // A stale or missing id means the newest of the kind (mainOf).
    mainProductIds.value = data.mainProductIds && typeof data.mainProductIds === 'object' ? data.mainProductIds : {}
    // A key saved before the photo names were left out of it, read in the current form.
    georef.value = data.georef ? { ...data.georef, evidenceKey: currentEvidenceKey(data.georef.evidenceKey) } : null
    scaleFit.value = data.scaleFit ?? null // absent in older projects ⇒ no scale
    coregistration.value = data.coregistration ?? null // absent ⇒ none
    region.value = normalizeRegion(data.region) ?? null
    orientation.value = normalizeOrientation(data.orientation) ?? null
    productLayers.value = normalizeProductLayers(data.productLayers) // absent ⇒ nothing on the map
    mapOrder.value = normalizeMapOrder(data.mapOrder) // absent ⇒ the default stack
    mapHidden.value = normalizeMapOrder(data.mapHidden) // a list of ids, as the order
    imageLayer.value = normalizeImageLayer(data.imageLayer)
    summary.value = data.summary ?? null
    denseSummary.value = data.denseSummary ?? null
    depthSummary.value = data.depthSummary ?? null
    summaryHistory.value = Array.isArray(data.summaryHistory) ? data.summaryHistory : []
    // The render + watcher flush these assignments queued (sidebar, 3D layers, map
    // frame) — timed on its own, since it is not part of reading or decoding.
    await nextTick()
    lap('first render')

    // Restore persisted raster products (DEMs / orthos), if any. A record keeps the
    // name of the document it was read from as its id, so its saves go back there.
    report('Reading the DEMs / orthophotos…')
    const saved = await productsRead
    if (!isCurrentRestore()) return
    const restoredProducts = []
    for (const { stem, product } of saved) {
      if (product.outdated) {
        // Saved before orthophotos were stored as tiled GeoTIFFs; that shape is not read.
        log(
          'A saved orthophoto uses an older storage format and was removed — rebuild it (Products ▸ Orthophoto)',
          'warn',
          'Products',
        )
        opfs.deleteProduct(projectId, stem).catch(() => {})
        continue
      }
      const kind = product.kind ?? (stem.startsWith('ortho') ? 'ortho' : 'dem')
      restoredProducts.push(withPreviewUrl({ ...product, id: stem, kind }))
    }
    rasterProducts.value = restoredProducts
    // Layer state of products that are gone (or keyed by kind, as projects saved
    // before every product could go on the map were): the main ones go on afresh.
    const productIds = new Set(restoredProducts.map((p) => p.id))
    productLayers.value = Object.fromEntries(Object.entries(productLayers.value).filter(([id]) => productIds.has(id)))
    if (restoredProducts.length) {
      const n = (kind) => restoredProducts.filter((p) => p.kind === kind).length
      log(
        `Products restored: ${[n('dem') && pluralize(n('dem'), 'DEM'), n('ortho') && pluralize(n('ortho'), 'ortho')]
          .filter(Boolean)
          .join(' + ')}`,
        'success',
        'Products',
      )
    }
    await nextTick()
    lap('products')

    if (clouds.value.length) {
      const camTotal = clouds.value.reduce((n, c) => n + c.cameras.size, 0)
      log(
        `Reconstruction restored: ${pluralize(clouds.value.length, 'cloud')}, ${camTotal} cameras`,
        'success',
        'Reconstruction',
      )
    }

    // Advertise saved depth maps without loading their planes — densify / ortho
    // hydrate them on demand. Runs after ensureMainSparse() so the staleness check
    // compares against the cloud the pipeline will actually consume.
    if ((await loadDepthIndexIntoMeta(projectId, isCurrentRestore, depthIndexRead)) && isCurrentRestore()) {
      log(
        `Dense: ${pluralize(depthMapsMeta.value.length, 'saved depth map')} available ` +
          `(${formatBytes(depthMapBytes(depthMapsMeta.value))}, loaded on demand)`,
        'success',
        'Dense',
      )
    }
    lap('depth index')
    // JS memory at the end (Chromium only). The decode itself is ~0.1 s for 20 M
    // dense points, so a decode measured in seconds is memory pressure (GC or paging)
    // landing in it. Caveat, measured: `usedJSHeapSize` INCLUDES ArrayBuffer backing
    // stores (a 32.8 M-point dense cloud moved it by its ~0.9 GB of typed arrays),
    // which the ~4 GB V8 heap limit does not count — the bench's DevTools reading
    // (`V8 heap + ArrayBuffers`) separates the two.
    const mem = globalThis.performance?.memory
    const heap = mem?.usedJSHeapSize
      ? ` · JS memory (heap + ArrayBuffers) ${formatBytes(mem.usedJSHeapSize)}, heap limit ${formatBytes(mem.jsHeapSizeLimit)}`
      : ''
    log(`Reconstruction restore timing: ${phases.join(' · ')}${heap}`, 'info', 'Reconstruction')
  }

  return {
    supersedeRestore,
    modelLanded,
    save,
    releaseReplaceableModelForRerun,
    recoverReleasedModel,
    clear,
    clearDerived,
    restore,
  }
}
