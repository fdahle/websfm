// Headless pipeline bench: the real Pinia stores, worker pool and WebGPU matcher,
// driven without the UI. scripts/bench/run-bench.mjs loads this page in Chrome and
// calls window.bench.* in order. Every useLog line is mirrored to the browser console
// as `@@LOG {json}`, so the runner can write it out in the dev console's export format.
//
// Settings resolve exactly as the modals do: the user-facing defaults (plus a preset
// delta if one is named) with the caller's overrides last. A bench must not quietly run
// different settings from the app, or its numbers stop meaning anything.
import { createPinia, setActivePinia } from 'pinia'
import { useLog } from '/src/composables/useLog.js'
import { useProjectsStore } from '/src/stores/useProjectsStore.js'
import { useImagesStore } from '/src/stores/useImagesStore.js'
import { useSensorsStore } from '/src/stores/useSensorsStore.js'
import { useMatchesStore } from '/src/stores/useMatchesStore.js'
import { useReconstructionStore } from '/src/stores/useReconstructionStore.js'
import { usePosesStore } from '/src/stores/usePosesStore.js'
// Every other registered project store, so a reopen restores what the app restores.
import '/src/stores/useExternalStore.js'
import { useFootprintsStore } from '/src/stores/useFootprintsStore.js'
import { parseGeoJson, geoJsonToFootprints, guessNameKey } from '/src/core/io/geojson.js'
import { useGcpsStore } from '/src/stores/useGcpsStore.js'
import '/src/stores/useLogStore.js'
import '/src/stores/useMeasurementsStore.js'
import '/src/stores/useScaleBarsStore.js'
import '/src/stores/useWorkflowsStore.js'
import { restoreProjectStores } from '/src/stores/projectStores.js'
import * as opfs from '/src/utils/opfs.js'
import { useComputeSettings } from '/src/composables/useComputeSettings.js'
import {
  DETECT_DEFAULTS_BY_DETECTOR,
  DETECT_PRESETS_BY_DETECTOR,
  MATCH_DEFAULTS,
  MATCH_PRESETS,
  RECONSTRUCT_DEFAULTS,
  RECONSTRUCT_PRESETS,
  DEPTHMAP_DEFAULTS,
  DENSE_FUSE_DEFAULTS,
  DEM_DEFAULTS,
  ORTHO_DEFAULTS,
  MESH_DEFAULTS,
  DECIMATE_MESH_DEFAULTS,
  TEXTURE_DEFAULTS,
} from '/src/core/defaults.user.js'
import { learnedDetector } from '/src/core/features/learnedDetectors.js'
import { LOD_MIN_POINTS } from '/src/core/lod/build.js'
import { MODEL_CACHE_NAME, modelUrl } from '/src/core/models/registry.js'
import { cameraPositionCheck, gcpCheck } from '/src/core/eval/positionCheck.js'
import { applySimilarity } from '/src/core/products/georef.js'
import { frameFromSpec } from '/src/core/products/frameSpec.js'
import { makeFrameModelResolver, gcpsInPinholeFrame } from '/src/core/sfm/displayFrame.js'
import { triangulateGcp } from '/src/core/sfm/gcpTriangulation.js'
import { encodeSfmInput } from './sfmInputDump.js'
import { demToGeoTiff } from '/src/core/products/exporters.js'
import { crsTagInfo } from '/src/core/products/geotiff.js'
import { emptyFiducialCalibration, calibratedFiducialPairs } from '/src/core/sfm/fiducialModel.js'
import { fitFiducialTransform } from '/src/core/sfm/fiducialCalibration.js'
import { RESEAU_DEFAULTS, PANORAMIC_DEFAULTS } from '/src/core/defaults.user.js'
import { buildBorderMask } from '/src/core/mask.js'
import { FIDUCIAL_SPOT_DEFAULTS, VIDEO_IMPORT_DEFAULTS } from '/src/core/defaults.user.js'
import { analysisTimes, intervalTimes, selectKeyframes } from '/src/core/io/videoFrames.js'
import { openVideoSource, analyzeVideo, extractVideoFrames } from '/src/utils/videoSource.js'

// SfM input capture (config `dumpSfmInput`): the next `reconstruct` op posted to a
// worker is encoded before it is sent (its match buffers are transferred, so they
// are only readable here), then handed to the runner as a download. Node replays it
// through reconstruct() as a real-data golden scene (src/core/sfm/sfmGolden.test.js).
let sfmCaptureArmed = false,
  sfmCapture = null
// The last reconstruction's camera-GPS fit (SfM → local ENU): later stages put their
// points in that frame for the node-side LiDAR comparison (densePointsEnu).
let lastPositionCheck = null
const postMessage = Worker.prototype.postMessage
Worker.prototype.postMessage = function (message, ...rest) {
  if (sfmCaptureArmed && message?.op === 'reconstruct') {
    sfmCaptureArmed = false
    sfmCapture = encodeSfmInput(message.args[0])
  }
  return postMessage.call(this, message, ...rest)
}

setActivePinia(createPinia())
const { onLog, takePending, log } = useLog()
onLog(() => {
  for (const e of takePending()) console.log('@@LOG ' + JSON.stringify(e))
})

const projects = useProjectsStore()
const images = useImagesStore()
const sensorsStore = useSensorsStore() // its watcher groups images into EXIF sensors, as in the app
const matches = useMatchesStore()
const recon = useReconstructionStore()
const poses = usePosesStore()
const gcpsStore = useGcpsStore()

const withPreset = (defaults, presets, preset) => ({ ...defaults, ...(preset ? presets[preset] : {}) })
const report = () => {}
// A local fetch can fail transiently under load; three tries before giving up.
const fetchRetry = async (url, tries = 3) => {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.blob()
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`)
      await new Promise((r) => setTimeout(r, 500 * i))
    }
  }
}
const stem = (n) => n.replace(/.[^.]+$/, '').toLowerCase()
// The sensor-table fields a run's `sensor` override may set, and each sensor's values
// before the first override, so a later run without one starts from the EXIF grouping.
const SENSOR_OVERRIDE_FIELDS = [
  'focal',
  'focalUnit',
  'cx',
  'cy',
  'k1',
  'k2',
  'k3',
  'k4',
  'k5',
  'k6',
  'p1',
  'p2',
  'distortionModel',
]
const sensorBase = {}
let demTiff = null
let reference = null // scripts/bench/reference.mjs: { positions, leverArm, gcps }

// Checkpoints: every reference GCP triangulated from its marks through the app's own
// path (marks → pinhole frame → N-view triangulation), then through the camera-position
// similarity into ENU and compared with its survey. The solve never saw them.
// `offsetPx` shifts every mark (on top of the loader's markOffsetPx) to score another
// pixel convention against the same cameras.
async function checkpoints(cloud, pc, offsetPx = 0) {
  const imgByStem = new Map(images.images.map((i) => [stem(i.name), i]))
  const imagesById = new Map(images.images.map((i) => [i.id, i]))
  const gcps = reference.gcps.map((g) => ({
    ...g,
    id: g.label,
    observations: g.marks
      .map((m) => {
        const im = imgByStem.get(m.image)
        return im ? { imageId: im.id, px: m.px + offsetPx, py: m.py + offsetPx } : null
      })
      .filter(Boolean),
  }))
  const frameModel = makeFrameModelResolver({ summary: recon.summary, sensors: sensorsStore.sensors })
  const inFrame = gcpsInPinholeFrame(gcps, { imagesById, sparseCameras: cloud.cameras, frameModel })
  const tri = []
  for (const g of inFrame) {
    const camerasByImageId = new Map()
    for (const o of g.observations) {
      const cam = cloud.cameras.get(imagesById.get(o.imageId)?.uuid)
      if (cam) camerasByImageId.set(o.imageId, cam)
    }
    const t = await triangulateGcp(g.observations, camerasByImageId)
    const rp = (t?.perViewReprojPx ?? []).map((v) => v.reprojPx).filter((v) => v != null)
    tri.push({
      label: g.label,
      lat: g.lat,
      lon: g.lon,
      h: g.h,
      views: camerasByImageId.size,
      sfm: t ? [t.x, t.y, t.z] : null,
      maxReprojPx: rp.length ? Math.max(...rp) : null,
    })
  }
  // The RMS leaves out reference.excludeGcps (known-bad survey or marks); the rows
  // list every GCP, the excluded ones flagged.
  const excluded = new Set(reference.excludeGcps ?? [])
  const all = gcpCheck(pc, tri)
  const r = gcpCheck(
    pc,
    tri.filter((t) => !excluded.has(String(t.label))),
  )
  const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4)
  return {
    count: r.count,
    of: r.of,
    excluded: [...excluded],
    rmsH: r4(r.rmsH),
    rmsV: r4(r.rmsV),
    meanE: r4(r.meanE),
    meanN: r4(r.meanN),
    meanU: r4(r.meanU),
    rows: all.rows.map(
      (row, i) =>
        `${row.label}${excluded.has(String(row.label)) ? ' (excluded)' : ''}: ${row.dE == null ? 'n/a' : `dE ${row.dE.toFixed(3)} dN ${row.dN.toFixed(3)} dU ${row.dU.toFixed(3)} m`} (${row.views} views, max reproj ${tri[i].maxReprojPx?.toFixed(2) ?? '–'} px)`,
    ),
  }
}

const until = async (pred, ms = 100) => {
  while (!pred()) await new Promise((r) => setTimeout(r, ms))
}

// A learned detector / LightGlue asks for consent before its weights load
// (useModelsStore.ensureReady), and a fresh bench profile has an empty Cache Storage,
// so the run would wait on a dialog nobody sees. Do what the consent does: put the
// served file (public/models/, copied into the frozen build) into the cache under the
// URL the app resolves, so ensureReady finds it and loads it unchanged.
async function provideModels(ids) {
  const cache = await caches.open(MODEL_CACHE_NAME)
  for (const id of ids) {
    const url = modelUrl(id)
    if (await cache.match(url)) continue
    const resp = await fetch(url)
    const type = resp.headers.get('content-type') ?? ''
    if (!resp.ok || type.toLowerCase().includes('text/html'))
      throw new Error(`model ${id}: ${url} is not served — place it in public/models/`)
    await cache.put(url, resp)
  }
}

// Live JS heap after a forced GC (the runner starts Chrome with --expose-gc).
async function liveHeap() {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc()
    await new Promise((r) => setTimeout(r, 200))
    globalThis.gc()
  }
  return performance.memory?.usedJSHeapSize ?? null
}

window.bench = {
  // What the page holds per item, after a GC: the counts that scale the renderer's
  // V8 heap (TODO ▸ MEM). Counts, not estimates — compare with heapBytes. Keypoints and
  // matches load on demand (TODO ▸ SC-2/SC-3): `keypoints`/`matchTuples` are what the
  // project holds, `resident` what is in memory now (LRU caches; pinned = unsaved).
  async inventory() {
    let keypoints = 0,
      kpImages = 0
    for (const i of images.images) {
      const n = i.kpStatus === 'done' ? (i.kpCount ?? 0) : 0
      keypoints += n
      if (n) kpImages++
    }
    let pairs = 0,
      matchTuples = 0
    for (const e of matches.matchStore.values()) {
      pairs++
      matchTuples += e.nMatches ?? 0
    }
    const kc = images.keypointCacheStats(),
      mc = matches.matchCacheStats()
    const resident = {
      keypointImages: kc.entries,
      keypointBytes: kc.bytes,
      keypointPinnedBytes: kc.pinnedBytes,
      matchPairs: mc.entries,
      matchBytes: mc.bytes,
      matchPinnedBytes: mc.pinnedBytes,
    }
    const clouds = recon.clouds.map((c) => ({
      kind: c.kind,
      name: c.name,
      points: c.kind === 'sparse' ? (c.points?.length ?? 0) : (c.count ?? 0),
      posType: c.pos?.constructor?.name ?? null,
      ...(c.texture
        ? {
            texturePages: c.texture.pages.length,
            textureBytes: c.texture.data.byteLength,
            uvs: (c.uv?.length ?? 0) / 2,
          }
        : {}),
    }))
    return {
      images: images.images.length,
      kpImages,
      keypoints,
      pairs,
      matchTuples,
      resident,
      clouds,
      depthMaps: recon.depthMapCount,
      heapBytes: await liveHeap(),
      heapLimit: performance.memory?.jsHeapSizeLimit ?? null,
    }
  },

  currentProject() {
    return projects.currentProjectId
  },
  // The most recently modified project of the profile (named `name`, if given): a kept
  // profile's reopen.
  async latestProject(name = null) {
    await projects.loadIndex()
    return (
      [...projects.projects]
        .filter((p) => !name || p.name === name)
        .sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))[0]?.id ?? null
    )
  },

  // Exclude one accepted pair, then include it again, as the match list's toggle does;
  // lists the project's matches folder after each save, so a run can check that a
  // toggle writes only a new flags file.
  async togglePair() {
    const dir = await opfs.getOpfsProjectDir(projects.currentProjectId)
    const list = async () => {
      const m = await dir.getDirectoryHandle('matches')
      const out = {}
      for await (const [name, h] of m.entries())
        if (h.kind === 'file') {
          const f = await h.getFile()
          out[name] = f.size
        }
      return out
    }
    const settle = async (prev) => {
      for (let t = 0; t < 40; t++) {
        await new Promise((r) => setTimeout(r, 250))
        const now = await list()
        if (JSON.stringify(now) !== JSON.stringify(prev)) {
          await new Promise((r) => setTimeout(r, 1000))
          return list()
        }
      }
      return list()
    }
    const pid = [...matches.matchStore.entries()].find(
      ([, e]) => e.status === 'done' && !e.weak && e.enabled !== false,
    )?.[0]
    if (!pid) throw new Error('togglePair: no accepted pair')
    const before = await list()
    const t0 = performance.now()
    matches.setPairEnabled(pid, false)
    const excluded = await settle(before)
    const excludeMs = performance.now() - t0
    matches.setPairEnabled(pid, true)
    const restored = await settle(excluded)
    const diff = (a, b) => ({
      added: Object.keys(b).filter((k) => !(k in a)),
      removed: Object.keys(a).filter((k) => !(k in b)),
    })
    return {
      pair: pid,
      excludeMs: Math.round(excludeMs),
      before,
      excluded,
      restored,
      onExclude: diff(before, excluded),
      onRestore: diff(excluded, restored),
    }
  },

  // Reopen a project in a FRESH page (the runner reloads first), through the same
  // sequence useProjectLifecycle.openProject runs: switch → sensors → images ∥ stores.
  async reopen(id) {
    // Where a slow reopen waits: the first storage access of the fresh page, the index,
    // the project switch, sensors — before images and the stores start in parallel.
    const tFirst = performance.now()
    const est = await navigator.storage.estimate().catch(() => null)
    const firstAccessMs = performance.now() - tFirst
    const tIdx = performance.now()
    await projects.loadIndex()
    const indexMs = performance.now() - tIdx
    const t0 = performance.now()
    const projectData = await projects.switchProject(id)
    if (!projectData) throw new Error('reopen: project.json missing')
    const switchMs = performance.now() - t0
    await sensorsStore.restoreSensors(id)
    const sensorsMs = performance.now() - t0 - switchMs
    const imagesDone = images
      .restoreImages(projectData.images || [], id, null, { groups: projectData.imageGroups })
      .then(() => performance.now() - t0)
    const storesDone = restoreProjectStores({ projectId: id, projectData })
    const [imagesMs, storeTimings] = await Promise.all([imagesDone, storesDone])
    return {
      seconds: (performance.now() - t0) / 1000,
      imagesSeconds: imagesMs / 1000,
      phases: {
        storageEstimateMs: Math.round(firstAccessMs),
        usageGB: est ? +(est.usage / 1024 ** 3).toFixed(2) : null,
        indexMs: Math.round(indexMs),
        switchMs: Math.round(switchMs),
        sensorsMs: Math.round(sensorsMs),
      },
      stores: Object.fromEntries(storeTimings.map(({ store, ms }) => [store, Math.round(ms)])),
      inventory: await window.bench.inventory(),
    }
  },

  // A Tools ▸ Model ▾ edit of the main sparse model ('optimize' = Optimize cameras,
  // 'sparse' = gradual selection), as the dialog submits it. Reports the focal and the
  // camera-centre fit to the reference / EXIF positions before and after.
  async modelEdit({ mode = 'optimize', settings = {} } = {}) {
    const fit = (cloud) => {
      const positions = reference?.positions
        ? new Map(
            images.images
              .filter((i) => reference.positions[stem(i.name)])
              .map((i) => [i.uuid, reference.positions[stem(i.name)]]),
          )
        : new Map(
            images.images
              .filter(
                (i) =>
                  Number.isFinite(i.meta?.gpsLat) && Number.isFinite(i.meta?.gpsLon) && Number.isFinite(i.meta?.gpsAlt),
              )
              .map((i) => [i.uuid, { lat: i.meta.gpsLat, lon: i.meta.gpsLon, alt: i.meta.gpsAlt }]),
          )
      const pc = cameraPositionCheck(cloud.cameras, positions, { leverArm: reference?.leverArm ?? null })
      return pc && { count: pc.count, rmsH: pc.rmsH, rmsV: pc.rmsV, rms3d: pc.rms3d }
    }
    const before = recon.mainSparseCloud
    if (!before) throw new Error('modelEdit: no sparse model')
    const fx = (c) => [...new Set([...c.cameras.values()].map((cam) => +cam.K.fx.toFixed(2)))]
    const was = { fx: fx(before), points: before.points.length, positions: fit(before) }
    const t0 = performance.now()
    const r = await recon.editClouds({
      mode,
      sourceIds: [before.id],
      settings: { ...settings, createdAt: before.createdAt },
    })
    const after = recon.mainSparseCloud
    return {
      seconds: (performance.now() - t0) / 1000,
      ok: !!r,
      replaced: after !== before,
      before: was,
      after: { fx: fx(after), points: after.points.length, positions: fit(after) },
    }
  },

  // A scale bar between two markers placed on real tie points: the two ≥4-view points
  // nearest opposite corners of the model, marked in every image that saw them (their
  // BA-frame pixels mapped to the click convention as Find GCPs does). The bar is
  // `factor` × their model distance, so the fitted scale is known: `factor`.
  async scaleBar({ factor = 2.5, unit = 'm' } = {}) {
    const { useScaleBarsStore } = await import('/src/stores/useScaleBarsStore.js')
    const { makePinholeToMark } = await import('/src/core/sfm/displayFrame.js')
    const bars = useScaleBarsStore()
    const cloud = recon.mainSparseCloud,
      pts = cloud.points
    const frameModel = makeFrameModelResolver({ summary: recon.summary, sensors: sensorsStore.sensors })
    let lo = -1,
      hi = -1,
      loS = Infinity,
      hiS = -Infinity
    for (let i = 0; i < pts.length; i++) {
      if (pts.pixelCount(i) < 4) continue
      const s = pts.x(i) + pts.y(i) + pts.z(i)
      if (s < loS) {
        loS = s
        lo = i
      }
      if (s > hiS) {
        hiS = s
        hi = i
      }
    }
    if (lo < 0 || hi === lo) throw new Error('scaleBar: no two ≥4-view points')
    const byUuid = new Map(images.images.map((im) => [im.uuid, im]))
    const mark = (i, name) => {
      const id = gcpsStore.addPoint({ role: 'marker', name })
      pts.forEachPixel(i, (uuid, px, py) => {
        const im = byUuid.get(uuid),
          cam = cloud.cameras.get(uuid)
        if (!im || !cam) return
        const { dist, selfCal, fiducial } = frameModel(im)
        const q = makePinholeToMark({ K: cam.K, dist, selfCal, fiducial })(px, py)
        gcpsStore.setObservation(id, im.id, im.name, q.x, q.y)
      })
      return id
    }
    const a = mark(lo, 'Bar end A'),
      b = mark(hi, 'Bar end B')
    const model = Math.hypot(...[0, 1, 2].map((k) => pts.xyz(hi)[k] - pts.xyz(lo)[k]))
    bars.addBar({
      a: { kind: 'marker', id: a },
      b: { kind: 'marker', id: b },
      knownDistance: model * factor,
      unit,
      name: 'Bench bar',
    })
    const fit = await recon.fitScaleBars()
    return {
      modelDistance: model,
      knownDistance: model * factor,
      views: [pts.pixelCount(lo), pts.pixelCount(hi)],
      scale: fit?.scale ?? null,
      fit: fit && { ...fit, bars: undefined },
    }
  },

  // Import ▸ point cloud / mesh with the dialog's defaults, from the file the runner put
  // on #bench-import-file: parsed in the worker (parseCloudFile), committed as
  // onCloudImport does. Samples the page's JS heap during the parse, which must stay
  // far below the file size (the text is read in slices in the worker).
  async importCloudFile() {
    const { parseCloudFile } = await import('/src/workers/computeClient.js')
    const { applyImportTransform } = await import('/src/core/io/cloudImport.js')
    const file = document.getElementById('bench-import-file')?.files?.[0]
    if (!file) throw new Error('importCloudFile: no file on #bench-import-file')
    // A LAS/LAZ too large to hold streams into an octree, and a large COPC file is read in
    // place, as openCloudImport decides.
    const { lasNeedsStreaming } = await import('/src/core/io/lasStream.js')
    const { copcReadsInPlace, COPC_IN_PLACE_MIN_POINTS } = await import('/src/core/lod/copc.js')
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 16)).arrayBuffer())
    if (head.length >= 100 && String.fromCharCode(...head.subarray(0, 4)) === 'LASF') {
      const off = new DataView(head.buffer).getUint32(96, true)
      const full = off > head.length ? new Uint8Array(await file.slice(0, off).arrayBuffer()) : head
      const stream = lasNeedsStreaming(full, file.size) === true
      const copc = copcReadsInPlace(full, { minPoints: stream ? 0 : COPC_IN_PLACE_MIN_POINTS })
      if (stream || copc) {
        const t0 = performance.now()
        const c = await (copc ? recon.importCopcCloud : recon.importStreamedCloud)(file, report)
        return {
          ok: !!c,
          streamed: true,
          copc,
          parseSeconds: (performance.now() - t0) / 1000,
          bytes: file.size,
          count: c?.count ?? 0,
          hasColor: !!c?.lod?.layout?.colour,
          attributes: (c?.lod?.layout?.attributes ?? []).map((a) => a.name),
        }
      }
    }
    let heapPeak = performance.memory?.usedJSHeapSize ?? 0
    const sample = setInterval(() => {
      heapPeak = Math.max(heapPeak, performance.memory?.usedJSHeapSize ?? 0)
    }, 100)
    const t0 = performance.now()
    try {
      const { parsed, stats } = await parseCloudFile(file, { onLog: (m, l, c) => useLog().log(m, l, c) })
      const parseSeconds = (performance.now() - t0) / 1000
      const ok = recon.importCloud(
        applyImportTransform(parsed, { onLog: (m, l, c) => useLog().log(m, l, c) }),
        file.name,
      )
      const c = recon.clouds[recon.clouds.length - 1]
      return {
        ok,
        parseSeconds,
        bytes: file.size,
        heapPeakBytes: heapPeak,
        stats,
        count: c?.count ?? 0,
        nVerts: c?.nVerts ?? null,
        hasColor: !!c?.col,
        attributes: Object.keys(c?.attributes ?? {}),
      }
    } finally {
      clearInterval(sample)
    }
  },

  // Model ▾ ▸ Region: the box spanning the middle `fraction` of the sparse cloud on each
  // axis (the vertical axis whole), as the toolbox's fitted-and-shrunk box. After the
  // dense stage, `regionCheck` counts the dense points outside it.
  setRegion({ fraction = 0.5 } = {}) {
    const p = recon.mainSparseCloud.points,
      lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < p.length; i++)
      for (let k = 0; k < 3; k++) {
        const v = p.pos[3 * i + k]
        if (v < lo[k]) lo[k] = v
        if (v > hi[k]) hi[k] = v
      }
    const min = [0, 1, 2].map((k) => (k === 2 ? lo[k] : lo[k] + ((hi[k] - lo[k]) * (1 - fraction)) / 2))
    const max = [0, 1, 2].map((k) => (k === 2 ? hi[k] : hi[k] - ((hi[k] - lo[k]) * (1 - fraction)) / 2))
    return { ok: recon.setRegion({ min, max }), min, max }
  },
  regionCheck() {
    const r = recon.region,
      d = recon.clouds.find((c) => c.kind === 'dense')
    if (!r || !d) return { error: 'no region or dense cloud' }
    let outside = 0
    for (let i = 0; i < d.count; i++) {
      const x = d.pos[3 * i],
        y = d.pos[3 * i + 1],
        z = d.pos[3 * i + 2]
      if (x < r.min[0] || x > r.max[0] || y < r.min[1] || y > r.max[1] || z < r.min[2] || z > r.max[2]) outside++
    }
    return { points: d.count, outside }
  },

  // The main sparse model's Quality Report numbers (core/eval/sparseStats.js): the
  // reprojection distribution over every stored observation, cameras, points.
  async modelStats() {
    const { sparseModelStats } = await import('/src/core/eval/sparseStats.js')
    const c = recon.mainSparseCloud
    if (!c) throw new Error('modelStats: no sparse model')
    const st = sparseModelStats(c.cameras, c.points)
    return {
      cameras: c.cameras.size,
      points: c.points.length,
      observations: c.points.viewTotal,
      imported: !!c.imported,
      reproj: st.reproj,
    }
  },

  // Open a .websfm (the runner put it on the #bench-project-file input) as a NEW
  // project, the way Project ▸ Open project file does, then restore it as reopen does.
  async openProjectFile() {
    const file = document.getElementById('bench-project-file')?.files?.[0]
    if (!file) throw new Error('openProjectFile: no file on #bench-project-file')
    const t0 = performance.now()
    const id = await projects.importProject(file, { onLog: (m, l, c) => useLog().log(m, l, c) })
    const importSeconds = (performance.now() - t0) / 1000
    return { importSeconds, bytes: file.size, ...(await window.bench.reopen(id)) }
  },

  // Dense Stage A, settings resolved exactly as DepthMapsModal.run() does.
  async depth({ ...overrides } = {}) {
    const { memBudgetBytes } = useComputeSettings()
    const { filterRelTol, maxDim, bestK, ...rest } = { ...DEPTHMAP_DEFAULTS, ...overrides }
    // `memBudgetBytes` in the stage config overrides Settings ▸ Compute (e.g. to exercise
    // the quality step-down); otherwise the app's own budget, as the modal passes it.
    const settings = {
      ...rest,
      filterRelTol: filterRelTol / 100,
      useGpu: overrides.useGpu ?? true,
      memBudgetBytes: overrides.memBudgetBytes ?? memBudgetBytes.value,
    }
    if (maxDim > 0) settings.maxDim = maxDim
    if (bestK > 0) settings.bestK = bestK
    const t0 = performance.now()
    await recon.computeDepthMaps(settings, report)
    return { settings, seconds: (performance.now() - t0) / 1000, depthMaps: recon.depthMapCount }
  },

  // Dense Stage B, settings resolved exactly as DenseModal.run() does.
  async dense({ ...overrides } = {}) {
    const { memBudgetBytes } = useComputeSettings()
    const v = { ...DENSE_FUSE_DEFAULTS, ...overrides }
    const settings = {
      minViews: v.auto ? null : v.minViews,
      maxCost: v.auto ? null : v.maxCost,
      depthTolRel: v.depthTolPct / 100,
      step: v.step,
      minTriAngleDeg: v.minTriAngleDeg,
      maxIncidenceDeg: v.maxIncidenceDeg,
      removeIsolated: v.removeIsolated,
      memBudgetBytes: overrides.memBudgetBytes ?? memBudgetBytes.value,
    }
    const t0 = performance.now()
    await recon.densify(settings, report)
    const dense = recon.clouds.filter((c) => c.kind === 'dense')
    return { settings, seconds: (performance.now() - t0) / 1000, points: dense.reduce((n, c) => n + (c.count ?? 0), 0) }
  },

  // DEM, settings resolved exactly as DemModal.run() does.
  async dem({ ...overrides } = {}) {
    const { memBudgetBytes } = useComputeSettings()
    const { gsd, ...rest } = { ...DEM_DEFAULTS, ...overrides }
    const settings = { ...rest, memBudgetBytes: memBudgetBytes.value, ...(gsd > 0 ? { gsd } : {}) }
    // A dense cloud's octree is built in the background after fusion (cloudLod.js
    // buildMissing), and a cloud too large to copy builds its DEM from it. A user opens
    // Build DEM after that; the bench waits for it the same way (up to an hour).
    const needsLod = () => {
      const c = recon.demSource?.cloud
      return c?.kind === 'dense' && !c.lod && c.count >= LOD_MIN_POINTS
    }
    if (needsLod()) {
      const w0 = performance.now()
      while (needsLod() && performance.now() - w0 < 3600e3) await new Promise((r) => setTimeout(r, 2000))
      log(
        `Bench: waited ${((performance.now() - w0) / 1000).toFixed(0)} s for the dense cloud's octree` +
          (needsLod() ? ' (still missing — the DEM runs without it)' : ''),
        'info',
        'Products',
      )
    }
    const t0 = performance.now()
    await recon.generateDem(settings, report)
    const d = recon.dem
    return {
      settings,
      seconds: (performance.now() - t0) / 1000,
      width: d?.width ?? 0,
      height: d?.height ?? 0,
      gsd: d?.gsd ?? null,
    }
  },

  // Mesh, settings resolved exactly as MeshModal.run() does (source: meshSource).
  async mesh({ ...overrides } = {}) {
    const settings = { ...MESH_DEFAULTS, ...overrides, sourceId: overrides.sourceId ?? recon.meshSource?.id ?? null }
    const t0 = performance.now()
    await recon.generateMesh(settings, report)
    const m = recon.clouds.find((c) => c.kind === 'mesh' && !c.imported && !c.derived)
    return { settings, seconds: (performance.now() - t0) / 1000, triangles: m?.count ?? 0, vertices: m?.nVerts ?? 0 }
  },

  // Decimate the computed mesh (Tools ▸ Mesh ▾ ▸ Decimate), as DecimateMeshModal does.
  async decimate({ ...overrides } = {}) {
    const s = { ...DECIMATE_MESH_DEFAULTS, ...overrides }
    const src = recon.clouds.find((c) => c.kind === 'mesh' && !c.imported && !c.derived)
    const settings =
      s.targetTriangles > 0 && overrides.targetTriangles
        ? { targetTriangles: Math.round(s.targetTriangles), preserveBoundary: !!s.preserveBoundary }
        : { targetRatio: s.targetRatio, preserveBoundary: !!s.preserveBoundary }
    const t0 = performance.now()
    const cloud = await recon.editClouds(
      { mode: 'mesh-decimate', sourceIds: [src?.id], settings, name: `${src?.name} (decimated)` },
      report,
    )
    return { settings, seconds: (performance.now() - t0) / 1000, triangles: cloud?.count ?? 0 }
  },

  // Texture the newest untextured mesh (a decimated copy if there is one), settings
  // resolved as TextureMeshModal.run() does.
  async texture({ ...overrides } = {}) {
    const { useGpu, memBudgetBytes } = useComputeSettings()
    const meshes = recon.clouds.filter((c) => c.kind === 'mesh' && !c.texture)
    const src = meshes[meshes.length - 1]
    const settings = {
      ...TEXTURE_DEFAULTS,
      useGpu: overrides.useGpu ?? useGpu.value,
      memBudgetBytes: memBudgetBytes.value,
      ...overrides,
    }
    const t0 = performance.now()
    const cloud = await recon.textureMesh({ sourceId: src?.id, settings }, report)
    return {
      settings,
      seconds: (performance.now() - t0) / 1000,
      source: src?.name ?? null,
      sourceTriangles: src?.count ?? 0,
      summary: cloud?.textureSummary ?? null,
    }
  },
  // The texture lab's inputs (scripts/bench/textureLab.mjs): the newest untextured mesh
  // and every registered camera with its frame model, as the texture run sees them.
  // → { meta (JSON), mesh bytes (pos f64 | idx u32 | col u8) } via textureDumpChunk.
  async texturedump() {
    const meshes = recon.clouds.filter((c) => c.kind === 'mesh' && !c.texture)
    const m = meshes[meshes.length - 1]
    const frameModel = makeFrameModelResolver({ summary: recon.summary, sensors: sensorsStore.sensors })
    const cams = recon.mainSparseCloud?.cameras ?? new Map()
    const views = []
    for (const im of images.images) {
      const cam = cams.get(im.uuid)
      if (!cam) continue
      const { dist, selfCal, fiducial } = frameModel(im)
      views.push({
        name: im.name,
        R: cam.R,
        t: cam.t,
        K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
        width: im.meta?.width,
        height: im.meta?.height,
        dist,
        selfCal,
        fiducial,
        hasMask: !!im.mask,
      })
    }
    const pos = new Float64Array(m.pos),
      idx = m.idx,
      col = m.col ?? new Uint8Array(0)
    const bytes = new Uint8Array(pos.byteLength + idx.byteLength + col.byteLength)
    bytes.set(new Uint8Array(pos.buffer), 0)
    bytes.set(new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength), pos.byteLength)
    bytes.set(col, pos.byteLength + idx.byteLength)
    window.__textureDump = bytes
    return { meta: { mesh: m.name, nVerts: m.nVerts, triangles: m.count, hasCol: !!m.col, views }, size: bytes.length }
  },
  textureDumpChunk(start, n) {
    const u8 = window.__textureDump.subarray(start, start + n)
    let s = ''
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000))
    return btoa(s)
  },

  // Export the newest textured mesh through the worker's own mesh export (as the Export
  // dialog does) in each format; the runner reads the files back in chunks.
  async meshexport({ formats = ['glb', 'obj'] } = {}) {
    const { exportMeshFile } = await import('/src/workers/computeClient.js')
    const c = [...recon.clouds].reverse().find((x) => x.texture)
    if (!c) return { files: [] }
    window.__benchExports = []
    const files = []
    for (const format of formats) {
      const t0 = performance.now()
      const mesh = {
        nVerts: c.nVerts,
        count: c.count,
        pos: c.pos.slice(),
        idx: c.idx.slice(),
        uv: c.uv.slice(),
        ...(c.col ? { col: c.col.slice() } : {}),
      }
      const texture = {
        data: c.texture.data.slice(),
        pages: c.texture.pages.map((p) => ({ ...p })),
        groups: c.texture.groups.map((g) => ({ ...g })),
      }
      const { blob, ext } = await exportMeshFile({ mesh, format, texture, name: 'textured' })
      window.__benchExports.push(blob)
      files.push({ format, ext, size: blob.size, seconds: (performance.now() - t0) / 1000 })
    }
    return { files }
  },
  async meshexportChunk(i, start, n) {
    const u8 = new Uint8Array(await window.__benchExports[i].slice(start, start + n).arrayBuffer())
    let s = ''
    for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000))
    return btoa(s)
  },
  // The textured mesh's atlas pages (JPEG), base64 in chunks for the runner.
  texturePages() {
    const c = [...recon.clouds].reverse().find((x) => x.texture)
    return c ? c.texture.pages.map((p) => p.length) : []
  },
  texturePageChunk(page, start, n) {
    const c = [...recon.clouds].reverse().find((x) => x.texture)
    const p = c.texture.pages[page]
    const u8 = c.texture.data.subarray(p.offset + start, p.offset + Math.min(p.length, start + n))
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  },

  // Orthophoto, settings resolved exactly as OrthoModal.run() does; returns the
  // ortho's own quality figures (its `stats` run record, core/eval/orthoStats.js).
  async ortho({ ...overrides } = {}) {
    const { memBudgetBytes } = useComputeSettings()
    const { depthTolRel, maxCost, gsd: gsdIn, ...rest } = { ...ORTHO_DEFAULTS, ...overrides }
    // gsd "dem": the built DEM's cell size, so two surfaces can be compared at one GSD.
    const gsd = gsdIn === 'dem' ? (recon.dem?.gsd ?? 0) : gsdIn
    // The modal passes Settings ▸ Compute's budget (it sizes the map/photo cache); a
    // stage `memBudgetBytes` overrides it, as for depth and dense.
    const settings = {
      ...rest,
      memBudgetBytes: overrides.memBudgetBytes ?? memBudgetBytes.value,
      gsd: gsd > 0 ? gsd : 0,
      depthTolRel: depthTolRel / 100,
      maxCost: maxCost > 0 ? maxCost : Infinity,
    }
    const t0 = performance.now()
    await recon.generateOrtho(settings, report)
    const o = recon.ortho
    return {
      settings,
      seconds: (performance.now() - t0) / 1000,
      width: o?.width ?? 0,
      height: o?.height ?? 0,
      gsd: o?.gsd ?? null,
      covered: o?.covered ?? 0,
      sampled: o?.sampled ?? 0,
      filled: o?.filled ?? 0,
      stats: o?.stats ?? null,
      cogBytes: o?.cog?.size ?? 0,
    }
  },
  // The ortho's preview PNG (≤ 2,048 px a side; the ortho itself is its stored COG),
  // base64 in chunks for the runner.
  orthoPngSize() {
    return recon.ortho?.previewBlob?.size ?? 0
  },
  orthoCogSize() {
    return recon.ortho?.cog?.size ?? 0
  },
  async orthoCogChunk(start, n) {
    const u8 = new Uint8Array(await recon.ortho.cog.slice(start, start + n).arrayBuffer())
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  },
  async orthoPngChunk(start, n) {
    const u8 = new Uint8Array(await recon.ortho.previewBlob.slice(start, start + n).arrayBuffer())
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  },

  // One export through the app's own dialog dispatch (useExports, wired from the stores
  // as App.vue wires it). The files arrive as browser downloads; the runner saves them.
  //   kind: 'cloud' | 'mesh' | 'model' | 'colmap' | 'undistorted' | 'tiles3d' | 'dem' | 'ortho'
  //   cloud: 'sparse' | 'dense' | 'mesh' — aim a cloud/mesh export at that cloud
  async exportRun({ kind, settings = {}, cloud = null, cloudName = null }) {
    const { storeToRefs } = await import('pinia')
    const { useExports } = await import('/src/composables/useExports.js')
    const recon = useReconstructionStore(),
      projects = useProjectsStore()
    const { clouds, selectedCloud, mainSparseCloud, dem, ortho, georef, summary } = storeToRefs(recon)
    const { currentProjectName, currentCrs } = storeToRefs(projects)
    const ex = useExports({
      poses: storeToRefs(usePosesStore()).poses,
      sensors: storeToRefs(useSensorsStore()).sensors,
      images: storeToRefs(useImagesStore()).images,
      matchStore: storeToRefs(useMatchesStore()).matchStore,
      clouds,
      selectedCloud,
      mainSparseCloud,
      dem,
      ortho,
      georef,
      currentProjectName,
      currentCrs,
      summary,
      progress: null,
      effectiveFrameSpec: recon.effectiveFrameSpec,
    })
    if (kind === 'project') {
      // Save as .websfm. Without showSaveFilePicker (removed here, as on Firefox and
      // Safari) the archive goes out as a buffered download, which the runner keeps.
      const had = Object.getOwnPropertyDescriptor(window, 'showSaveFilePicker')
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true, writable: true })
      const t0 = performance.now()
      try {
        const r = await projects.exportProject(projects.currentProjectId, {
          includeDerived: settings.includeDerived ?? true,
          onLog: (m, l, c) => useLog().log(m, l, c),
        })
        return { seconds: (performance.now() - t0) / 1000, ...r }
      } finally {
        if (had) Object.defineProperty(window, 'showSaveFilePicker', had)
        else delete window.showSaveFilePicker
      }
    }
    if (kind === 'keypoints' || kind === 'matches') {
      // The sidebar's Keypoints / Matches JSON downloads (exports/tabular.js).
      const t0 = performance.now()
      await (kind === 'keypoints' ? ex.exportKeypoints() : ex.exportMatches())
      return { seconds: (performance.now() - t0) / 1000 }
    }
    const target = cloud
      ? recon.clouds.find((c) => c.kind === cloud && (cloudName ? c.name === cloudName : !c.imported && !c.derived))
      : null
    if (cloud && !target) throw new Error(`exportRun: no ${cloud} cloud`)
    // 3D Tiles writes the selected mesh or cloud: the named one is selected first.
    if (target && kind === 'tiles3d') {
      recon.selectedCloudId = target.id
      ex.exportKind.value = kind
    } else if (target) ex.openCloudExport(target.id)
    else ex.exportKind.value = kind
    const t0 = performance.now()
    await ex.onExportRun(settings)
    return { seconds: (performance.now() - t0) / 1000 }
  },

  // A COLMAP model from the files the runner put on #bench-colmap-files, read as bytes
  // as Import ▸ SfM project does (useSfmInterop): no file is ever one JS string.
  async importColmapFiles() {
    const list = [...(document.getElementById('bench-colmap-files')?.files ?? [])]
    const files = {}
    for (const f of list) files[f.name] = new Uint8Array(await f.arrayBuffer())
    const t0 = performance.now()
    const ok = recon.importColmapModel(files)
    const cloud = recon.mainSparseCloud
    return {
      ok,
      seconds: (performance.now() - t0) / 1000,
      bytes: list.reduce((n, f) => n + f.size, 0),
      cameras: cloud?.cameras?.size ?? 0,
      points: cloud?.points?.length ?? 0,
    }
  },

  // A COLMAP text model as the main sparse cloud, through the app's own import (the
  // runner reads the files): dense then runs on known poses, e.g. ETH3D's ground truth.
  async importColmap({ files }) {
    const t0 = performance.now()
    const ok = recon.importColmapModel(files)
    const cloud = recon.mainSparseCloud
    return {
      ok,
      seconds: (performance.now() - t0) / 1000,
      cameras: cloud?.cameras?.size ?? 0,
      points: cloud?.points?.length ?? 0,
    }
  },

  // The fused dense cloud's positions, `n` points from `start`, as base64 Float32 xyz —
  // the runner pulls it in chunks for a node-side comparison (scripts/bench/eth3d.mjs).
  denseInfo() {
    const c = recon.clouds.find((x) => x.kind === 'dense' && !x.imported)
    return c ? { count: c.count, posType: c.pos.constructor.name } : null
  },
  denseChunk(start, n) {
    const c = recon.clouds.find((x) => x.kind === 'dense' && !x.imported)
    const f = new Float32Array(c.pos.subarray(3 * start, 3 * Math.min(c.count, start + n)))
    const u8 = new Uint8Array(f.buffer)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  },

  // The fused dense cloud in the last reconstruction's positionCheck ENU frame, every
  // `stride`-th point so at most `maxPoints` come back (base64 Float32 e,n,u), for the
  // node-side LiDAR check (scripts/bench/lidar.mjs). Null without a GPS fit.
  densePointsEnu(maxPoints = 1_000_000) {
    const c = recon.clouds.find((x) => x.kind === 'dense' && !x.imported)
    const pc = lastPositionCheck
    if (!c || !pc) return null
    const stride = Math.max(1, Math.ceil(c.count / maxPoints))
    const out = new Float32Array(3 * Math.ceil(c.count / stride))
    let k = 0
    for (let i = 0; i < c.count; i += stride) {
      const q = applySimilarity(pc.sim, [c.pos[3 * i], c.pos[3 * i + 1], c.pos[3 * i + 2]])
      out[k++] = q[0]
      out[k++] = q[1]
      out[k++] = q[2]
    }
    const u8 = new Uint8Array(out.buffer, 0, 4 * k)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return { count: c.count, stride, origin: pc.origin, b64: btoa(s) }
  },

  // A cloud in the project CRS (grid E, N and height, through the products' own frame
  // resolver), every `stride`-th point so at most `maxPoints` come back, as base64
  // Float64 xyz — for scoring points against a truth surface (synthetic blocks).
  // kind: 'sparse' (with each point's view count as a 4th value) | 'dense'.
  async cloudPointsProject({ kind = 'dense', maxPoints = 2_000_000 } = {}) {
    const resolved = await recon.effectiveFrameSpec({ crs: 'project' })
    if (resolved.source !== 'georef') return null
    const frame = frameFromSpec(resolved.frameSpec)
    const sparse = recon.clouds.find((x) => x.kind === 'sparse' && !x.imported)
    const c = kind === 'sparse' ? sparse : recon.clouds.find((x) => x.kind === 'dense' && !x.imported)
    if (!c) return null
    const n = kind === 'sparse' ? c.points.length : c.count
    const stride = Math.max(1, Math.ceil(n / maxPoints))
    const width = kind === 'sparse' ? 4 : 3
    const out = new Float64Array(width * Math.ceil(n / stride))
    let k = 0
    for (let i = 0; i < n; i += stride) {
      const sp = kind === 'sparse' ? c.points : null
      const q = frame.fromSfm(sp ? sp.xyz(i) : [c.pos[3 * i], c.pos[3 * i + 1], c.pos[3 * i + 2]])
      out[k++] = q[0]
      out[k++] = q[1]
      out[k++] = q[2]
      if (sp) out[k++] = sp.viewCount(i)
    }
    const u8 = new Uint8Array(out.buffer, 0, 8 * k)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return { count: n, stride, width, crs: resolved.frameSpec?.crs ?? null, b64: btoa(s) }
  },

  // The reference camera positions as imported poses (WGS84), as a user importing a
  // camera CSV would: preselection uses them; `posePriors` decides whether SfM does.
  async importReferencePoses() {
    const raw = Object.entries(reference?.positions ?? {}).map(([name, p]) => ({
      imageName: name,
      x: p.lon,
      y: p.lat,
      z: p.alt,
      ...(p.se ? { accuracyX: p.se, accuracyY: p.sn, accuracyZ: p.su } : {}),
    }))
    return poses.addPoses(raw, 'EPSG:4326')
  },

  // Historical blocks (config `hist`, scripts/bench/hist/): surveyed GCPs as control
  // (and every `checkEvery`-th as a checkpoint), through the GCP import's own call:
  // gcps = [{ name, x, y, z, accuracyX/Y/Z, role, observations: [{ imageName, px, py }] }]
  // in `crs` (pixel-edge marks, the app's convention).
  async setGcps({ gcps, crs }) {
    const n = await gcpsStore.addGcps(
      gcps,
      crs,
      { x: 0.5, y: 0.5, z: 0.5 },
      { convention: '1sigma', unit: 'metres', rememberDefaults: false },
      { x: 1, y: 1 },
    )
    const all = gcpsStore.gcps
    return {
      added: n,
      total: all.length,
      control: all.filter((g) => g.role === 'control').length,
      check: all.filter((g) => g.role === 'check').length,
      observations: all.reduce((k, g) => k + (g.observations?.length ?? 0), 0),
    }
  },
  // One sensor for the whole block (film scans can differ by a pixel and would split
  // into several), with the certificate's focal (mm) and the scan pitch (mm/px):
  // resolveK's focal-mm + pixelSize path. `fields` go onto the sensor as given.
  setSensor(fields) {
    const [first, ...rest] = sensorsStore.sensors
    if (!first) return null
    for (const s of rest) sensorsStore.mergeSensors(first.id, s.id)
    Object.assign(first, fields)
    // Persist through the store: a bare assignment never reached project storage, so a
    // `reopen` run lost the certificate and reconstructed from a default-FOV guess
    // (found 2026-10-19, SAT-6). Re-setting the unit saves the whole sensor.
    sensorsStore.updateSensor(first.id, 'focalUnit', first.focalUnit === 'mm' ? 'mm' : 'px')
    // A later run's `sensor` override restores to these values, not the EXIF guess.
    sensorBase[first.id] = Object.fromEntries(SENSOR_OVERRIDE_FIELDS.map((k) => [k, first[k]]))
    return {
      sensors: sensorsStore.sensors.length,
      ...Object.fromEntries(Object.keys(fields).map((k) => [k, first[k]])),
    }
  },
  // Tools ▸ Images ▾ ▸ Detect reseau (SAT-5) on the block's one sensor, as the dialog
  // runs it: the crosses of every image, the 'reseau' calibration applied. Film size
  // defaults to the first image × the scan pitch. Returns the per-image numbers and each
  // image's fit (scan px → camera mm) for the runner's truth check.
  async reseau(overrides = {}) {
    const sensor = sensorsStore.sensors[0]
    if (!sensor) return { error: 'no sensor' }
    const img0 = images.images[0],
      pitch = Number(sensor.pixelSize)
    const settings = {
      ...RESEAU_DEFAULTS,
      filmWidthMm: (img0?.meta?.width ?? 0) * pitch,
      filmHeightMm: (img0?.meta?.height ?? 0) * pitch,
      ...overrides,
    }
    const t0 = performance.now()
    const { calibration, perImage } = await images.detectReseauForSensor({ sensor, settings })
    if (calibration) sensorsStore.setFiducialCalibration(sensor.id, calibration)
    const fits = images.images
      .map((img) => {
        const fit = fitFiducialTransform(calibratedFiducialPairs(img, sensor), 'reseau', {
          spacingMm: settings.spacingMm,
        })
        return fit && { name: img.name, forward: fit.forward, residual: fit.residual }
      })
      .filter(Boolean)
    return { seconds: (performance.now() - t0) / 1000, settings, perImage, fits }
  },
  // Tools ▸ Images ▾ ▸ Detect reseau ▸ Half frames (SAT-5): every `<frame>_a` / `_b`
  // pair of the block's sensor stitched into one frame on the film grid, GCP marks
  // carried over, the halves removed — as the dialog runs it. Returns the per-pair
  // numbers and each half's fit for the runner's truth check.
  async reseauHalves(overrides = {}) {
    const sensor = sensorsStore.sensors[0]
    if (!sensor) return { error: 'no sensor' }
    const t0 = performance.now()
    const { pairs } = await images.stitchReseauHalvesForSensor({
      sensor,
      settings: { ...RESEAU_DEFAULTS, ...overrides },
    })
    const fits = pairs.flatMap((p) => p.fits ?? [])
    return {
      seconds: (performance.now() - t0) / 1000,
      images: images.images.map((i) => i.name),
      pairs: pairs.map(({ fits: _f, ...p }) => p),
      fits,
    }
  },
  // Panoramic strips (config stage `panosplit`): every scan of the one sensor cut into
  // frame-camera segments (Tools ▸ Images ▾ ▸ Split panoramic strips).
  async panoramicSplit(overrides = {}) {
    const sensor = sensorsStore.sensors[0]
    if (!sensor) return { error: 'no sensor' }
    const t0 = performance.now()
    const { removeStrips, ...settings } = { ...PANORAMIC_DEFAULTS, ...overrides }
    const { strips } = await images.splitPanoramicForSensor({ sensor, settings, removeStrips })
    return { seconds: (performance.now() - t0) / 1000, images: images.images.length, strips }
  },
  // One static mask for every image (fiducial borders, data strip): a PNG data URL,
  // opaque = excluded, transparent = kept (core/mask.js).
  async setMask(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob()
    for (const img of images.images) images.updateMask(img.id, blob, true)
    return images.images.filter((i) => i.mask).length
  },
  // A GeoJSON polygon file (config `hist.footprints` and other polygon layers), as
  // Import ▸ polygons does: linked to images by the name field when it has one.
  async importPolygons({ text, name }) {
    const parsed = parseGeoJson(text)
    if (parsed.kind !== 'polygons') return { error: `not a polygon file (${parsed.kind})` }
    const fps = geoJsonToFootprints(parsed.features, guessNameKey(parsed.propertyKeys))
    const n = await useFootprintsStore().addFootprints(fps, parsed.sourceCrs, name)
    return { polygons: fps.length, added: n, crs: parsed.sourceCrs }
  },
  // A folder of per-image masks (config `hist.masks`), paired by name through
  // Masks ▸ Import folder: files = [{ url, name }].
  async importMasks({ files, existing }) {
    const t0 = performance.now()
    const objs = []
    for (const f of files) {
      const blob = await fetchRetry(f.url)
      objs.push(new File([blob], f.name, { type: blob.type, lastModified: 0 }))
    }
    const { imported, failed, noSize, plan } = await images.importMaskFiles(objs, existing ? { existing } : {})
    return {
      seconds: (performance.now() - t0) / 1000,
      imported,
      failed,
      noSize,
      unmatched: plan.unmatched.length,
      imagesWithout: plan.imagesWithout,
      masked: images.images.filter((i) => i.mask).length,
    }
  },
  // Film scans (config `hist.fiducials`): the camera certificate on the one sensor and,
  // in mode 'provided', the per-image fiducial marks from the benchmark's CSV;
  // mode 'detect' runs the app's own detector (Detect Fiducials) instead and reports
  // how far its marks land from the provided ones. certificate = { focalMm, ppxMm,
  // ppyMm, marks: [{ id, xMm, yMm, slot }] }; provided = [{ imageName, slot, px, py }].
  // `frameMask` masks the film frame outside the corner fiducials (2 % inside them):
  // a raw scan without it matches its fiducials, frame edge and data strip across
  // every image (Casa Grande raw: 665/666 pairs accepted, 34/37 cameras, GCPs off).
  // In mode 'detect' it is the detector's own generateMasks.
  async setFiducials({ certificate, provided = [], mode = 'provided', positions = 'corners+sides', frameMask = true }) {
    const sensor = sensorsStore.sensors[0]
    if (!sensor) return { error: 'no sensor' }
    const cal = {
      ...emptyFiducialCalibration(certificate.focalMm),
      ppxMm: certificate.ppxMm ?? 0,
      ppyMm: certificate.ppyMm ?? 0,
      marks: certificate.marks.map(({ id, xMm, yMm }) => ({ id, xMm, yMm })),
      slotMap: Object.fromEntries(certificate.marks.map((m) => [m.slot, m.id])),
    }
    sensorsStore.setFiducialCalibration(sensor.id, cal)
    const byName = new Map(images.images.map((i) => [i.name, i]))
    const out = { mode, sensor: sensor.label, marks: cal.marks.length }
    if (mode === 'provided') {
      let n = 0
      for (const d of provided) {
        const img = byName.get(d.imageName)
        if (img) {
          images.setFiducialDetection(img.id, { slot: d.slot, px: d.px, py: d.py, source: 'import' })
          n++
        }
      }
      out.applied = n
      if (frameMask) {
        let masked = 0
        for (const img of images.images) {
          const d = Object.fromEntries(provided.filter((x) => x.imageName === img.name).map((x) => [x.slot, x]))
          const W = img.meta?.width,
            H = img.meta?.height
          if (!(W > 0 && H > 0) || !['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'].every((k) => d[k])) continue
          const m = 0.02 * Math.max(W, H)
          const left = Math.max(d['corner-tl'].px, d['corner-bl'].px) + m,
            right = Math.min(d['corner-tr'].px, d['corner-br'].px) - m
          const top = Math.max(d['corner-tl'].py, d['corner-tr'].py) + m,
            bottom = Math.min(d['corner-bl'].py, d['corner-br'].py) - m
          const blob = await buildBorderMask(W, H, {
            left: Math.round(left),
            top: Math.round(top),
            right: Math.round(W - 1 - right),
            bottom: Math.round(H - 1 - bottom),
          })
          images.updateMask(img.id, blob, true)
          masked++
        }
        out.masked = masked
      }
      return out
    }
    const t0 = performance.now()
    const r = await images.detectFiducialsForSensor({
      sensor,
      settings: { ...FIDUCIAL_SPOT_DEFAULTS, positions, generateMasks: frameMask, overwrite: true },
      overwrite: true,
    })
    out.seconds = (performance.now() - t0) / 1000
    out.applied = r?.applied ?? null
    out.drafts = r?.drafts?.length ?? 0
    out.masked = images.images.filter((i) => i.mask).length
    // Against the provided marks: per-slot distance of the detector's mark (px).
    const ref = new Map(provided.map((d) => [`${d.imageName}|${d.slot}`, d]))
    const dist = [],
      missing = []
    for (const img of images.images) {
      const found = new Set()
      for (const det of img.fiducialDetections ?? []) {
        const q = ref.get(`${img.name}|${det.slot}`)
        if (q) {
          dist.push(Math.hypot(det.px - q.px, det.py - q.py))
          found.add(det.slot)
        }
      }
      for (const d of provided)
        if (d.imageName === img.name && !found.has(d.slot)) missing.push(`${img.name}:${d.slot}`)
    }
    dist.sort((a, b) => a - b)
    const q = (f) => (dist.length ? dist[Math.min(dist.length - 1, Math.floor(f * dist.length))] : null)
    Object.assign(out, {
      matched: dist.length,
      of: provided.length,
      medianPx: q(0.5),
      p90Px: q(0.9),
      maxPx: dist.at(-1) ?? null,
      over5px: dist.filter((v) => v > 5).length,
      missing: missing.length,
      missingSample: missing.slice(0, 8),
    })
    return out
  },

  // Control and checkpoint residuals against the current georeference.
  async gcpReport() {
    if (!recon.validGeoref) await recon.georeference()
    const rows = await recon.gcpAccuracyReport()
    const rms = (rs, f) => (rs.length ? Math.sqrt(rs.reduce((a, r) => a + f(r), 0) / rs.length) : null)
    const ok = rows.filter((r) => r.dx != null)
    const by = (role) => ok.filter((r) => r.role === role)
    const sum = (rs) => ({
      n: rs.length,
      rmsH: rms(rs, (r) => r.dx * r.dx + r.dy * r.dy),
      rmsV: rms(rs, (r) => r.dz * r.dz),
      meanU: rs.length ? rs.reduce((a, r) => a + r.dz, 0) / rs.length : null,
    })
    return {
      georef: recon.validGeoref
        ? {
            method: recon.validGeoref.method,
            count: recon.validGeoref.count,
            rms: recon.validGeoref.rms,
            crs: recon.validGeoref.crs,
          }
        : null,
      control: sum(by('control')),
      check: sum(by('check')),
      untriangulated: rows.filter((r) => r.dx == null).map((r) => r.name),
      rows: ok.map(
        (r) =>
          `${r.name} ${r.role}: dE ${r.dx.toFixed(2)} dN ${r.dy.toFixed(2)} dU ${r.dz.toFixed(2)} m (${r.viewCount} views)`,
      ),
    }
  },
  // The DEM as a GeoTIFF (NaN → -9999), base64 in chunks for the runner. A DEM past one
  // plane (SAT-3) is its stored full-resolution COG (nodata NaN), read a chunk at a time.
  async demTiffSize() {
    if (!recon.dem) return 0
    if (recon.dem.cog) {
      demTiff = recon.dem.cog
      return demTiff.size
    }
    demTiff = await demToGeoTiff(recon.dem, { crs: crsTagInfo(recon.dem), nodata: -9999 })
    return demTiff.byteLength
  },
  async demTiffChunk(start, n) {
    const u8 =
      demTiff instanceof Blob
        ? new Uint8Array(await demTiff.slice(start, start + n).arrayBuffer())
        : demTiff.subarray(start, start + n)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  },

  setReference(r) {
    reference = r
    return { positions: Object.keys(r?.positions ?? {}).length, gcps: r?.gcps?.length ?? 0, leverArm: r?.leverArm }
  },

  // Tools ▸ Align: the computed dense cloud is moved by a known rigid transform, put
  // back by 3 point pairs (the same three points of the moved and the unmoved cloud, as a
  // user would click one feature in each), refined by ICP onto the imported reference,
  // then Distance to reference. Points keep their order through every edit, so the final
  // positions against the unmoved ones measure how well the transform was undone.
  async alignCheck({
    rotateDeg = [2, -1.5, 3],
    translateFrac = [0.05, -0.03, 0.02],
    pickNoiseFrac = 0.005,
    icp = {},
    distance = {},
    sample = 200_000,
  } = {}) {
    const { transformFromEuler, matrixFromTransform, fitPointPairs, rotationAngle } =
      await import('/src/core/products/cloudAlign.js')
    const { ICP_DEFAULTS, DISTANCE_DEFAULTS } = await import('/src/core/defaults.user.js')
    const ref = recon.clouds.find((c) => c.kind === 'dense' && c.imported)
    const src = recon.clouds.find((c) => c.kind === 'dense' && !c.imported && !c.derived)
    if (!ref || !src) throw new Error('alignCheck: needs an imported dense reference and a computed dense cloud')
    const n = src.count,
      P = src.pos
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity],
      c0 = [0, 0, 0]
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) {
        const v = P[i * 3 + k]
        lo[k] = Math.min(lo[k], v)
        hi[k] = Math.max(hi[k], v)
        c0[k] += v / n
      }
    const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    const lines = (from) =>
      useLog()
        .entries.value.slice(from)
        .map((e) => e.message)
    const t0 = performance.now()
    const tf = transformFromEuler({ translate: translateFrac.map((f) => f * diag), rotateDeg, scale: 1, pivot: c0 })
    const moved = await recon.editClouds({
      mode: 'transform',
      sourceIds: [src.id],
      settings: { matrix: matrixFromTransform(tf) },
      name: 'moved',
    })
    // Three well-spread points: the extremes along x and y, and the one farthest from both.
    let ia = 0,
      ib = 0
    for (let i = 0; i < n; i++) {
      if (P[i * 3] < P[ia * 3]) ia = i
      if (P[i * 3] > P[ib * 3]) ib = i
    }
    const d2 = (i, j) =>
      (P[i * 3] - P[j * 3]) ** 2 + (P[i * 3 + 1] - P[j * 3 + 1]) ** 2 + (P[i * 3 + 2] - P[j * 3 + 2]) ** 2
    let ic = 0,
      best = -1
    for (let i = 0; i < n; i += 97) {
      const v = Math.min(d2(i, ia), d2(i, ib))
      if (v > best) {
        best = v
        ic = i
      }
    }
    const at = (c, i) => [c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]]
    // A click lands near the feature, not on it: a fixed offset of pickNoiseFrac × the
    // scene size per pair (alternating signs), so ICP has a real residual to remove.
    const noise = [
      [1, -1, 0.5],
      [-0.5, 1, -1],
      [1, 0.5, 1],
    ].map((v) => v.map((x) => x * pickNoiseFrac * diag))
    const fit = fitPointPairs(
      [ia, ib, ic].map((i, k) => ({ src: at(moved, i), dst: at(src, i).map((v, j) => v + noise[k][j]) })),
      { scale: false },
    )
    const paired = await recon.editClouds({
      mode: 'transform',
      sourceIds: [moved.id],
      settings: { matrix: matrixFromTransform(fit.transform) },
      name: 'paired',
    })
    const nIcp = useLog().entries.value.length
    const icpSettings = { ...ICP_DEFAULTS, ...icp }
    const aligned = await recon.editClouds({
      mode: 'icp',
      sourceIds: [paired.id, ref.id],
      settings: icpSettings,
      name: 'aligned',
    })
    const icpLog = lines(nIcp).filter((m) => m.startsWith('ICP'))
    const nDist = useLog().entries.value.length
    await recon.editClouds({
      mode: 'distance',
      sourceIds: [aligned.id, ref.id],
      settings: { ...DISTANCE_DEFAULTS, ...distance },
      name: 'distance',
    })
    const distLog = lines(nDist).filter((m) => m.startsWith('Distance'))
    // Residual of the whole round trip, per point (sampled).
    const step = Math.max(1, Math.floor(n / sample))
    function d2i(A, B, i) {
      return (A[i * 3] - B[i * 3]) ** 2 + (A[i * 3 + 1] - B[i * 3 + 1]) ** 2 + (A[i * 3 + 2] - B[i * 3 + 2]) ** 2
    }
    const residuals = (A) => {
      const r = []
      for (let i = 0; i < n; i += step) r.push(Math.sqrt(d2i(A, P, i)))
      return r.sort((a, b) => a - b)
    }
    const res = residuals(aligned.pos),
      resPaired = residuals(paired.pos)
    const pairRes = [ia, ib, ic].map((i) => Math.sqrt(d2i(paired.pos, P, i)))
    return {
      seconds: (performance.now() - t0) / 1000,
      srcPoints: n,
      refPoints: ref.count,
      diag,
      perturb: {
        pickNoise: pickNoiseFrac * diag,
        rotateDeg,
        rotationDeg: +((rotationAngle(tf.R) * 180) / Math.PI).toFixed(3),
        translate: translateFrac.map((f) => f * diag),
      },
      pairFit: {
        rms: fit.rms,
        rotationDeg: +((rotationAngle(fit.transform.R) * 180) / Math.PI).toFixed(3),
        residualAtPairs: pairRes,
      },
      afterPairs: { median: resPaired[resPaired.length >> 1], p95: resPaired[Math.floor(resPaired.length * 0.95)] },
      roundTrip: {
        median: res[res.length >> 1],
        p95: res[Math.floor(res.length * 0.95)],
        max: res[res.length - 1],
        relMedian: res[res.length >> 1] / diag,
      },
      icpSettings,
      icpLog,
      distLog,
    }
  },

  // Import ▸ Reference raster of the file on #bench-raster-file, as the import modal
  // does, then the background display conversion (flushPendingWork).
  async importRasterFile() {
    const { useExternalStore } = await import('/src/stores/useExternalStore.js')
    const ext = useExternalStore()
    const file = document.getElementById('bench-raster-file')?.files?.[0]
    if (!file) throw new Error('importRasterFile: no file on #bench-raster-file')
    const t0 = performance.now()
    const rec = await ext.importRaster(file)
    const t1 = performance.now()
    await ext.flushPendingWork()
    const t2 = performance.now()
    const meta = rec && ext.rasterById(rec.id)
    return {
      ok: !!rec,
      bytes: file.size,
      importSeconds: (t1 - t0) / 1000,
      conversionSeconds: (t2 - t1) / 1000,
      raster: meta
        ? {
            id: meta.id,
            name: meta.name,
            kind: meta.kind,
            width: meta.width,
            height: meta.height,
            crs: meta.crs ?? null,
            gpuReady: !!meta.gpuReady,
          }
        : null,
      projectCrs: projects.currentCrs,
    }
  },

  // Sample the (last) reference DEM at points given in the project CRS, as Quality Report
  // and the GCP Z fill do. `residentBefore`: whether its plane was in memory already.
  async rasterSample({ points = [] } = {}) {
    const { useExternalStore } = await import('/src/stores/useExternalStore.js')
    const ext = useExternalStore()
    const meta = ext.demRasters.at(-1)
    if (!meta) throw new Error('rasterSample: no reference DEM')
    const residentBefore = ext.sources.has(meta.id)
    const out = []
    const t0 = performance.now()
    for (const [x, y] of points) {
      const t = performance.now()
      const r = await ext.sampleReferenceDem(x, y, { rasterId: meta.id })
      out.push({
        x,
        y,
        rasterXY: ext.toRasterCoords(meta, x, y),
        z: r?.z ?? null,
        ms: Math.round(performance.now() - t),
      })
    }
    return {
      raster: meta.name,
      crs: meta.crs,
      projectCrs: projects.currentCrs,
      residentBefore,
      seconds: (performance.now() - t0) / 1000,
      samples: out,
    }
  },

  // Restyle the last reference raster with a different stretch (a full re-read).
  async rasterRestyle({ loPct = 5, hiPct = 95 } = {}) {
    const { useExternalStore } = await import('/src/stores/useExternalStore.js')
    const ext = useExternalStore()
    const meta = ext.rasters.at(-1)
    const t0 = performance.now()
    const ok = await ext.setRasterStyle(meta.id, { ...meta.style, loPct, hiPct })
    await ext.flushPendingWork()
    return { ok, seconds: (performance.now() - t0) / 1000 }
  },

  // Tools ▸ Mesh ▾ on the computed mesh, as TOOL-03 runs it: Clean (defaults) →
  // Decimate to 25 % → Smooth 10 → Clean with every hole closed → Area & volume.
  // Each step makes a named copy (export them with `cloudName`).
  async meshTools() {
    const { CLEAN_MESH_DEFAULTS, SMOOTH_MESH_DEFAULTS, DECIMATE_MESH_DEFAULTS } =
      await import('/src/core/defaults.user.js')
    const { meshMeasure } = await import('/src/core/products/meshEdit.js')
    const src = recon.clouds.find((c) => c.kind === 'mesh' && !c.imported && !c.derived)
    if (!src) throw new Error('meshTools: no computed mesh')
    const steps = []
    const run = async (label, mode, from, settings) => {
      const t0 = performance.now()
      const out = await recon.editClouds({ mode, sourceIds: [from.id], settings, name: label }, report)
      steps.push({
        label,
        mode,
        seconds: (performance.now() - t0) / 1000,
        triangles: out?.count ?? 0,
        vertices: out?.nVerts ?? null,
      })
      return out
    }
    const tris = src.count
    const cleaned = await run('TOOL03 cleaned', 'mesh-clean', src, { ...CLEAN_MESH_DEFAULTS })
    const decimated = await run('TOOL03 decimated', 'mesh-decimate', cleaned, {
      targetRatio: DECIMATE_MESH_DEFAULTS.targetRatio,
      preserveBoundary: DECIMATE_MESH_DEFAULTS.preserveBoundary,
    })
    const smoothed = await run('TOOL03 smoothed', 'mesh-smooth', decimated, { ...SMOOTH_MESH_DEFAULTS })
    const closed = await run('TOOL03 closed', 'mesh-clean', cleaned, { ...CLEAN_MESH_DEFAULTS, maxHoleEdges: 0 })
    const t0 = performance.now()
    const m = meshMeasure(closed)
    const measureSeconds = (performance.now() - t0) / 1000
    return {
      source: { name: src.name, triangles: tris, vertices: src.nVerts },
      steps,
      measure: { ...m, seconds: measureSeconds },
    }
  },

  // Georeferencing ▸ Georeference: the SfM → project-CRS similarity from GCPs, else the
  // camera positions (EXIF GNSS / imported poses).
  async georef() {
    const t0 = performance.now()
    const g = await recon.georeference()
    return {
      seconds: (performance.now() - t0) / 1000,
      ok: !!g,
      crs: projects.currentCrs ?? null,
      method: g?.method ?? null,
      count: g?.count ?? 0,
      rms: g?.rms ?? null,
      scale: g?.scale ?? null,
    }
  },

  // Settings ▸ worker count, as the preference applies it: now if the pool is idle,
  // and stored, so a `reopen` after this stage starts with that pool in any case.
  async setPoolSize(n) {
    const c = await import('/src/workers/computeClient.js')
    if (n > 0) localStorage.setItem('websfm.compute.workerCount', String(n))
    else localStorage.removeItem('websfm.compute.workerCount')
    const ok = c.configureWorkerPoolSize(n)
    return { ok, poolSize: c.POOL_SIZE, max: c.MAX_POOL_SIZE }
  },

  async start({ name = 'bench', sceneType = 'object', crs = undefined } = {}) {
    await projects.loadIndex()
    await projects.createProject(name, sceneType, crs)
    return projects.currentProjectId
  },

  // files: [{ url, name }] served by the runner from the dataset folder.
  async addImages(files) {
    const before = images.images.length
    const objs = []
    for (const f of files) {
      const blob = await fetchRetry(f.url)
      objs.push(new File([blob], f.name, { type: blob.type, lastModified: 0 }))
    }
    await images.addImages(objs)
    await until(
      () => images.images.length >= before + objs.length && images.images.every((i) => i.meta || i.previewFailed),
    )
    return images.images.length
  },

  // Config `video`: the frames of one video, planned and extracted exactly as
  // Import ▸ Video does (the dialog's plan, then the importer's extraction), with
  // `settings` over VIDEO_IMPORT_DEFAULTS.
  async addVideo({ url, name, settings = {} }) {
    const blob = await fetchRetry(url)
    const file = new File([blob], name, { type: blob.type, lastModified: 0 })
    const s = { ...VIDEO_IMPORT_DEFAULTS, ...settings }
    const src = await openVideoSource(file)
    const info = { duration: src.duration, width: src.width, height: src.height, fps: src.fps }
    let times,
      plan = null
    const t0 = performance.now()
    try {
      if (s.mode === 'auto') {
        const { step, times: at } = analysisTimes(src.duration, src.fps)
        const samples = await analyzeVideo(src, at)
        const sel = selectKeyframes(samples, s)
        times = sel.times
        plan = {
          samples: samples.length,
          step,
          overlap: sel.overlap,
          blurry: sel.blurry,
          blurryKept: sel.blurryKept,
          gaps: sel.gaps,
          travel: Number(sel.travel.toFixed(3)),
          lost: samples.filter((x) => x.lost).length,
          fast: samples.filter((x) => x.fast).length,
        }
      } else {
        times = intervalTimes(src.duration, { every: s.every, unit: s.unit, fps: src.fps })
      }
    } finally {
      src.close()
    }
    const scanSeconds = (performance.now() - t0) / 1000
    log(
      `Bench video: ${name} ${info.width}×${info.height} ${info.duration.toFixed(1)} s ${info.fps ?? '?'} fps — ` +
        `${times.length} frame(s) planned (${s.mode}) in ${scanSeconds.toFixed(1)} s${plan ? ` ${JSON.stringify(plan)}` : ''}`,
      'info',
      'Import',
    )
    const t1 = performance.now()
    const r = await extractVideoFrames({
      file,
      times,
      duration: info.duration,
      fps: info.fps,
      settings: s,
      addImages: images.addImages,
    })
    await until(() => images.images.every((i) => i.meta || i.previewFailed))
    return {
      images: images.images.length,
      frames: r.added,
      ...info,
      plan,
      scanSeconds,
      extractSeconds: (performance.now() - t1) / 1000,
    }
  },

  async detect({ preset = null, ...overrides } = {}) {
    // Defaults per detector, exactly as DetectFeaturesModal resolves them.
    const detector = overrides.detector ?? 'sift'
    const settings = {
      detector,
      overwrite: true,
      ...withPreset(DETECT_DEFAULTS_BY_DETECTOR[detector], DETECT_PRESETS_BY_DETECTOR[detector], preset),
      memBudgetBytes: useComputeSettings().memBudgetBytes.value,
      ...overrides,
    }
    const spec = learnedDetector(detector)
    if (spec) await provideModels([spec.modelId])
    const t0 = performance.now()
    await images.detectAll(settings, null, report, () => false)
    const done = images.images.filter((i) => i.kpStatus === 'done')
    // Per-image keypoint counts by name, hashed: two runs' detections compare at a glance.
    let h = 2166136261
    for (const s of done.map((i) => `${i.name}:${i.kpCount}`).sort())
      for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    // And their CONTENT: keypoint buffer and descriptor bytes per image, hashed by
    // 32-bit word — equal counts do not mean equal features (determinism, PAR-6).
    const hashWords = (ta) => {
      if (!ta) return null
      const w = new Uint32Array(ta.buffer, ta.byteOffset, ta.byteLength >> 2)
      let x = 2166136261
      for (let i = 0; i < w.length; i++) x = Math.imul(x ^ w[i], 16777619)
      return (x >>> 0).toString(16)
    }
    const featureDigest = {}
    for (const img of done) {
      const kps = await images.readKeypoints(img)
      const desc = await opfs.loadDescriptors(projects.currentProjectId, img.uuid)
      featureDigest[img.name] = `${hashWords(kps?.data)}/${hashWords(desc)}`
    }
    return {
      settings,
      seconds: (performance.now() - t0) / 1000,
      images: done.length,
      keypoints: done.reduce((s, i) => s + (i.kpCount ?? 0), 0),
      kpDigest: h.toString(16),
      kpPerImage: Object.fromEntries(done.map((i) => [i.name, i.kpCount])),
      featureDigest,
    }
  },

  async match({ preset = null, ...overrides } = {}) {
    const settings = {
      strategy: 'exhaustive',
      matcher: 'bruteforce',
      useGpu: true,
      ...withPreset(MATCH_DEFAULTS, MATCH_PRESETS, preset),
      ...overrides,
    }
    if (settings.matcher === 'lightglue') {
      const spec = learnedDetector(images.images.find((i) => i.kpStatus === 'done')?.detector)
      if (spec) await provideModels([spec.matcherModelId])
    }
    const t0 = performance.now()
    await matches.matchAll(images.images, settings, report, () => false)
    let accepted = 0,
      inliers = 0
    // Per pair "status:nMatches:weak", keyed by image NAMES (uuids differ between runs),
    // so two runs on the same detection can be diffed pair by pair (determinism).
    const nameOf = new Map(images.images.map((i) => [i.uuid, i.name]))
    const perPair = {}
    for (const [id, e] of matches.matchStore) {
      if (e.status === 'done' && !e.weak && (e.nMatches ?? 0) > 0) {
        accepted++
        inliers += e.inlierCount ?? e.nMatches
      }
      const key = id
        .split('--')
        .map((u) => nameOf.get(u) ?? u)
        .sort()
        .join('|')
      perPair[key] = `${e.status}:${e.nMatches ?? 0}:${e.weak ? 1 : 0}`
    }
    let h = 2166136261
    for (const k of Object.keys(perPair).sort())
      for (const c of k + perPair[k]) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    return {
      settings,
      seconds: (performance.now() - t0) / 1000,
      pairs: matches.matchStore.size,
      accepted,
      inliers,
      pairDigest: h.toString(16),
      perPair,
    }
  },

  // posePriors: false disables every camera pose (incl. the EXIF GNSS the app imports
  // automatically) for this run, so the solve is pure SfM and positionCheck below is an
  // independent accuracy measurement. The default keeps the app's behaviour.
  // leverArm: true sets the reference GNSS antenna offset on every sensor, so the
  // camera priors are treated as antenna positions (sensor.gnssLeverArm); false clears it.
  // sensor: { focal, cx, cy, k1, …, distortionModel } is assigned to every sensor for
  // this run (sensor-table units: focal + focalUnit, absolute pixel-centre cx/cy, OpenCV
  // p1/p2). A run without it restores the fields to what the EXIF grouping produced.
  armSfmCapture() {
    sfmCaptureArmed = true
    sfmCapture = null
  },
  sfmCaptureBytes() {
    return sfmCapture?.byteLength ?? 0
  },
  // Starts a download of the captured input; the runner saves it. Returns its size.
  downloadSfmCapture(name) {
    if (!sfmCapture) return 0
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([sfmCapture], { type: 'application/octet-stream' }))
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    const n = sfmCapture.byteLength
    sfmCapture = null
    return n
  },

  async reconstruct({
    preset = null,
    posePriors = true,
    leverArm = false,
    sensor = null,
    exportPoints = false,
    ...overrides
  } = {}) {
    const settings = { ...withPreset(RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS, preset), ...overrides }
    for (const p of poses.poses) p.enabled = posePriors
    const arm = leverArm && reference?.leverArm ? [...reference.leverArm] : null
    for (const s of sensorsStore.sensors) s.gnssLeverArm = arm
    for (const s of sensorsStore.sensors) {
      const base = (sensorBase[s.id] ??= Object.fromEntries(SENSOR_OVERRIDE_FIELDS.map((k) => [k, s[k]])))
      Object.assign(s, base, sensor ?? {})
    }
    const priors = poses.poses.filter((p) => p.enabled !== false).length
    const t0 = performance.now()
    await recon.reconstruct(settings, report)
    const cloud = recon.mainSparseCloud
    const points = cloud?.points ?? null
    let ge3 = 0,
      obs = 0
    for (let i = 0; i < (points?.length ?? 0); i++) {
      const n = points.viewCount(i)
      obs += n
      if (n >= 3) ge3++
    }
    const s = recon.summary
    // Independent shape check when the images carry GNSS the solve never used (EXIF;
    // the bench imports no poses, so there are no camera priors): see positionCheck.js.
    // Reference positions (a survey file) win over EXIF when the config supplies them.
    const positions = reference?.positions
      ? new Map(
          images.images
            .filter((i) => reference.positions[stem(i.name)])
            .map((i) => [i.uuid, reference.positions[stem(i.name)]]),
        )
      : new Map(
          images.images
            .filter(
              (i) =>
                Number.isFinite(i.meta?.gpsLat) && Number.isFinite(i.meta?.gpsLon) && Number.isFinite(i.meta?.gpsAlt),
            )
            .map((i) => [i.uuid, { lat: i.meta.gpsLat, lon: i.meta.gpsLon, alt: i.meta.gpsAlt }]),
        )
    const pc = cloud?.cameras
      ? cameraPositionCheck(cloud.cameras, positions, { leverArm: reference?.leverArm ?? null })
      : null
    lastPositionCheck = pc
    const checkpointCheck =
      pc && reference?.gcps ? await checkpoints(cloud, pc).catch((e) => ({ error: String(e?.stack ?? e) })) : null
    const checkpointOffsets = {}
    if (pc && reference?.gcps) {
      for (const off of reference.markOffsetsPx ?? []) {
        const r = await checkpoints(cloud, pc, off).catch((e) => ({ error: String(e?.stack ?? e) }))
        checkpointOffsets[off] = r.error
          ? r
          : { rmsH: r.rmsH, rmsV: r.rmsV, meanE: r.meanE, meanN: r.meanN, meanU: r.meanU }
      }
    }
    // The ≥3-view points in the positionCheck ENU frame, for a node-side comparison
    // with a reference surface (scripts/bench/lidar.mjs); centimetre-rounded.
    const pointsEnu =
      pc && exportPoints
        ? Array.from(
            points.indicesWhere((i) => points.viewCount(i) >= 3),
            (i) => applySimilarity(pc.sim, points.xyz(i)).map((v) => Math.round(v * 100) / 100),
          )
        : null
    const nameOf = new Map(images.images.map((i) => [i.uuid, i.name]))
    const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4)
    // Projects with GCPs (historical blocks): control + checkpoint residuals in the CRS.
    const gcpResiduals =
      gcpsStore.gcps.length && cloud?.cameras?.size
        ? await window.bench.gcpReport().catch((e) => ({ error: String(e?.stack ?? e) }))
        : null
    const positionCheck = pc && {
      count: pc.count,
      scale: r4(pc.scale),
      rms3d: r4(pc.rms3d),
      rmsH: r4(pc.rmsH),
      rmsV: r4(pc.rmsV),
      medianH: r4(pc.medianH),
      p95H: r4(pc.p95H),
      maxH: r4(pc.maxH),
      medianV: r4(pc.medianV),
      p95V: r4(pc.p95V),
      maxV: r4(pc.maxV),
      worst: pc.worst.map((w) => `${nameOf.get(w.uuid) ?? w.uuid} ${w.m.toFixed(3)}m`),
    }
    return {
      settings,
      seconds: (performance.now() - t0) / 1000,
      cameras: cloud?.cameras?.size ?? 0,
      images: images.images.length,
      points: points?.length ?? 0,
      pointsGe3: ge3,
      observations: obs,
      reprojection: s?.reprojection ?? s?.finalReprojection ?? null,
      // BA linear-solver totals + stage wall clock: the PCG-vs-Cholesky comparison
      // (TODO ▸ MEM ▸ PCG) reads these; set recon.baSolver per variant to compare.
      baSolver: s?.baSolver ?? null,
      timings: s?.timings ?? null,
      positionCheck,
      checkpointCheck,
      checkpointOffsets,
      gcpResiduals,
      posePriors: priors,
      leverArm: arm,
      sensor,
      pointsEnu,
      enuOrigin: pc?.origin ?? null,
      // The posed cameras (pinhole frame), so accuracy can be re-analysed without a rerun.
      model: cloud?.cameras
        ? Object.fromEntries([...cloud.cameras].map(([u, c]) => [nameOf.get(u) ?? u, { R: c.R, t: c.t, K: c.K }]))
        : null,
    }
  },
}
document.getElementById('status').textContent = 'ready'
window.benchReady = true
