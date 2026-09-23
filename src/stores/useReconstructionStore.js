import { createFrameResolver } from './reconstruction/frames.js'
import { ref, shallowRef, computed, markRaw } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import {
  reconstruct as workerReconstruct,
  computeDepthMaps as workerComputeDepthMaps,
  densify as workerDensify,
  generateDem as workerGenerateDem,
  generateOrtho as workerGenerateOrtho,
  meshify as workerMeshify,
  editCloud as workerEditCloud,
  terminateAll,
} from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { aerialUpRotation, rotateReconstruction } from '../core/products/projection.js'
import { qualityToMaxDim } from '../core/dense/mvs.js'
import { projectDensifyPeakBytes, formatBytes, DEFAULT_BUDGET_BYTES, deviceBudget } from '../core/dense/memBudget.js'
import { depthMapBytes } from '../core/dense/depthMapCodec.js'
import { distortionOf } from '../core/sfm/distortion.js'
import { parseColmapModel, parseColmapModelBin, readColmapModel, makeNameResolver, colmapToSparse } from '../core/io/colmapModel.js'
import { serializeCloud, deserializeCloud, legacyDeserializeCloud } from './reconstruction/cloudSerde.js'
import { createDepthMapCache } from './reconstruction/depthMapCache.js'
import { createGeoreferencing } from './reconstruction/georeferencing.js'
import { createScaling } from './reconstruction/scaling.js'
import { isGeographic } from '../core/crs.js'
import { precisionFromGcp } from '../core/gcpAccuracy.js'
import { isGroundControl } from '../core/io/gcp.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useGcpsStore } from './useGcpsStore.js'
import { useScaleBarsStore } from './useScaleBarsStore.js'
import { buildCameraPriors } from '../core/sfm/cameraPriors.js'
import { unpackReconstructionResult } from '../core/sfm/resultCodec.js'
import { packMatchPairs } from '../core/sfm/matchCodec.js'
import {
  projectSparsePeakBreakdownBytes, sparseMemoryDecision, SPARSE_HEAP_FRACTION,
} from '../core/sfm/memBudget.js'

// Project-scoped store: the sparse model (camera poses + 3D points) from
// incremental SfM. Reads the image list and match graph from their stores;
// restore/clear run through the project-store registry.
export const useReconstructionStore = registerProjectStore(defineStore('reconstruction', () => {
  const { log } = useLog()
  const projects = useProjectsStore()
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const { matchStore } = storeToRefs(useMatchesStore())
  const { sensors } = storeToRefs(useSensorsStore())
  const posesStore = usePosesStore()
  const gcpsStore = useGcpsStore()
  const scaleBarsStore = useScaleBarsStore()

  // Point clouds produced for this project. Each is an independent layer the user
  // can select in the sidebar and view in the 3D viewer (sparse now; dense later).
  //   { id, name, kind: 'sparse'|'dense', createdAt,
  //     cameras: Map<uuid, { R, t, K }>, points: [{ x, y, z, views, color }] }
  const clouds = ref([])
  const selectedCloudId = ref(null)
  // The sparse cloud downstream stages (dense / DEM / ortho / export / the sensor
  // table) consume. Distinct from `selectedCloudId` (viewer focus): multiple sparse
  // clouds can coexist — a computed reconstruction alongside a COLMAP import — but
  // exactly one is "main". Invariant: whenever any sparse cloud exists, this points
  // at one of them (see `ensureMainSparse`). Persisted in reconstruction.json.
  const mainSparseId = ref(null)
  const reconStatus = ref('idle') // last run: 'idle' | 'running' | 'done' | 'error'
  let restoreGeneration = 0

  // Per-image depth maps from the dense Stage A (Build Depth Maps), keyed by image
  // uuid. Each: { uuid, width, height, K, R, t, depth, cost, rgb, normals }.
  // shallowRef so the large typed-array planes (and the rest) stay PLAIN — a
  // reactive Proxy wrapper can't be structured-cloned to the densify worker.
  //
  // These ARE persisted (depthmaps/, see core/dense/depthMapCodec.js) — the one
  // recomputable artifact expensive enough to earn disk (minutes/image), without
  // which reopening a project forced a full Stage A re-run before densify/ortho.
  // Persistence is LAZY on the way back in: `restore` reads only the tiny index
  // into `depthMapsMeta`, and `ensureDepthMapsLoaded()` hydrates the planes on
  // first use — eagerly pulling hundreds of MB into memory on every project open
  // would undo the fusion memory budget for opens that never densify.
  const {
    depthMaps, depthMapsMeta, depthMapCount,
    persistDepthMaps, ensureDepthMapsLoaded, loadDepthIndexIntoMeta, clearDepthMaps,
  } = createDepthMapCache({
    isPersisting: () => isPersisting(),
    currentProjectId: () => projects.currentProjectId,
    mainSparseCloud: () => mainSparseCloud.value,
    log,
  })

  // Georeference: a fitted SfM→CRS similarity (scale + rotation + translation),
  // or null in the local frame. { sim:{scale,R,t}, crs, rms, count, method }.
  // Small + useful across sessions, so it persists in reconstruction.json.
  const georef = ref(null)

  // Scale fit: the SfM→metres scalar fitted from known distances (scale bars),
  // or null. { scale, rms, count, method:'scalebars', sourceStamp, evidenceDigest,
  // createdAt, constraints:[…] }. It is a CACHE of a derivation, which is why it
  // carries a stamp + digest and is refused when either moves — see
  // reconstruction/scaling.js and D11. The bar *records* themselves are evidence
  // and live in useScaleBarsStore / scalebars.json, not here.
  //
  // Scale NEVER rewrites coordinates. It is applied as a property of the
  // projection frame (`frameFromScaledLocal`), because rescaling the cloud would
  // invalidate the depth-map staleness stamp and contradict every recorded
  // summary number.
  const scaleFit = ref(null)

  // Quality summaries from the last sparse / dense run (Q3). Small, persisted in
  // reconstruction.json so successive runs can be compared across sessions.
  //   summary:      { date, nCameras, nPoints, pct3plusViewTracks, preBaP95px,
  //                   postBaMedianPx, perPairInitReproj }
  //   denseSummary: { costMedian, keptPct, cullBreakdown }
  //   depthSummary: dense Stage A — { backend, settings, medianMsPerImage, coverage,
  //                 geomFilter* } (workers/ops/dense.js). Persisted for the same reason
  //                 the other two are: a dense baseline outlives the session that ran it.
  const summary = ref(null)
  const denseSummary = ref(null)
  const depthSummary = ref(null)

  // The last few sparse-run summaries (newest last), so the Quality Report can answer
  // "did that tweak help?" across runs (WS5). Summaries only — cheap JSON, no cloud
  // diffing. Persisted in reconstruction.json; absent on legacy docs ⇒ empty.
  const summaryHistory = ref([])
  const SUMMARY_HISTORY_MAX = 5

  // Monotonic counter bumped whenever something the Quality Report overview derives
  // from changes (a georef refit, a GCP toggle). The hub caches the async GCP report
  // per open and re-runs when this moves, so pruning a bad GCP updates the overview.
  const healthDirty = ref(0)

  // Products (DEM + orthophoto). Transient, recomputable rasters (large typed
  // arrays) — shallowRef so the planes stay PLAIN, NOT persisted (like depthMaps).
  //   dem:   { width, height, gsd, originX, originY, data, mask, zMin, zMax,
  //            crs, unit, previewDataUrl }
  //   ortho: { width, height, rgba, covered, previewDataUrl }
  const dem = shallowRef(null)
  const ortho = shallowRef(null)

  let cloudSeq = 0
  const makeCloudId = () => `cloud-${Date.now()}-${cloudSeq++}`

  // The cloud currently shown in the 3D viewer.
  const selectedCloud = computed(
    () => clouds.value.find((c) => c.id === selectedCloudId.value) || null,
  )

  // Camera poses / 3D points of the selected cloud. Kept as derived refs so the
  // image & sensor tables (which read estimated extrinsics/intrinsics) and the
  // viewer keep working off "the active model" without knowing about the list.
  const cameras = computed(() => selectedCloud.value?.cameras ?? new Map())
  const points3d = computed(() => selectedCloud.value?.points ?? [])

  // Cameras of the sparse model specifically — only the sparse cloud carries
  // bundle-adjusted poses/intrinsics. The sensor table reads estimated values
  // from these, so it must not follow the viewer's selection (selecting the
  // dense cloud, whose camera Map is empty, would otherwise blank the table).
  // The main sparse cloud — what downstream stages consume. Falls back to the first
  // sparse cloud when `mainSparseId` is stale/unset (legacy projects, post-delete).
  const mainSparseCloud = computed(
    () => clouds.value.find((c) => c.id === mainSparseId.value && c.kind === 'sparse')
      ?? clouds.value.find((c) => c.kind === 'sparse')
      ?? null,
  )

  const sparseCameras = computed(() => mainSparseCloud.value?.cameras ?? new Map())

  // The cloud a DEM run would rasterise: the densest one available. Exposed as a
  // getter (rather than re-derived in DemModal) so the modal's "Source:" line and
  // generateDem() below can never disagree about what is about to be built —
  // generateDem consumes this, it does not repeat the pick.
  // A sparse source is allowed on purpose (it's the only DEM available for an
  // imported COLMAP model, and the fastest orientation/scale sanity check before
  // committing to dense) — the modal warns, it does not gate.
  const demSource = computed(() => {
    const dense = clouds.value.find((c) => c.kind === 'dense')
    if (dense?.count) return { cloud: dense, kind: 'dense', count: dense.count, name: dense.name ?? null }
    const sparse = mainSparseCloud.value
    const n = sparse?.points?.length ?? 0
    if (!n) return null
    return { cloud: sparse, kind: 'sparse', count: n, name: sparse.name ?? null }
  })

  // The mesh a mesh-surface ortho would rasterise (the first non-empty one).
  const meshCloud = computed(() => clouds.value.find((c) => c.kind === 'mesh' && c.count > 0) ?? null)

  // Which surfaces an ortho run could use for its height-per-cell. Same contract
  // as demSource: the modal RENDERS this list and generateOrtho() CONSUMES it, so
  // the two can't disagree about what is available or what is about to be built.
  // An ortho is not a DEM product — it just needs a surface (Metashape's Build
  // Orthomosaic ▸ Surface: DEM / Mesh / planar), and the DEM is the holey one.
  const orthoSurfaces = computed(() => {
    const src = demSource.value
    return [
      {
        id: 'dem',
        label: 'DEM',
        available: !!dem.value,
        detail: dem.value ? `${dem.value.width}×${dem.value.height} · ${dem.value.crs === 'local' || !dem.value.crs ? 'local frame' : dem.value.crs}` : null,
        hint: dem.value
          ? 'Reuses the built DEM and its frame. Cells the DEM has no height for stay transparent.'
          : 'Build a DEM first.',
      },
      {
        id: 'mesh',
        label: 'Mesh',
        available: !!meshCloud.value,
        detail: meshCloud.value ? `${meshCloud.value.count.toLocaleString()} triangles` : null,
        hint: meshCloud.value
          ? 'Rasterises the mesh from above. Watertight, so there are no surface holes — the fix for a patchy ortho.'
          : 'Build a mesh first (Products ▸ Mesh).',
      },
      {
        id: 'plane',
        label: 'Plane',
        available: !!src,
        detail: src ? `fitted to the ${src.kind} cloud` : null,
        hint: src
          ? 'Least-squares plane through the cloud. Fully dense, but only correct where the ground really is flat.'
          : 'Build a point cloud first.',
      },
    ]
  })

  // Re-establish the "one sparse cloud is always main" invariant after any change
  // to the cloud list (delete, restore). If the current main is gone but sparse
  // clouds remain, promote the first; if none remain, clear it.
  function ensureMainSparse() {
    const stillMain = clouds.value.some((c) => c.id === mainSparseId.value && c.kind === 'sparse')
    if (stillMain) return
    mainSparseId.value = clouds.value.find((c) => c.kind === 'sparse')?.id ?? null
  }

  // Promote a sparse cloud to main (right-click "Set as main" in the sidebar).
  function setMainSparse(id) {
    const cloud = clouds.value.find((c) => c.id === id && c.kind === 'sparse')
    if (!cloud || mainSparseId.value === id) return
    mainSparseId.value = id
    log(`Main sparse cloud → "${cloud.name}"`, 'info', 'Reconstruction', { channel: 'activity' })
    persist()
  }

  function selectCloud(id) {
    selectedCloudId.value = id
  }

  function setCloudStyle(id, style) {
    const cloud = clouds.value.find(c => c.id === id)
    if (!cloud) return
    cloud.style = JSON.parse(JSON.stringify(style))
    persist()
  }

  function setCloudVisible(id, visible) {
    const cloud = clouds.value.find(c => c.id === id)
    if (!cloud) return
    cloud.visible = !!visible
    persist()
  }

  function removeCloud(id) {
    const removed = clouds.value.find((c) => c.id === id)
    clouds.value = clouds.value.filter((c) => c.id !== id)
    if (selectedCloudId.value === id)
      selectedCloudId.value = clouds.value[0]?.id ?? null
    ensureMainSparse()
    if (removed) log(`Removed cloud "${removed.name}"`, 'info', 'Reconstruction', { channel: 'activity' })
    persist()
  }

  // Rename is label-only — every link (selection, persistence, viewer) keys off
  // the cloud's stable `id`, so the name is free to change. A custom name also
  // survives a rebuild (upsertSparseCloud carries the previous name forward).
  function renameCloud(id, name) {
    const cloud = clouds.value.find((c) => c.id === id)
    const trimmed = name.trim()
    if (!cloud || !trimmed || trimmed === cloud.name) return
    const prev = cloud.name
    cloud.name = trimmed
    log(`Renamed cloud "${prev}" → "${trimmed}"`, 'info', 'Reconstruction', { channel: 'activity' })
    persist()
  }

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // Serialise every cloud to the on-disk shape (metadata + binary buffers).
  function serialize() {
    return {
      clouds: clouds.value.map(serializeCloud),
      // Which sparse cloud downstream stages consume (MC). Absent in legacy docs ⇒
      // restore falls back to the first sparse cloud.
      mainSparseId: mainSparseId.value,
      // Small + reusable across sessions; the DEM/ortho rasters themselves are
      // recomputable and stay out of the persisted doc.
      georef: georef.value,
      // Derived, not evidence — the bars live in scalebars.json (see D11).
      scaleFit: scaleFit.value,
      // Run-quality summaries (Q3) — tiny, kept for cross-run comparison.
      summary: summary.value,
      denseSummary: denseSummary.value,
      depthSummary: depthSummary.value,
      summaryHistory: summaryHistory.value,
    }
  }

  async function persist() {
    if (!isPersisting()) return false
    try {
      await opfs.saveReconstruction(projects.currentProjectId, serialize())
      return true
    } catch {
      return false
    }
  }

  // Insert a sparse model. Two intents via `opts`:
  //   • reconstruct (default) — replace the *main* sparse cloud in place, carrying
  //     its id/name forward, and keep it main. `replaceId` defaults to the current
  //     main so a rebuild updates the model the pipeline was consuming.
  //   • import (COLMAP) — pass `replaceId: null` to add a NEW cloud alongside any
  //     existing ones (so it can be compared), with `asMain` only when there's no
  //     main yet, and an explicit `name`.
  // A new object (not an in-place mutation) so consumers watching `selectedCloud`
  // by reference re-render after a rebuild.
  function upsertSparseCloud(cameras, points, opts = {}) {
    const { replaceId = mainSparseId.value, asMain = true, name, imported = false, secondary = false, select = true } = opts
    const idx = replaceId
      ? clouds.value.findIndex((c) => c.id === replaceId && c.kind === 'sparse')
      : -1
    const prev = idx >= 0 ? clouds.value[idx] : null
    const cloud = {
      id: prev?.id ?? makeCloudId(),
      name: name ?? prev?.name ?? 'Sparse cloud',
      kind: 'sparse',
      createdAt: Date.now(),
      // Provenance, not a role: a COLMAP-imported sparse cloud still lives in the
      // Reconstruction section (it IS the model) but carries the chip. NOT
      // inherited from `prev` — a reconstruct that replaces an imported cloud
      // in place has genuinely recomputed it, so the flag must clear.
      ...(imported ? { imported: true } : {}),
      ...(secondary ? { secondary: true } : {}),
      // markRaw: keep the big point/camera data out of Vue's reactivity (see restore).
      cameras: markRaw(cameras),
      points: markRaw(points),
    }
    if (idx >= 0) clouds.value.splice(idx, 1, cloud)
    else clouds.value.push(cloud)
    if (select) selectedCloudId.value = cloud.id
    if (asMain || !mainSparseCloud.value) mainSparseId.value = cloud.id
  }

  // A sparse rerun replaces the current main model. Keeping that model's hundreds of
  // thousands of Map-backed tracks resident while constructing the worker input can
  // make the memory preflight reject a run that fits comfortably from a clean state.
  // Replace it with a lightweight placeholder only when headroom is insufficient.
  // Nothing is persisted here: if the new solve fails, reloading restores the previous
  // saved reconstruction. Imported/derived comparison clouds remain untouched.
  function releaseReplaceableModelForRerun() {
    const main = mainSparseCloud.value
    const replaceId = main?.id ?? null
    const pointCount = main?.points?.length ?? 0
    const cameraCount = main?.cameras?.size ?? 0
    let dependentClouds = 0

    clouds.value = clouds.value.flatMap((cloud) => {
      if (cloud.kind === 'sparse' && cloud.secondary) return []
      if ((cloud.kind === 'dense' || cloud.kind === 'mesh') && !cloud.imported && !cloud.derived) {
        dependentClouds++
        return []
      }
      if (cloud.id !== replaceId || cloud.kind !== 'sparse') return [cloud]
      return [{ ...cloud, cameras: markRaw(new Map()), points: markRaw([]), count: 0 }]
    })
    clearDepthMaps()
    dem.value = null
    ortho.value = null
    georef.value = null
    scaleFit.value = null
    summary.value = null
    denseSummary.value = null
    depthSummary.value = null
    healthDirty.value++
    for (const img of images.value) if (img.depth) img.depth = null
    if (selectedCloudId.value && !clouds.value.some((c) => c.id === selectedCloudId.value))
      selectedCloudId.value = replaceId

    return { released: pointCount > 0 || cameraCount > 0 || dependentClouds > 0,
      pointCount, cameraCount, dependentClouds }
  }

  // A sparse rebuild changes the coordinate frame and camera solution consumed by
  // every computed downstream stage. Retire those artifacts together so an old
  // local ortho/depth set can never masquerade as belonging to the adjusted model.
  // Imported and user-derived clouds are independent records and remain available;
  // only the pipeline's replaceable dense/mesh slots are removed.
  async function invalidateSparseDependents() {
    const removedIds = new Set(clouds.value
      .filter((c) => (c.kind === 'dense' || c.kind === 'mesh') && !c.imported && !c.derived)
      .map((c) => c.id))
    const depthPreviewImages = images.value.filter((im) => !!im.depth)
    const hadDerived = depthMapCount.value > 0 || depthPreviewImages.length > 0 || !!dem.value || !!ortho.value
      || !!georef.value || removedIds.size > 0

    clouds.value = clouds.value.filter((c) => !removedIds.has(c.id))
    if (removedIds.has(selectedCloudId.value)) selectedCloudId.value = mainSparseId.value
    clearDepthMaps()
    dem.value = null
    ortho.value = null
    georef.value = null
    scaleFit.value = null
    denseSummary.value = null
    depthSummary.value = null
    for (const im of depthPreviewImages) im.depth = null

    if (isPersisting()) {
      await Promise.all([
        opfs.deleteDepthPlanes(projects.currentProjectId).catch(() => {}),
        opfs.deleteProducts(projects.currentProjectId).catch(() => {}),
        ...depthPreviewImages.map((im) => opfs.deleteDepth(projects.currentProjectId, im.uuid).catch(() => {})),
      ])
    }
    if (hadDerived) {
      log('Sparse model changed — depth maps, computed dense/mesh, DEM, orthophoto and '
        + 'georeference were retired; rebuild them from the adjusted model.', 'info', 'Reconstruction')
    }
  }

  // Import a COLMAP sparse model (text OR binary) as a NEW sparse cloud (never
  // replaces a computed one — MC lets both coexist for comparison; becomes main
  // only when no sparse cloud exists yet). `files` is a map keyed by canonical
  // name — `cameras.txt`/`images.txt`/`points3D.txt` (string values) or the `.bin`
  // variants (Uint8Array values); the presence of a `.bin` key selects the binary
  // parser. Images are matched to the loaded set by name. Returns true on success.
  // Distortion coeffs of RADIAL/OPENCV cameras are read for fx/fy/cx/cy only — the
  // model is treated as pinhole (consistent with the pipeline), dropped terms warned.
  function importColmapModel(files) {
    const isBin = files['cameras.bin'] || files['images.bin'] || files['points3D.bin']
    let colImages, colPoints, droppedDistortion
    try {
      const model = isBin ? parseColmapModelBin(files) : parseColmapModel(files)
      ;({ images: colImages, points: colPoints, droppedDistortion } = readColmapModel(model))
    } catch (err) {
      log(`COLMAP import: could not parse model — ${err?.message ?? err}`, 'error', 'Reconstruction')
      return false
    }
    if (!colImages.length) {
      log('COLMAP import: no images found (need cameras.txt + images.txt)', 'warn', 'Reconstruction')
      return false
    }

    const resolve = makeNameResolver(images.value.map((im) => ({ uuid: im.uuid, name: im.name })))
    const { cameras, points, matched, unmatched } = colmapToSparse(
      { images: colImages, points: colPoints }, resolve)

    log(`COLMAP import: matched ${matched.length}/${colImages.length} images by name`
      + `, ${points.length}/${colPoints.length} points`, 'info', 'Reconstruction')
    if (unmatched.length) {
      log(`COLMAP import: ${unmatched.length} image(s) not in this project (skipped): `
        + unmatched.slice(0, 8).join(', ') + (unmatched.length > 8 ? '…' : ''), 'warn', 'Reconstruction')
    }
    if (droppedDistortion.length) {
      log(`COLMAP import: dropped distortion of ${droppedDistortion.join(', ')} camera(s) `
        + '— intrinsics read as pinhole (fx/fy/cx/cy)', 'warn', 'Reconstruction')
    }
    if (cameras.size < 2) {
      log('COLMAP import: fewer than 2 images matched the loaded set — nothing to import. '
        + 'Load the matching images first (names must correspond).', 'warn', 'Reconstruction')
      return false
    }

    upsertSparseCloud(cameras, points, {
      replaceId: null,
      asMain: !mainSparseCloud.value,
      name: 'Imported (COLMAP)',
      imported: true,
    })
    log(`COLMAP import: added sparse cloud (${cameras.size} cameras, ${points.length} points)`
      + `${mainSparseId.value === selectedCloudId.value ? ' — set as main' : ''}`, 'success', 'Reconstruction')
    persist()
    return true
  }

  function importInteropModel(model) {
    const resolve = makeNameResolver(images.value.map((im) => ({ uuid: im.uuid, name: im.name })))
    const loadedByUuid = new Map(images.value.map((im) => [im.uuid, im]))
    const normalizedImages = (model.images ?? []).map((im) => {
      const uuid = resolve(im.name), loaded = loadedByUuid.get(uuid)
      const width = im.width ?? loaded?.meta?.width ?? null, height = im.height ?? loaded?.meta?.height ?? null
      return { ...im, width, height, K: { fx: im.K?.fx, fy: im.K?.fy ?? im.K?.fx, cx: im.K?.cx ?? (width ? width / 2 : 0), cy: im.K?.cy ?? (height ? height / 2 : 0) } }
    })
    const { cameras, points, matched, unmatched } = colmapToSparse({ images: normalizedImages, points: model.points ?? [] }, resolve)
    if (cameras.size < 2) {
      log(`${model.format} import: fewer than 2 cameras match loaded images`, 'warn', 'Reconstruction')
      return false
    }
    upsertSparseCloud(cameras, points, { replaceId: null, asMain: !mainSparseCloud.value, name: `Imported (${model.format})`, imported: true })
    log(`${model.format} import: ${matched.length} cameras, ${points.length} points${unmatched.length ? `, ${unmatched.length} unmatched` : ''}`, 'success', 'Reconstruction')
    persist()
    return true
  }

  // Insert the fused dense model, replacing any existing dense cloud (carries the
  // previous name/id forward so a rename survives a re-fuse). Dense clouds have no
  // cameras of their own — the viewer renders their points. Unlike sparse clouds
  // (arrays of {x,y,z,color,views} objects — they carry per-point tracks), a dense
  // cloud is stored **flat**: { count, pos:Float32Array(3N), col:Uint8Array(3N) }.
  // Millions of fused points as JS objects were ~110 B each (hundreds of MB, the
  // fusion OOM's main-thread tail); the flat buffers are ~15 B/point and feed the
  // viewer / PLY / DEM directly with no per-point object churn.
  function upsertDenseCloud({ count, pos, col, nrm }) {
    // Never replace an *imported* or *derived* (crop/filter/merge output) cloud — a
    // re-fuse targets the densify stage's own slot only.
    const idx = clouds.value.findIndex((c) => c.kind === 'dense' && !c.imported && !c.derived)
    const prev = idx >= 0 ? clouds.value[idx] : null
    const cloud = {
      id: prev?.id ?? makeCloudId(),
      name: prev?.name ?? 'Dense cloud',
      kind: 'dense',
      createdAt: Date.now(),
      cameras: markRaw(new Map()),
      count,
      pos: markRaw(pos),
      col: markRaw(col),
      // World-space per-point unit normals (3N Float32), when the dense run produced
      // them (Poisson mesh input). Undefined on legacy/normal-less runs.
      ...(nrm ? { nrm: markRaw(nrm) } : {}),
    }
    if (idx >= 0) clouds.value.splice(idx, 1, cloud)
    else clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
  }

  // Insert/replace the single mesh cloud (kind:'mesh'). Flat like the dense cloud:
  // per-vertex pos/col + triangle idx, no per-vertex objects. count = triangles.
  function upsertMeshCloud({ nVerts, count, pos, idx: triIdx, col }) {
    // As with dense: a re-mesh replaces the computed mesh, never an imported one.
    const i = clouds.value.findIndex((c) => c.kind === 'mesh' && !c.imported)
    const prev = i >= 0 ? clouds.value[i] : null
    const cloud = {
      id: prev?.id ?? makeCloudId(),
      name: prev?.name ?? 'Mesh',
      kind: 'mesh',
      createdAt: Date.now(),
      cameras: markRaw(new Map()),
      count, nVerts,
      pos: markRaw(pos),
      idx: markRaw(triIdx),
      col: markRaw(col),
    }
    if (i >= 0) clouds.value.splice(i, 1, cloud)
    else clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
  }

  // Import an external point cloud or mesh (parsed off-thread by the `parseCloud`
  // worker op, transformed by applyImportTransform). Always ADDS a new cloud —
  // never replaces computed ones — flagged `imported: true` so upsertDense/Mesh
  // skip it on a re-fuse/re-mesh. Coordinates land verbatim in the current frame
  // (no CRS reprojection). Authoritative positions retain Float64 precision;
  // the renderer builds origin-relative Float32 buffers. Returns true
  // on success.
  function importCloud(parsed, fileName = 'file') {
    const isMesh = !!parsed.idx
    const n = isMesh ? (parsed.nVerts ?? 0) : (parsed.count ?? 0)
    if (!n) {
      log(`Cloud import: ${fileName} contained no points`, 'warn', 'Reconstruction')
      return false
    }
    const pos = parsed.pos instanceof Float64Array ? parsed.pos : Float64Array.from(parsed.pos)
    const cloud = {
      id: makeCloudId(),
      name: `Imported (${fileName})`,
      kind: isMesh ? 'mesh' : 'dense',
      createdAt: Date.now(),
      imported: true,
      cameras: markRaw(new Map()),
      pos: markRaw(pos),
      ...(parsed.attributes ? { attributes: markRaw(parsed.attributes) } : {}),
      ...(parsed.col ? { col: markRaw(parsed.col) } : { col: null }),
      ...(isMesh
        ? { nVerts: n, count: parsed.count, idx: markRaw(parsed.idx) }
        : { count: n, ...(parsed.nrm ? { nrm: markRaw(parsed.nrm) } : {}) }),
    }
    clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
    log(`Cloud import: added "${cloud.name}" — ${n.toLocaleString()} ${isMesh ? `vertices, ${parsed.count.toLocaleString()} triangles` : 'points'}`
      + `${parsed.col ? ', color' : ''}${parsed.nrm ? ', normals' : ''}`, 'success', 'Reconstruction')
    persist()
    return true
  }

  // Dense Stage A — Build Depth Maps. Runs PatchMatch MVS in the worker over the
  // sparse cloud's registered cameras, stores the raw depth maps for fusion, and
  // pushes a display depth image into each image (viewer overlay). Needs a sparse
  // cloud whose points carry view-tracks; these are now persisted, so a restored
  // project works without rebuilding (legacy models saved before this still need
  // a Reconstruct re-run).
  async function computeDepthMaps(settings = {}, onProgress) {
    const cloud = mainSparseCloud.value
    if (!cloud || cloud.cameras.size < 2) {
      log('Dense: need a sparse cloud with ≥2 cameras first', 'warn', 'Dense')
      return
    }
    const hasTracks = cloud.points.some((p) => p.views.size > 0)
    if (!hasTracks) {
      log('Dense: sparse cloud has no view-tracks (rebuild the sparse model first)', 'warn', 'Dense')
      return
    }
    reconStatus.value = 'running'
    try {
      // Resolve a quality preset → working maxDim from the largest native image
      // dimension (Step 3), unless the user set an explicit maxDim in Advanced.
      const resolved = { ...settings }
      if (resolved.quality && !(resolved.maxDim > 0)) {
        const nativeLong = images.value.reduce(
          (m, im) => Math.max(m, im.meta?.width || 0, im.meta?.height || 0), 0)
        resolved.maxDim = qualityToMaxDim(resolved.quality, nativeLong)
        log(`Dense: quality '${resolved.quality}' → working ≤${resolved.maxDim}px `
          + `(¼-scale presets of ${nativeLong}px native)`, 'info', 'Dense')
      }
      settings = resolved
      // Rebuild every value as plain arrays/objects: cloud cameras + points are
      // reactive Pinia state, and Vue's Proxy wrappers can't be structured-cloned
      // to the worker ("object can not be cloned").
      const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
      const sensorById = new Map(sensors.value.map((s) => [s.id, s]))
      // WS2: composed radial distortion {k1,k2,k3} the sparse run self-calibrated per
      // sensor (folded into the keypoints there). Passed to dense as a SECOND bag
      // (`selfCal`) applied after the calibrated `dist` — dense's camera K is the
      // BA-refined K the fold used, so it reproduces the same pinhole frame as the
      // sparse cloud. Empty ⇒ no-op (the normal EXIF-only case has no calibrated dist,
      // so selfCal is the only bag).
      const selfCalBySensor = new Map(
        (summary.value?.selfCalDistortion ?? []).map((d) => [d.sensorId, { k1: d.k1, k2: d.k2, k3: d.k3 }]))
      // F4: per-image scan→canonical transform from the sparse run. The dense
      // stage reproduces that exact frame (it must NOT re-fit) — the sparse run
      // defines it. Fail loudly if a film image is in the cloud but its transform
      // is missing (a stale/partial summary would silently mis-warp its raster).
      const fidByUuid = new Map(
        (summary.value?.fiducialTransforms ?? []).map((t) => [t.uuid, { A: t.A, transform: t.transform ?? null, frame: t.frame }]))
      const inputImages = []
      for (const [uuid, cam] of cloud.cameras) {
        const im = imgByUuid.get(uuid)
        if (!im) continue
        // Lens distortion for this image's sensor — the worker undistorts the raster
        // so depth maps / fusion / DEM / ortho all stay pinhole (matches sparse).
        const s = im.sensorId ? sensorById.get(im.sensorId) : null
        const fid = fidByUuid.get(uuid) ?? null
        if (s?.kind === 'film' && !fid) {
          // Three distinct causes — point the user at the actual fix, not always "re-run".
          const nMarks = s.fiducialCalibration?.marks?.length || s.fiducials?.marks?.length || 0
          const nObs = im.fiducialDetections?.length || im.fiducialObs?.length || 0
          let why
          if (nMarks < 3) {
            why = `its detected fiducials are not calibrated (${nMarks} metric marks, need ≥3) — `
              + `run Calibrate Fiducials, then re-run the sparse reconstruction`
          } else if (nObs < 3) {
            why = `this image has ${nObs} accepted fiducial detection(s) (need ≥3) — `
              + `run Detect Fiducials or review its spots, then re-run the sparse reconstruction`
          } else {
            why = `the last sparse run produced no interior-orientation transform for it — `
              + `re-run the sparse reconstruction before densifying`
          }
          log(`Dense: ${im.name} skipped — ${why}.`, 'error', 'Dense')
          continue
        }
        // A TIFF's lossless compute PNG may still be encoding right after ingest;
        // wait for it (rejects if its transcode failed) so dense reads the PNG,
        // never the lossy display JPEG — see the computeUrl invariant.
        await imagesStore.whenComputeReady(im)
        const dist = s ? distortionOf(s) : null
        // Composed self-cal bag for this image's sensor (a second undistortion applied
        // after `dist`). Null when self-cal was off for it.
        const sc = im.sensorId ? selfCalBySensor.get(im.sensorId) : null
        const selfCal = sc && (sc.k1 || sc.k2 || sc.k3)
          ? { k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0 } : null
        inputImages.push({
          uuid, name: im.name, url: im.computeUrl ?? im.url,
          // Per-image mask (if any) so masked regions are excluded from the dense cloud.
          mask: im.mask?.dataUrl ?? null,
          R: cam.R.map((row) => [...row]),
          t: [...cam.t],
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
          dist,
          selfCal,
          // Film scan→canonical warp (plain data; the frame is already a plain object).
          fid,
        })
      }
      if (selfCalBySensor.size) {
        const parts = [...selfCalBySensor].map(([id, d]) =>
          `${sensorById.get(id)?.label ?? id.slice(0, 6)} k1 ${(d.k1 || 0).toFixed(5)}`
          + `${d.k2 ? `, k2 ${d.k2.toFixed(5)}` : ''}${d.k3 ? `, k3 ${d.k3.toFixed(5)}` : ''}`)
        log(`Dense: applying self-calibrated distortion from the sparse run — ${parts.join('; ')}`,
          'info', 'Dense')
      }
      const points = cloud.points.map((p) => ({
        x: p.x, y: p.y, z: p.z,
        views: [...p.views.entries()].map(([u, kp]) => [u, kp]),
      }))

      const { maps, summary: aSummary } = await workerComputeDepthMaps(
        { images: inputImages, points, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
      )

      depthMaps.value = new Map(maps.map((m) => [m.uuid, m]))
      depthMapsMeta.value = []   // the fresh maps supersede any restored index
      depthSummary.value = aSummary ?? null
      for (const m of maps) {
        const im = imgByUuid.get(m.uuid)
        if (im && m.displayDataUrl) imagesStore.updateDepth(im.id, m.displayDataUrl)
      }
      log(`Dense: ${maps.length} depth map(s) computed`, 'success', 'Dense')
      reconStatus.value = 'done'
      // Persist before densify can transfer the buffers away. Writing does not
      // detach them, so the live cache is untouched.
      await persistDepthMaps(maps, settings)
    } catch (err) {
      log(`Depth-map error: ${err?.message ?? err}`, 'error', 'Dense')
      reconStatus.value = 'error'
    }
  }

  // Dense Stage B — fuse the Stage A depth maps into a coloured dense cloud.
  async function densify(settings = {}, onProgress) {
    // Hydrate a restored project's saved planes (no-op if Stage A ran this session).
    await ensureDepthMapsLoaded()
    const maps = [...depthMaps.value.values()]
    if (!maps.length) {
      log('Dense: compute depth maps before building the dense cloud', 'warn', 'Dense')
      return
    }
    // Stage B pre-flight (Phase 7): project the fusion peak from the real depth maps
    // and refuse before starting, rather than OOM-killing the tab mid-fuse. Run it
    // here — before the buffers are transferred to the worker — so a refusal leaves
    // the depth maps intact (a worker-side gate would throw after transfer and lose
    // them). Same budget knob as Stage A.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    const proj = projectDensifyPeakBytes({ maps })
    log(`Dense fuse: projected peak memory ≈ ${formatBytes(proj.total)} `
      + `(input ${formatBytes(proj.input)} + accumulator ${formatBytes(proj.accumulator)} + `
      + `output ${formatBytes(proj.output)}; ${proj.validPx.toLocaleString()} valid px → `
      + `~${proj.cells.toLocaleString()} cells) vs budget ${formatBytes(budget)}`,
      proj.total > budget ? 'error' : 'info', 'Dense')
    if (proj.total > budget) {
      log('Dense: aborting fusion before start — projected memory exceeds the budget. '
        + 'Re-run depth maps at a lower Quality, use a larger merge cell / fusion step, '
        + 'or raise the memory budget, then retry.', 'error', 'Dense')
      reconStatus.value = 'error'
      return
    }
    reconStatus.value = 'running'
    // Transfer (not clone) each map's depth/cost/rgb buffers to the worker — they're
    // the bulk of dense memory, and a clone briefly doubles it (the fusion OOM's
    // secondary contributor). The heavy per-map displayDataUrl PNG is display-only,
    // so strip it from the wire payload entirely. The worker returns the buffers so
    // we re-attach them below; until then the store's copies are detached.
    // Resolve uuid → filename for the fusion progress/log labels. Deliberately derived
    // here rather than persisted in the depth-map index: the image list is the authority
    // on names (a rename must not leave a stale copy in the sidecar), and a restored
    // project has the list but no name on the map. Falls back to a uuid fragment in
    // core/dense/mvs.js when the image is gone.
    const nameByUuid = new Map(images.value.map((im) => [im.uuid, im.name]))
    const mapsInput = maps.map((m) => ({
      uuid: m.uuid, name: m.name ?? nameByUuid.get(m.uuid), width: m.width, height: m.height, K: m.K, R: m.R, t: m.t,
      depth: m.depth, cost: m.cost, rgb: m.rgb, normals: m.normals || null,
    }))
    const transfer = []
    for (const m of mapsInput) {
      transfer.push(m.depth.buffer, m.cost.buffer, m.rgb.buffer)
      if (m.normals) transfer.push(m.normals.buffer)
    }
    try {
      const { points: flat, nrm, summary: dSummary, mapBuffers } = await workerDensify(
        { maps: mapsInput, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
      )
      // Re-attach the round-tripped buffers so ortho / a second densify still work.
      if (mapBuffers) {
        for (const mb of mapBuffers) {
          const m = depthMaps.value.get(mb.uuid)
          if (m) { m.depth = mb.depth; m.cost = mb.cost; m.rgb = mb.rgb; if (mb.normals) m.normals = mb.normals }
        }
      }
      // De-interleave the worker's flat [x,y,z,r,g,b] into the dense cloud's split
      // position/colour buffers (one typed-array pass, no per-point objects).
      const n = flat.length / 6
      const pos = new Float32Array(n * 3)
      const col = new Uint8Array(n * 3)
      for (let i = 0; i < n; i++) {
        const s = i * 6, d = i * 3
        pos[d] = flat[s]; pos[d+1] = flat[s+1]; pos[d+2] = flat[s+2]
        col[d] = flat[s+3]; col[d+1] = flat[s+4]; col[d+2] = flat[s+5]
      }
      // nrm (world-space unit normals, 3N) rides along when present — the Poisson
      // mesh stage consumes it; absent on GPU-less legacy runs (upsert leaves it off).
      upsertDenseCloud({ count: n, pos, col, ...(nrm ? { nrm } : {}) })
      denseSummary.value = dSummary ?? null
      reconStatus.value = 'done'
      await persist()
    } catch (err) {
      // The buffers were transferred out; if the worker failed before returning them
      // they're detached (dead). Drop the in-memory cache so ortho / re-densify don't
      // read empty buffers. The planes are on disk now, so point the store back at the
      // saved index: a retry rehydrates from OPFS instead of forcing a Stage A re-run.
      depthMaps.value = new Map()
      const recovered = await loadDepthIndexIntoMeta()
      log(`Densify error: ${err?.message ?? err}. Depth maps were released to the worker`
        + (recovered
          ? ' — they will be reloaded from disk on the next attempt.'
          : ' and must be recomputed before retrying.'), 'error', 'Dense')
      reconStatus.value = 'error'
    }
  }

  // Mesh — screened Poisson over the main dense cloud (needs its oriented normals).
  // Sends disposable copies of the dense buffers to the worker. Keeping the
  // authoritative arrays here costs one temporary copy, but makes cancellation
  // genuinely non-destructive: terminating a worker cannot strand detached
  // source buffers. Upserts a single kind:'mesh' cloud.
  async function generateMesh(settings = {}, onProgress) {
    const dense = clouds.value.find((c) => c.kind === 'dense')
    if (!dense?.count) { log('Mesh: build a dense point cloud first', 'warn', 'Products'); return }
    if (!dense.nrm || dense.nrm.length < dense.count * 3) {
      log('Mesh: the dense cloud has no per-point normals — re-run Densify to compute them', 'warn', 'Products')
      return
    }
    // Pass the dense merge cell (GSD) so the worker sizes the trim radius + colour grid.
    const mergeCell = denseSummary.value?.mergeCell ?? 0
    const posCopy = dense.pos.slice()
    const colCopy = dense.col?.slice() || null
    const nrmCopy = dense.nrm.slice()
    const input = {
      dense: { count: dense.count, pos: posCopy, col: colCopy, nrm: nrmCopy },
      settings: { ...settings, mergeCell },
    }
    const transfer = [posCopy.buffer]
    if (colCopy) transfer.push(colCopy.buffer)
    transfer.push(nrmCopy.buffer)
    reconStatus.value = 'running'
    try {
      const { mesh } = await workerMeshify(input,
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer })
      if (!mesh || !mesh.nVerts) {
        log('Mesh: Poisson produced no surface — try a lower depth or check the cloud/normals', 'warn', 'Products')
        reconStatus.value = 'done'
        return
      }
      upsertMeshCloud(mesh)
      reconStatus.value = 'done'
      await persist()
    } catch (err) {
      log(`Mesh error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  // ── Cloud editing (crop / filter / merge) ────────────────────────────────────

  // Add a cloud produced by an edit. Always a NEW cloud — editing is
  // non-destructive, so the source stays exactly as it was and the user can compare
  // or discard. Flagged `derived: true` so upsertDenseCloud never replaces it with a
  // re-fuse's output (the same protection `imported` gives an imported cloud, for
  // the same reason: neither is the densify stage's own slot). `imported` is
  // INHERITED from the source, because that flag is what sorts the sidebar into
  // Products vs Reference Data — a crop of imported evidence is still evidence.
  function addDerivedCloud(flat, { name, imported = false }) {
    const cloud = {
      id: makeCloudId(),
      name,
      kind: 'dense',
      createdAt: Date.now(),
      derived: true,
      ...(imported ? { imported: true } : {}),
      cameras: markRaw(new Map()),
      count: flat.count,
      pos: markRaw(flat.pos),
      ...(flat.attributes ? { attributes: markRaw(flat.attributes) } : {}),
      col: markRaw(flat.col || null),
      ...(flat.nrm ? { nrm: markRaw(flat.nrm) } : {}),
    }
    clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
    return cloud
  }

  // Crop / filter / merge dense clouds in the worker. `sourceIds` are cloud ids
  // (one for crop/filter, two or more for merge); `settings` is already in the
  // core/products/cloudEdit.js shape (the modals do the UI→core mapping in run()).
  //
  // Disposable copies are transferred to the worker. The source buffers remain
  // attached throughout, including when Cancel hard-terminates the worker.
  async function editClouds({ mode, sourceIds = [], settings = {}, name } = {}, onProgress) {
    const sources = sourceIds
      .map((id) => clouds.value.find((c) => c.id === id))
      .filter((c) => c && c.kind === 'dense' && c.count > 0)
    if (!sources.length) {
      log('Cloud edit: no dense source cloud selected', 'warn', 'Products')
      return null
    }
    if (mode === 'merge' && sources.length < 2) {
      log('Cloud edit: merge needs at least two dense clouds', 'warn', 'Products')
      return null
    }
    const transfer = []
    const payload = sources.map((c) => {
      const pos = c.pos.slice()
      const col = c.col?.slice() || null
      const nrm = c.nrm?.slice() || null
      transfer.push(pos.buffer)
      if (col) transfer.push(col.buffer)
      if (nrm) transfer.push(nrm.buffer)
      const attributes = Object.fromEntries(Object.entries(c.attributes || {}).map(([key, values]) => {
        const copy = values.slice()
        transfer.push(copy.buffer)
        return [key, copy]
      }))
      return { id: c.id, count: c.count, pos, col, nrm, attributes }
    })
    reconStatus.value = 'running'
    try {
      const { cloud: edited, error } = await workerEditCloud(
        { mode, clouds: payload, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
      )
      if (error) throw new Error(error)
      if (!edited?.count) {
        log('Cloud edit: the result is empty — nothing was added', 'warn', 'Products')
        reconStatus.value = 'done'
        return null
      }
      const cloud = addDerivedCloud(edited, {
        name: name || `${sources[0].name} (${mode})`,
        imported: sources.every((c) => c.imported),
      })
      log(`Cloud edit: added "${cloud.name}" — ${cloud.count.toLocaleString()} points`,
        'success', 'Products')
      reconStatus.value = 'done'
      await persist()
      return cloud
    } catch (err) {
      log(`Cloud edit error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
      return null
    }
  }

  // ── Georeferencing + products (DEM / orthophoto) ─────────────────────────────

  const {
    georefPairs, imagesById, qualifyingGcps, canGeoreferenceGcps, gcpGeorefPairs,
    canGeoreference, georeference, validGeoref, poseResidualReport, gcpAccuracyReport,
    gcpGuides, gcpEstimate,
  } = createGeoreferencing({
    sparseCameras, images, georef, healthDirty,
    modelStamp: () => mainSparseCloud.value ? [mainSparseCloud.value.id, mainSparseCloud.value.createdAt] : null,
    poses: () => posesStore.poses,
    gcps: () => gcpsStore.gcps,
    currentCrs: () => projects.currentCrs,
    persist, log,
  })

  const {
    canFitScale, fitScaleBars, scaleBarReport, scaleFitStatus,
  } = createScaling({
    sparseCameras, images, mainSparseCloud, scaleFit, healthDirty,
    bars: () => scaleBarsStore.bars,
    gcps: () => gcpsStore.gcps,
    persist, log,
  })

  const { effectiveFrameSpec, currentFrameSignature, productFrameStatus, frameStampOf } = createFrameResolver({
    mainSparseCloud, validGeoref, currentCrs: () => projects.currentCrs, georeference,
    scaleFit, scaleFitStatus, log,
  })

  // Build a DEM from the densest available cloud, in the requested frame
  // (settings.crs: 'local' | 'project'). A new DEM invalidates the old ortho.
  async function generateDem(settings = {}, onProgress) {
    const sparse = mainSparseCloud.value
    // Single source of truth for "which cloud" — the same getter the modal shows.
    const source = demSource.value
    if (!source) {
      log('DEM: build a point cloud first', 'warn', 'Products')
      return
    }
    const src = source.cloud
    log(`DEM: source is the ${source.kind} cloud`
      + `${source.name ? ` "${source.name}"` : ''} (${source.count.toLocaleString()} points)`
      + (source.kind === 'sparse'
        ? ' — cells are interpolated from tie points; densify for a true surface'
        : ''),
      source.kind === 'sparse' ? 'warn' : 'info', 'Products')
    // Resolve the target frame through THE resolver — never independently. A
    // 'project' request fits/refits the georeference on demand; otherwise a valid
    // scale-bar fit still makes the local frame metric (with no CRS).
    const resolved = await effectiveFrameSpec({ crs: settings.crs })
    const frameSpec = resolved.frameSpec
    if (settings.crs && settings.crs !== 'local' && resolved.source !== 'georef') {
      log('DEM: no georeference available — using the local frame'
        + (resolved.unit === 'm' ? ', scaled to metres by the scale bars' : ''), 'warn', 'Products')
    }
    reconStatus.value = 'running'
    try {
      // Plain copies: cloud state is reactive (Vue proxies can't be cloned). Dense
      // clouds are flat typed arrays — read xyz straight out (colour isn't needed).
      const count = src.kind === 'dense' ? src.count : src.points.length
      if (count * 48 > 512 * 1024 ** 2) throw new Error('DEM point staging exceeds 512 MiB; subsample the cloud first')
      const pos = new Float64Array(count * 3)
      if (src.kind === 'dense') pos.set(src.pos.subarray(0, count * 3))
      else for (let i = 0; i < count; i++) {
        const p = src.points[i]
        pos[i*3] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z
      }
      const points = { pos, count }
      const cameras = [...(sparse?.cameras ?? new Map()).entries()].map(([uuid, cam]) => ({
        uuid, R: cam.R.map((r) => [...r]), t: [...cam.t], K: { ...cam.K },
      }))
      const grid = await workerGenerateDem(
        { points, cameras, frame: frameSpec, settings },
        { transfer: [pos.buffer], onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
      )
      dem.value = { ...grid, frameStamp: frameStampOf(resolved) }
      // A new DEM invalidates an ortho BUILT ON IT — but not one built over the
      // mesh/plane surface, which this run didn't touch. (An ortho with no
      // recorded surface predates the choice, so it was a DEM ortho.)
      const orthoWasDem = ortho.value && (ortho.value.surface ?? 'DEM') === 'DEM'
      if (orthoWasDem) ortho.value = null
      if (isPersisting()) {
        opfs.saveProduct(projects.currentProjectId, 'dem', dem.value).catch(() => {})
        if (orthoWasDem) opfs.deleteProduct(projects.currentProjectId, 'ortho').catch(() => {})
      }
      reconStatus.value = 'done'
    } catch (err) {
      log(`DEM error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  // Build the surface payload for an ortho run: the height source the worker will
  // turn into a grid. `settings.surface` is one of orthoSurfaces' ids. Returns null
  // (after logging why) when the chosen surface isn't available.
  //
  // A mesh/plane surface needs a frame of its own — a DEM carries the one it was
  // built in, but there may be no DEM at all now. It's resolved exactly as
  // generateDem does, so the two products stay co-registered.
  async function orthoSurfacePayload(settings, resolved) {
    const id = settings.surface ?? 'dem'
    const opt = orthoSurfaces.value.find((s) => s.id === id)
    if (!opt) { log(`Ortho: unknown surface "${id}"`, 'warn', 'Products'); return null }
    if (!opt.available) { log(`Ortho: ${opt.hint}`, 'warn', 'Products'); return null }

    if (id === 'dem') {
      const d = dem.value
      log('Ortho: surface is the DEM — cells the DEM has no height for stay transparent',
        'info', 'Products')
      return {
        kind: 'dem',
        grid: {
          width: d.width, height: d.height, gsd: d.gsd, originX: d.originX, originY: d.originY,
          data: d.data, mask: d.mask, frame: d.frame,
        },
      }
    }

    let frameSpec = resolved.source === 'georef' ? resolved.frameSpec : null
    if (settings.crs && settings.crs !== 'local' && !frameSpec) {
      log('Ortho: no georeference available — using the local frame', 'warn', 'Products')
    }
    // Local frame: reuse the DEM's when it was built locally, so a mesh ortho lands
    // on the same grid origin as the DEM instead of a near-identical one of its own.
    // A bare { kind:'local' } / { kind:'scaled-local' } spec is only a REQUEST —
    // buildLocalFrame derives the up-vector from the scene, so cameras + points must
    // travel with it. A reused DEM descriptor is only valid at the SAME scale: a
    // refit since then means its metres are not these metres.
    if (!frameSpec) {
      const reusable = dem.value?.frame
      const sameKind = reusable?.kind === resolved.frameSpec.kind
      const sameScale = resolved.frameSpec.kind !== 'scaled-local'
        || Math.abs((reusable?.scale ?? 0) - resolved.frameSpec.scale) < 1e-12
      frameSpec = sameKind && sameScale ? reusable : resolved.frameSpec
    }
    const surfSettings = { gsd: settings.surfaceGsd > 0 ? settings.surfaceGsd : 0 }

    // Point sample from the densest cloud: the plane's fit input, and the local
    // frame's origin/PCA fallback. Subsampled — a plane needs spread, not every
    // point, and 25 M boxed {x,y,z} in the worker is the OOM we avoid everywhere.
    const src = demSource.value
    const cloud = src?.cloud
    const total = src?.count ?? 0
    const MAX_FIT = 200_000
    const stride = Math.max(1, Math.ceil(total / MAX_FIT))
    const n = total ? Math.ceil(total / stride) : 0
    const pos = new Float64Array(n * 3)
    for (let i = 0, k = 0; i < total; i += stride, k++) {
      if (cloud.kind === 'dense') {
        pos[k * 3] = cloud.pos[i * 3]; pos[k * 3 + 1] = cloud.pos[i * 3 + 1]; pos[k * 3 + 2] = cloud.pos[i * 3 + 2]
      } else {
        const p = cloud.points[i]
        pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z
      }
    }
    const cameras = [...sparseCameras.value.entries()].map(([uuid, cam]) => ({
      uuid, R: cam.R.map((r) => [...r]), t: [...cam.t], K: { ...cam.K },
    }))

    if (id === 'mesh') {
      const m = meshCloud.value
      log(`Ortho: surface is the mesh "${m.name ?? 'mesh'}" `
        + `(${m.count.toLocaleString()} triangles)`, 'info', 'Products')
      return {
        kind: 'mesh', frame: frameSpec, cameras, framePoints: pos, framePointCount: n,
        pos: m.pos, idx: m.idx, settings: surfSettings,
      }
    }

    log(`Ortho: surface is a plane fitted to the ${src.kind} cloud `
      + `(${n.toLocaleString()} of ${total.toLocaleString()} points)`, 'info', 'Products')
    // The plane's fit points double as the local frame's — one sample, one array.
    return {
      kind: 'plane', frame: frameSpec, cameras, framePoints: pos, framePointCount: n,
      pos, count: n, settings: surfSettings,
    }
  }

  // Orthorectify a surface using the cached depth maps (occlusion via their depth
  // planes, colour from their RGB planes). Needs depth maps and a surface — which
  // is a DEM only when the user picks one (see orthoSurfaces).
  async function generateOrtho(settings = {}, onProgress) {
    // Hydrate a restored project's saved planes (no-op if they're already in memory).
    await ensureDepthMapsLoaded()
    let maps = [...depthMaps.value.values()]
    if (!maps.length) { log('Ortho: compute depth maps first', 'warn', 'Products'); return }
    // A failed densify transfers (and loses) the depth buffers; a detached typed
    // array reports byteLength 0. Reload them from disk if they were saved, and only
    // refuse when nothing usable is left — never reproject empty planes.
    if (maps.some((m) => m.depth.byteLength === 0 || m.rgb.byteLength === 0)) {
      depthMaps.value = new Map()
      const recovered = await loadDepthIndexIntoMeta() && await ensureDepthMapsLoaded()
      maps = [...depthMaps.value.values()]
      if (!recovered || !maps.length) {
        log('Ortho: depth maps were released by a prior densify — recompute them first',
          'warn', 'Products')
        return
      }
    }
    const resolved = await effectiveFrameSpec({ crs: settings.crs })
    const surface = await orthoSurfacePayload(settings, resolved)
    if (!surface) return
    reconStatus.value = 'running'
    try {
      const mapsPayload = maps.map((m) => ({
        uuid: m.uuid, width: m.width, height: m.height, K: m.K, R: m.R, t: m.t,
        depth: m.depth, cost: m.cost, rgb: m.rgb,
      }))
      const res = await workerGenerateOrtho(
        { surface, maps: mapsPayload, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (dn, t, lbl, f) => onProgress?.(dn, t, lbl, f) },
      )
      // An ortho built ON the DEM inherits the DEM's recorded frame — its cells are
      // that grid's cells, so claiming today's frame would be a claim about a raster
      // this run never re-projected.
      ortho.value = {
        ...res,
        frameStamp: (settings.surface ?? 'dem') === 'dem'
          ? (dem.value?.frameStamp ?? frameStampOf(resolved))
          : frameStampOf(resolved),
      }
      if (isPersisting()) opfs.saveProduct(projects.currentProjectId, 'ortho', ortho.value).catch(() => {})
      reconStatus.value = 'done'
    } catch (err) {
      log(`Ortho error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  // Run incremental SfM in the compute worker (off the main thread). The heavy
  // orchestration lives in core/sfm/sfm.js; this gathers the plain inputs it needs
  // (keypoints + match graph + settings), streams its log/progress back through
  // the usual hooks, then writes the returned model into reactive state and
  // persists it. (The model now lands all at once at the end rather than building
  // up live in the viewer — a fair trade for never freezing the UI.)
  async function reconstruct(settings = {}, onProgress) {
    restoreGeneration++
    reconStatus.value = 'running'
    let stopMemoryWatchdog = () => {}

    try {
      // Descriptors are required for matching, never for SfM. In a persistent
      // project they are already in OPFS and can be loaded on demand if matching
      // is run again. Keeping 127 × 25k × 128 float SIFT descriptors resident can
      // consume ~1.5 GiB and is enough to kill the renderer during reconstruction.
      let descriptorBytesReleased = 0
      let descriptorImagesReleased = 0
      if (isPersisting()) {
        for (const img of images.value) {
          const bytes = img.descriptors?.byteLength ?? 0
          if (!bytes) continue
          descriptorBytesReleased += bytes
          descriptorImagesReleased++
          img.descriptors = null
        }
      }
      if (descriptorBytesReleased) {
        log(`Released ${formatBytes(descriptorBytesReleased)} of persisted descriptors from `
          + `${descriptorImagesReleased} image(s) before reconstruction`, 'info', 'Compute')
        // Yield once so the engine can reclaim detached descriptor backing stores
        // before the live-heap reading below. Never assume it did: the decision
        // uses the observed value without subtracting bytes optimistically.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const imgs = images.value.filter((img) => img.kpStatus === 'done' && (img.keypoints?.length ?? 0) > 0)
      const sensorById = new Map(sensors.value.map((s) => [s.id, s]))
      const reconstructionTransfers = []
      const reconstructionPairs = [...matchStore.value.values()]
        .filter((e) => e.status === 'done' && !e.disabled)

      // Renderer OOM cannot be caught after the fact. Refuse before constructing
      // the large plain worker input when its projected peak exceeds safe headroom.
      const keypointCount = imgs.reduce((sum, img) => sum + (img.keypoints?.length ?? 0), 0)
      const matchCount = reconstructionPairs.reduce((sum, pair) => sum + (pair.matches?.length ?? 0), 0)
      const peak = projectSparsePeakBreakdownBytes({ keypointCount, matchCount })
      const heap = globalThis.performance?.memory
      const hardwareBudget = deviceBudget({
        deviceMemoryGB: Number(globalThis.navigator?.deviceMemory) || null,
        jsHeapLimitBytes: Number(heap?.jsHeapSizeLimit) || null,
      }).budgetBytes
      const decideMemory = () => ({
        renderer: sparseMemoryDecision({
          estimateBytes: peak.rendererBytes,
          usedHeapBytes: Number(globalThis.performance?.memory?.usedJSHeapSize),
          heapLimitBytes: Number(globalThis.performance?.memory?.jsHeapSizeLimit),
          fallbackBudgetBytes: hardwareBudget,
        }),
        // A Web Worker is a separate V8 isolate with its own heap ceiling. Comparing
        // renderer-used + worker-projected bytes to one isolate's limit rejected safe
        // runs (the 127-image DJI set: 1.40 + 2.35 > 3.52 GB) even though neither heap
        // approached its own ceiling.
        worker: sparseMemoryDecision({
          estimateBytes: peak.workerBytes,
          usedHeapBytes: 0,
          heapLimitBytes: Number(globalThis.performance?.memory?.jsHeapSizeLimit),
          fallbackBudgetBytes: hardwareBudget,
        }),
      })
      let decisions = decideMemory()

      // A reload restores the saved sparse model, so "reload and retry" alone does
      // not create renderer headroom. If the only thing preventing a rerun is the
      // replaceable current result, unload it in memory (the saved copy stays on disk),
      // discard idle worker heaps, yield for collection, and measure again.
      if (!decisions.renderer.safe) {
        const released = releaseReplaceableModelForRerun()
        if (released.released) {
          terminateAll('preparing a clean sparse-reconstruction rerun')
          log(`Released the loaded reconstruction before rerun (${released.cameraCount} cameras, `
            + `${released.pointCount.toLocaleString()} points`
            + `${released.dependentClouds ? `, ${released.dependentClouds} computed dependent cloud(s)` : ''}). `
            + 'The saved model remains recoverable by reloading until the replacement succeeds.',
          'info', 'Compute')
          await new Promise((resolve) => setTimeout(resolve, 50))
          decisions = decideMemory()
        }
      }
      const decisionSafe = decisions.renderer.safe && decisions.worker.safe
      log(`Sparse memory preflight — ${keypointCount.toLocaleString()} keypoints, `
        + `${matchCount.toLocaleString()} matches; renderer `
        + `${decisions.renderer.usedBytes != null ? `${formatBytes(decisions.renderer.usedBytes)} current + ` : ''}`
        + `${formatBytes(peak.rendererBytes)} input`
        + `${decisions.renderer.limitBytes ? ` ≤ ${formatBytes(decisions.renderer.limitBytes)} ceiling` : ''}; `
        + `worker projected peak ${formatBytes(peak.workerBytes)}`
        + `${decisions.worker.limitBytes ? ` ≤ ${formatBytes(decisions.worker.limitBytes)} ceiling` : ''} `
        + `(combined device peak estimate ${formatBytes(peak.totalBytes)})`,
      decisionSafe ? 'info' : 'error', 'Compute')
      if (!decisionSafe) {
        reconStatus.value = 'error'
        const where = !decisions.renderer.safe && !decisions.worker.safe
          ? 'renderer and worker heaps' : (!decisions.renderer.safe ? 'renderer heap' : 'worker heap')
        log(`Sparse reconstruction stopped before start because the projected ${where} would exceed `
          + 'its safety ceiling. Close other memory-heavy tabs or reduce the image/keypoint/match set.',
        'error', 'Reconstruction')
        return
      }

      const input = {
        images: imgs.map((img) => {
          // Forward everything resolveK() may need: the EXIF fields that let it
          // derive focal length in pixels, plus the assigned sensor's intrinsics
          // (which take priority, so edits in the sensor table actually apply).
          const s = img.sensorId ? sensorById.get(img.sensorId) : null
          return {
            uuid: img.uuid,
            name: img.name,
            kpStatus: img.kpStatus,
            // Resolution the keypoints were MEASURED at (keypoint coords themselves
            // are native px). core/scaleContext.js resolves the reprojection gates
            // against it — a gate below the measurement quantum rejects good data.
            // Absent on pre-scale projects ⇒ treated as 1 ⇒ no correction.
            detectScale: img.detectScale ?? null,
            // Sensor id lets BA share one focal across images on the same sensor
            // (self-calibration); null → the image is its own intrinsics group.
            sensorId: img.sensorId ?? null,
            keypoints: (img.keypoints || []).map((kp) => ({ x: kp.x, y: kp.y, color: kp.color })),
            // Fiducial-mark observations (F4) — scan-pixel clicks the sfm ingest
            // uses to fit this image's scan→canonical affine. Spread to plain
            // objects (the Vue proxy can't be structured-cloned).
            fiducialObs: (img.fiducialObs || []).map((o) => ({ fidId: o.fidId, px: o.px, py: o.py })),
            fiducialDetections: (img.fiducialDetections || []).map((d) => ({ slot: d.slot, px: d.px, py: d.py,
              family: d.family, source: d.source, confidence: d.confidence, reviewed: d.reviewed })),
            meta: img.meta
              ? {
                  width: img.meta.width,
                  height: img.meta.height,
                  focalLength35: img.meta.focalLength35,
                  focalLength: img.meta.focalLength,
                  focalPlaneXRes: img.meta.focalPlaneXRes,
                  focalPlaneResUnit: img.meta.focalPlaneResUnit,
                  make: img.meta.make,
                  model: img.meta.model,
                }
              : null,
            sensor: s
              ? {
                  focal: s.focal, focalUnit: s.focalUnit, pixelSize: s.pixelSize,
                  sensorWidthMm: s.sensorWidthMm,
                  cx: s.cx, cy: s.cy, width: s.width, height: s.height,
                  // Lens distortion (Brown–Conrady) — undistorted at ingest so the
                  // pipeline stays pinhole. Null coeffs are treated as zero.
                  k1: s.k1, k2: s.k2, k3: s.k3, p1: s.p1, p2: s.p2,
                  distortionModel: s.distortionModel,
                  // Film-scan interior orientation (F4): kind + calibrated fiducial
                  // layout. The sfm ingest fits a per-image affine and builds one
                  // canonical K per sensor (resolveK path 0). Plain-copy the marks.
                  kind: s.kind ?? 'digital',
                  fiducials: s.fiducials
                    ? {
                        marks: (s.fiducials.marks || []).map((m) => ({ id: m.id, xMm: m.xMm, yMm: m.yMm })),
                        ppxMm: s.fiducials.ppxMm, ppyMm: s.fiducials.ppyMm, focalMm: s.fiducials.focalMm,
                      }
                    : null,
                  fiducialCalibration: s.fiducialCalibration
                    ? JSON.parse(JSON.stringify(s.fiducialCalibration))
                    : null,
                }
              : null,
          }
        }),
        pairs: reconstructionPairs
          .map((e) => ({
            idA: e.idA, idB: e.idB,
            // F (3×3) and matches come from reactive store entries; rebuild them
            // as plain arrays or the Vue proxy can't be structured-cloned to the
            // worker ("[object Array] could not be cloned").
            F: e.F ? e.F.map((row) => [...row]) : null,
            // Millions of tuple arrays are catastrophic to clone. This fresh
            // packed buffer is disposable and transferred into the worker below.
            matches: (() => {
              const packed = packMatchPairs(e.matches)
              reconstructionTransfers.push(packed.buffer)
              return packed
            })(),
            // WS1: weak pairs (valid F below the accept gate) ride through with the flag.
            // sfm.js keeps them out of the cycle filter / init / triangulation and feeds
            // them only to PnP correspondence collection (register.js).
            inlierCount: e.inlierCount, weak: e.weak ?? false, status: 'done',
          })),
        // GCPs, pre-resolved to plain data + imageId → uuid (the worker only knows
        // images by uuid): [{ x, y, z, accuracy*, observations: [{ uuid, px, py }] }].
        // Feeds the optional GCP-anchored bundle-adjust pass in core/sfm/sfm.js.
        gcps: (() => {
          const imgById = imagesById()
          // Anchored BA is a Euclidean 3D constraint. Do not mix longitude/
          // latitude degrees with metre elevations, and never invent z=0 for a
          // 2D control point. Post-hoc products enforce the same boundary.
          if (isGeographic(projects.currentCrs)) return []
          return gcpsStore.gcps
            .filter((g) => isGroundControl(g, { precision: precisionFromGcp }))
            .map((g) => ({
              role: 'control',
              x: g.x, y: g.y, z: g.z,
              accuracyX: g.accuracyX, accuracyY: g.accuracyY, accuracyZ: g.accuracyZ,
              correlationXY: g.correlationXY, correlationXZ: g.correlationXZ, correlationYZ: g.correlationYZ,
              observations: (g.observations || [])
                .map((o) => ({ uuid: imgById.get(o.imageId)?.uuid, px: o.px, py: o.py,
                  accuracyX: o.accuracyX ?? g.accuracyImgX,
                  accuracyY: o.accuracyY ?? g.accuracyImgY }))
                .filter((o) => o.uuid != null),
            }))
        })(),
        // Surveyed/imported and EXIF-derived camera positions. buildCameraPriors
        // keeps projected coordinates as-is and gives geographic projects an
        // internal survey-centred metric frame; the project/output CRS is unchanged.
        cameraPriors: (() => {
          const priors = buildCameraPriors(posesStore.poses, images.value, projects.currentCrs)
          if (isGeographic(projects.currentCrs) && priors.length) {
            log(`Camera priors: ${priors.length} geographic position(s) converted to a `
              + 'survey-centred metric frame for bundle adjustment', 'info', 'Pose')
          }
          return priors
        })(),
        settings,
      }

      // Chrome exposes live heap usage. Poll while the main thread is idle and the
      // worker solves; terminate early because a renderer OOM itself is uncatchable.
      if (Number.isFinite(heap?.usedJSHeapSize) && Number.isFinite(heap?.jsHeapSizeLimit)) {
        const stopAt = heap.jsHeapSizeLimit * SPARSE_HEAP_FRACTION
        let stopped = false
        const timer = setInterval(() => {
          if (stopped || !(performance.memory?.usedJSHeapSize >= stopAt)) return
          stopped = true
          clearInterval(timer)
          const used = performance.memory.usedJSHeapSize
          log(`Sparse reconstruction stopped at ${formatBytes(used)} heap usage `
            + `(safety ceiling ${formatBytes(stopAt)})`, 'error', 'Compute')
          terminateAll('reconstruction stopped before browser memory exhaustion')
        }, 500)
        stopMemoryWatchdog = () => { stopped = true; clearInterval(timer) }
      }

      let packedResult = await workerReconstruct(input, {
        onLog: (message, level, category) => log(message, level, category),
        onProgress: (done, total, label, fraction) => onProgress?.(done, total, label, fraction),
        transfer: reconstructionTransfers,
      })
      stopMemoryWatchdog()
      stopMemoryWatchdog = () => {}
      const result = unpackReconstructionResult(packedResult)
      // The expanded Maps are now authoritative. Drop the transferred CSR buffers
      // before orientation + persistence allocate their own compact arrays.
      packedResult = null
      log(`Compact result received: ${result.points.length.toLocaleString()} points`,
        'info', 'Reconstruction')

      // Apply the compact worker result. The transport codec has already expanded
      // its CSR buffers directly into the Map-based point shape used by the app.
      if (result.status === 'done') {
        let camMap = result.cameras
        let pts = result.points

        // Aerial auto-orient: SfM leaves the model in an arbitrary frame (it can
        // come out upside-down). For aerial surveys the cameras look down, so we
        // rotate the whole model Z-up — cameras above the ground — before storing.
        if (projects.currentSceneType === 'aerial') {
          const R = aerialUpRotation(camMap)
          if (R) {
            const oriented = rotateReconstruction(camMap, pts, R, { inPlace: true })
            camMap = oriented.cameras
            pts = oriented.points
            log('Oriented model Z-up (aerial: cameras above ground)', 'info', 'Reconstruction')
          }
        }
        upsertSparseCloud(camMap, pts)
        // A secondary component that could not satisfy the conservative shared-camera
        // alignment gates is still a valid reconstruction. Preserve it as a separate
        // sparse cloud rather than discarding it or forcing it into the primary frame.
        clouds.value = clouds.value.filter((c) => !(c.kind === 'sparse' && c.secondary))
        for (const [si, model] of (result.secondaryModels || []).entries()) {
          let secondaryCameras = model.cameras
          let secondaryPoints = model.points
          if (projects.currentSceneType === 'aerial') {
            const R = aerialUpRotation(secondaryCameras)
            if (R) ({ cameras: secondaryCameras, points: secondaryPoints } =
              rotateReconstruction(secondaryCameras, secondaryPoints, R, { inPlace: true }))
          }
          upsertSparseCloud(secondaryCameras, secondaryPoints, {
            replaceId: null,
            asMain: false,
            select: false,
            secondary: true,
            name: model.name || `Secondary sparse ${si + 1}`,
          })
        }
        await invalidateSparseDependents()
        // Retire the outgoing summary into the run history before overwriting it, so
        // "vs previous run" compares against what was on screen a moment ago (WS5).
        if (summary.value) {
          summaryHistory.value = [...summaryHistory.value, summary.value].slice(-SUMMARY_HISTORY_MAX)
        }
        summary.value = result.summary ?? null
        healthDirty.value++
        reconStatus.value = 'done'
        const saved = await persist()
        log(saved
          ? 'Reconstruction saved to project storage'
          : 'Reconstruction is available in memory but could not be saved to project storage',
        saved ? 'success' : 'warn', 'Project')
      } else {
        reconStatus.value = result.status === 'error' ? 'error' : 'idle'
      }
    } catch (err) {
      log(`Reconstruction error: ${err?.message ?? err}`, 'error', 'Reconstruction')
      reconStatus.value = 'error'
    } finally {
      stopMemoryWatchdog()
    }
  }


  // Reset the in-memory clouds. Pass { purge: true } to also delete the persisted
  // reconstruction.json — do NOT purge on project switch, since restore reads it.
  function clear({ purge = false } = {}) {
    restoreGeneration++
    clouds.value = []
    selectedCloudId.value = null
    mainSparseId.value = null
    reconStatus.value = 'idle'
    clearDepthMaps()
    dem.value = null
    ortho.value = null
    georef.value = null
    scaleFit.value = null
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
    dem.value = null
    ortho.value = null
    if (isPersisting()) await opfs.deleteProjectDerived(projects.currentProjectId)
    log('Cleared cached image transcodes, depth maps, and raster products.', 'success', 'Project')
  }

  // Rebuild one cloud from version-2 metadata + binary buffers (inverse of
  // serializeCloud). markRaw: point clouds are large and only ever replaced
  // wholesale, never mutated per-point — deep reactivity freezes render/restore.
  async function restore({ projectId }) {
    // Reset first so switching to a project without a saved model doesn't leave
    // the previous project's clouds in memory (loadReconstruction returns null for
    // an empty project and would otherwise no-op).
    clear()
    const generation = restoreGeneration
    const isCurrentRestore = () => generation === restoreGeneration && projectId === projects.currentProjectId
    const data = await opfs.loadReconstruction(projectId)
    if (!isCurrentRestore()) return
    if (!data) {
      // No sparse model, so any saved depth planes are orphans (they only exist in a
      // sparse cloud's frame). Let the staleness check collect them rather than leak
      // hundreds of MB of OPFS forever.
      await loadDepthIndexIntoMeta(projectId, isCurrentRestore)
      return
    }

    // New shape: { clouds: [...] }. Legacy shape: a single model
    // { cameras: [...], points: [...] } — wrap it as one sparse cloud.
    const raw = Array.isArray(data.clouds)
      ? data.clouds
      : data.cameras
        ? [{ name: 'Sparse cloud', kind: 'sparse', ...data }]
        : []

    clouds.value = raw.map((c) => (c.buffers ? deserializeCloud(c, makeCloudId) : legacyDeserializeCloud(c, makeCloudId)))
    selectedCloudId.value = clouds.value[0]?.id ?? null
    mainSparseId.value = data.mainSparseId ?? null
    ensureMainSparse() // legacy docs (no mainSparseId) → first sparse cloud
    georef.value = data.georef ?? null
    scaleFit.value = data.scaleFit ?? null    // absent in older projects ⇒ no scale
    summary.value = data.summary ?? null
    denseSummary.value = data.denseSummary ?? null
    depthSummary.value = data.depthSummary ?? null
    summaryHistory.value = Array.isArray(data.summaryHistory) ? data.summaryHistory : []

    // Restore persisted raster products (DEM / ortho), if any.
    const [savedDem, savedOrtho] = await Promise.all([
      opfs.loadProduct(projectId, 'dem'),
      opfs.loadProduct(projectId, 'ortho'),
    ])
    if (!isCurrentRestore()) return
    dem.value = savedDem
    ortho.value = savedOrtho
    if (savedDem || savedOrtho) {
      log(`Products restored: ${[savedDem && 'DEM', savedOrtho && 'ortho'].filter(Boolean).join(' + ')}`, 'success', 'Products')
    }

    if (clouds.value.length) {
      const camTotal = clouds.value.reduce((n, c) => n + c.cameras.size, 0)
      log(`Reconstruction restored: ${clouds.value.length} cloud(s), ${camTotal} cameras`, 'success', 'Reconstruction')
    }

    // Advertise saved depth maps without loading their planes — densify / ortho
    // hydrate them on demand. Runs after ensureMainSparse() so the staleness check
    // compares against the cloud the pipeline will actually consume.
    if (await loadDepthIndexIntoMeta(projectId, isCurrentRestore) && isCurrentRestore()) {
      log(`Dense: ${depthMapsMeta.value.length} saved depth map(s) available `
        + `(${formatBytes(depthMapBytes(depthMapsMeta.value))}, loaded on demand)`, 'success', 'Dense')
    }
  }

  return {
    clouds,
    selectedCloudId,
    selectedCloud,
    mainSparseId,
    mainSparseCloud,
    setMainSparse,
    cameras,
    sparseCameras,
    points3d,
    reconStatus,
    depthMaps,
    depthMapsMeta,
    depthMapCount,
    georef,
    scaleFit,
    summary,
    denseSummary,
    depthSummary,
    summaryHistory,
    healthDirty,
    dem,
    demSource,
    ortho,
    orthoSurfaces,
    canGeoreference,
    canGeoreferenceGcps,
    georeference,
    // Scale constraints (F11). `effectiveFrameSpec` is THE resolver — product
    // builders, readouts, reports and exports must all ask it rather than
    // choosing a scale independently.
    effectiveFrameSpec,
    canFitScale,
    fitScaleBars,
    scaleBarReport,
    scaleFitStatus,
    currentFrameSignature,
    productFrameStatus,
    gcpAccuracyReport,
    poseResidualReport,
    gcpGuides,
    gcpEstimate,
    generateDem,
    generateOrtho,
    generateMesh,
    reconstruct,
    importColmapModel, importInteropModel,
    importCloud,
    editClouds,
    computeDepthMaps,
    densify,
    restore,
    clear,
    clearDerived,
    selectCloud,
    setCloudStyle, setCloudVisible,
    removeCloud,
    renameCloud,
  }
}))
