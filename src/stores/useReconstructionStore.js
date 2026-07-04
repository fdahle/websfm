import { ref, shallowRef, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import {
  reconstruct as workerReconstruct,
  computeDepthMaps as workerComputeDepthMaps,
  densify as workerDensify,
  generateDem as workerGenerateDem,
  generateOrtho as workerGenerateOrtho,
} from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { fitSimilarity } from '../core/georef.js'
import { aerialUpRotation, rotateReconstruction } from '../core/projection.js'
import { cameraCenter } from '../core/geometry.js'
import { qualityToMaxDim } from '../core/mvs.js'
import { distortionOf } from '../core/distortion.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'

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

  // Point clouds produced for this project. Each is an independent layer the user
  // can select in the sidebar and view in the 3D viewer (sparse now; dense later).
  //   { id, name, kind: 'sparse'|'dense', createdAt,
  //     cameras: Map<uuid, { R, t, K }>, points: [{ x, y, z, views, color }] }
  const clouds = ref([])
  const selectedCloudId = ref(null)
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
  const sparseCameras = computed(
    () => clouds.value.find((c) => c.kind === 'sparse')?.cameras ?? new Map(),
  )

  function selectCloud(id) {
    selectedCloudId.value = id
  }

  function removeCloud(id) {
    clouds.value = clouds.value.filter((c) => c.id !== id)
    if (selectedCloudId.value === id)
      selectedCloudId.value = clouds.value[0]?.id ?? null
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

  // Serialise every cloud to the on-disk shape (Maps → entry arrays).
  function serialize() {
    return {
      clouds: clouds.value.map((c) => ({
        id: c.id, name: c.name, kind: c.kind, createdAt: c.createdAt,
        cameras: [...c.cameras.entries()].map(([uuid, cam]) => ({ uuid, ...cam })),
        // Persist view-tracks ([uuid, kpIdx] pairs) so dense MVS can run on a
        // restored project without rebuilding the sparse model. Dense clouds
        // carry no tracks; their points serialize the empty array.
        points: c.points.map(({ x, y, z, color, views }) => ({
          x, y, z, color, views: views ? [...views.entries()] : [],
        })),
      })),
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

  // Insert the freshly-computed sparse model, replacing any existing sparse cloud.
  // A new object (not an in-place mutation) so consumers watching `selectedCloud`
  // by reference re-render after a rebuild.
  function upsertSparseCloud(cameras, points) {
    const idx = clouds.value.findIndex((c) => c.kind === 'sparse')
    const prev = idx >= 0 ? clouds.value[idx] : null
    const cloud = {
      id: prev?.id ?? makeCloudId(),
      name: prev?.name ?? 'Sparse cloud',
      kind: 'sparse',
      createdAt: Date.now(),
      cameras,
      points,
    }
    if (idx >= 0) clouds.value.splice(idx, 1, cloud)
    else clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
  }

  // Insert the fused dense model, replacing any existing dense cloud (carries the
  // previous name/id forward so a rename survives a re-fuse). Dense clouds have no
  // cameras of their own — the viewer renders their points.
  function upsertDenseCloud(points) {
    const idx = clouds.value.findIndex((c) => c.kind === 'dense')
    const prev = idx >= 0 ? clouds.value[idx] : null
    const cloud = {
      id: prev?.id ?? makeCloudId(),
      name: prev?.name ?? 'Dense cloud',
      kind: 'dense',
      createdAt: Date.now(),
      cameras: new Map(),
      points,
    }
    if (idx >= 0) clouds.value.splice(idx, 1, cloud)
    else clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
  }

  // Dense Stage A — Build Depth Maps. Runs PatchMatch MVS in the worker over the
  // sparse cloud's registered cameras, stores the raw depth maps for fusion, and
  // pushes a display depth image into each image (viewer overlay). Needs a sparse
  // cloud whose points carry view-tracks; these are now persisted, so a restored
  // project works without rebuilding (legacy models saved before this still need
  // a Reconstruct re-run).
  async function computeDepthMaps(settings = {}, onProgress) {
    const cloud = clouds.value.find((c) => c.kind === 'sparse')
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
      const inputImages = []
      for (const [uuid, cam] of cloud.cameras) {
        const im = imgByUuid.get(uuid)
        if (!im) continue
        // Lens distortion for this image's sensor — the worker undistorts the raster
        // so depth maps / fusion / DEM / ortho all stay pinhole (matches sparse).
        const s = im.sensorId ? sensorById.get(im.sensorId) : null
        const dist = s ? distortionOf(s) : null
        inputImages.push({
          uuid, name: im.name, url: im.url,
          // Per-image mask (if any) so masked regions are excluded from the dense cloud.
          mask: im.mask?.dataUrl ?? null,
          R: cam.R.map((row) => [...row]),
          t: [...cam.t],
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
          dist,
        })
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
    reconStatus.value = 'running'
    try {
      const { points: flat, summary: dSummary } = await workerDensify(
        { maps, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl) => onProgress?.(d, t, lbl) },
      )
      const pts = []
      for (let i = 0; i < flat.length; i += 6) {
        pts.push({ x: flat[i], y: flat[i+1], z: flat[i+2], color: [flat[i+3], flat[i+4], flat[i+5]] })
      }
      upsertDenseCloud(pts)
      denseSummary.value = dSummary ?? null
      reconStatus.value = 'done'
      await persist()
    } catch (err) {
      log(`Densify error: ${err?.message ?? err}`, 'error', 'Dense')
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

  // True when a georeference can be fit (≥3 pose↔camera correspondences), so the
  // product modals can offer a real-CRS output alongside the local frame.
  const canGeoreference = computed(() => georefPairs().length >= 3)

  // Fit (or refit) the SfM→CRS similarity from camera poses, targeting the current
  // project CRS. Returns the georef record or null.
  function georeference() {
    const pairs = georefPairs()
    if (pairs.length < 3) {
      log('Georeference: need ≥3 camera poses matching registered images', 'warn', 'Products')
      return null
    }
    const fit = fitSimilarity(pairs)
    if (!fit) {
      log('Georeference: fit failed (degenerate pose configuration)', 'warn', 'Products')
      return null
    }
    georef.value = {
      sim: { scale: fit.scale, R: fit.R, t: fit.t },
      crs: projects.currentCrs, rms: fit.rms, count: fit.count, method: 'poses',
    }
    log(`Georeference: ${fit.count} poses → ${projects.currentCrs}, `
      + `scale ${fit.scale.toPrecision(4)}, RMS ${fit.rms.toPrecision(3)}`, 'success', 'Products')
    persist()
    return georef.value
  }

  // Build a DEM from the densest available cloud, in the requested frame
  // (settings.crs: 'local' | 'project'). A new DEM invalidates the old ortho.
  async function generateDem(settings = {}, onProgress) {
    const dense = clouds.value.find((c) => c.kind === 'dense')
    const sparse = clouds.value.find((c) => c.kind === 'sparse')
    const src = dense?.points?.length ? dense : sparse
    if (!src || !src.points.length) {
      log('DEM: build a point cloud first', 'warn', 'Products')
      return
    }
    // Resolve the target frame. 'project' needs a georeference (fit on demand,
    // refit if the CRS changed since); fall back to local if it can't be built.
    let frameSpec = { kind: 'local' }
    if (settings.crs && settings.crs !== 'local') {
      const g = georef.value?.crs === projects.currentCrs ? georef.value : georeference()
      if (g) frameSpec = { kind: 'similarity', ...g.sim, crs: g.crs }
      else log('DEM: no georeference available — using the local frame', 'warn', 'Products')
    }
    reconStatus.value = 'running'
    try {
      // Plain copies: cloud state is reactive (Vue proxies can't be cloned).
      const points = src.points.map((p) => ({ x: p.x, y: p.y, z: p.z }))
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
  // orchestration lives in core/sfm.js; this gathers the plain inputs it needs
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
                }
              : null,
          }
        }),
        pairs: [...matchStore.value.values()]
          .filter((e) => e.status === 'done')
          .map((e) => ({
            idA: e.idA, idB: e.idB,
            // F (3×3) and matches come from reactive store entries; rebuild them
            // as plain arrays or the Vue proxy can't be structured-cloned to the
            // worker ("[object Array] could not be cloned").
            F: e.F ? e.F.map((row) => [...row]) : null,
            matches: e.matches.map((m) => [m[0], m[1]]),
            inlierCount: e.inlierCount, status: 'done',
          })),
        settings,
      }

      const result = await workerReconstruct(input, {
        onLog: (message, level, category) => log(message, level, category),
        onProgress: (done, total, label) => onProgress?.(done, total, label),
      })

      // Apply the model. Point view-tracks come back as [[uuid, kpIdx], …];
      // rebuild them as Maps to match the in-memory shape.
      if (result.status === 'done') {
        let camMap = new Map()
        for (const { uuid, R, t, K } of result.cameras) camMap.set(uuid, { R, t, K })
        let pts = result.points.map(({ x, y, z, views, color }) => ({ x, y, z, views: new Map(views), color }))

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

    clouds.value = raw.map((c) => {
      const map = new Map()
      for (const cam of c.cameras || []) {
        const { uuid, R, t, K } = cam
        map.set(uuid, { R, t, K })
      }
      return {
        id: c.id ?? makeCloudId(),
        name: c.name ?? 'Sparse cloud',
        kind: c.kind ?? 'sparse',
        createdAt: c.createdAt ?? Date.now(),
        cameras: map,
        // Restore view-tracks if persisted (legacy clouds saved none → empty Map).
        points: (c.points || []).map(({ x, y, z, color, views }) => ({
          x, y, z, color, views: new Map(views || []),
        })),
      }
    })
    selectedCloudId.value = clouds.value[0]?.id ?? null
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
    georeference,
    generateDem,
    generateOrtho,
    reconstruct,
    computeDepthMaps,
    densify,
    restore,
    clear,
    selectCloud,
    removeCloud,
    renameCloud,
  }
}))
