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
import {
  DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS, MATCH_DEFAULTS, MATCH_PRESETS,
  RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS,
} from '/src/core/defaults.user.js'
import { cameraPositionCheck, gcpCheck } from '/src/core/eval/positionCheck.js'
import { applySimilarity } from '/src/core/products/georef.js'
import { makeFrameModelResolver, gcpsInPinholeFrame } from '/src/core/sfm/displayFrame.js'
import { triangulateGcp } from '/src/core/sfm/gcpTriangulation.js'

setActivePinia(createPinia())
const { onLog, takePending } = useLog()
onLog(() => { for (const e of takePending()) console.log('@@LOG ' + JSON.stringify(e)) })

const projects = useProjectsStore()
const images = useImagesStore()
const sensorsStore = useSensorsStore() // its watcher groups images into EXIF sensors, as in the app
const matches = useMatchesStore()
const recon = useReconstructionStore()
const poses = usePosesStore()

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
const SENSOR_OVERRIDE_FIELDS = ['focal', 'focalUnit', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2', 'distortionModel']
const sensorBase = {}
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

window.bench = {
  // The reference camera positions as imported poses (WGS84), as a user importing a
  // camera CSV would: preselection uses them; `posePriors` decides whether SfM does.
  async importReferencePoses() {
    const raw = Object.entries(reference?.positions ?? {}).map(([name, p]) => ({ imageName: name, x: p.lon, y: p.lat, z: p.alt,
      ...(p.se ? { accuracyX: p.se, accuracyY: p.sn, accuracyZ: p.su } : {}) }))
    return poses.addPoses(raw, 'EPSG:4326')
  },

  setReference(r) { reference = r; return { positions: Object.keys(r?.positions ?? {}).length, gcps: r?.gcps?.length ?? 0, leverArm: r?.leverArm } },

  async start({ name = 'bench', sceneType = 'object' } = {}) {
    await projects.loadIndex()
    await projects.createProject(name, sceneType)
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
    const settings = { detector: 'sift', overwrite: true, ...withPreset(DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS, preset), ...overrides }
    const t0 = performance.now()
    await images.detectAll(settings, null, report, () => false)
    const done = images.images.filter((i) => i.kpStatus === 'done')
    return {
      settings, seconds: (performance.now() - t0) / 1000, images: done.length,
      keypoints: done.reduce((s, i) => s + (i.kpCount ?? 0), 0),
    }
  },

  async match({ preset = null, ...overrides } = {}) {
    const settings = { strategy: 'exhaustive', matcher: 'bruteforce', useGpu: true, ...withPreset(MATCH_DEFAULTS, MATCH_PRESETS, preset), ...overrides }
    const t0 = performance.now()
    await matches.matchAll(images.images, settings, report, () => false)
    let accepted = 0, inliers = 0
    for (const e of matches.matchStore.values()) {
      if (e.status === 'done' && !e.weak && (e.matches?.length ?? 0) > 0) { accepted++; inliers += e.inlierCount ?? e.matches.length }
    }
    return { settings, seconds: (performance.now() - t0) / 1000, pairs: matches.matchStore.size, accepted, inliers }
  },

  // posePriors: false disables every camera pose (incl. the EXIF GNSS the app imports
  // automatically) for this run, so the solve is pure SfM and positionCheck below is an
  // independent accuracy measurement. The default keeps the app's behaviour.
  // leverArm: true sets the reference GNSS antenna offset on every sensor, so the
  // camera priors are treated as antenna positions (sensor.gnssLeverArm); false clears it.
  // sensor: { focal, cx, cy, k1, …, distortionModel } is assigned to every sensor for
  // this run (sensor-table units: focal + focalUnit, absolute pixel-centre cx/cy, OpenCV
  // p1/p2). A run without it restores the fields to what the EXIF grouping produced.
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
      positionCheck, checkpointCheck, checkpointOffsets, posePriors: priors, leverArm: arm, sensor,
      pointsEnu, enuOrigin: pc?.origin ?? null,
      // The posed cameras (pinhole frame), so accuracy can be re-analysed without a rerun.
      model: cloud?.cameras ? Object.fromEntries([...cloud.cameras].map(([u, c]) => [nameOf.get(u) ?? u, { R: c.R, t: c.t, K: c.K }])) : null,
    }
  },
}
document.getElementById('status').textContent = 'ready'
window.benchReady = true
