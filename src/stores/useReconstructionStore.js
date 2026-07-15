import { ref, shallowRef, computed, markRaw } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import {
  reconstruct as workerReconstruct,
  computeDepthMaps as workerComputeDepthMaps,
  densify as workerDensify,
  generateDem as workerGenerateDem,
  generateOrtho as workerGenerateOrtho,
  meshify as workerMeshify,
} from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { fitSimilarity, applySimilarity } from '../core/products/georef.js'
import { aerialUpRotation, rotateReconstruction } from '../core/products/projection.js'
import { cameraCenter } from '../core/sfm/geometry.js'
import { triangulateAllGcps } from '../core/sfm/gcpTriangulation.js'
import { qualityToMaxDim } from '../core/dense/mvs.js'
import { projectDensifyPeakBytes, formatBytes, DEFAULT_BUDGET_BYTES } from '../core/dense/memBudget.js'
import { distortionOf } from '../core/sfm/distortion.js'
import { parseColmapModel, parseColmapModelBin, readColmapModel, makeNameResolver, colmapToSparse } from '../core/io/colmapModel.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useGcpsStore } from './useGcpsStore.js'

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

  // Per-image depth maps from the dense Stage A (Build Depth Maps). Transient,
  // recomputable cache keyed by image uuid — NOT persisted to OPFS (raw float
  // planes are large; recompute from the sparse cloud instead). Stage B (densify)
  // reads these. Each: { uuid, width, height, K, R, t, depth, cost, rgb }.
  // shallowRef so the large typed-array planes (and the rest) stay PLAIN — a
  // reactive Proxy wrapper can't be structured-cloned to the densify worker.
  const depthMaps = shallowRef(new Map())

  // Georeference: a fitted SfM→CRS similarity (scale + rotation + translation),
  // or null in the local frame. { sim:{scale,R,t}, crs, rms, count, method }.
  // Small + useful across sessions, so it persists in reconstruction.json.
  const georef = ref(null)

  // Quality summaries from the last sparse / dense run (Q3). Small, persisted in
  // reconstruction.json so successive runs can be compared across sessions.
  //   summary:      { date, nCameras, nPoints, pct3plusViewTracks, preBaP95px,
  //                   postBaMedianPx, perPairInitReproj }
  //   denseSummary: { costMedian, keptPct, cullBreakdown }
  const summary = ref(null)
  const denseSummary = ref(null)

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
    log(`Main sparse cloud → "${cloud.name}"`, 'info', 'Reconstruction')
    persist()
  }

  function selectCloud(id) {
    selectedCloudId.value = id
  }

  function removeCloud(id) {
    clouds.value = clouds.value.filter((c) => c.id !== id)
    if (selectedCloudId.value === id)
      selectedCloudId.value = clouds.value[0]?.id ?? null
    ensureMainSparse()
    persist()
  }

  // Rename is label-only — every link (selection, persistence, viewer) keys off
  // the cloud's stable `id`, so the name is free to change. A custom name also
  // survives a rebuild (upsertSparseCloud carries the previous name forward).
  function renameCloud(id, name) {
    const cloud = clouds.value.find((c) => c.id === id)
    const trimmed = name.trim()
    if (!cloud || !trimmed || trimmed === cloud.name) return
    cloud.name = trimmed
    persist()
  }

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // Pack one cloud into the on-disk shape: small metadata (cameras stay JSON —
  // ~hundreds at most) plus binary buffers for the heavy per-point data. Colour is
  // whole-cloud (the colouring pass runs over every point), so a single hasColor
  // flag governs the col buffer. View-tracks use a CSR layout: vcount[i] tracks for
  // point i, flattened into vcam/vkp; camera uuids are dictionary-encoded via
  // viewUuids (seeded from the cloud's cameras, extended for any stray uuid).
  // Dense clouds are already flat ({ count, pos:Float32, col:Uint8 }) with no
  // view-tracks, so serialization is near-passthrough. pos is widened to Float64 on
  // disk to match the sparse sidecar format (so the reader stays dtype-uniform and
  // dense clouds persisted before the flat rework still load through this branch).
  function serializeDenseCloud(c) {
    const N = c.count || 0
    const pos = new Float64Array(N * 3)
    pos.set(c.pos.subarray(0, N * 3))
    const col = c.col ? c.col.slice(0, N * 3) : null
    // World-space normals stay Float32 on disk (unit scale — no precision gain from
    // widening). Absent on normal-less/legacy runs; the reader leaves nrm undefined.
    const nrm = c.nrm ? c.nrm.slice(0, N * 3) : null
    return {
      id: c.id, name: c.name, kind: 'dense', createdAt: c.createdAt,
      imported: !!c.imported,
      cameras: [], pointCount: N, hasColor: !!col, hasNormals: !!nrm, viewUuids: [],
      buffers: { pos: pos.buffer, col: col ? col.buffer : null, nrm: nrm ? nrm.buffer : null,
        vcount: null, vcam: null, vkp: null, vx: null, vy: null },
    }
  }

  // Mesh cloud on-disk shape: pos (Float64, per-vertex, uniform sidecar dtype) + col
  // (Uint8, per-vertex) + idx (Uint32, 3·triangles). nVerts + count(=tris) in metadata.
  function serializeMeshCloud(c) {
    const nVerts = c.nVerts || 0
    const pos = new Float64Array(nVerts * 3)
    pos.set(c.pos.subarray(0, nVerts * 3))
    const col = c.col ? c.col.slice(0, nVerts * 3) : null
    const idx = c.idx ? Uint32Array.from(c.idx) : new Uint32Array(0)
    return {
      id: c.id, name: c.name, kind: 'mesh', createdAt: c.createdAt,
      imported: !!c.imported,
      cameras: [], pointCount: nVerts, nVerts, triCount: c.count || 0,
      hasColor: !!col, viewUuids: [],
      buffers: { pos: pos.buffer, col: col ? col.buffer : null, idx: idx.buffer,
        vcount: null, vcam: null, vkp: null, vx: null, vy: null },
    }
  }

  function serializeCloud(c) {
    if (c.kind === 'dense') return serializeDenseCloud(c)
    if (c.kind === 'mesh') return serializeMeshCloud(c)
    const pts = c.points
    const N = pts.length
    const pos = new Float64Array(N * 3)
    const hasColor = pts.some((p) => p.color)
    const col = hasColor ? new Uint8Array(N * 3) : null

    const camIndex = new Map()
    const viewUuids = []
    for (const uuid of c.cameras.keys()) { camIndex.set(uuid, viewUuids.length); viewUuids.push(uuid) }

    const vcount = new Uint32Array(N)
    let totalViews = 0
    for (const p of pts) totalViews += p.views ? p.views.size : 0
    const vcam = new Uint32Array(totalViews)
    const vkp = new Uint32Array(totalViews)
    // Per-view BA-frame pixel (COLMAP export). Only allocated when some point carries
    // it (sparse clouds from a real reconstruct); NaN marks a view without a pixel.
    const hasViewPx = pts.some((p) => p.viewsPx && p.viewsPx.size)
    const vx = hasViewPx ? new Float32Array(totalViews).fill(NaN) : null
    const vy = hasViewPx ? new Float32Array(totalViews).fill(NaN) : null

    let vi = 0
    for (let i = 0; i < N; i++) {
      const p = pts[i]
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z
      if (col && p.color) { col[i * 3] = p.color[0]; col[i * 3 + 1] = p.color[1]; col[i * 3 + 2] = p.color[2] }
      if (p.views && p.views.size) {
        vcount[i] = p.views.size
        for (const [uuid, kp] of p.views) {
          let ci = camIndex.get(uuid)
          if (ci === undefined) { ci = viewUuids.length; camIndex.set(uuid, ci); viewUuids.push(uuid) }
          vcam[vi] = ci; vkp[vi] = kp
          if (vx) { const px = p.viewsPx?.get(uuid); if (px) { vx[vi] = px[0]; vy[vi] = px[1] } }
          vi++
        }
      }
    }
    return {
      id: c.id, name: c.name, kind: c.kind, createdAt: c.createdAt,
      cameras: [...c.cameras.entries()].map(([uuid, cam]) => ({ uuid, ...cam })),
      pointCount: N, hasColor, viewUuids,
      buffers: {
        pos: pos.buffer,
        col: col ? col.buffer : null,
        vcount: vcount.buffer,
        vcam: vcam.buffer,
        vkp: vkp.buffer,
        vx: vx ? vx.buffer : null,
        vy: vy ? vy.buffer : null,
      },
    }
  }

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
      // Run-quality summaries (Q3) — tiny, kept for cross-run comparison.
      summary: summary.value,
      denseSummary: denseSummary.value,
    }
  }

  async function persist() {
    if (!isPersisting()) return
    await opfs.saveReconstruction(projects.currentProjectId, serialize()).catch(() => {})
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
    const { replaceId = mainSparseId.value, asMain = true, name } = opts
    const idx = replaceId
      ? clouds.value.findIndex((c) => c.id === replaceId && c.kind === 'sparse')
      : -1
    const prev = idx >= 0 ? clouds.value[idx] : null
    const cloud = {
      id: prev?.id ?? makeCloudId(),
      name: name ?? prev?.name ?? 'Sparse cloud',
      kind: 'sparse',
      createdAt: Date.now(),
      // markRaw: keep the big point/camera data out of Vue's reactivity (see restore).
      cameras: markRaw(cameras),
      points: markRaw(points),
    }
    if (idx >= 0) clouds.value.splice(idx, 1, cloud)
    else clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
    if (asMain || !mainSparseCloud.value) mainSparseId.value = cloud.id
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
    })
    log(`COLMAP import: added sparse cloud (${cameras.size} cameras, ${points.length} points)`
      + `${mainSparseId.value === selectedCloudId.value ? ' — set as main' : ''}`, 'success', 'Reconstruction')
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
    // Never replace an *imported* cloud — a re-fuse targets the computed one only.
    const idx = clouds.value.findIndex((c) => c.kind === 'dense' && !c.imported)
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
  // (no CRS reprojection). pos is narrowed to Float32 in memory (the DenseCloud/
  // MeshCloud convention — the viewer feeds it straight to Three.js). Returns true
  // on success.
  function importCloud(parsed, fileName = 'file') {
    const isMesh = !!parsed.idx
    const n = isMesh ? (parsed.nVerts ?? 0) : (parsed.count ?? 0)
    if (!n) {
      log(`Cloud import: ${fileName} contained no points`, 'warn', 'Reconstruction')
      return false
    }
    const pos = parsed.pos instanceof Float32Array ? parsed.pos : Float32Array.from(parsed.pos)
    const cloud = {
      id: makeCloudId(),
      name: `Imported (${fileName})`,
      kind: isMesh ? 'mesh' : 'dense',
      createdAt: Date.now(),
      imported: true,
      cameras: markRaw(new Map()),
      pos: markRaw(pos),
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
      // D2: radial k1 the sparse run self-calibrated per sensor (folded into the
      // keypoints there). Add it to that sensor's undistortion so the dense rasters
      // land in the same pinhole frame as the sparse cloud — dense's camera K is the
      // BA-refined K the fold used, so applying k1 here reproduces it. Empty ⇒ no-op.
      const selfCalBySensor = new Map(
        (summary.value?.selfCalDistortion ?? []).map((d) => [d.sensorId, d.k1]))
      // F4: per-image scan→canonical transform from the sparse run. The dense
      // stage reproduces that exact frame (it must NOT re-fit) — the sparse run
      // defines it. Fail loudly if a film image is in the cloud but its transform
      // is missing (a stale/partial summary would silently mis-warp its raster).
      const fidByUuid = new Map(
        (summary.value?.fiducialTransforms ?? []).map((t) => [t.uuid, { A: t.A, frame: t.frame }]))
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
          const nMarks = s.fiducials?.marks?.length || 0
          const nObs = im.fiducialObs?.length || 0
          let why
          if (nMarks < 3) {
            why = `its film sensor has no fiducial marks configured (${nMarks} set, need ≥3) — `
              + `add fiducial marks to the sensor, click them on each image, then re-run the sparse reconstruction`
          } else if (nObs < 3) {
            why = `this image has ${nObs} clicked fiducial observation(s) (need ≥3) — `
              + `mark its fiducials, then re-run the sparse reconstruction`
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
        let dist = s ? distortionOf(s) : null
        const selfK1 = im.sensorId ? (selfCalBySensor.get(im.sensorId) || 0) : 0
        if (selfK1) {
          dist = {
            k1: (dist?.k1 || 0) + selfK1, k2: dist?.k2 || 0, k3: dist?.k3 || 0,
            p1: dist?.p1 || 0, p2: dist?.p2 || 0,
          }
        }
        inputImages.push({
          uuid, name: im.name, url: im.computeUrl ?? im.url,
          // Per-image mask (if any) so masked regions are excluded from the dense cloud.
          mask: im.mask?.dataUrl ?? null,
          R: cam.R.map((row) => [...row]),
          t: [...cam.t],
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
          dist,
          // Film scan→canonical warp (plain data; the frame is already a plain object).
          fid,
        })
      }
      if (selfCalBySensor.size) {
        const parts = [...selfCalBySensor].map(([id, k1]) =>
          `${sensorById.get(id)?.label ?? id.slice(0, 6)} k1 ${k1.toFixed(5)}`)
        log(`Dense: applying self-calibrated distortion from the sparse run — ${parts.join(', ')}`,
          'info', 'Dense')
      }
      const points = cloud.points.map((p) => ({
        x: p.x, y: p.y, z: p.z,
        views: [...p.views.entries()].map(([u, kp]) => [u, kp]),
      }))

      const { maps } = await workerComputeDepthMaps(
        { images: inputImages, points, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl) => onProgress?.(d, t, lbl) },
      )

      depthMaps.value = new Map(maps.map((m) => [m.uuid, m]))
      for (const m of maps) {
        const im = imgByUuid.get(m.uuid)
        if (im && m.displayDataUrl) imagesStore.updateDepth(im.id, m.displayDataUrl)
      }
      log(`Dense: ${maps.length} depth map(s) computed`, 'success', 'Dense')
      reconStatus.value = 'done'
    } catch (err) {
      log(`Depth-map error: ${err?.message ?? err}`, 'error', 'Dense')
      reconStatus.value = 'error'
    }
  }

  // Dense Stage B — fuse the Stage A depth maps into a coloured dense cloud.
  async function densify(settings = {}, onProgress) {
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
    const mapsInput = maps.map((m) => ({
      uuid: m.uuid, width: m.width, height: m.height, K: m.K, R: m.R, t: m.t,
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
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl) => onProgress?.(d, t, lbl), transfer },
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
      // they're detached (dead). Drop the depth-map cache so ortho / re-densify don't
      // read empty buffers — the user must recompute depth maps. Truthful > silent.
      depthMaps.value = new Map()
      log(`Densify error: ${err?.message ?? err}. Depth maps were released to the worker `
        + `and must be recomputed before retrying.`, 'error', 'Dense')
      reconStatus.value = 'error'
    }
  }

  // Mesh — screened Poisson over the main dense cloud (needs its oriented normals).
  // Consumes the dense cloud's pos/col/nrm; the worker round-trips them home so the
  // dense cloud stays usable. Upserts a single kind:'mesh' cloud.
  async function generateMesh(settings = {}, onProgress) {
    const dense = clouds.value.find((c) => c.kind === 'dense')
    if (!dense?.count) { log('Mesh: build a dense point cloud first', 'warn', 'Products'); return }
    if (!dense.nrm || dense.nrm.length < dense.count * 3) {
      log('Mesh: the dense cloud has no per-point normals — re-run Densify to compute them', 'warn', 'Products')
      return
    }
    // Pass the dense merge cell (GSD) so the worker sizes the trim radius + colour grid.
    const mergeCell = denseSummary.value?.mergeCell ?? 0
    // Transfer (not clone) the dense buffers; the worker returns them for re-attach.
    const input = {
      dense: { count: dense.count, pos: dense.pos, col: dense.col || null, nrm: dense.nrm },
      settings: { ...settings, mergeCell },
    }
    const transfer = [dense.pos.buffer]
    if (dense.col) transfer.push(dense.col.buffer)
    transfer.push(dense.nrm.buffer)
    reconStatus.value = 'running'
    try {
      const { mesh, denseHome } = await workerMeshify(input,
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl) => onProgress?.(d, t, lbl), transfer })
      // Re-attach the round-tripped dense buffers (mesh generation is non-destructive).
      if (denseHome) {
        const d = clouds.value.find((c) => c.kind === 'dense')
        if (d) { d.pos = markRaw(denseHome.pos); if (denseHome.col) d.col = markRaw(denseHome.col); if (denseHome.nrm) d.nrm = markRaw(denseHome.nrm) }
      }
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

  // ── Georeferencing + products (DEM / orthophoto) ─────────────────────────────

  // 3D-3D correspondences for the SfM→CRS fit: registered sparse camera centres
  // ↔ imported camera poses (both keyed to images; poses are in the project CRS).
  function georefPairs() {
    const cams = sparseCameras.value
    if (!cams.size) return []
    const imgById = new Map(images.value.map((im) => [im.id, im]))
    const pairs = []
    for (const p of posesStore.poses) {
      if (p.enabled === false || p.imageId == null || p.x == null || p.y == null) continue
      const im = imgById.get(p.imageId)
      if (!im) continue
      const cam = cams.get(im.uuid)
      if (!cam) continue
      pairs.push({ src: cameraCenter(cam), dst: [p.x, p.y, p.z ?? 0] })
    }
    return pairs
  }

  // Maps needed to resolve a GCP observation's imageId → its registered camera:
  // imageId → image (for .uuid), and the sparse cloud's cameras (uuid-keyed).
  function imagesById() {
    return new Map(images.value.map((im) => [im.id, im]))
  }

  // Fit-eligible GCPs: enabled, with ≥2 observations that resolve to a
  // *registered* camera — cheap sync check, no triangulation, used to gate
  // `canGeoreferenceGcps` and to decide whether it's worth triangulating at all.
  function qualifyingGcps() {
    const cams = sparseCameras.value
    if (!cams.size) return []
    const imgById = imagesById()
    return gcpsStore.gcps.filter((g) => {
      if (g.enabled === false) return false
      const nRegistered = (g.observations || []).filter((o) => {
        const uuid = imgById.get(o.imageId)?.uuid
        return uuid != null && cams.has(uuid)
      }).length
      return nRegistered >= 2
    })
  }

  // True when a GCP-based fit is *plausible* (≥3 GCPs each with ≥2 registered
  // observations) — cheap, does not triangulate.
  const canGeoreferenceGcps = computed(() => qualifyingGcps().length >= 3)

  // 3D-3D correspondences for the SfM→CRS fit from GCPs: triangulate each
  // qualifying GCP in the current SfM frame, pair with its surveyed position.
  async function gcpGeorefPairs() {
    const qualifying = qualifyingGcps()
    if (!qualifying.length) return []
    const results = await triangulateAllGcps(qualifying, sparseCameras.value, imagesById())
    return results
      .filter(({ tri }) => tri != null)
      .map(({ gcp, tri }) => ({ src: [tri.x, tri.y, tri.z], dst: [gcp.x, gcp.y, gcp.z ?? 0] }))
  }

  // True when a georeference can be fit (≥3 correspondences from GCPs or poses),
  // so the product modals can offer a real-CRS output alongside the local frame.
  const canGeoreference = computed(() => canGeoreferenceGcps.value || georefPairs().length >= 3)

  // Fit (or refit) the SfM→CRS similarity, targeting the current project CRS.
  // GCPs are the accuracy-defining source and win when ≥3 triangulate; imported
  // camera poses are the fallback. Returns the georef record or null.
  async function georeference() {
    const gcpPairs = await gcpGeorefPairs()
    const usingGcps = gcpPairs.length >= 3
    const pairs = usingGcps ? gcpPairs : georefPairs()
    if (pairs.length < 3) {
      log('Georeference: need ≥3 GCPs or camera poses matching registered images', 'warn', 'Products')
      return null
    }
    const fit = fitSimilarity(pairs)
    if (!fit) {
      log('Georeference: fit failed (degenerate configuration)', 'warn', 'Products')
      return null
    }
    georef.value = {
      sim: { scale: fit.scale, R: fit.R, t: fit.t },
      crs: projects.currentCrs, rms: fit.rms, count: fit.count, method: usingGcps ? 'gcps' : 'poses',
    }
    log(`Georeference: ${fit.count} ${usingGcps ? 'GCPs' : 'poses'} → ${projects.currentCrs}, `
      + `scale ${fit.scale.toPrecision(4)}, RMS ${fit.rms.toPrecision(3)}`, 'success', 'Products')
    persist()
    return georef.value
  }

  // Per-GCP accuracy report against the current georeference: triangulate every
  // enabled GCP, apply the fitted similarity, and diff against its surveyed CRS
  // position — plus the per-observation reprojection residual already computed
  // by triangulateGcp. Pure read against already-fitted state; cheap to recompute
  // on demand (e.g. every time the GCP table is shown or a mark is placed).
  // Returns [{ gcpId, name, viewCount, dx, dy, dz, dTotal, observations }] —
  // entries for untriangulable GCPs still appear with residuals `null`.
  async function gcpAccuracyReport() {
    const sim = georef.value?.sim
    const enabled = gcpsStore.gcps.filter((g) => g.enabled !== false)
    if (!enabled.length) return []
    const results = await triangulateAllGcps(enabled, sparseCameras.value, imagesById())
    return results.map(({ gcp, tri }) => {
      if (!tri) {
        return { gcpId: gcp.id, name: gcp.name, viewCount: 0,
          dx: null, dy: null, dz: null, dTotal: null, observations: [] }
      }
      let dx = null, dy = null, dz = null, dTotal = null
      if (sim && gcp.x != null && gcp.y != null) {
        const p = applySimilarity(sim, [tri.x, tri.y, tri.z])
        dx = p[0] - gcp.x; dy = p[1] - gcp.y; dz = p[2] - (gcp.z ?? 0)
        dTotal = Math.hypot(dx, dy, dz)
      }
      return {
        gcpId: gcp.id, name: gcp.name, viewCount: tri.viewCount,
        dx, dy, dz, dTotal, observations: tri.perViewReprojPx,
      }
    })
  }

  // Build a DEM from the densest available cloud, in the requested frame
  // (settings.crs: 'local' | 'project'). A new DEM invalidates the old ortho.
  async function generateDem(settings = {}, onProgress) {
    const dense = clouds.value.find((c) => c.kind === 'dense')
    const sparse = mainSparseCloud.value
    const src = dense?.count ? dense : sparse
    const srcCount = src ? (src.kind === 'dense' ? src.count : src.points.length) : 0
    if (!src || !srcCount) {
      log('DEM: build a point cloud first', 'warn', 'Products')
      return
    }
    // Resolve the target frame. 'project' needs a georeference (fit on demand,
    // refit if the CRS changed since); fall back to local if it can't be built.
    let frameSpec = { kind: 'local' }
    if (settings.crs && settings.crs !== 'local') {
      const g = georef.value?.crs === projects.currentCrs ? georef.value : await georeference()
      if (g) frameSpec = { kind: 'similarity', ...g.sim, crs: g.crs }
      else log('DEM: no georeference available — using the local frame', 'warn', 'Products')
    }
    reconStatus.value = 'running'
    try {
      // Plain copies: cloud state is reactive (Vue proxies can't be cloned). Dense
      // clouds are flat typed arrays — read xyz straight out (colour isn't needed).
      const points = src.kind === 'dense'
        ? Array.from({ length: src.count }, (_, i) => ({ x: src.pos[i*3], y: src.pos[i*3+1], z: src.pos[i*3+2] }))
        : src.points.map((p) => ({ x: p.x, y: p.y, z: p.z }))
      const cameras = [...(sparse?.cameras ?? new Map()).entries()].map(([uuid, cam]) => ({
        uuid, R: cam.R.map((r) => [...r]), t: [...cam.t], K: { ...cam.K },
      }))
      const grid = await workerGenerateDem(
        { points, cameras, frame: frameSpec, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl) => onProgress?.(d, t, lbl) },
      )
      dem.value = grid
      ortho.value = null // a new DEM invalidates the old ortho
      if (isPersisting()) {
        opfs.saveProduct(projects.currentProjectId, 'dem', grid).catch(() => {})
        opfs.deleteProduct(projects.currentProjectId, 'ortho').catch(() => {})
      }
      reconStatus.value = 'done'
    } catch (err) {
      log(`DEM error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  // Orthorectify the current DEM using the cached depth maps (occlusion via their
  // depth planes, colour from their RGB planes). Needs a DEM + depth maps.
  async function generateOrtho(settings = {}, onProgress) {
    if (!dem.value) { log('Ortho: build a DEM first', 'warn', 'Products'); return }
    const maps = [...depthMaps.value.values()]
    if (!maps.length) { log('Ortho: compute depth maps first', 'warn', 'Products'); return }
    // A failed densify transfers (and loses) the depth buffers; a detached typed
    // array reports byteLength 0. Refuse rather than reproject empty planes.
    if (maps.some((m) => m.depth.byteLength === 0 || m.rgb.byteLength === 0)) {
      depthMaps.value = new Map()
      log('Ortho: depth maps were released by a prior densify — recompute them first', 'warn', 'Products')
      return
    }
    reconStatus.value = 'running'
    try {
      const d = dem.value
      const demPayload = {
        width: d.width, height: d.height, gsd: d.gsd, originX: d.originX, originY: d.originY,
        data: d.data, mask: d.mask, frame: d.frame,
      }
      const mapsPayload = maps.map((m) => ({
        uuid: m.uuid, width: m.width, height: m.height, K: m.K, R: m.R, t: m.t,
        depth: m.depth, cost: m.cost, rgb: m.rgb,
      }))
      const res = await workerGenerateOrtho(
        { dem: demPayload, maps: mapsPayload, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (dn, t, lbl) => onProgress?.(dn, t, lbl) },
      )
      ortho.value = res
      if (isPersisting()) opfs.saveProduct(projects.currentProjectId, 'ortho', res).catch(() => {})
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
    reconStatus.value = 'running'

    try {
      const imgs = images.value.filter((img) => img.kpStatus === 'done')
      const sensorById = new Map(sensors.value.map((s) => [s.id, s]))

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
            // Sensor id lets BA share one focal across images on the same sensor
            // (self-calibration); null → the image is its own intrinsics group.
            sensorId: img.sensorId ?? null,
            keypoints: (img.keypoints || []).map((kp) => ({ x: kp.x, y: kp.y, color: kp.color })),
            // Fiducial-mark observations (F4) — scan-pixel clicks the sfm ingest
            // uses to fit this image's scan→canonical affine. Spread to plain
            // objects (the Vue proxy can't be structured-cloned).
            fiducialObs: (img.fiducialObs || []).map((o) => ({ fidId: o.fidId, px: o.px, py: o.py })),
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
                }
              : null,
          }
        }),
        pairs: [...matchStore.value.values()]
          // Skip pairs the user has excluded (obviously-wrong matches) as well as
          // any still in flight/errored.
          .filter((e) => e.status === 'done' && !e.disabled)
          .map((e) => ({
            idA: e.idA, idB: e.idB,
            // F (3×3) and matches come from reactive store entries; rebuild them
            // as plain arrays or the Vue proxy can't be structured-cloned to the
            // worker ("[object Array] could not be cloned").
            F: e.F ? e.F.map((row) => [...row]) : null,
            matches: e.matches.map((m) => [m[0], m[1]]),
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
          return gcpsStore.gcps
            .filter((g) => g.enabled !== false && g.x != null && g.y != null)
            .map((g) => ({
              x: g.x, y: g.y, z: g.z ?? 0,
              accuracyX: g.accuracyX, accuracyY: g.accuracyY, accuracyZ: g.accuracyZ,
              observations: (g.observations || [])
                .map((o) => ({ uuid: imgById.get(o.imageId)?.uuid, px: o.px, py: o.py }))
                .filter((o) => o.uuid != null),
            }))
        })(),
        settings,
      }

      const result = await workerReconstruct(input, {
        onLog: (message, level, category) => log(message, level, category),
        onProgress: (done, total, label) => onProgress?.(done, total, label),
      })

      // Apply the model. Point view-tracks come back as [[uuid, kpIdx, x, y], …];
      // rebuild `views` (uuid→kpIdx) plus a parallel `viewsPx` (uuid→[x,y]) carrying
      // the BA-frame keypoint pixels (undistorted / canonical / self-cal-folded) —
      // the only pixels coherent with the exported K/R/t (COLMAP export reads them).
      if (result.status === 'done') {
        let camMap = new Map()
        for (const { uuid, R, t, K } of result.cameras) camMap.set(uuid, { R, t, K })
        let pts = result.points.map(({ x, y, z, views, color }) => {
          const v = new Map(), vpx = new Map()
          for (const entry of views) {
            v.set(entry[0], entry[1])
            if (entry.length >= 4) vpx.set(entry[0], [entry[2], entry[3]])
          }
          return { x, y, z, views: v, viewsPx: vpx.size ? vpx : undefined, color }
        })

        // Aerial auto-orient: SfM leaves the model in an arbitrary frame (it can
        // come out upside-down). For aerial surveys the cameras look down, so we
        // rotate the whole model Z-up — cameras above the ground — before storing.
        if (projects.currentSceneType === 'aerial') {
          const R = aerialUpRotation(camMap)
          if (R) {
            const oriented = rotateReconstruction(camMap, pts, R)
            camMap = oriented.cameras
            pts = oriented.points
            log('Oriented model Z-up (aerial: cameras above ground)', 'info', 'Reconstruction')
          }
        }
        upsertSparseCloud(camMap, pts)
        summary.value = result.summary ?? null
        reconStatus.value = 'done'
        await persist()
      } else {
        reconStatus.value = result.status === 'error' ? 'error' : 'idle'
      }
    } catch (err) {
      log(`Reconstruction error: ${err?.message ?? err}`, 'error', 'Reconstruction')
      reconStatus.value = 'error'
    }
  }


  // Reset the in-memory clouds. Pass { purge: true } to also delete the persisted
  // reconstruction.json — do NOT purge on project switch, since restore reads it.
  function clear({ purge = false } = {}) {
    clouds.value = []
    selectedCloudId.value = null
    mainSparseId.value = null
    reconStatus.value = 'idle'
    depthMaps.value = new Map()
    dem.value = null
    ortho.value = null
    georef.value = null
    summary.value = null
    denseSummary.value = null
    if (purge && isPersisting()) {
      opfs.deleteReconstruction(projects.currentProjectId).catch(() => {})
      opfs.deleteProducts(projects.currentProjectId).catch(() => {})
    }
  }

  // Rebuild one cloud from version-2 metadata + binary buffers (inverse of
  // serializeCloud). markRaw: point clouds are large and only ever replaced
  // wholesale, never mutated per-point — deep reactivity freezes render/restore.
  function deserializeCloud(c) {
    const N = c.pointCount ?? 0
    const b = c.buffers || {}
    // Dense clouds restore into the flat { count, pos:Float32, col:Uint8 } shape.
    // On-disk pos is Float64 (uniform sidecar format); narrow it to Float32 in memory.
    if (c.kind === 'dense') {
      const posF = b.pos ? Float32Array.from(new Float64Array(b.pos)) : new Float32Array(0)
      const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
      // Normals stay Float32 on disk; undefined when the run produced none (no heal).
      const nrm = c.hasNormals && b.nrm ? new Float32Array(b.nrm) : null
      return {
        id: c.id ?? makeCloudId(), name: c.name ?? 'Dense cloud', kind: 'dense',
        createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
        ...(c.imported ? { imported: true } : {}),
        count: N, pos: markRaw(posF), col: markRaw(col),
        ...(nrm ? { nrm: markRaw(nrm) } : {}),
      }
    }
    if (c.kind === 'mesh') {
      const nVerts = c.nVerts ?? N
      const posF = b.pos ? Float32Array.from(new Float64Array(b.pos)) : new Float32Array(0)
      const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
      const idx = b.idx ? new Uint32Array(b.idx) : new Uint32Array(0)
      return {
        id: c.id ?? makeCloudId(), name: c.name ?? 'Mesh', kind: 'mesh',
        createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
        ...(c.imported ? { imported: true } : {}),
        count: c.triCount ?? (idx.length / 3), nVerts,
        pos: markRaw(posF), idx: markRaw(idx), col: markRaw(col),
      }
    }
    const pos = b.pos ? new Float64Array(b.pos) : new Float64Array(0)
    const col = c.hasColor && b.col ? new Uint8Array(b.col) : null
    const vcount = b.vcount ? new Uint32Array(b.vcount) : null
    const vcam = b.vcam ? new Uint32Array(b.vcam) : null
    const vkp = b.vkp ? new Uint32Array(b.vkp) : null
    const vx = b.vx ? new Float32Array(b.vx) : null
    const vy = b.vy ? new Float32Array(b.vy) : null
    const viewUuids = c.viewUuids || []

    const cameras = new Map()
    for (const cam of c.cameras || []) { const { uuid, R, t, K } = cam; cameras.set(uuid, { R, t, K }) }

    const points = new Array(N)
    let vi = 0
    for (let i = 0; i < N; i++) {
      const views = new Map()
      let viewsPx
      if (vcount && vcam && vkp) {
        const k = vcount[i]
        for (let j = 0; j < k; j++) {
          const uuid = viewUuids[vcam[vi]]
          views.set(uuid, vkp[vi])
          if (vx && vy && Number.isFinite(vx[vi])) {
            (viewsPx ??= new Map()).set(uuid, [vx[vi], vy[vi]])
          }
          vi++
        }
      }
      points[i] = {
        x: pos[i * 3], y: pos[i * 3 + 1], z: pos[i * 3 + 2],
        color: col ? [col[i * 3], col[i * 3 + 1], col[i * 3 + 2]] : undefined,
        views,
        viewsPx,
      }
    }
    return {
      id: c.id ?? makeCloudId(),
      name: c.name ?? 'Sparse cloud',
      kind: c.kind ?? 'sparse',
      createdAt: c.createdAt ?? Date.now(),
      cameras: markRaw(cameras),
      points: markRaw(points),
    }
  }

  // Legacy inline shape (points embedded in JSON) — kept so a pre-binary project
  // still opens. New projects always write version 2.
  function legacyDeserializeCloud(c) {
    // Legacy dense clouds embedded points as objects; fold them into the flat shape.
    if (c.kind === 'dense') {
      const src = c.points || []
      const n = src.length
      const pos = new Float32Array(n * 3)
      const col = new Uint8Array(n * 3)
      for (let i = 0; i < n; i++) {
        const p = src[i]
        pos[i*3] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z
        const cc = p.color || [200, 200, 200]
        col[i*3] = cc[0]; col[i*3+1] = cc[1]; col[i*3+2] = cc[2]
      }
      return {
        id: c.id ?? makeCloudId(), name: c.name ?? 'Dense cloud', kind: 'dense',
        createdAt: c.createdAt ?? Date.now(), cameras: markRaw(new Map()),
        count: n, pos: markRaw(pos), col: markRaw(col),
      }
    }
    const map = new Map()
    for (const cam of c.cameras || []) { const { uuid, R, t, K } = cam; map.set(uuid, { R, t, K }) }
    return {
      id: c.id ?? makeCloudId(),
      name: c.name ?? 'Sparse cloud',
      kind: c.kind ?? 'sparse',
      createdAt: c.createdAt ?? Date.now(),
      cameras: markRaw(map),
      points: markRaw((c.points || []).map(({ x, y, z, color, views }) => ({
        x, y, z, color, views: new Map(views || []),
      }))),
    }
  }

  async function restore({ projectId }) {
    // Reset first so switching to a project without a saved model doesn't leave
    // the previous project's clouds in memory (loadReconstruction returns null for
    // an empty project and would otherwise no-op).
    clear()
    const data = await opfs.loadReconstruction(projectId)
    if (!data) return

    // New shape: { clouds: [...] }. Legacy shape: a single model
    // { cameras: [...], points: [...] } — wrap it as one sparse cloud.
    const raw = Array.isArray(data.clouds)
      ? data.clouds
      : data.cameras
        ? [{ name: 'Sparse cloud', kind: 'sparse', ...data }]
        : []

    clouds.value = raw.map((c) => (c.buffers ? deserializeCloud(c) : legacyDeserializeCloud(c)))
    selectedCloudId.value = clouds.value[0]?.id ?? null
    mainSparseId.value = data.mainSparseId ?? null
    ensureMainSparse() // legacy docs (no mainSparseId) → first sparse cloud
    georef.value = data.georef ?? null
    summary.value = data.summary ?? null
    denseSummary.value = data.denseSummary ?? null

    // Restore persisted raster products (DEM / ortho), if any.
    const [savedDem, savedOrtho] = await Promise.all([
      opfs.loadProduct(projectId, 'dem'),
      opfs.loadProduct(projectId, 'ortho'),
    ])
    dem.value = savedDem
    ortho.value = savedOrtho
    if (savedDem || savedOrtho) {
      log(`Products restored: ${[savedDem && 'DEM', savedOrtho && 'ortho'].filter(Boolean).join(' + ')}`, 'success', 'Products')
    }

    if (clouds.value.length) {
      const camTotal = clouds.value.reduce((n, c) => n + c.cameras.size, 0)
      log(`Reconstruction restored: ${clouds.value.length} cloud(s), ${camTotal} cameras`, 'success', 'Reconstruction')
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
    georef,
    summary,
    denseSummary,
    dem,
    ortho,
    canGeoreference,
    canGeoreferenceGcps,
    georeference,
    gcpAccuracyReport,
    generateDem,
    generateOrtho,
    generateMesh,
    reconstruct,
    importColmapModel,
    importCloud,
    computeDepthMaps,
    densify,
    restore,
    clear,
    selectCloud,
    removeCloud,
    renameCloud,
  }
}))
