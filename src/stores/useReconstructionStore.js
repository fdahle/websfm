import { ref, shallowRef, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import {
  reconstruct as workerReconstruct,
  computeDepthMaps as workerComputeDepthMaps,
  densify as workerDensify,
} from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useSensorsStore } from './useSensorsStore.js'

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
        points: c.points.map(({ x, y, z, color }) => ({ x, y, z, color })),
      })),
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
  // cloud whose points still carry view-tracks (a freshly-built one — restored
  // clouds drop tracks, so re-run Reconstruct first).
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
      // Rebuild every value as plain arrays/objects: cloud cameras + points are
      // reactive Pinia state, and Vue's Proxy wrappers can't be structured-cloned
      // to the worker ("object can not be cloned").
      const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
      const inputImages = []
      for (const [uuid, cam] of cloud.cameras) {
        const im = imgByUuid.get(uuid)
        if (!im) continue
        inputImages.push({
          uuid, name: im.name, url: im.url,
          // Per-image mask (if any) so masked regions are excluded from the dense cloud.
          mask: im.mask?.dataUrl ?? null,
          R: cam.R.map((row) => [...row]),
          t: [...cam.t],
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
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
      const { points: flat } = await workerDensify(
        { maps, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl) => onProgress?.(d, t, lbl) },
      )
      const pts = []
      for (let i = 0; i < flat.length; i += 6) {
        pts.push({ x: flat[i], y: flat[i+1], z: flat[i+2], color: [flat[i+3], flat[i+4], flat[i+5]] })
      }
      upsertDenseCloud(pts)
      reconStatus.value = 'done'
      await persist()
    } catch (err) {
      log(`Densify error: ${err?.message ?? err}`, 'error', 'Dense')
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
                  cx: s.cx, cy: s.cy, width: s.width, height: s.height,
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
        const camMap = new Map()
        for (const { uuid, R, t, K } of result.cameras) camMap.set(uuid, { R, t, K })
        const pts = result.points.map(({ x, y, z, views, color }) => ({ x, y, z, views: new Map(views), color }))
        upsertSparseCloud(camMap, pts)
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
    if (purge && isPersisting()) {
      opfs.deleteReconstruction(projects.currentProjectId).catch(() => {})
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
        points: (c.points || []).map(({ x, y, z, color }) => ({ x, y, z, views: new Map(), color })),
      }
    })
    selectedCloudId.value = clouds.value[0]?.id ?? null

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
    points3d,
    reconStatus,
    depthMaps,
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
