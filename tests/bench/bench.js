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
import '/src/stores/useFootprintsStore.js'
import { useGcpsStore } from '/src/stores/useGcpsStore.js'
import '/src/stores/useLogStore.js'
import '/src/stores/useMeasurementsStore.js'
import '/src/stores/useScaleBarsStore.js'
import '/src/stores/useWorkflowsStore.js'
import { restoreProjectStores } from '/src/stores/projectStores.js'
import * as opfs from '/src/utils/opfs.js'
import { useComputeSettings } from '/src/composables/useComputeSettings.js'
import {
  DETECT_DEFAULTS_BY_DETECTOR, DETECT_PRESETS_BY_DETECTOR, MATCH_DEFAULTS, MATCH_PRESETS,
  RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS, DEPTHMAP_DEFAULTS, DENSE_FUSE_DEFAULTS,
  DEM_DEFAULTS, ORTHO_DEFAULTS, MESH_DEFAULTS,
} from '/src/core/defaults.user.js'
import { learnedDetector } from '/src/core/features/learnedDetectors.js'
import { MODEL_CACHE_NAME, modelUrl } from '/src/core/models/registry.js'
import { cameraPositionCheck, gcpCheck } from '/src/core/eval/positionCheck.js'
import { applySimilarity } from '/src/core/products/georef.js'
import { frameFromSpec } from '/src/core/products/frameSpec.js'
import { makeFrameModelResolver, gcpsInPinholeFrame } from '/src/core/sfm/displayFrame.js'
import { triangulateGcp } from '/src/core/sfm/gcpTriangulation.js'
import { encodeSfmInput } from './sfmInputDump.js'
import { demToGeoTiff } from '/src/core/products/exporters.js'
import { crsTagInfo } from '/src/core/products/geotiff.js'
import { emptyFiducialCalibration } from '/src/core/sfm/fiducialModel.js'
import { buildBorderMask } from '/src/core/mask.js'
import { FIDUCIAL_SPOT_DEFAULTS } from '/src/core/defaults.user.js'

// SfM input capture (config `dumpSfmInput`): the next `reconstruct` op posted to a
// worker is encoded before it is sent (its match buffers are transferred, so they
// are only readable here), then handed to the runner as a download. Node replays it
// through reconstruct() as a real-data golden scene (src/core/sfm/sfmGolden.test.js).
let sfmCaptureArmed = false, sfmCapture = null
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
const { onLog, takePending } = useLog()
onLog(() => { for (const e of takePending()) console.log('@@LOG ' + JSON.stringify(e)) })

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
    try { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.blob() } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e.message}`)
      await new Promise((r) => setTimeout(r, 500 * i))
    }
  }
}
const stem = (n) => n.replace(/.[^.]+$/, '').toLowerCase()
// The sensor-table fields a run's `sensor` override may set, and each sensor's values
// before the first override, so a later run without one starts from the EXIF grouping.
const SENSOR_OVERRIDE_FIELDS = ['focal', 'focalUnit', 'cx', 'cy', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2', 'distortionModel']
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
  const gcps = reference.gcps.map((g) => ({ ...g, id: g.label,
    observations: g.marks.map((m) => { const im = imgByStem.get(m.image); return im ? { imageId: im.id, px: m.px + offsetPx, py: m.py + offsetPx } : null }).filter(Boolean) }))
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
    tri.push({ label: g.label, lat: g.lat, lon: g.lon, h: g.h, views: camerasByImageId.size,
      sfm: t ? [t.x, t.y, t.z] : null, maxReprojPx: rp.length ? Math.max(...rp) : null })
  }
  // The RMS leaves out reference.excludeGcps (known-bad survey or marks); the rows
  // list every GCP, the excluded ones flagged.
  const excluded = new Set(reference.excludeGcps ?? [])
  const all = gcpCheck(pc, tri)
  const r = gcpCheck(pc, tri.filter((t) => !excluded.has(String(t.label))))
  const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4)
  return { count: r.count, of: r.of, excluded: [...excluded], rmsH: r4(r.rmsH), rmsV: r4(r.rmsV), meanE: r4(r.meanE), meanN: r4(r.meanN), meanU: r4(r.meanU),
    rows: all.rows.map((row, i) => `${row.label}${excluded.has(String(row.label)) ? ' (excluded)' : ''}: ${row.dE == null ? 'n/a' : `dE ${row.dE.toFixed(3)} dN ${row.dN.toFixed(3)} dU ${row.dU.toFixed(3)} m`} (${row.views} views, max reproj ${tri[i].maxReprojPx?.toFixed(2) ?? '–'} px)`) }
}

const until = async (pred, ms = 100) => { while (!pred()) await new Promise((r) => setTimeout(r, ms)) }

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
    if (!resp.ok || type.toLowerCase().includes('text/html')) throw new Error(`model ${id}: ${url} is not served — place it in public/models/`)
    await cache.put(url, resp)
  }
}

// Live JS heap after a forced GC (the runner starts Chrome with --expose-gc).
async function liveHeap() {
  if (typeof globalThis.gc === 'function') { globalThis.gc(); await new Promise((r) => setTimeout(r, 200)); globalThis.gc() }
  return performance.memory?.usedJSHeapSize ?? null
}

window.bench = {
  // What the page holds per item, after a GC: the counts that scale the renderer's
  // V8 heap (TODO ▸ MEM). Counts, not estimates — compare with heapBytes. Keypoints and
  // matches load on demand (TODO ▸ SC-2/SC-3): `keypoints`/`matchTuples` are what the
  // project holds, `resident` what is in memory now (LRU caches; pinned = unsaved).
  async inventory() {
    let keypoints = 0, kpImages = 0
    for (const i of images.images) { const n = i.kpStatus === 'done' ? i.kpCount ?? 0 : 0; keypoints += n; if (n) kpImages++ }
    let pairs = 0, matchTuples = 0
    for (const e of matches.matchStore.values()) { pairs++; matchTuples += e.nMatches ?? 0 }
    const kc = images.keypointCacheStats(), mc = matches.matchCacheStats()
    const resident = {
      keypointImages: kc.entries, keypointBytes: kc.bytes, keypointPinnedBytes: kc.pinnedBytes,
      matchPairs: mc.entries, matchBytes: mc.bytes, matchPinnedBytes: mc.pinnedBytes,
    }
    const clouds = recon.clouds.map((c) => ({ kind: c.kind, name: c.name,
      points: c.kind === 'sparse' ? c.points?.length ?? 0 : c.count ?? 0,
      posType: c.pos?.constructor?.name ?? null }))
    return { images: images.images.length, kpImages, keypoints, pairs, matchTuples, resident, clouds,
      depthMaps: recon.depthMapCount, heapBytes: await liveHeap(), heapLimit: performance.memory?.jsHeapSizeLimit ?? null }
  },

  currentProject() { return projects.currentProjectId },

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
    const imagesDone = images.restoreImages(projectData.images || [], id, null, { groups: projectData.imageGroups })
      .then(() => performance.now() - t0)
    const storesDone = restoreProjectStores({ projectId: id, projectData })
    const [imagesMs, storeTimings] = await Promise.all([imagesDone, storesDone])
    return { seconds: (performance.now() - t0) / 1000, imagesSeconds: imagesMs / 1000,
      phases: { storageEstimateMs: Math.round(firstAccessMs), usageGB: est ? +(est.usage / 1024 ** 3).toFixed(2) : null,
        indexMs: Math.round(indexMs), switchMs: Math.round(switchMs), sensorsMs: Math.round(sensorsMs) },
      stores: Object.fromEntries(storeTimings.map(({ store, ms }) => [store, Math.round(ms)])),
      inventory: await window.bench.inventory() }
  },

  // Dense Stage A, settings resolved exactly as DepthMapsModal.run() does.
  async depth({ ...overrides } = {}) {
    const { memBudgetBytes } = useComputeSettings()
    const { filterRelTol, maxDim, bestK, ...rest } = { ...DEPTHMAP_DEFAULTS, ...overrides }
    // `memBudgetBytes` in the stage config overrides Settings ▸ Compute (e.g. to exercise
    // the quality step-down); otherwise the app's own budget, as the modal passes it.
    const settings = { ...rest, filterRelTol: filterRelTol / 100, useGpu: overrides.useGpu ?? true,
      memBudgetBytes: overrides.memBudgetBytes ?? memBudgetBytes.value }
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
    const settings = { minViews: v.auto ? null : v.minViews, maxCost: v.auto ? null : v.maxCost,
      depthTolRel: v.depthTolPct / 100, step: v.step, minTriAngleDeg: v.minTriAngleDeg,
      maxIncidenceDeg: v.maxIncidenceDeg, removeIsolated: v.removeIsolated, memBudgetBytes: memBudgetBytes.value }
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
    const t0 = performance.now()
    await recon.generateDem(settings, report)
    const d = recon.dem
    return { settings, seconds: (performance.now() - t0) / 1000,
      width: d?.width ?? 0, height: d?.height ?? 0, gsd: d?.gsd ?? null }
  },

  // Mesh, settings resolved exactly as MeshModal.run() does (source: meshSource).
  async mesh({ ...overrides } = {}) {
    const settings = { ...MESH_DEFAULTS, ...overrides, sourceId: overrides.sourceId ?? recon.meshSource?.id ?? null }
    const t0 = performance.now()
    await recon.generateMesh(settings, report)
    const m = recon.clouds.find((c) => c.kind === 'mesh' && !c.imported && !c.derived)
    return { settings, seconds: (performance.now() - t0) / 1000, triangles: m?.count ?? 0, vertices: m?.nVerts ?? 0 }
  },

  // Orthophoto, settings resolved exactly as OrthoModal.run() does; returns the
  // ortho's own quality figures (its `stats` run record, core/eval/orthoStats.js).
  async ortho({ ...overrides } = {}) {
    const { depthTolRel, maxCost, gsd, ...rest } = { ...ORTHO_DEFAULTS, ...overrides }
    const settings = { ...rest, gsd: gsd > 0 ? gsd : 0, depthTolRel: depthTolRel / 100, maxCost: maxCost > 0 ? maxCost : Infinity }
    const t0 = performance.now()
    await recon.generateOrtho(settings, report)
    const o = recon.ortho
    return { settings, seconds: (performance.now() - t0) / 1000,
      width: o?.width ?? 0, height: o?.height ?? 0, gsd: o?.gsd ?? null,
      covered: o?.covered ?? 0, sampled: o?.sampled ?? 0, filled: o?.filled ?? 0, stats: o?.stats ?? null,
      cogBytes: o?.cog?.size ?? 0 }
  },
  // The ortho's preview PNG (≤ 2,048 px a side; the ortho itself is its stored COG),
  // base64 in chunks for the runner.
  orthoPngSize() { return recon.ortho?.previewBlob?.size ?? 0 },
  async orthoPngChunk(start, n) {
    const u8 = new Uint8Array(await recon.ortho.previewBlob.slice(start, start + n).arrayBuffer())
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  },

  // A COLMAP text model as the main sparse cloud, through the app's own import (the
  // runner reads the files): dense then runs on known poses, e.g. ETH3D's ground truth.
  async importColmap({ files }) {
    const t0 = performance.now()
    const ok = recon.importColmapModel(files)
    const cloud = recon.mainSparseCloud
    return { ok, seconds: (performance.now() - t0) / 1000, cameras: cloud?.cameras?.size ?? 0, points: cloud?.points?.length ?? 0 }
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
      out[k++] = q[0]; out[k++] = q[1]; out[k++] = q[2]
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
      const p = kind === 'sparse' ? c.points[i] : null
      const q = frame.fromSfm(p ? [p.x, p.y, p.z] : [c.pos[3 * i], c.pos[3 * i + 1], c.pos[3 * i + 2]])
      out[k++] = q[0]; out[k++] = q[1]; out[k++] = q[2]
      if (p) out[k++] = p.views?.length ?? p.views?.size ?? 0
    }
    const u8 = new Uint8Array(out.buffer, 0, 8 * k)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return { count: n, stride, width, crs: resolved.frameSpec?.crs ?? null, b64: btoa(s) }
  },

  // The reference camera positions as imported poses (WGS84), as a user importing a
  // camera CSV would: preselection uses them; `posePriors` decides whether SfM does.
  async importReferencePoses() {
    const raw = Object.entries(reference?.positions ?? {}).map(([name, p]) => ({ imageName: name, x: p.lon, y: p.lat, z: p.alt,
      ...(p.se ? { accuracyX: p.se, accuracyY: p.sn, accuracyZ: p.su } : {}) }))
    return poses.addPoses(raw, 'EPSG:4326')
  },

  // Historical blocks (config `hist`, scripts/bench/hist/): surveyed GCPs as control
  // (and every `checkEvery`-th as a checkpoint), through the GCP import's own call:
  // gcps = [{ name, x, y, z, accuracyX/Y/Z, role, observations: [{ imageName, px, py }] }]
  // in `crs` (pixel-edge marks, the app's convention).
  async setGcps({ gcps, crs }) {
    const n = await gcpsStore.addGcps(gcps, crs, { x: 0.5, y: 0.5, z: 0.5 }, { convention: '1sigma', unit: 'metres', rememberDefaults: false }, { x: 1, y: 1 })
    const all = gcpsStore.gcps
    return { added: n, total: all.length, control: all.filter((g) => g.role === 'control').length,
      check: all.filter((g) => g.role === 'check').length, observations: all.reduce((k, g) => k + (g.observations?.length ?? 0), 0) }
  },
  // One sensor for the whole block (film scans can differ by a pixel and would split
  // into several), with the certificate's focal (mm) and the scan pitch (mm/px):
  // resolveK's focal-mm + pixelSize path. `fields` go onto the sensor as given.
  setSensor(fields) {
    const [first, ...rest] = sensorsStore.sensors
    if (!first) return null
    for (const s of rest) sensorsStore.mergeSensors(first.id, s.id)
    Object.assign(first, fields)
    // A later run's `sensor` override restores to these values, not the EXIF guess.
    sensorBase[first.id] = Object.fromEntries(SENSOR_OVERRIDE_FIELDS.map((k) => [k, first[k]]))
    return { sensors: sensorsStore.sensors.length, ...Object.fromEntries(Object.keys(fields).map((k) => [k, first[k]])) }
  },
  // One static mask for every image (fiducial borders, data strip): a PNG data URL,
  // opaque = excluded, transparent = kept (core/mask.js).
  async setMask(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob()
    for (const img of images.images) images.updateMask(img.id, blob, true)
    return images.images.filter((i) => i.mask).length
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
    const cal = { ...emptyFiducialCalibration(certificate.focalMm), ppxMm: certificate.ppxMm ?? 0, ppyMm: certificate.ppyMm ?? 0,
      marks: certificate.marks.map(({ id, xMm, yMm }) => ({ id, xMm, yMm })),
      slotMap: Object.fromEntries(certificate.marks.map((m) => [m.slot, m.id])) }
    sensorsStore.setFiducialCalibration(sensor.id, cal)
    const byName = new Map(images.images.map((i) => [i.name, i]))
    const out = { mode, sensor: sensor.label, marks: cal.marks.length }
    if (mode === 'provided') {
      let n = 0
      for (const d of provided) {
        const img = byName.get(d.imageName)
        if (img) { images.setFiducialDetection(img.id, { slot: d.slot, px: d.px, py: d.py, source: 'import' }); n++ }
      }
      out.applied = n
      if (frameMask) {
        let masked = 0
        for (const img of images.images) {
          const d = Object.fromEntries(provided.filter((x) => x.imageName === img.name).map((x) => [x.slot, x]))
          const W = img.meta?.width, H = img.meta?.height
          if (!(W > 0 && H > 0) || !['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'].every((k) => d[k])) continue
          const m = 0.02 * Math.max(W, H)
          const left = Math.max(d['corner-tl'].px, d['corner-bl'].px) + m, right = Math.min(d['corner-tr'].px, d['corner-br'].px) - m
          const top = Math.max(d['corner-tl'].py, d['corner-tr'].py) + m, bottom = Math.min(d['corner-bl'].py, d['corner-br'].py) - m
          const blob = await buildBorderMask(W, H, { left: Math.round(left), top: Math.round(top),
            right: Math.round(W - 1 - right), bottom: Math.round(H - 1 - bottom) })
          images.updateMask(img.id, blob, true)
          masked++
        }
        out.masked = masked
      }
      return out
    }
    const t0 = performance.now()
    const r = await images.detectFiducialsForSensor({ sensor, settings: { ...FIDUCIAL_SPOT_DEFAULTS, positions, generateMasks: frameMask, overwrite: true }, overwrite: true })
    out.seconds = (performance.now() - t0) / 1000
    out.applied = r?.applied ?? null
    out.drafts = r?.drafts?.length ?? 0
    out.masked = images.images.filter((i) => i.mask).length
    // Against the provided marks: per-slot distance of the detector's mark (px).
    const ref = new Map(provided.map((d) => [`${d.imageName}|${d.slot}`, d]))
    const dist = [], missing = []
    for (const img of images.images) {
      const found = new Set()
      for (const det of img.fiducialDetections ?? []) {
        const q = ref.get(`${img.name}|${det.slot}`)
        if (q) { dist.push(Math.hypot(det.px - q.px, det.py - q.py)); found.add(det.slot) }
      }
      for (const d of provided) if (d.imageName === img.name && !found.has(d.slot)) missing.push(`${img.name}:${d.slot}`)
    }
    dist.sort((a, b) => a - b)
    const q = (f) => (dist.length ? dist[Math.min(dist.length - 1, Math.floor(f * dist.length))] : null)
    Object.assign(out, { matched: dist.length, of: provided.length, medianPx: q(0.5), p90Px: q(0.9), maxPx: dist.at(-1) ?? null,
      over5px: dist.filter((v) => v > 5).length, missing: missing.length, missingSample: missing.slice(0, 8) })
    return out
  },

  // Control and checkpoint residuals against the current georeference.
  async gcpReport() {
    if (!recon.validGeoref) await recon.georeference()
    const rows = await recon.gcpAccuracyReport()
    const rms = (rs, f) => (rs.length ? Math.sqrt(rs.reduce((a, r) => a + f(r), 0) / rs.length) : null)
    const ok = rows.filter((r) => r.dx != null)
    const by = (role) => ok.filter((r) => r.role === role)
    const sum = (rs) => ({ n: rs.length, rmsH: rms(rs, (r) => r.dx * r.dx + r.dy * r.dy), rmsV: rms(rs, (r) => r.dz * r.dz),
      meanU: rs.length ? rs.reduce((a, r) => a + r.dz, 0) / rs.length : null })
    return { georef: recon.validGeoref ? { method: recon.validGeoref.method, count: recon.validGeoref.count, rms: recon.validGeoref.rms, crs: recon.validGeoref.crs } : null,
      control: sum(by('control')), check: sum(by('check')), untriangulated: rows.filter((r) => r.dx == null).map((r) => r.name),
      rows: ok.map((r) => `${r.name} ${r.role}: dE ${r.dx.toFixed(2)} dN ${r.dy.toFixed(2)} dU ${r.dz.toFixed(2)} m (${r.viewCount} views)`) }
  },
  // The DEM as a GeoTIFF (NaN → -9999), base64 in chunks for the runner.
  async demTiffSize() {
    if (!recon.dem) return 0
    demTiff = await demToGeoTiff(recon.dem, { crs: crsTagInfo(recon.dem), nodata: -9999 })
    return demTiff.byteLength
  },
  demTiffChunk(start, n) {
    const u8 = demTiff.subarray(start, start + n)
    let s = ''
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    return btoa(s)
  },

  setReference(r) { reference = r; return { positions: Object.keys(r?.positions ?? {}).length, gcps: r?.gcps?.length ?? 0, leverArm: r?.leverArm } },

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
    await until(() => images.images.length >= before + objs.length && images.images.every((i) => i.meta || i.previewFailed))
    return images.images.length
  },

  async detect({ preset = null, ...overrides } = {}) {
    // Defaults per detector, exactly as DetectFeaturesModal resolves them.
    const detector = overrides.detector ?? 'sift'
    const settings = { detector, overwrite: true,
      ...withPreset(DETECT_DEFAULTS_BY_DETECTOR[detector], DETECT_PRESETS_BY_DETECTOR[detector], preset),
      memBudgetBytes: useComputeSettings().memBudgetBytes.value, ...overrides }
    const spec = learnedDetector(detector)
    if (spec) await provideModels([spec.modelId])
    const t0 = performance.now()
    await images.detectAll(settings, null, report, () => false)
    const done = images.images.filter((i) => i.kpStatus === 'done')
    // Per-image keypoint counts by name, hashed: two runs' detections compare at a glance.
    let h = 2166136261
    for (const s of done.map((i) => `${i.name}:${i.kpCount}`).sort()) for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
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
      settings, seconds: (performance.now() - t0) / 1000, images: done.length,
      keypoints: done.reduce((s, i) => s + (i.kpCount ?? 0), 0), kpDigest: h.toString(16),
      kpPerImage: Object.fromEntries(done.map((i) => [i.name, i.kpCount])), featureDigest,
    }
  },

  async match({ preset = null, ...overrides } = {}) {
    const settings = { strategy: 'exhaustive', matcher: 'bruteforce', useGpu: true, ...withPreset(MATCH_DEFAULTS, MATCH_PRESETS, preset), ...overrides }
    if (settings.matcher === 'lightglue') {
      const spec = learnedDetector(images.images.find((i) => i.kpStatus === 'done')?.detector)
      if (spec) await provideModels([spec.matcherModelId])
    }
    const t0 = performance.now()
    await matches.matchAll(images.images, settings, report, () => false)
    let accepted = 0, inliers = 0
    // Per pair "status:nMatches:weak", keyed by image NAMES (uuids differ between runs),
    // so two runs on the same detection can be diffed pair by pair (determinism).
    const nameOf = new Map(images.images.map((i) => [i.uuid, i.name]))
    const perPair = {}
    for (const [id, e] of matches.matchStore) {
      if (e.status === 'done' && !e.weak && (e.nMatches ?? 0) > 0) { accepted++; inliers += e.inlierCount ?? e.nMatches }
      const key = id.split('--').map((u) => nameOf.get(u) ?? u).sort().join('|')
      perPair[key] = `${e.status}:${e.nMatches ?? 0}:${e.weak ? 1 : 0}`
    }
    let h = 2166136261
    for (const k of Object.keys(perPair).sort()) for (const c of k + perPair[k]) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0
    return { settings, seconds: (performance.now() - t0) / 1000, pairs: matches.matchStore.size, accepted, inliers,
      pairDigest: h.toString(16), perPair }
  },

  // posePriors: false disables every camera pose (incl. the EXIF GNSS the app imports
  // automatically) for this run, so the solve is pure SfM and positionCheck below is an
  // independent accuracy measurement. The default keeps the app's behaviour.
  // leverArm: true sets the reference GNSS antenna offset on every sensor, so the
  // camera priors are treated as antenna positions (sensor.gnssLeverArm); false clears it.
  // sensor: { focal, cx, cy, k1, …, distortionModel } is assigned to every sensor for
  // this run (sensor-table units: focal + focalUnit, absolute pixel-centre cx/cy, OpenCV
  // p1/p2). A run without it restores the fields to what the EXIF grouping produced.
  armSfmCapture() { sfmCaptureArmed = true; sfmCapture = null },
  sfmCaptureBytes() { return sfmCapture?.byteLength ?? 0 },
  // Starts a download of the captured input; the runner saves it. Returns its size.
  downloadSfmCapture(name) {
    if (!sfmCapture) return 0
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([sfmCapture], { type: 'application/octet-stream' }))
    a.download = name
    document.body.appendChild(a); a.click(); a.remove()
    const n = sfmCapture.byteLength
    sfmCapture = null
    return n
  },

  async reconstruct({ preset = null, posePriors = true, leverArm = false, sensor = null, exportPoints = false, ...overrides } = {}) {
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
    const points = cloud?.points ?? []
    let ge3 = 0, obs = 0
    for (const p of points) { const n = p.views?.size ?? 0; obs += n; if (n >= 3) ge3++ }
    const s = recon.summary
    // Independent shape check when the images carry GNSS the solve never used (EXIF;
    // the bench imports no poses, so there are no camera priors): see positionCheck.js.
    // Reference positions (a survey file) win over EXIF when the config supplies them.
    const positions = reference?.positions
      ? new Map(images.images.filter((i) => reference.positions[stem(i.name)]).map((i) => [i.uuid, reference.positions[stem(i.name)]]))
      : new Map(images.images
        .filter((i) => Number.isFinite(i.meta?.gpsLat) && Number.isFinite(i.meta?.gpsLon) && Number.isFinite(i.meta?.gpsAlt))
        .map((i) => [i.uuid, { lat: i.meta.gpsLat, lon: i.meta.gpsLon, alt: i.meta.gpsAlt }]))
    const pc = cloud?.cameras ? cameraPositionCheck(cloud.cameras, positions, { leverArm: reference?.leverArm ?? null }) : null
    lastPositionCheck = pc
    const checkpointCheck = pc && reference?.gcps
      ? await checkpoints(cloud, pc).catch((e) => ({ error: String(e?.stack ?? e) }))
      : null
    const checkpointOffsets = {}
    if (pc && reference?.gcps) {
      for (const off of reference.markOffsetsPx ?? []) {
        const r = await checkpoints(cloud, pc, off).catch((e) => ({ error: String(e?.stack ?? e) }))
        checkpointOffsets[off] = r.error ? r : { rmsH: r.rmsH, rmsV: r.rmsV, meanE: r.meanE, meanN: r.meanN, meanU: r.meanU }
      }
    }
    // The ≥3-view points in the positionCheck ENU frame, for a node-side comparison
    // with a reference surface (scripts/bench/lidar.mjs); centimetre-rounded.
    const pointsEnu = pc && exportPoints
      ? points.filter((p) => (p.views?.size ?? 0) >= 3).map((p) => applySimilarity(pc.sim, [p.x, p.y, p.z]).map((v) => Math.round(v * 100) / 100))
      : null
    const nameOf = new Map(images.images.map((i) => [i.uuid, i.name]))
    const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4)
    // Projects with GCPs (historical blocks): control + checkpoint residuals in the CRS.
    const gcpResiduals = gcpsStore.gcps.length && cloud?.cameras?.size
      ? await window.bench.gcpReport().catch((e) => ({ error: String(e?.stack ?? e) }))
      : null
    const positionCheck = pc && {
      count: pc.count, scale: r4(pc.scale), rms3d: r4(pc.rms3d), rmsH: r4(pc.rmsH), rmsV: r4(pc.rmsV),
      medianH: r4(pc.medianH), p95H: r4(pc.p95H), maxH: r4(pc.maxH), medianV: r4(pc.medianV), p95V: r4(pc.p95V), maxV: r4(pc.maxV),
      worst: pc.worst.map((w) => `${nameOf.get(w.uuid) ?? w.uuid} ${w.m.toFixed(3)}m`),
    }
    return {
      settings, seconds: (performance.now() - t0) / 1000,
      cameras: cloud?.cameras?.size ?? 0, images: images.images.length,
      points: points.length, pointsGe3: ge3, observations: obs,
      reprojection: s?.reprojection ?? s?.finalReprojection ?? null,
      // BA linear-solver totals + stage wall clock: the PCG-vs-Cholesky comparison
      // (TODO ▸ MEM ▸ PCG) reads these; set recon.baSolver per variant to compare.
      baSolver: s?.baSolver ?? null, timings: s?.timings ?? null,
      positionCheck, checkpointCheck, checkpointOffsets, gcpResiduals, posePriors: priors, leverArm: arm, sensor,
      pointsEnu, enuOrigin: pc?.origin ?? null,
      // The posed cameras (pinhole frame), so accuracy can be re-analysed without a rerun.
      model: cloud?.cameras ? Object.fromEntries([...cloud.cameras].map(([u, c]) => [nameOf.get(u) ?? u, { R: c.R, t: c.t, K: c.K }])) : null,
    }
  },
}
document.getElementById('status').textContent = 'ready'
window.benchReady = true
